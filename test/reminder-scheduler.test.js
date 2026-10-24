'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ALL_DAYS } = require('../lib/common');
const {
  createReminderFromTemplate,
  defaultSchedule
} = require('../lib/reminders');
const {
  ReminderQueue,
  ReminderScheduler,
  findMissedReminders,
  idleDue,
  nextOccurrence,
  nextTrigger,
  occurrencesBetween,
  systemClock
} = require('../lib/scheduler');

const local = (year, month, day, hour = 0, minute = 0) => (
  new Date(year, month - 1, day, hour, minute, 0, 0)
);

function makeReminder(overrides = {}) {
  const base = createReminderFromTemplate('custom', { now: local(2026, 1, 1, 9) });
  const reminder = {
    ...base,
    id: overrides.id || 'r-test',
    title: overrides.title || 'Test reminder',
    ...overrides
  };
  reminder.schedule = {
    ...defaultSchedule(overrides.schedule?.kind || 'interval'),
    ...base.schedule,
    ...(overrides.schedule || {})
  };
  if (overrides.snooze) reminder.snooze = { ...base.snooze, ...overrides.snooze };
  return reminder;
}

function timesAt(entries) {
  return entries.map((entry) => {
    const date = new Date(entry.at);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  });
}

function nthSunday(year, monthIndex, index) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (7 - first.getUTCDay()) % 7;
  return 1 + offset + (index - 1) * 7;
}

function createNewYorkClock(nowMs) {
  let current = nowMs;
  const boundaries = (year) => {
    const springWall = Date.UTC(year, 2, nthSunday(year, 2, 2), 2, 0, 0, 0);
    const fallWall = Date.UTC(year, 10, nthSunday(year, 10, 1), 2, 0, 0, 0);
    return {
      springWall,
      fallWall,
      springUtc: springWall + 300 * 60_000,
      fallUtc: fallWall + 240 * 60_000
    };
  };
  return {
    now: () => current,
    setNow: (ms) => { current = ms; },
    fromParts(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
      const wall = Date.UTC(year, month, day, hour, minute, second, millisecond);
      const actualYear = new Date(wall).getUTCFullYear();
      const { springWall, fallWall } = boundaries(actualYear);
      const inGap = wall >= springWall && wall < springWall + 3_600_000;
      const isDst = !inGap && wall >= springWall && wall < fallWall;
      return wall + (isDst ? 240 : 300) * 60_000;
    },
    parts(ms) {
      const utc = new Date(ms);
      const year = utc.getUTCFullYear();
      const { springUtc, fallUtc } = boundaries(year);
      const isDst = ms >= springUtc && ms < fallUtc;
      const offset = isDst ? 240 : 300;
      const localDate = new Date(ms - offset * 60_000);
      return {
        year: localDate.getUTCFullYear(),
        month: localDate.getUTCMonth(),
        day: localDate.getUTCDate(),
        hour: localDate.getUTCHours(),
        minute: localDate.getUTCMinutes(),
        second: localDate.getUTCSeconds(),
        weekday: localDate.getUTCDay(),
        offset
      };
    }
  };
}

test('interval schedules anchor to active hours and skip inactive days', () => {
  const schedule = {
    kind: 'interval',
    intervalMinutes: 60,
    activeStart: '09:00',
    activeEnd: '21:00',
    days: [...ALL_DAYS]
  };
  assert.deepEqual(
    timesAt(occurrencesBetween(
      schedule,
      local(2026, 1, 5, 9).getTime() - 1,
      local(2026, 1, 5, 11, 30).getTime()
    )),
    ['2026-01-05 09:00', '2026-01-05 10:00', '2026-01-05 11:00']
  );
  assert.equal(new Date(nextOccurrence(schedule, local(2026, 1, 5, 9, 30).getTime()).at).getHours(), 10);
  assert.equal(
    new Date(nextOccurrence(schedule, local(2026, 1, 5, 20, 30).getTime()).at).getDate(),
    6
  );
  assert.equal(new Date(nextOccurrence(schedule, local(2026, 1, 5, 20, 30).getTime()).at).getHours(), 9);

  const mondayOnly = { ...schedule, days: [1] };
  const monday = nextOccurrence(mondayOnly, local(2026, 1, 6, 10).getTime());
  assert.equal(new Date(monday.at).getDay(), 1);
  assert.equal(new Date(monday.at).getDate(), 12);
});

test('interval schedules can cross midnight inside an overnight window', () => {
  const schedule = {
    kind: 'interval',
    intervalMinutes: 60,
    activeStart: '22:00',
    activeEnd: '02:00',
    days: [...ALL_DAYS]
  };
  const entries = occurrencesBetween(
    schedule,
    local(2026, 1, 5, 22).getTime() - 1,
    local(2026, 1, 6, 3).getTime()
  );
  assert.deepEqual(timesAt(entries), [
    '2026-01-05 22:00',
    '2026-01-05 23:00',
    '2026-01-06 00:00',
    '2026-01-06 01:00'
  ]);
  const next = nextOccurrence(schedule, local(2026, 1, 5, 23, 30).getTime());
  assert.equal(timesAt([next])[0], '2026-01-06 00:00');
});

test('fixed times respect weekdays, date ranges, and multiple times per day', () => {
  const schedule = {
    kind: 'times',
    times: ['14:00', '08:00', '21:30'],
    days: [1, 2, 3, 4, 5],
    activeStart: '09:00',
    activeEnd: '17:00'
  };
  const friday = local(2026, 1, 9, 15);
  assert.equal(timesAt([nextOccurrence(schedule, friday.getTime())])[0], '2026-01-09 21:30');
  assert.equal(
    timesAt([nextOccurrence(schedule, local(2026, 1, 9, 22).getTime())])[0],
    '2026-01-12 08:00'
  );

  const ranged = {
    ...schedule,
    startDate: '2026-01-12',
    endDate: '2026-01-16'
  };
  assert.equal(
    timesAt([nextOccurrence(ranged, local(2026, 1, 10, 12).getTime())])[0],
    '2026-01-12 08:00'
  );
  assert.equal(nextOccurrence(ranged, local(2026, 1, 16, 22).getTime()), null);
});

test('monthly schedules skip months without the chosen day', () => {
  const monthly = makeReminder({
    schedule: { kind: 'monthly', monthlyDay: 31, times: ['09:00'] }
  });
  assert.equal(
    timesAt([nextOccurrence(monthly.schedule, local(2026, 1, 31, 10).getTime())])[0],
    '2026-03-31 09:00'
  );
  assert.equal(
    timesAt([nextOccurrence(monthly.schedule, local(2026, 12, 31, 10).getTime())])[0],
    '2027-01-31 09:00'
  );

  const first = makeReminder({ schedule: { kind: 'monthly', monthlyDay: 1, times: ['08:30'] } });
  assert.equal(
    timesAt([nextOccurrence(first.schedule, local(2026, 12, 2, 10).getTime())])[0],
    '2027-01-01 08:30'
  );
});

test('once schedules fire once, support overdue catch-up, and repeat yearly', () => {
  const once = makeReminder({
    schedule: { kind: 'once', onceAt: '2026-06-01T09:00', repeatYearly: false }
  });
  assert.equal(
    timesAt([nextOccurrence(once.schedule, local(2026, 5, 1, 9).getTime())])[0],
    '2026-06-01 09:00'
  );
  assert.equal(nextOccurrence(once.schedule, local(2026, 6, 2, 9).getTime()), null);

  const overdue = nextTrigger(once, { now: local(2026, 6, 2, 9) });
  assert.equal(overdue.overdue, true);
  assert.ok(overdue.at <= local(2026, 6, 2, 9).getTime() + 1);
  assert.equal(nextTrigger(once, {
    now: local(2026, 6, 2, 9),
    runtime: { lastDueAt: local(2026, 6, 1, 9).toISOString() }
  }), null);

  const yearly = makeReminder({
    schedule: { kind: 'once', onceAt: '2026-03-15T09:00', repeatYearly: true }
  });
  assert.equal(
    timesAt([nextOccurrence(yearly.schedule, local(2026, 3, 16, 9).getTime())])[0],
    '2027-03-15 09:00'
  );

  const leap = makeReminder({
    schedule: { kind: 'once', onceAt: '2028-02-29T09:00', repeatYearly: true }
  });
  assert.equal(
    timesAt([nextOccurrence(leap.schedule, local(2026, 3, 1, 9).getTime())])[0],
    '2028-02-29 09:00'
  );
});

test('startup schedules fire once per launch after the configured delay', () => {
  const reminder = makeReminder({
    schedule: { kind: 'startup', startupDelayMinutes: 5 }
  });
  const launched = local(2026, 1, 5, 8).getTime();
  const trigger = nextTrigger(reminder, {
    now: local(2026, 1, 5, 8, 1),
    appStartedAt: launched,
    runtime: {}
  });
  assert.equal(timesAt([{ at: trigger.at }])[0], '2026-01-05 08:05');

  assert.equal(nextTrigger(reminder, {
    now: local(2026, 1, 5, 8, 10),
    appStartedAt: launched,
    runtime: { startupDoneAt: local(2026, 1, 5, 8, 5).toISOString() }
  }), null);

  const relaunched = local(2026, 1, 6, 9).getTime();
  const nextLaunch = nextTrigger(reminder, {
    now: local(2026, 1, 6, 9, 1),
    appStartedAt: relaunched,
    runtime: { startupDoneAt: local(2026, 1, 5, 8, 5).toISOString() }
  });
  assert.equal(timesAt([{ at: nextLaunch.at }])[0], '2026-01-06 09:05');

  assert.equal(nextTrigger(reminder, {
    now: local(2026, 1, 6, 9, 10),
    appStartedAt: relaunched,
    runtime: { startupDoneAt: null, skippedOn: '2026-01-06' }
  }), null);
});

test('idle schedules fire once per idle period inside active hours', () => {
  const reminder = makeReminder({
    schedule: { kind: 'idle', idleMinutes: 30, activeStart: '09:00', activeEnd: '21:00' }
  });
  const options = {
    now: local(2026, 1, 5, 10),
    runtime: {},
    settings: {},
    pausedUntil: null
  };
  assert.equal(idleDue(reminder, { ...options, idleSeconds: 1_700 }), null);
  const due = idleDue(reminder, { ...options, idleSeconds: 1_800 });
  assert.ok(due);
  assert.equal(due.reason, 'idle');

  assert.equal(idleDue(reminder, {
    ...options,
    idleSeconds: 1_800,
    runtime: { lastIdleFiredAt: local(2026, 1, 5, 9, 45).toISOString() }
  }), null);
  assert.ok(idleDue(reminder, {
    ...options,
    idleSeconds: 1_800,
    runtime: { lastIdleFiredAt: local(2026, 1, 5, 9).toISOString() }
  }));
  assert.equal(idleDue(reminder, {
    ...options,
    now: local(2026, 1, 5, 22),
    idleSeconds: 3_600
  }), null);
});

test('global pause skips normal reminders but not high priority ones', () => {
  const reminder = makeReminder({
    schedule: { kind: 'interval', intervalMinutes: 60, activeStart: '09:00', activeEnd: '21:00' },
    priority: 'normal'
  });
  const pausedUntil = local(2026, 1, 5, 12, 30).getTime();
  const trigger = nextTrigger(reminder, {
    now: local(2026, 1, 5, 9, 30),
    pausedUntil,
    runtime: {},
    settings: {}
  });
  assert.equal(timesAt([{ at: trigger.at }])[0], '2026-01-05 13:00');

  const high = { ...reminder, priority: 'high' };
  const highTrigger = nextTrigger(high, {
    now: local(2026, 1, 5, 9, 30),
    pausedUntil,
    runtime: {},
    settings: {}
  });
  assert.equal(timesAt([{ at: highTrigger.at }])[0], '2026-01-05 10:00');
});

test('snoozes respect pause and do not stack with the normal schedule', () => {
  const reminder = makeReminder({
    schedule: { kind: 'interval', intervalMinutes: 60, activeStart: '09:00', activeEnd: '21:00' }
  });
  const snoozed = nextTrigger(reminder, {
    now: local(2026, 1, 5, 10),
    runtime: { snoozeUntil: local(2026, 1, 5, 10, 30).toISOString() },
    pausedUntil: local(2026, 1, 5, 11).getTime(),
    settings: {}
  });
  assert.equal(snoozed.reason, 'snooze');
  assert.equal(timesAt([{ at: snoozed.at }])[0], '2026-01-05 11:00');

  const overdue = nextTrigger(reminder, {
    now: local(2026, 1, 5, 10, 45),
    runtime: { snoozeUntil: local(2026, 1, 5, 10, 30).toISOString() },
    settings: {}
  });
  assert.equal(overdue.reason, 'snooze');
  assert.ok(overdue.at <= local(2026, 1, 5, 10, 45).getTime() + 1);
});

test('do not disturb pushes reminders to the end of the window', () => {
  const dnd = {
    enabled: true,
    start: '12:00',
    end: '14:00',
    days: [...ALL_DAYS]
  };
  const reminder = makeReminder({
    schedule: { kind: 'times', times: ['12:30', '15:00'] }
  });
  const trigger = nextTrigger(reminder, {
    now: local(2026, 1, 5, 11),
    runtime: {},
    settings: { dnd }
  });
  assert.equal(timesAt([{ at: trigger.at }])[0], '2026-01-05 15:00');

  const allowed = nextTrigger({ ...reminder, schedule: { ...reminder.schedule, skipDnd: false } }, {
    now: local(2026, 1, 5, 11),
    runtime: {},
    settings: { dnd }
  });
  assert.equal(timesAt([{ at: allowed.at }])[0], '2026-01-05 12:30');

  const overnight = nextTrigger(makeReminder({
    schedule: { kind: 'times', times: ['23:00', '08:00'] }
  }), {
    now: local(2026, 1, 5, 21),
    runtime: {},
    settings: {
      dnd: { enabled: true, start: '22:00', end: '07:00', days: [...ALL_DAYS] }
    }
  });
  assert.equal(timesAt([{ at: overnight.at }])[0], '2026-01-06 08:00');
});

test('pomodoro schedules alternate focus and break prompts', () => {
  const reminder = makeReminder({
    schedule: {
      kind: 'pomodoro',
      focusMinutes: 25,
      breakMinutes: 5,
      activeStart: '09:00',
      activeEnd: '11:00'
    }
  });
  const entries = occurrencesBetween(
    reminder.schedule,
    local(2026, 1, 5, 8).getTime(),
    local(2026, 1, 5, 11).getTime()
  );
  assert.deepEqual(timesAt(entries), [
    '2026-01-05 09:00',
    '2026-01-05 09:25',
    '2026-01-05 09:30',
    '2026-01-05 09:55',
    '2026-01-05 10:00',
    '2026-01-05 10:25',
    '2026-01-05 10:30',
    '2026-01-05 10:55'
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.phase),
    ['focus-start', 'break', 'focus', 'break', 'focus', 'break', 'focus', 'break']
  );
  const next = nextOccurrence(reminder.schedule, local(2026, 1, 5, 9, 20).getTime());
  assert.equal(next.phase, 'break');
  assert.equal(timesAt([next])[0], '2026-01-05 09:25');
});

test('missed reminders catch up after sleep, respecting policy and skip state', () => {
  const medicine = makeReminder({
    id: 'r-medicine',
    title: 'Medicine',
    type: 'confirm',
    priority: 'high',
    schedule: { kind: 'times', times: ['12:00', '20:00'] }
  });
  const water = makeReminder({
    id: 'r-water',
    title: 'Water',
    schedule: {
      kind: 'interval',
      intervalMinutes: 60,
      activeStart: '09:00',
      activeEnd: '21:00'
    }
  });
  const eyeRest = makeReminder({
    id: 'r-eyes',
    title: 'Eye rest',
    type: 'note',
    schedule: {
      kind: 'interval',
      intervalMinutes: 20,
      activeStart: '09:00',
      activeEnd: '18:00'
    }
  });
  const skipped = makeReminder({
    id: 'r-skipped',
    title: 'Skipped',
    schedule: { kind: 'times', times: ['08:00'], missedPolicy: 'skip' }
  });

  const now = local(2026, 1, 5, 12, 30);
  const missed = findMissedReminders([medicine, water, eyeRest, skipped], {
    now,
    lastSeenAt: local(2026, 1, 5, 9, 30).getTime(),
    runtime: {
      reminderStates: {
        'r-medicine': {},
        'r-water': {},
        'r-skipped': {}
      }
    },
    settings: { missedPolicy: 'show' }
  });

  const ids = missed.map((entry) => entry.reminder.id).sort();
  assert.deepEqual(ids, ['r-medicine', 'r-water']);
  const medicineMiss = missed.find((entry) => entry.reminder.id === 'r-medicine');
  assert.equal(medicineMiss.missedCount, 1);
  assert.equal(timesAt([{ at: medicineMiss.at }])[0], '2026-01-05 12:00');
  const waterMiss = missed.find((entry) => entry.reminder.id === 'r-water');
  assert.equal(waterMiss.missedCount, 3);
  assert.equal(timesAt([{ at: waterMiss.at }])[0], '2026-01-05 12:00');
  assert.equal(missed[0].reminder.id, 'r-medicine');

  const skippedBySettings = findMissedReminders([water], {
    now,
    lastSeenAt: local(2026, 1, 5, 9, 30).getTime(),
    runtime: { reminderStates: { 'r-water': {} } },
    settings: { missedPolicy: 'skip' }
  });
  assert.deepEqual(skippedBySettings, []);

  const skippedToday = findMissedReminders([water], {
    now,
    lastSeenAt: local(2026, 1, 5, 9, 30).getTime(),
    runtime: { reminderStates: { 'r-water': { skippedOn: '2026-01-05' } } },
    settings: { missedPolicy: 'show' }
  });
  assert.deepEqual(skippedToday, []);

  const noDoubleCount = findMissedReminders([water], {
    now,
    lastSeenAt: local(2026, 1, 5, 10, 30).getTime(),
    runtime: {
      reminderStates: { 'r-water': { lastDueAt: local(2026, 1, 5, 10).toISOString() } }
    },
    settings: { missedPolicy: 'show' }
  });
  assert.equal(noDoubleCount[0].missedCount, 2);
  assert.equal(timesAt([{ at: noDoubleCount[0].at }])[0], '2026-01-05 12:00');

  const pendingSnooze = findMissedReminders([water], {
    now,
    lastSeenAt: local(2026, 1, 5, 9, 30).getTime(),
    runtime: {
      reminderStates: { 'r-water': { snoozeUntil: local(2026, 1, 5, 12).toISOString() } }
    },
    settings: { missedPolicy: 'show' }
  });
  assert.deepEqual(pendingSnooze, []);
});

test('missed catch-up is capped to the recent window', () => {
  const water = makeReminder({
    id: 'r-water',
    schedule: {
      kind: 'interval',
      intervalMinutes: 60,
      activeStart: '09:00',
      activeEnd: '21:00'
    }
  });
  const now = local(2026, 1, 15, 12);
  const missed = findMissedReminders([water], {
    now,
    lastSeenAt: local(2026, 1, 1, 9).getTime(),
    runtime: { reminderStates: { 'r-water': {} } },
    settings: { missedPolicy: 'show' }
  });
  assert.equal(missed.length, 1);
  assert.ok(now.getTime() - missed[0].at <= 7 * 86_400_000);
});

test('DST changes keep fixed local times and hourly slots unique', () => {
  const clock = createNewYorkClock(Date.UTC(2026, 2, 7, 12));
  const morning = {
    kind: 'times',
    times: ['08:00'],
    days: [...ALL_DAYS]
  };
  const from = clock.fromParts(2026, 2, 7, 0, 0);
  const to = clock.fromParts(2026, 2, 9, 0, 0);
  const entries = occurrencesBetween(morning, from, to, { clock });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => clock.parts(entry.at).hour), [8, 8]);
  assert.deepEqual(entries.map((entry) => clock.parts(entry.at).day), [7, 8]);
  assert.equal(entries[1].at - entries[0].at, 23 * 3_600_000);

  const next = nextOccurrence(morning, clock.fromParts(2026, 2, 7, 9), { clock });
  assert.equal(clock.parts(next.at).hour, 8);
  assert.equal(clock.parts(next.at).day, 8);
  assert.equal(clock.parts(next.at).offset, 240);

  const hourly = {
    kind: 'interval',
    intervalMinutes: 60,
    activeStart: '01:00',
    activeEnd: '06:00',
    days: [...ALL_DAYS]
  };
  const spring = occurrencesBetween(
    hourly,
    clock.fromParts(2026, 2, 8, 0),
    clock.fromParts(2026, 2, 8, 12),
    { clock }
  );
  assert.deepEqual(spring.map((entry) => clock.parts(entry.at).hour), [1, 3, 4, 5]);
  assert.equal(new Set(spring.map((entry) => entry.at)).size, spring.length);

  const fall = occurrencesBetween(
    { ...hourly, activeStart: '00:00', activeEnd: '03:00' },
    clock.fromParts(2026, 10, 1, 0) - 1,
    clock.fromParts(2026, 10, 1, 4),
    { clock }
  );
  assert.deepEqual(fall.map((entry) => clock.parts(entry.at).hour), [0, 1, 2]);
});

test('queue orders by time and priority with a gap and no duplicates', () => {
  let now = local(2026, 1, 5, 10).getTime();
  const queue = new ReminderQueue({ gapMs: 3_000, now: () => now });
  const highLater = makeReminder({ id: 'r-high', priority: 'high' });
  const normalLater = makeReminder({ id: 'r-normal', priority: 'normal', title: 'Normal' });
  const first = makeReminder({ id: 'r-first', priority: 'normal', title: 'First' });

  queue.enqueue(normalLater, { at: local(2026, 1, 5, 10, 5).getTime(), key: 'a' });
  queue.enqueue(highLater, { at: local(2026, 1, 5, 10, 5).getTime(), key: 'b' });
  queue.enqueue(first, { at: local(2026, 1, 5, 10).getTime(), key: 'c' });
  queue.enqueue(highLater, { at: local(2026, 1, 5, 10, 5).getTime(), key: 'd' });
  assert.equal(queue.size, 3);
  assert.deepEqual(queue.toArray().map((item) => item.reminderId), ['r-first', 'r-high', 'r-normal']);

  const shifted = queue.shift(now);
  assert.equal(shifted.reminderId, 'r-first');
  assert.equal(queue.shift(now), null);
  now += 3_000;
  assert.equal(queue.shift(now).reminderId, 'r-high');
  now += 1_000;
  assert.equal(queue.shift(now), null);
  now += 2_000;
  assert.equal(queue.shift(now).reminderId, 'r-normal');
  assert.equal(queue.shift(now), null);
});

test('queue puts missed catch-up reminders ahead of new prompts', () => {
  let now = local(2026, 1, 5, 10).getTime();
  const queue = new ReminderQueue({ gapMs: 0, now: () => now });
  const scheduled = makeReminder({ id: 'r-new', title: 'Now' });
  const missed = makeReminder({ id: 'r-missed', title: 'Missed' });
  queue.enqueue(scheduled, { at: now, key: 'new' });
  now += 1;
  queue.enqueue(missed, { at: local(2026, 1, 5, 8).getTime(), key: 'missed' }, {
    missed: true,
    missedCount: 2
  });
  assert.deepEqual(queue.toArray().map((item) => item.reminderId), ['r-missed', 'r-new']);
  assert.equal(queue.toArray()[0].missedCount, 2);
});

test('scheduler fires the earliest planned reminder through a single timer', () => {
  let nowMs = local(2026, 1, 5, 9).getTime();
  const clock = { ...systemClock, now: () => nowMs };
  const reminder = makeReminder({
    id: 'r-single',
    schedule: { kind: 'times', times: ['10:00'] }
  });
  const runtime = { reminderStates: { 'r-single': {} } };
  const fired = [];

  let nextId = 1;
  const timers = new Map();
  const scheduler = new ReminderScheduler({
    clock,
    maxWaitMs: 5 * 60_000,
    getState: () => ({
      reminders: [reminder],
      runtime,
      settings: {},
      pendingIds: [],
      appStartedAt: nowMs - 60_000
    }),
    onDue: ({ reminder: dueReminder, trigger }) => {
      fired.push({ id: dueReminder.id, at: trigger.at });
      runtime.reminderStates['r-single'].lastDueAt = new Date(trigger.at).toISOString();
    },
    setTimer: (callback, wait) => {
      const id = nextId++;
      timers.set(id, { callback, at: nowMs + wait });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    onError: (error) => { throw error; }
  });

  function advanceTo(target) {
    let guard = 0;
    while (guard < 1_000) {
      guard += 1;
      const candidates = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at);
      if (candidates.length === 0) break;
      const [id, timer] = candidates[0];
      timers.delete(id);
      nowMs = Math.max(nowMs, timer.at);
      timer.callback();
    }
    nowMs = Math.max(nowMs, target);
  }

  scheduler.start();
  assert.equal(scheduler.getNextAt(), local(2026, 1, 5, 10).getTime());
  advanceTo(local(2026, 1, 5, 10).getTime());
  scheduler.stop();

  assert.equal(fired.length, 1);
  assert.equal(fired[0].id, 'r-single');
  assert.equal(timesAt([{ at: fired[0].at }])[0], '2026-01-05 10:00');
});

test('scheduler waits for pending reminders and polls idle reminders', () => {
  let nowMs = local(2026, 1, 5, 9).getTime();
  const clock = { ...systemClock, now: () => nowMs };
  const idleReminder = makeReminder({
    id: 'r-idle',
    schedule: { kind: 'idle', idleMinutes: 30, activeStart: '09:00', activeEnd: '21:00' }
  });
  const pendingReminder = makeReminder({
    id: 'r-pending',
    schedule: { kind: 'times', times: ['09:30'] }
  });
  const state = {
    reminders: [idleReminder, pendingReminder],
    runtime: { reminderStates: { 'r-idle': {}, 'r-pending': {} } },
    settings: {},
    pendingIds: ['r-pending'],
    getIdleSeconds: () => 1_800
  };
  const fired = [];
  let nextId = 1;
  const timers = new Map();
  const scheduler = new ReminderScheduler({
    clock,
    maxWaitMs: 5 * 60_000,
    idlePollMs: 30_000,
    getState: () => state,
    onDue: ({ reminder, trigger }) => {
      fired.push({ id: reminder.id, reason: trigger.reason });
      if (reminder.id === 'r-idle') {
        state.runtime.reminderStates['r-idle'].lastIdleFiredAt = new Date(nowMs).toISOString();
      }
    },
    setTimer: (callback, wait) => {
      const id = nextId++;
      timers.set(id, { callback, at: nowMs + wait });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    onError: (error) => { throw error; }
  });

  function advanceTo(target) {
    let guard = 0;
    while (guard < 1_000) {
      guard += 1;
      const candidates = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at);
      if (candidates.length === 0) break;
      const [id, timer] = candidates[0];
      timers.delete(id);
      nowMs = Math.max(nowMs, timer.at);
      timer.callback();
    }
    nowMs = Math.max(nowMs, target);
  }

  scheduler.start();
  assert.deepEqual(scheduler.getPlan(), []);
  advanceTo(local(2026, 1, 5, 9, 1).getTime());
  scheduler.stop();

  assert.deepEqual(fired, [{ id: 'r-idle', reason: 'idle' }]);
});
