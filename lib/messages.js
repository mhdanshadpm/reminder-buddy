'use strict';

const { isPlainObject } = require('./common');

const MESSAGE_KEYS = Object.freeze([
  'question',
  'positive',
  'negative',
  'neutral',
  'snooze',
  'skipped',
  'pomodoroFocus',
  'pomodoroBreak'
]);

const GLOBAL_MESSAGE_KEYS = Object.freeze(['positive', 'negative', 'neutral', 'snooze', 'skipped']);

const DEFAULT_GLOBAL_MESSAGES = Object.freeze({
  positive: Object.freeze(['Nice work.', 'Logged. Thank you!']),
  negative: Object.freeze(['Maybe next time.']),
  neutral: Object.freeze(['Noted.']),
  snooze: Object.freeze(["Okay — I'll be back in {snooze} minutes."]),
  skipped: Object.freeze(['Skipped until tomorrow.'])
});

const MAX_VARIATIONS = 8;
const MAX_MESSAGE_LENGTH = 600;

function cloneGlobalMessages(source = DEFAULT_GLOBAL_MESSAGES) {
  const result = {};
  for (const key of GLOBAL_MESSAGE_KEYS) {
    result[key] = Array.isArray(source?.[key]) ? source[key].map((value) => String(value)) : [...DEFAULT_GLOBAL_MESSAGES[key]];
  }
  return result;
}

function normalizeVariations(raw, { max = MAX_VARIATIONS, maxLength = MAX_MESSAGE_LENGTH } = {}) {
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  const result = [];
  for (const value of list) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const clipped = trimmed.slice(0, maxLength);
    if (!result.includes(clipped)) result.push(clipped);
    if (result.length >= max) break;
  }
  return result;
}

function normalizeMessages(raw, { strict = false } = {}) {
  const errors = [];
  const source = isPlainObject(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    errors.push('Messages must be an object.');
  }

  const messages = {};
  for (const key of MESSAGE_KEYS) {
    messages[key] = normalizeVariations(source[key]);
  }

  if (strict && errors.length > 0) {
    const error = new Error(errors[0]);
    error.errors = errors;
    error.name = 'ValidationError';
    throw error;
  }
  return { messages, errors };
}

function normalizeGlobalMessages(raw, { strict = false } = {}) {
  const result = cloneGlobalMessages();
  const errors = [];
  if (raw === undefined || raw === null) return { messages: result, errors };
  if (!isPlainObject(raw)) {
    const message = 'Default messages must be an object.';
    if (strict) {
      const error = new Error(message);
      error.errors = [message];
      error.name = 'ValidationError';
      throw error;
    }
    return { messages: result, errors: [message] };
  }

  for (const key of GLOBAL_MESSAGE_KEYS) {
    if (raw[key] === undefined) continue;
    const variations = normalizeVariations(raw[key]);
    if (variations.length === 0) {
      errors.push(`Default ${key} message must contain at least one line of text.`);
      continue;
    }
    result[key] = variations;
  }

  if (strict && errors.length > 0) {
    const error = new Error(errors[0]);
    error.errors = errors;
    error.name = 'ValidationError';
    throw error;
  }
  return { messages: result, errors };
}

function resolveMessages(reminderMessages, globalMessages) {
  const reminder = isPlainObject(reminderMessages) ? reminderMessages : {};
  const globals = cloneGlobalMessages(globalMessages);
  const resolved = {};
  for (const key of MESSAGE_KEYS) {
    const own = normalizeVariations(reminder[key]);
    const fallback = GLOBAL_MESSAGE_KEYS.includes(key) ? globals[key] : [];
    resolved[key] = own.length > 0 ? own : [...fallback];
  }
  return resolved;
}

function weekdayName(date) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date);
}

function longDate(date) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(date);
}

function shortTime(date) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function messageContext(reminder, now = new Date(), extra = {}) {
  return {
    title: reminder?.title || '',
    note: reminder?.notes || '',
    date: longDate(now),
    weekday: weekdayName(now),
    time: shortTime(now),
    snooze: extra.snoozeMinutes ?? reminder?.snooze?.minutes ?? 10,
    count: extra.count ?? 0,
    ...extra
  };
}

function renderMessage(template, context = {}) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{([a-zA-Z]+)\}/g, (match, key) => {
    if (!(key in context)) return match;
    const value = context[key];
    if (value === null || value === undefined) return '';
    return String(value);
  });
}

function pickVariation(list, random = Math.random) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const index = Math.min(list.length - 1, Math.max(0, Math.floor(random() * list.length)));
  return list[index];
}

function renderVariation(list, context, random = Math.random) {
  return renderMessage(pickVariation(list, random), context);
}

function renderQuestion(reminder, resolvedMessages, context) {
  if (resolvedMessages.question.length > 0) {
    const rendered = renderVariation(resolvedMessages.question, context);
    if (rendered.trim()) return rendered;
  }
  return reminder?.title || 'Reminder';
}

function messagePreviewLines(messages) {
  const preview = {};
  for (const key of MESSAGE_KEYS) {
    preview[key] = Array.isArray(messages?.[key]) ? [...messages[key]] : [];
  }
  return preview;
}

module.exports = {
  DEFAULT_GLOBAL_MESSAGES,
  GLOBAL_MESSAGE_KEYS,
  MAX_MESSAGE_LENGTH,
  MAX_VARIATIONS,
  MESSAGE_KEYS,
  cloneGlobalMessages,
  longDate,
  messageContext,
  messagePreviewLines,
  normalizeGlobalMessages,
  normalizeMessages,
  normalizeVariations,
  pickVariation,
  renderMessage,
  renderQuestion,
  renderVariation,
  resolveMessages,
  shortTime,
  weekdayName
};
