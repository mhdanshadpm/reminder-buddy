'use strict';

const {
  ALL_DAYS,
  ValidationError,
  formatClock,
  isPlainObject,
  parseClock,
  sortedUniqueDays
} = require('./common');
const {
  cloneGlobalMessages,
  normalizeGlobalMessages
} = require('./messages');

const THEMES = Object.freeze(['system', 'light', 'dark']);
const LANGUAGES = Object.freeze(['system', 'en', 'de', 'es', 'fr', 'pt', 'ja']);
const DISPLAY_TARGETS = Object.freeze(['cursor', 'primary', 'all']);
const MISSED_POLICIES = Object.freeze(['show', 'skip']);
const TIMEOUT_ACTIONS = Object.freeze(['negative', 'snooze', 'dismiss']);

const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  language: 'system',
  overlayEnabled: true,
  display: 'cursor',
  skipFullscreen: true,
  notifyFallback: true,
  missedPolicy: 'show',
  soundEnabled: true,
  soundVolume: 60,
  defaultTimeoutSeconds: 60,
  defaultTimeoutAction: 'negative',
  startMinimized: true,
  quickAddShortcut: 'CommandOrControl+Alt+R',
  defaultCharacterId: 'buddy',
  defaultCharacterScale: 100,
  randomCharacter: false,
  messages: cloneGlobalMessages(),
  dnd: {
    enabled: false,
    start: '22:00',
    end: '07:00',
    days: [...ALL_DAYS]
  },
  syncFolder: ''
});

function cloneDefaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    messages: cloneGlobalMessages(DEFAULT_SETTINGS.messages),
    dnd: { ...DEFAULT_SETTINGS.dnd, days: [...DEFAULT_SETTINGS.dnd.days] }
  };
}

function isValidCharacterId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 80
    && value.trim() === value
    && !value.startsWith('.')
    && !/[/\\\u0000-\u001f]/.test(value);
}

function isValidShortcut(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > 64) return false;
  if (!/^[A-Za-z0-9+_-]+$/.test(value)) return false;
  return value.includes('+');
}

function normalizeDnd(raw, target, errors) {
  if (!isPlainObject(raw)) {
    errors.push('Do Not Disturb settings must be an object.');
    return;
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') target.enabled = raw.enabled;
    else errors.push('Do Not Disturb must be on or off.');
  }

  const startMinutes = raw.start === undefined ? parseClock(target.start) : parseClock(raw.start);
  const endMinutes = raw.end === undefined ? parseClock(target.end) : parseClock(raw.end);
  if (startMinutes === null) errors.push('Do Not Disturb start time is invalid.');
  if (endMinutes === null) errors.push('Do Not Disturb end time is invalid.');
  if (startMinutes !== null && endMinutes !== null) {
    if (startMinutes === endMinutes) {
      errors.push('Do Not Disturb start and end times must be different.');
    } else {
      target.start = raw.start ?? target.start;
      target.end = raw.end ?? target.end;
    }
  }

  if (raw.days !== undefined) {
    const days = sortedUniqueDays(raw.days);
    if (!days) errors.push('Choose at least one Do Not Disturb day.');
    else target.days = days;
  }
}

function normalizeSettings(raw, { strict = true } = {}) {
  const errors = [];
  const settings = cloneDefaultSettings();
  if (raw === undefined || raw === null) {
    if (strict && raw === undefined) return settings;
    return settings;
  }
  if (!isPlainObject(raw)) {
    const message = 'Settings payload is invalid.';
    if (strict) throw new ValidationError([message]);
    return settings;
  }

  if (raw.theme !== undefined) {
    if (THEMES.includes(raw.theme)) settings.theme = raw.theme;
    else errors.push('Theme must be system, light, or dark.');
  }

  if (raw.language !== undefined) {
    if (LANGUAGES.includes(raw.language)) settings.language = raw.language;
    else errors.push('Language selection is invalid.');
  }

  if (raw.overlayEnabled !== undefined) {
    if (typeof raw.overlayEnabled === 'boolean') settings.overlayEnabled = raw.overlayEnabled;
    else errors.push('Overlay setting must be on or off.');
  }

  if (raw.display !== undefined) {
    if (DISPLAY_TARGETS.includes(raw.display)) settings.display = raw.display;
    else errors.push('Display selection is invalid.');
  }

  const booleans = [
    ['skipFullscreen', 'Skip fullscreen setting must be on or off.'],
    ['notifyFallback', 'Notification fallback setting must be on or off.'],
    ['soundEnabled', 'Sound setting must be on or off.'],
    ['startMinimized', 'Start minimized setting must be on or off.'],
    ['randomCharacter', 'Random character setting must be on or off.']
  ];
  for (const [key, message] of booleans) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === 'boolean') settings[key] = raw[key];
    else errors.push(message);
  }

  if (raw.missedPolicy !== undefined) {
    if (MISSED_POLICIES.includes(raw.missedPolicy)) settings.missedPolicy = raw.missedPolicy;
    else errors.push('Missed reminder policy is invalid.');
  }

  if (raw.soundVolume !== undefined) {
    if (Number.isInteger(raw.soundVolume) && raw.soundVolume >= 0 && raw.soundVolume <= 100) {
      settings.soundVolume = raw.soundVolume;
    } else {
      errors.push('Sound volume must be between 0 and 100.');
    }
  }

  if (raw.defaultTimeoutSeconds !== undefined) {
    if (Number.isInteger(raw.defaultTimeoutSeconds)
      && raw.defaultTimeoutSeconds >= 10
      && raw.defaultTimeoutSeconds <= 600) {
      settings.defaultTimeoutSeconds = raw.defaultTimeoutSeconds;
    } else {
      errors.push('Prompt timeout must be between 10 and 600 seconds.');
    }
  }

  if (raw.defaultTimeoutAction !== undefined) {
    if (TIMEOUT_ACTIONS.includes(raw.defaultTimeoutAction)) {
      settings.defaultTimeoutAction = raw.defaultTimeoutAction;
    } else {
      errors.push('Timeout action is invalid.');
    }
  }

  if (raw.quickAddShortcut !== undefined) {
    if (isValidShortcut(raw.quickAddShortcut)) settings.quickAddShortcut = raw.quickAddShortcut;
    else errors.push('Quick add shortcut is invalid.');
  }

  if (raw.defaultCharacterId !== undefined) {
    if (isValidCharacterId(raw.defaultCharacterId)) settings.defaultCharacterId = raw.defaultCharacterId;
    else errors.push('Default character selection is invalid.');
  }

  if (raw.defaultCharacterScale !== undefined) {
    if (Number.isInteger(raw.defaultCharacterScale)
      && raw.defaultCharacterScale >= 50
      && raw.defaultCharacterScale <= 200) {
      settings.defaultCharacterScale = raw.defaultCharacterScale;
    } else {
      errors.push('Default character size must be between 50 and 200 percent.');
    }
  }

  if (raw.syncFolder !== undefined) {
    if (typeof raw.syncFolder === 'string' && raw.syncFolder.length <= 500 && !/[\u0000-\u001f]/.test(raw.syncFolder)) {
      settings.syncFolder = raw.syncFolder.trim();
    } else {
      errors.push('Sync folder path is invalid.');
    }
  }

  if (raw.dnd !== undefined) {
    normalizeDnd(raw.dnd, settings.dnd, errors);
  }

  if (raw.messages !== undefined) {
    try {
      const normalized = normalizeGlobalMessages(raw.messages, { strict });
      settings.messages = normalized.messages;
      errors.push(...normalized.errors);
    } catch (error) {
      errors.push(...(error.errors || [error.message]));
    }
  }

  if (strict && errors.length > 0) throw new ValidationError(errors);
  return settings;
}

function dndWindowFor(date, dnd) {
  if (!dnd?.enabled || !Array.isArray(dnd.days) || dnd.days.length === 0) return null;
  const startMinutes = parseClock(dnd.start);
  const endMinutes = parseClock(dnd.end);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return null;
  const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const candidates = [today, new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1)];
  for (const day of candidates) {
    if (!dnd.days.includes(day.getDay())) continue;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(startMinutes / 60), startMinutes % 60);
    const endDay = endMinutes > startMinutes
      ? day
      : new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    const end = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate(), Math.floor(endMinutes / 60), endMinutes % 60);
    if (date >= start && date < end) return { start, end };
  }
  return null;
}

function isDndActive(dnd, now = new Date()) {
  return dndWindowFor(now, dnd) !== null;
}

function formatDndSummary(dnd) {
  if (!dnd?.enabled) return 'Off';
  const days = Array.isArray(dnd.days) ? dnd.days : [];
  let dayLabel = 'Every day';
  if (days.length === 5 && days.every((day) => day >= 1 && day <= 5)) dayLabel = 'Weekdays';
  else if (days.length === 2 && days.includes(0) && days.includes(6)) dayLabel = 'Weekends';
  else if (days.length !== 7) {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    dayLabel = [...days].sort().map((day) => names[day]).join(', ');
  }
  return `${dayLabel} · ${formatClock(parseClock(dnd.start))}–${formatClock(parseClock(dnd.end))}`;
}

module.exports = {
  DEFAULT_SETTINGS,
  DISPLAY_TARGETS,
  LANGUAGES,
  MISSED_POLICIES,
  THEMES,
  TIMEOUT_ACTIONS,
  cloneDefaultSettings,
  dndWindowFor,
  formatDndSummary,
  isDndActive,
  isValidCharacterId,
  isValidShortcut,
  normalizeSettings
};
