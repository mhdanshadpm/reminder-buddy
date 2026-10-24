'use strict';

const {
  pad2,
  parseClock,
  parseLocalDateTime
} = require('./common');

const MINUTE = 60_000;
const DAY = 86_400_000;
const QUEUE_GAP_MS = 3_000;
const IDLE_POLL_MS = 30_000;
const SCHEDULER_MAX_WAIT_MS = 60_000;
const MAX_SCAN_DAYS = 400;
const MAX_OCCURRENCES = 2_000;
const MAX_MISSED_AGE_MS = 7 * DAY;

const systemClock = Object.freeze({
  now: () => Date.now(),
  parts(ms) {
    const date = new Date(ms);
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      weekday: date.getDay(),
      offset: date.getTimezoneOffset()
    };
  },
  fromParts(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
    return new Date(year, month, day, hour, minute, second, millisecond).getTime();
  }
});

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  return null;
}

function clockNowMs(clock) {
  return clock.parts ? clock.now() : Date.now();
}

function localDayStart(clock, ms) {
  const parts = clock.parts(ms);
  return clock.fromParts(parts.year, parts.month, parts.day, 0, 0, 0, 0);
}

function addLocalDays(clock, ms, days) {
  const parts = clock.parts(ms);
  return clock.fromParts(parts.year, parts.month, parts.day + days, 0, 0, 0, 0);
}

function localClockMs(clock, dayStartMs, minutes) {
  const parts = clock.parts(dayStartMs);
  const dayOffset = Math.floor(minutes / 1440);
  const withinDay = ((minutes % 1440) + 1440) % 1440;
  return clock.fromParts(
    parts.year,
    parts.month,
    parts.day + dayOffset,
    Math.floor(withinDay / 60),
    withinDay % 60,
    0,
    0
  );
}

function localKey(clock, ms) {
  const parts = clock.parts(ms);
  return `${parts.year}-${pad2(parts.month + 1)}-${pad2(parts.day)}`;
}

function dateInRange(clock, schedule, ms) {
  const key = localKey(clock, ms);
  if (schedule.startDate && key < schedule.startDate) return false;
  if (schedule.endDate && key > schedule.endDate) return false;
  return true;
}

function dayAllowed(clock, schedule, dayStartMs) {
  if (!Array.isArray(schedule.days) || !schedule.days.includes(clock.parts(dayStartMs).weekday)) {
    return false;
  }
  return dateInRange(clock, schedule, dayStartMs);
}

function activeWindowForDay(clock, schedule, dayStartMs) {
  const startMinutes = parseClock(schedule.activeStart);
  const endMinutes = parseClock(schedule.activeEnd);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return null;
  const duration = endMinutes > startMinutes
    ? endMinutes - startMinutes
    : 1440 - startMinutes + endMinutes;
  return {
    start: localClockMs(clock, dayStartMs, startMinutes),
    end: localClockMs(clock, dayStartMs, startMinutes + duration),
    startMinutes,
    endMinutes: startMinutes + duration,
    durationMinutes: duration
  };
}

function activeWindowAt(clock, schedule, ms) {
  const today = localDayStart(clock, ms);
  for (const offset of [-1, 0]) {
    const dayStart = addLocalDays(clock, today, offset);
    if (!dayAllowed(clock, schedule, dayStart)) continue;
    const window = activeWindowForDay(clock, schedule, dayStart);
    if (window && ms >= window.start && ms < window.end) return window;
  }
  return null;
}

function dndWindowAt(clock, dnd, ms) {
  if (!dnd?.enabled || !Array.isArray(dnd.days) || dnd.days.length === 0) return null;
  const startMinutes = parseClock(dnd.start);
  const endMinutes = parseClock(dnd.end);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return null;
  for (const offset of [-1, 0]) {
    const dayStart = addLocalDays(clock, localDayStart(clock, ms), offset);
    if (!dnd.days.includes(clock.parts(dayStart).weekday)) continue;
    const start = localClockMs(clock, dayStart, startMinutes);
    const end = localClockMs(
      clock,
      dayStart,
      endMinutes > startMinutes ? endMinutes : endMinutes + 1440
    );
    if (ms >= start && ms < end) return { start, end };
  }
  return null;
}

function uniqueEntries(entries) {
  entries.sort((left, right) => left.at - right.at);
  const result = [];
  for (const entry of entries) {
    const previous = result[result.length - 1];
    if (previous && previous.at === entry.at) continue;
    result.push(entry);
  }
  return result;
}

function dayOccurrences(clock, schedule, dayStartMs) {
  const kind = schedule.kind;
  if (kind === 'interval') {
    const window = activeWindowForDay(clock, schedule, dayStartMs);
    if (!window) return [];
    const step = schedule.intervalMinutes;
    const result = [];
    for (let minutes = window.startMinutes; minutes < window.endMinutes; minutes += step) {
      result.push({ at: localClockMs(clock, dayStartMs, minutes) });
      if (result.length >= MAX_OCCURRENCES) break;
    }
    // DST can collapse two wall-clock slots onto one instant; never double-fire.
    return uniqueEntries(result);
  }

  if (kind === 'times' || kind === 'monthly') {
    const times = Array.isArray(schedule.times) ? schedule.times : [];
    const result = [];
    for (const value of times) {
      const minutes = parseClock(value);
      if (minutes === null) continue;
      result.push({ at: localClockMs(clock, dayStartMs, minutes) });
    }
    return uniqueEntries(result);
  }

  if (kind === 'pomodoro') {
    const window = activeWindowForDay(clock, schedule, dayStartMs);
    if (!window) return [];
    const result = [];
    let minutes = window.startMinutes;
    let focusing = true;
    let index = 0;
    while (minutes < window.endMinutes && result.length < MAX_OCCURRENCES) {
      const at = localClockMs(clock, dayStartMs, minutes);
      if (at >= window.end) break;
      result.push({
        at,
        phase: index === 0 ? 'focus-start' : (focusing ? 'focus' : 'break')
      });
      minutes += focusing ? schedule.focusMinutes : schedule.breakMinutes;
      focusing = !focusing;
      index += 1;
    }
    return uniqueEntries(result);
  }

  return [];
}

function onceParts(value) {
  if (parseLocalDateTime(value) === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]) - 1,
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0)
  };
}

function onceMs(clock, value) {
  const parts = onceParts(value);
  if (!parts) return null;
  return clock.fromParts(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, 0);
}

function pushUnique(target, entry) {
  if (target.length >= MAX_OCCURRENCES) return false;
  const previous = target[target.length - 1];
  if (previous && previous.at === entry.at && previous.phase === entry.phase) return true;
  target.push(entry);
  return true;
}

function occurrencesBetween(schedule, fromMs, toMs, options = {}) {
  const clock = options.clock || systemClock;
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : MAX_OCCURRENCES;
  if (!schedule || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const result = [];
  const kind = schedule.kind;

  if (kind === 'startup' || kind === 'idle') return [];

  if (kind === 'monthly') {
    const fromParts = clock.parts(fromMs);
    const toParts = clock.parts(toMs);
    let monthCursor = clock.fromParts(fromParts.year, fromParts.month, 1, 0, 0, 0, 0);
    for (let index = 0; index < 24 && monthCursor <= toMs; index += 1) {
      const parts = clock.parts(monthCursor);
      const dayStart = clock.fromParts(parts.year, parts.month, schedule.monthlyDay, 0, 0, 0, 0);
      const dayParts = clock.parts(dayStart);
      if (dayParts.day === schedule.monthlyDay && dateInRange(clock, schedule, dayStart)) {
        for (const entry of dayOccurrences(clock, schedule, dayStart)) {
          if (entry.at > fromMs && entry.at <= toMs) {
            if (!pushUnique(result, entry)) break;
            if (result.length >= limit) break;
          }
        }
      }
      monthCursor = clock.fromParts(parts.year, parts.month + 1, 1, 0, 0, 0, 0);
      if (result.length >= limit) break;
    }
    return result;
  }

  if (kind === 'once') {
    const parts = onceParts(schedule.onceAt);
    if (!parts) return [];
    if (!schedule.repeatYearly) {
      const at = onceMs(clock, schedule.onceAt);
      if (at !== null && at > fromMs && at <= toMs) result.push({ at });
      return result;
    }
    const fromYear = clock.parts(fromMs).year;
    const toYear = clock.parts(toMs).year;
    for (let year = fromYear - 1; year <= toYear + 1; year += 1) {
      const at = clock.fromParts(year, parts.month, parts.day, parts.hour, parts.minute, parts.second, 0);
      const check = clock.parts(at);
      if (check.month !== parts.month || check.day !== parts.day) continue;
      if (at > fromMs && at <= toMs) {
        if (!pushUnique(result, { at })) break;
        if (result.length >= limit) break;
      }
    }
    return result;
  }

  const firstDay = addLocalDays(clock, localDayStart(clock, fromMs), -1);
  const lastDay = localDayStart(clock, toMs);
  let dayCursor = firstDay;
  for (let index = 0; index <= MAX_SCAN_DAYS && dayCursor <= lastDay; index += 1) {
    if (dayAllowed(clock, schedule, dayCursor)) {
      for (const entry of dayOccurrences(clock, schedule, dayCursor)) {
        if (entry.at > fromMs && entry.at <= toMs) {
          if (!pushUnique(result, entry)) break;
          if (result.length >= limit) break;
        }
      }
    }
    if (result.length >= limit) break;
    dayCursor = addLocalDays(clock, dayCursor, 1);
  }
  return result;
}

function nextOccurrence(schedule, afterMs, options = {}) {
  const clock = options.clock || systemClock;
  const kind = schedule?.kind;
  const horizonDays = kind === 'once' ? 366 * 8 : MAX_SCAN_DAYS;
  const horizon = horizonDays * DAY + 2 * 60 * MINUTE;
  return occurrencesBetween(schedule, afterMs, afterMs + horizon, {
    clock,
    limit: 1
  })[0] || null;
}

function blockedUntilFor(reminder, atMs, options = {}) {
  const clock = options.clock || systemClock;
  const schedule = reminder.schedule || {};
  const highPriority = reminder.priority === 'high';
  const pausedUntil = timestamp(options.pausedUntil);
  let blockedUntil = null;

  if (!highPriority && schedule.skipPaused !== false && pausedUntil !== null && pausedUntil > atMs) {
    blockedUntil = pausedUntil;
  }

  if (schedule.skipDnd !== false) {
    const window = dndWindowAt(clock, options.settings?.dnd, atMs);
    if (window && window.end > atMs) {
      blockedUntil = Math.max(blockedUntil ?? 0, window.end);
    }
  }

  return blockedUntil;
}

function nextAllowedAfterBlockers(reminder, afterMs, options) {
  const clock = options.clock || systemClock;
  let cursor = afterMs;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const occurrence = nextOccurrence(reminder.schedule || {}, cursor, { clock });
    if (!occurrence) return null;
    const blockedUntil = blockedUntilFor(reminder, occurrence.at, options);
    if (blockedUntil !== null && blockedUntil > occurrence.at) {
      cursor = blockedUntil - 1;
      continue;
    }
    return occurrence;
  }
  return null;
}

function triggerKey(trigger, suffix = '') {
  return `${new Date(trigger.at).toISOString()}${suffix}`;
}

function nextTrigger(reminder, options = {}) {
  if (!reminder || !reminder.enabled) return null;
  const clock = options.clock || systemClock;
  const nowMs = options.now === undefined
    ? clockNowMs(clock)
    : (timestamp(options.now) ?? clockNowMs(clock));
  const schedule = reminder.schedule || {};
  const runtime = options.runtime || {};
  const priorityHigh = reminder.priority === 'high';
  const pausedUntil = timestamp(options.pausedUntil);
  const snoozeUntil = timestamp(runtime.snoozeUntil);

  if (snoozeUntil !== null) {
    let at = Math.max(snoozeUntil, nowMs);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const blocked = blockedUntilFor(reminder, at, options);
      if (blocked === null || blocked <= at) break;
      at = blocked;
    }
    return {
      at,
      reason: 'snooze',
      key: `snooze:${new Date(snoozeUntil).toISOString()}`,
      occurrenceKey: `snooze:${new Date(snoozeUntil).toISOString()}`
    };
  }

  const todayKey = localKey(clock, nowMs);
  const skippedToday = runtime.skippedOn === todayKey;
  if (skippedToday && schedule.kind === 'startup') return null;

  if (schedule.kind === 'idle') return null;

  if (schedule.kind === 'startup') {
    const appStartedAt = timestamp(options.appStartedAt) ?? nowMs;
    const doneAt = timestamp(runtime.startupDoneAt);
    if (doneAt !== null && doneAt >= appStartedAt) return null;
    if (schedule.startDate && todayKey < schedule.startDate) return null;
    if (schedule.endDate && todayKey > schedule.endDate) return null;
    let at = appStartedAt + (schedule.startupDelayMinutes || 0) * MINUTE;
    if (pausedUntil !== null && !priorityHigh && schedule.skipPaused !== false) {
      at = Math.max(at, pausedUntil);
    }
    const blocked = blockedUntilFor(reminder, at, options);
    if (blocked !== null && blocked > at) at = blocked;
    return {
      at,
      reason: 'startup',
      key: `startup:${appStartedAt}`
    };
  }

  let afterMs = nowMs;
  if (skippedToday) {
    afterMs = addLocalDays(clock, localDayStart(clock, nowMs), 1) - 1;
  }

  if (schedule.kind === 'once' && !schedule.repeatYearly) {
    const base = onceMs(clock, schedule.onceAt);
    if (base === null) return null;
    const lastDue = Math.max(
      timestamp(runtime.lastDueAt) ?? 0,
      timestamp(runtime.lastFiredAt) ?? 0
    );
    if (base > afterMs) {
      let at = base;
      const blocked = blockedUntilFor(reminder, at, options);
      if (blocked !== null && blocked > at) at = blocked;
      return { at, reason: 'once', key: `once:${base}` };
    }
    if (lastDue >= base) return null;
    if (skippedToday && localKey(clock, base) === todayKey) return null;
    let at = nowMs;
    const blocked = blockedUntilFor(reminder, at, options);
    if (blocked !== null && blocked > at) at = blocked;
    return {
      at,
      reason: 'once',
      overdue: true,
      key: `once:${base}`
    };
  }

  const occurrence = nextAllowedAfterBlockers(reminder, afterMs, options);
  if (!occurrence) return null;
  return {
    at: occurrence.at,
    reason: schedule.kind,
    phase: occurrence.phase,
    key: triggerKey(occurrence, occurrence.phase ? `:${occurrence.phase}` : ''),
    occurrenceKey: triggerKey(occurrence, occurrence.phase ? `:${occurrence.phase}` : '')
  };
}

function idleDue(reminder, options = {}) {
  if (!reminder || !reminder.enabled || reminder.schedule?.kind !== 'idle') return null;
  const clock = options.clock || systemClock;
  const nowMs = timestamp(options.now) ?? clockNowMs(clock);
  const schedule = reminder.schedule;
  const runtime = options.runtime || {};
  const idleSeconds = Number(options.idleSeconds);
  if (!Number.isFinite(idleSeconds) || idleSeconds < schedule.idleMinutes * 60) return null;
  if (!dayAllowed(clock, schedule, localDayStart(clock, nowMs))) return null;
  if (!activeWindowAt(clock, schedule, nowMs)) return null;
  if (runtime.skippedOn === localKey(clock, nowMs)) return null;
  if (blockedUntilFor(reminder, nowMs, options) !== null) return null;

  const idleStartedAt = nowMs - idleSeconds * 1000;
  const lastFiredAt = timestamp(runtime.lastIdleFiredAt);
  if (lastFiredAt !== null && idleStartedAt <= lastFiredAt) return null;

  return {
    at: nowMs,
    reason: 'idle',
    idleStartedAt,
    key: `idle:${nowMs}`
  };
}

function findMissedReminders(reminders, options = {}) {
  const clock = options.clock || systemClock;
  const nowMs = timestamp(options.now) ?? clockNowMs(clock);
  const runtime = options.runtime || {};
  const states = runtime.reminderStates || {};
  const lastSeenAt = timestamp(options.lastSeenAt ?? runtime.lastCheckAt);
  if (lastSeenAt === null || lastSeenAt >= nowMs) return [];

  const fromFloor = nowMs - (options.maxAgeMs || MAX_MISSED_AGE_MS);
  const from = Math.max(lastSeenAt, fromFloor);
  const missed = [];

  for (const reminder of reminders || []) {
    if (!reminder?.enabled || reminder.type === 'note') continue;
    const schedule = reminder.schedule || {};
    if (schedule.kind === 'startup' || schedule.kind === 'idle') continue;
    const policy = schedule.missedPolicy && schedule.missedPolicy !== 'inherit'
      ? schedule.missedPolicy
      : (options.settings?.missedPolicy || 'show');
    if (policy !== 'show') continue;

    const state = states[reminder.id] || {};
    const lastDueAt = timestamp(state.lastDueAt) ?? timestamp(state.lastFiredAt);
    let lowerBound = Math.max(from, lastDueAt ?? 0);
    const snoozeUntil = timestamp(state.snoozeUntil);
    if (snoozeUntil !== null && snoozeUntil > lowerBound) lowerBound = snoozeUntil;
    if (lowerBound >= nowMs) continue;

    const entries = occurrencesBetween(schedule, lowerBound, nowMs, { clock });
    const skippedOn = typeof state.skippedOn === 'string' ? state.skippedOn : null;
    const relevant = skippedOn
      ? entries.filter((entry) => localKey(clock, entry.at) !== skippedOn)
      : entries;
    if (relevant.length === 0) continue;
    const latest = relevant[relevant.length - 1];
    missed.push({
      reminder,
      at: latest.at,
      phase: latest.phase,
      missedCount: relevant.length,
      ageMs: nowMs - latest.at
    });
  }

  missed.sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at;
    const priority = (reminder) => (reminder.priority === 'high' ? 0 : 1);
    return priority(left.reminder) - priority(right.reminder);
  });
  return missed;
}

class ReminderQueue {
  constructor({ gapMs = QUEUE_GAP_MS, now = () => Date.now() } = {}) {
    this.gapMs = Math.max(0, gapMs);
    this.now = now;
    this.readyAt = 0;
    this.sequence = 0;
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  has(reminderId) {
    return this.items.some((item) => item.reminderId === reminderId);
  }

  enqueue(reminder, trigger, { missed = false, missedCount = 1 } = {}) {
    const existing = this.items.find((item) => item.reminderId === reminder.id);
    if (existing) {
      existing.missed = existing.missed || missed;
      existing.missedCount = Math.max(existing.missedCount || 0, missedCount);
      return existing;
    }
    const enqueuedAt = this.now();
    const sortAt = missed ? enqueuedAt : trigger.at;
    const item = {
      id: `${reminder.id}:${trigger.key || trigger.at}:${this.sequence}`,
      reminderId: reminder.id,
      title: reminder.title,
      priority: reminder.priority,
      type: reminder.type,
      dueAt: trigger.at,
      phase: trigger.phase || null,
      reason: trigger.reason || 'schedule',
      missed,
      missedCount,
      enqueuedAt,
      sortAt,
      sequence: this.sequence,
      trigger
    };
    this.sequence += 1;
    this.items.push(item);
    this.items.sort((left, right) => {
      if (left.missed !== right.missed) return left.missed ? -1 : 1;
      if (left.sortAt !== right.sortAt) return left.sortAt - right.sortAt;
      const priority = (itemPriority) => (itemPriority.priority === 'high' ? 0 : 1);
      if (priority(left) !== priority(right)) return priority(left) - priority(right);
      return left.sequence - right.sequence;
    });
    return item;
  }

  peek() {
    return this.items[0] || null;
  }

  shift(now = this.now()) {
    if (this.items.length === 0) return null;
    if (now < this.readyAt) return null;
    const item = this.items.shift();
    this.readyAt = now + this.gapMs;
    return item;
  }

  remove(reminderId) {
    const index = this.items.findIndex((item) => item.reminderId === reminderId);
    if (index === -1) return null;
    const [item] = this.items.splice(index, 1);
    return item;
  }

  clear() {
    this.items = [];
    this.readyAt = 0;
  }

  toArray() {
    return this.items.map((item) => ({ ...item }));
  }
}

class ReminderScheduler {
  constructor({
    getState,
    onDue,
    clock = systemClock,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    maxWaitMs = SCHEDULER_MAX_WAIT_MS,
    idlePollMs = IDLE_POLL_MS,
    onError = null
  } = {}) {
    if (typeof getState !== 'function') throw new Error('A getState function is required.');
    if (typeof onDue !== 'function') throw new Error('An onDue function is required.');
    this.getState = getState;
    this.onDue = onDue;
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.maxWaitMs = Math.max(1_000, maxWaitMs);
    this.idlePollMs = Math.max(1_000, idlePollMs);
    this.onError = onError;
    this.running = false;
    this.timer = null;
    this.plan = [];
    this.nextAt = null;
    this.idlePollAt = null;
    this.lastOffset = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastOffset = this.clock.parts(this.clock.now()).offset;
    this.refresh();
  }

  stop() {
    this.running = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  getNextAt() {
    return this.nextAt;
  }

  getPlan() {
    return this.plan.map((item) => ({
      reminderId: item.reminder.id,
      title: item.reminder.title,
      at: item.trigger.at,
      reason: item.trigger.reason,
      phase: item.trigger.phase || null
    }));
  }

  _report(error) {
    if (typeof this.onError === 'function') this.onError(error);
    else throw error;
  }

  _hasIdle(state) {
    return (state.reminders || []).some((reminder) => (
      reminder.enabled && reminder.schedule?.kind === 'idle'
    ));
  }

  _arm(waitMs) {
    if (this.timer !== null) this.clearTimer(this.timer);
    const wait = Math.max(0, Math.min(waitMs, this.maxWaitMs));
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.tick();
    }, wait);
  }

  refresh() {
    if (!this.running) return;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }

    let state;
    try {
      state = this.getState();
    } catch (error) {
      this._report(error);
      this._arm(this.maxWaitMs);
      return;
    }

    const nowMs = this.clock.now();
    const runtimeStates = state.runtime?.reminderStates || state.reminderStates || {};
    const pending = new Set(state.pendingIds || []);
    const plan = [];

    for (const reminder of state.reminders || []) {
      if (!reminder.enabled || pending.has(reminder.id)) continue;
      if (reminder.schedule?.kind === 'idle') continue;
      const trigger = nextTrigger(reminder, {
        clock: this.clock,
        now: nowMs,
        runtime: runtimeStates[reminder.id] || {},
        settings: state.settings,
        pausedUntil: state.pausedUntil,
        appStartedAt: state.appStartedAt
      });
      if (trigger) plan.push({ reminder, trigger });
    }

    plan.sort((left, right) => {
      if (left.trigger.at !== right.trigger.at) return left.trigger.at - right.trigger.at;
      const priority = (item) => (item.reminder.priority === 'high' ? 0 : 1);
      return priority(left) - priority(right);
    });

    this.plan = plan;
    this.nextAt = plan.length > 0 ? plan[0].trigger.at : null;
    this.idlePollAt = this._hasIdle(state) ? nowMs + this.idlePollMs : null;

    let wait = this.maxWaitMs;
    if (this.nextAt !== null) wait = Math.min(wait, Math.max(0, this.nextAt - nowMs));
    if (this.idlePollAt !== null) wait = Math.min(wait, Math.max(0, this.idlePollAt - nowMs));
    this._arm(wait);
  }

  tick() {
    if (!this.running) return;
    const nowMs = this.clock.now();
    const offset = this.clock.parts(nowMs).offset;
    if (this.lastOffset !== null && offset !== this.lastOffset) {
      this.lastOffset = offset;
      this.refresh();
      return;
    }
    this.lastOffset = offset;

    let state;
    try {
      state = this.getState();
    } catch (error) {
      this._report(error);
      this._arm(this.maxWaitMs);
      return;
    }

    const pending = new Set(state.pendingIds || []);
    const due = this.plan.filter((item) => item.trigger.at <= nowMs + 50);
    for (const item of due) {
      if (pending.has(item.reminder.id)) continue;
      const current = (state.reminders || []).find((reminder) => reminder.id === item.reminder.id);
      if (!current || !current.enabled) continue;
      try {
        this.onDue({
          reminder: current,
          trigger: item.trigger,
          at: new Date(item.trigger.at),
          reason: item.trigger.reason
        });
      } catch (error) {
        this._report(error);
      }
      pending.add(item.reminder.id);
    }

    if (this._hasIdle(state) && this.idlePollAt !== null && nowMs >= this.idlePollAt - 50) {
      const runtimeStates = state.runtime?.reminderStates || state.reminderStates || {};
      const idleSeconds = typeof state.getIdleSeconds === 'function'
        ? state.getIdleSeconds()
        : 0;
      for (const reminder of state.reminders || []) {
        if (!reminder.enabled || reminder.schedule?.kind !== 'idle') continue;
        if (pending.has(reminder.id)) continue;
        const trigger = idleDue(reminder, {
          clock: this.clock,
          now: nowMs,
          idleSeconds,
          runtime: runtimeStates[reminder.id] || {},
          settings: state.settings,
          pausedUntil: state.pausedUntil
        });
        if (!trigger) continue;
        try {
          this.onDue({ reminder, trigger, at: new Date(trigger.at), reason: 'idle' });
        } catch (error) {
          this._report(error);
        }
        pending.add(reminder.id);
      }
    }

    this.refresh();
  }
}

module.exports = {
  IDLE_POLL_MS,
  MAX_MISSED_AGE_MS,
  QUEUE_GAP_MS,
  ReminderQueue,
  ReminderScheduler,
  SCHEDULER_MAX_WAIT_MS,
  activeWindowAt,
  activeWindowForDay,
  findMissedReminders,
  idleDue,
  localDayStart,
  localKey,
  nextOccurrence,
  nextTrigger,
  occurrencesBetween,
  systemClock
};
