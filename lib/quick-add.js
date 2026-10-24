'use strict';

const {
  ALL_DAYS,
  dateKey,
  localDateTimeString,
  pad2,
  parseClock,
  parseLocalDateTime
} = require('./common');
const {
  normalizeReminder,
  scheduleSummary
} = require('./reminders');

const WEEKDAY_NAMES = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
});

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseTimeToken(raw) {
  const token = String(raw || '').trim().toLocaleLowerCase().replace(/\./g, '');
  if (!token) return null;
  if (token === 'noon') return 12 * 60;
  if (token === 'midnight') return 0;

  const match = /^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/.exec(token);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = match[3];
  if (!meridiem && match[2] === undefined && hours < 13) {
    // A bare hour is ambiguous; only accept 0–23 when it cannot be a date.
    if (hours > 23) return null;
  }
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours %= 12;
    if (meridiem === 'pm') hours += 12;
  } else if (hours > 23) {
    return null;
  }
  return hours * 60 + minutes;
}

const TIME_TOKEN = String.raw`(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:am|pm)?|(?:0?\d|1[0-2])\s*(?:am|pm)\.?|noon|midnight`;
const LEADING_TIME_RE = new RegExp(`^(?:at\\s+)?(${TIME_TOKEN})\\b\\s*[,:-]?\\s*`, 'i');

function parseLeadingTime(text) {
  const match = LEADING_TIME_RE.exec(text);
  if (!match) return null;
  const minutes = parseTimeToken(match[1]);
  if (minutes === null) return null;
  return { minutes, rest: text.slice(match[0].length) };
}

function atTimeOn(baseDate, minutes) {
  return new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate(),
    Math.floor(minutes / 60),
    minutes % 60,
    0,
    0
  );
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function cleanTitle(value) {
  return normalizeSpaces(value)
    .replace(/^[,;:\-–—\s]+/, '')
    .replace(/[,;:\-–—\s]+$/, '')
    .replace(/^(?:to|please)\s+/i, '')
    .trim();
}

function titleCaseFirst(value) {
  if (!value) return value;
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

function nextDailyOccurrence(now, minutes) {
  const candidate = atTimeOn(now, minutes);
  if (candidate.getTime() <= now.getTime() + 1000) return atTimeOn(addDays(now, 1), minutes);
  return candidate;
}

function nextWeeklyOccurrence(now, weekday, minutes) {
  const current = now.getDay();
  let offset = (weekday - current + 7) % 7;
  let candidate = atTimeOn(addDays(now, offset), minutes);
  if (candidate.getTime() <= now.getTime() + 1000) {
    offset += 7;
    candidate = atTimeOn(addDays(now, offset), minutes);
  }
  return candidate;
}

function finish(parsed, rawTitle) {
  const title = cleanTitle(rawTitle);
  if (!title) return { ok: false, error: 'Add a short title after the time, for example “tomorrow 9am pay rent”.' };
  return {
    ok: true,
    title: titleCaseFirst(title.slice(0, 100)),
    schedule: parsed.schedule,
    description: scheduleSummary({ schedule: parsed.schedule }),
    matched: parsed.matched
  };
}

function parseQuickAdd(input, { now = new Date() } = {}) {
  const text = normalizeSpaces(input);
  if (!text) return { ok: false, error: 'Type a reminder, for example “in 30 min call mom”.' };
  if (text.length > 240) return { ok: false, error: 'Quick add text is too long.' };

  let match;

  match = /^in\s+(\d{1,4})\s*(minutes?|mins?|m|hours?|hrs?|h)\b\s*[,:-]?\s*(.*)$/i.exec(text);
  if (match) {
    const amount = Number(match[1]);
    const unit = /^h/i.test(match[2]) ? 60 : 1;
    if (!Number.isInteger(amount) || amount <= 0 || amount * unit > 10080) {
      return { ok: false, error: 'Use a delay between 1 minute and 7 days.' };
    }
    const at = new Date(now.getTime() + amount * unit * 60_000);
    return finish({
      schedule: { kind: 'once', onceAt: localDateTimeString(at) },
      matched: match[2]
    }, match[3]);
  }

  match = /^(tomorrow|today|tonight)\b\s*[,:-]?\s*(.*)$/i.exec(text);
  if (match) {
    const word = match[1].toLocaleLowerCase();
    let rest = match[2];
    let minutes = word === 'tonight' ? 20 * 60 : 9 * 60;
    const time = parseLeadingTime(rest);
    if (time) {
      minutes = time.minutes;
      rest = time.rest;
    }
    let base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (word === 'tomorrow') base = addDays(base, 1);
    if (word !== 'tomorrow') {
      const candidate = atTimeOn(base, minutes);
      if (candidate.getTime() <= now.getTime() + 1000) base = addDays(base, 1);
    }
    return finish({
      schedule: { kind: 'once', onceAt: localDateTimeString(atTimeOn(base, minutes)) },
      matched: word
    }, rest);
  }

  match = /^(?:on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b\s*[,:-]?\s*(.*)$/i.exec(text);
  if (match) {
    const weekday = WEEKDAY_NAMES[match[1].toLocaleLowerCase()];
    let rest = match[2];
    let minutes = 9 * 60;
    const time = parseLeadingTime(rest);
    if (time) {
      minutes = time.minutes;
      rest = time.rest;
    }
    const at = nextWeeklyOccurrence(now, weekday, minutes);
    return finish({
      schedule: { kind: 'once', onceAt: localDateTimeString(at), days: [weekday] },
      matched: match[1]
    }, rest);
  }

  match = /^on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b\s*[,:-]?\s*(.*)$/i.exec(text);
  if (match) {
    const day = Number(match[1]);
    if (day < 1 || day > 31) return { ok: false, error: 'Choose a monthly day between 1 and 31.' };
    let rest = match[2];
    let minutes = 9 * 60;
    const time = parseLeadingTime(rest);
    if (time) {
      minutes = time.minutes;
      rest = time.rest;
    }
    const timeLabel = `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
    return finish({
      schedule: { kind: 'monthly', monthlyDay: day, times: [timeLabel] },
      matched: match[1]
    }, rest);
  }

  match = /^on\s+(\d{4}-\d{2}-\d{2})\b\s*[,:-]?\s*(.*)$/i.exec(text);
  if (match) {
    const day = match[1];
    let rest = match[2];
    let minutes = 9 * 60;
    const time = parseLeadingTime(rest);
    if (time) {
      minutes = time.minutes;
      rest = time.rest;
    }
    const at = parseLocalDateTime(`${day}T${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`);
    if (!at) return { ok: false, error: 'That date is not valid.' };
    return finish({
      schedule: { kind: 'once', onceAt: localDateTimeString(at) },
      matched: day
    }, rest);
  }

  match = /^every\s+(day|weekday|weekdays|weekend|weekends)\b\s*[,:-]?\s*(.*)$/i.exec(text);
  if (match) {
    const word = match[1].toLocaleLowerCase();
    let rest = match[2];
    let minutes = 9 * 60;
    const time = parseLeadingTime(rest);
    if (time) {
      minutes = time.minutes;
      rest = time.rest;
    }
    const days = word === 'day'
      ? [...ALL_DAYS]
      : (word.startsWith('weekend') ? [0, 6] : [1, 2, 3, 4, 5]);
    return finish({
      schedule: {
        kind: 'times',
        times: [`${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`],
        days
      },
      matched: word
    }, rest);
  }

  match = /^every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b\s*[,:-]?\s*(.*)$/i.exec(text);
  if (match) {
    const weekday = WEEKDAY_NAMES[match[1].toLocaleLowerCase()];
    let rest = match[2];
    let minutes = 9 * 60;
    const time = parseLeadingTime(rest);
    if (time) {
      minutes = time.minutes;
      rest = time.rest;
    }
    return finish({
      schedule: {
        kind: 'times',
        times: [`${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`],
        days: [weekday]
      },
      matched: match[1]
    }, rest);
  }

  match = /^every\s+(\d{1,4})\s*(minutes?|mins?|m|hours?|hrs?|h)\b\s*[,:-]?\s*(.*)$/i.exec(text);
  if (match) {
    const amount = Number(match[1]);
    const unit = /^h/i.test(match[2]) ? 60 : 1;
    const minutes = amount * unit;
    if (!Number.isInteger(amount) || minutes < 5 || minutes > 10080) {
      return { ok: false, error: 'Interval reminders must be between 5 minutes and 7 days.' };
    }
    return finish({
      schedule: {
        kind: 'interval',
        intervalMinutes: minutes,
        activeStart: '00:00',
        activeEnd: '23:59',
        days: [...ALL_DAYS]
      },
      matched: match[2]
    }, match[3]);
  }

  const leadingTime = parseLeadingTime(text);
  if (leadingTime) {
    const at = nextDailyOccurrence(now, leadingTime.minutes);
    return finish({
      schedule: { kind: 'once', onceAt: localDateTimeString(at) },
      matched: 'time'
    }, leadingTime.rest);
  }

  match = new RegExp(`\\s+at\\s+(${TIME_TOKEN})\\s*$`, 'i').exec(text);
  if (match) {
    const minutes = parseTimeToken(match[1]);
    if (minutes !== null) {
      const at = nextDailyOccurrence(now, minutes);
      return finish({
        schedule: { kind: 'once', onceAt: localDateTimeString(at) },
        matched: 'time'
      }, text.slice(0, match.index));
    }
  }

  return {
    ok: false,
    error: 'I could not find a time. Try “in 30 min call mom” or “tomorrow 9am pay rent”.'
  };
}

function createQuickAddReminder(input, { now = new Date() } = {}) {
  const parsed = parseQuickAdd(input, { now });
  if (!parsed.ok) return parsed;
  const reminder = normalizeReminder({
    title: parsed.title,
    icon: '⏰',
    color: '#17a9df',
    category: 'Quick',
    type: 'confirm',
    messages: {
      question: [parsed.title],
      positive: ['Done. Nice one.'],
      negative: ['Noted.']
    },
    schedule: parsed.schedule,
    tracking: { log: true, dailyGoal: null },
    priority: 'normal',
    templateId: null
  }, { strict: true, now });
  return { ...parsed, reminder };
}

module.exports = {
  WEEKDAY_NAMES,
  createQuickAddReminder,
  parseQuickAdd,
  parseTimeToken
};
