'use strict';

const {
  createId,
  dateKey,
  isPlainObject
} = require('./common');

const OUTCOMES = Object.freeze(['done', 'skipped', 'snoozed', 'ignored', 'missed']);
const HISTORY_RETENTION_DAYS = 366;
const MAX_EVENTS = 50_000;
const MAX_TITLE_LENGTH = 100;

function safeText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function sanitizeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function sanitizeEvent(raw) {
  if (!isPlainObject(raw)) return null;
  if (!OUTCOMES.includes(raw.outcome)) return null;
  const at = sanitizeTimestamp(raw.at);
  if (!at) return null;
  const reminderId = safeText(raw.reminderId, 80);
  if (!reminderId) return null;

  const event = {
    id: typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(raw.id) ? raw.id : createId('h'),
    reminderId,
    reminderTitle: safeText(raw.reminderTitle, MAX_TITLE_LENGTH) || 'Reminder',
    outcome: raw.outcome,
    at
  };

  const icon = safeText(raw.icon, 16);
  if (icon) event.icon = icon;
  const dueAt = sanitizeTimestamp(raw.dueAt);
  if (dueAt) event.dueAt = dueAt;
  if (typeof raw.source === 'string' && /^[a-z][a-z-]{0,30}$/.test(raw.source)) event.source = raw.source;
  if (typeof raw.answerId === 'string' && raw.answerId.length <= 40) event.answerId = raw.answerId;
  const answerLabel = safeText(raw.answerLabel, 40);
  if (answerLabel) event.answerLabel = answerLabel;
  if (raw.late === true) event.late = true;
  if (Number.isInteger(raw.snoozeMinutes) && raw.snoozeMinutes >= 0 && raw.snoozeMinutes <= 1440) {
    event.snoozeMinutes = raw.snoozeMinutes;
  }
  return event;
}

function pruneEvents(events, now = new Date(), retentionDays = HISTORY_RETENTION_DAYS) {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - retentionDays + 1, 0, 0, 0, 0);
  return events.filter((event) => new Date(event.at).getTime() >= cutoff.getTime());
}

function sanitizeHistory(raw, { now = new Date() } = {}) {
  const source = Array.isArray(raw) ? raw : (Array.isArray(raw?.events) ? raw.events : []);
  const events = source.map(sanitizeEvent).filter(Boolean);
  const seen = new Set();
  const deduped = [];
  for (const event of events) {
    if (seen.has(event.id)) event.id = createId('h');
    seen.add(event.id);
    deduped.push(event);
  }
  deduped.sort((left, right) => new Date(left.at) - new Date(right.at));
  const pruned = pruneEvents(deduped, now);
  return pruned.slice(-MAX_EVENTS);
}

function appendEvent(events, raw, now = new Date()) {
  const event = sanitizeEvent({ id: createId('h'), ...raw });
  if (!event) return events;
  const next = [...events, event].sort((left, right) => new Date(left.at) - new Date(right.at));
  return pruneEvents(next, now).slice(-MAX_EVENTS);
}

function eventsForDay(events, day = new Date()) {
  const key = dateKey(day);
  return events.filter((event) => dateKey(new Date(event.at)) === key);
}

function countOutcomes(events) {
  const counts = { done: 0, skipped: 0, snoozed: 0, ignored: 0, missed: 0, total: 0 };
  for (const event of events) {
    if (counts[event.outcome] !== undefined) counts[event.outcome] += 1;
    counts.total += 1;
  }
  return counts;
}

function summarizeDays(events, days = 7, now = new Date(), reminderId = null) {
  const filtered = reminderId
    ? events.filter((event) => event.reminderId === reminderId)
    : events;
  const summary = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, 12);
    const dayEvents = eventsForDay(filtered, day);
    summary.push({
      dateKey: dateKey(day),
      isToday: offset === 0,
      ...countOutcomes(dayEvents)
    });
  }
  return summary;
}

function doneDayKeys(events, reminderId) {
  const keys = new Set();
  for (const event of events) {
    if (event.outcome !== 'done') continue;
    if (reminderId && event.reminderId !== reminderId) continue;
    keys.add(dateKey(new Date(event.at)));
  }
  return keys;
}

function streakForReminder(events, reminderId, now = new Date()) {
  const keys = doneDayKeys(events, reminderId);
  if (keys.size === 0) return 0;
  let cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  if (!keys.has(dateKey(cursor))) {
    cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
    if (!keys.has(dateKey(cursor))) return 0;
  }
  let streak = 0;
  while (keys.has(dateKey(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1, 12);
  }
  return streak;
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function eventsToCsv(events) {
  const header = ['Reminder', 'Outcome', 'At', 'Due at', 'Source', 'Late', 'Answer', 'Snooze minutes', 'Icon'];
  const lines = [header.join(',')];
  for (const event of events) {
    lines.push([
      event.reminderTitle,
      event.outcome,
      event.at,
      event.dueAt || '',
      event.source || '',
      event.late ? 'yes' : 'no',
      event.answerLabel || '',
      event.snoozeMinutes ?? '',
      event.icon || ''
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function historyFilePayload(events) {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    events
  };
}

module.exports = {
  HISTORY_RETENTION_DAYS,
  MAX_EVENTS,
  OUTCOMES,
  appendEvent,
  countOutcomes,
  eventsForDay,
  eventsToCsv,
  historyFilePayload,
  pruneEvents,
  sanitizeEvent,
  sanitizeHistory,
  streakForReminder,
  summarizeDays
};
