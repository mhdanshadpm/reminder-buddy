'use strict';

const {
  ALL_DAYS,
  ValidationError,
  createId,
  dateKey,
  isValidIdentifier,
  isPlainObject,
  localDateTimeString,
  parseClock,
  parseDateKey,
  parseLocalDateTime,
  sortedUniqueDays
} = require('./common');
const { normalizeMessages } = require('./messages');

const TYPES = Object.freeze(['yesno', 'confirm', 'choice', 'timer', 'note']);
const PRIORITIES = Object.freeze(['normal', 'high']);
const BUTTON_ACTIONS = Object.freeze(['positive', 'negative', 'neutral', 'snooze', 'skip']);
const REACTIONS = Object.freeze(['positive', 'negative', 'neutral', 'snooze', 'skip']);
const SCHEDULE_KINDS = Object.freeze(['interval', 'times', 'monthly', 'once', 'startup', 'idle', 'pomodoro']);
const CHARACTER_MODES = Object.freeze(['default', 'specific', 'random']);
const SOUND_MODES = Object.freeze(['default', 'chime', 'none', 'custom']);
const SPECIAL_ANIMATIONS = Object.freeze(['none', 'drinking', 'exercise']);
const MISSED_POLICIES = Object.freeze(['inherit', 'show', 'skip']);
const ESCALATIONS = Object.freeze(['none', 'frequent', 'bigger']);
const TIMEOUT_ACTIONS = Object.freeze(['negative', 'snooze', 'dismiss']);

const MAX_REMINDERS = 500;
const MAX_TITLE_LENGTH = 100;
const MAX_NOTE_LENGTH = 1000;
const MAX_BUTTONS = 4;
const MAX_TIMES = 12;

const DEFAULT_BUTTONS = Object.freeze({
  yesno: Object.freeze([
    Object.freeze({ id: 'yes', label: 'Yes', action: 'positive' }),
    Object.freeze({ id: 'no', label: 'No', action: 'negative' })
  ]),
  confirm: Object.freeze([
    Object.freeze({ id: 'done', label: 'Done', action: 'positive' }),
    Object.freeze({ id: 'later', label: 'Later', action: 'snooze' })
  ]),
  timer: Object.freeze([
    Object.freeze({ id: 'done', label: 'Done', action: 'positive' }),
    Object.freeze({ id: 'snooze', label: 'Snooze', action: 'snooze' })
  ]),
  choice: Object.freeze([]),
  note: Object.freeze([])
});

const TEMPLATE_META = Object.freeze([
  { id: 'water', name: 'Drink water', icon: '💧', color: '#17a9df', category: 'Health', description: 'A gentle sip reminder with a daily glass goal.' },
  { id: 'medicine', name: 'Take medicine', icon: '💊', color: '#7c6cf0', category: 'Health', description: 'Twice-daily high-priority dose check.' },
  { id: 'stretch', name: 'Stretch / stand up', icon: '🧘', color: '#f59f4b', category: 'Wellness', description: 'A movement break every 90 minutes.' },
  { id: 'eye-rest', name: '20-20-20 eye rest', icon: '👀', color: '#4cc9a7', category: 'Wellness', description: 'Look away every 20 minutes, auto-dismissing.' },
  { id: 'posture', name: 'Check posture', icon: '🧍', color: '#70b7ff', category: 'Wellness', description: 'A quick posture reset during work.' },
  { id: 'meal', name: 'Eat meal / snack', icon: '🍎', color: '#ff8a80', category: 'Meals', description: 'Breakfast, lunch, and dinner prompts.' },
  { id: 'walk', name: 'Walk', icon: '🚶', color: '#37b37a', category: 'Health', description: 'Two short walks a day.' },
  { id: 'break', name: 'Take a break', icon: '☕', color: '#c98b62', category: 'Wellness', description: 'Step away from the screen each hour.' },
  { id: 'sleep', name: 'Go to sleep', icon: '🌙', color: '#5b6cff', category: 'Health', description: 'A nightly wind-down reminder.' },
  { id: 'pomodoro', name: 'Study / focus session', icon: '📚', color: '#df74d4', category: 'Focus', description: 'Pomodoro rhythm: 25 minutes focus, 5 minutes break.' },
  { id: 'bills', name: 'Pay bills / rent', icon: '🧾', color: '#b0894e', category: 'Home', description: 'A high-priority monthly payment reminder.' },
  { id: 'birthday', name: 'Birthday / anniversary', icon: '🎂', color: '#f472b6', category: 'Personal', description: 'A yearly celebration reminder.' },
  { id: 'custom', name: 'Custom reminder', icon: '🔔', color: '#17a9df', category: 'Custom', description: 'Start from a blank, fully editable reminder.' }
]);

function defaultSchedule(kind = 'interval') {
  return {
    kind,
    intervalMinutes: 60,
    times: ['09:00'],
    monthlyDay: 1,
    onceAt: '',
    repeatYearly: false,
    startupDelayMinutes: 5,
    idleMinutes: 30,
    focusMinutes: 25,
    breakMinutes: 5,
    activeStart: '09:00',
    activeEnd: '21:00',
    days: [...ALL_DAYS],
    startDate: null,
    endDate: null,
    skipPaused: true,
    skipDnd: true,
    skipLocked: true,
    missedPolicy: 'inherit'
  };
}

function defaultCharacter() {
  return {
    mode: 'default',
    id: '',
    scale: 100,
    sound: 'default',
    soundFile: ''
  };
}

function defaultSnooze() {
  return { minutes: 10, max: 3, escalate: 'none' };
}

function defaultTracking() {
  return { log: true, dailyGoal: null };
}

function cloneButtons(type) {
  return (DEFAULT_BUTTONS[type] || []).map((button) => ({ ...button }));
}

function baseReminder(now = new Date()) {
  const stamp = now.toISOString();
  return {
    id: createId('r'),
    title: 'Reminder',
    icon: '🔔',
    color: '#17a9df',
    category: 'Custom',
    enabled: true,
    type: 'yesno',
    messages: {
      question: [],
      positive: [],
      negative: [],
      neutral: [],
      snooze: [],
      skipped: [],
      pomodoroFocus: [],
      pomodoroBreak: []
    },
    buttons: cloneButtons('yesno'),
    character: defaultCharacter(),
    schedule: defaultSchedule(),
    snooze: defaultSnooze(),
    tracking: defaultTracking(),
    priority: 'normal',
    notes: '',
    specialAnimation: 'none',
    timeoutAction: 'negative',
    timerMinutes: 10,
    autoDismissSeconds: 10,
    templateId: null,
    createdAt: stamp,
    updatedAt: stamp
  };
}

function normalizedTimes(raw, fallback, errors, { minCount = 1, maxCount = MAX_TIMES, label = 'time' } = {}) {
  const source = raw === undefined ? fallback : raw;
  if (!Array.isArray(source) || source.length < minCount || source.length > maxCount) {
    errors.push(`Choose between ${minCount} and ${maxCount} ${label}${maxCount === 1 ? '' : 's'}.`);
    return [...fallback];
  }
  const result = [];
  for (const value of source) {
    if (parseClock(value) === null) {
      errors.push(`The ${label} “${value}” is invalid. Use 24-hour HH:MM.`);
      continue;
    }
    if (!result.includes(value)) result.push(value);
  }
  if (result.length < minCount) {
    return [...fallback];
  }
  return result.sort((left, right) => parseClock(left) - parseClock(right));
}

function normalizeSchedule(raw, { strict = false } = {}) {
  const errors = [];
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    errors.push('Schedule must be an object.');
    if (strict) throw new ValidationError(errors);
    return { schedule: defaultSchedule(), errors };
  }
  const source = isPlainObject(raw) ? raw : {};
  const schedule = defaultSchedule();

  if (source.kind !== undefined) {
    if (SCHEDULE_KINDS.includes(source.kind)) schedule.kind = source.kind;
    else errors.push('Choose a valid schedule type.');
  }

  if (source.intervalMinutes !== undefined) {
    if (Number.isInteger(source.intervalMinutes) && source.intervalMinutes >= 5 && source.intervalMinutes <= 10080) {
      schedule.intervalMinutes = source.intervalMinutes;
    } else {
      errors.push('Interval must be between 5 minutes and 7 days.');
    }
  }

  if (source.times !== undefined) {
    schedule.times = normalizedTimes(source.times, schedule.times, errors, { minCount: 1, maxCount: MAX_TIMES });
  }

  if (source.monthlyDay !== undefined) {
    if (Number.isInteger(source.monthlyDay) && source.monthlyDay >= 1 && source.monthlyDay <= 31) {
      schedule.monthlyDay = source.monthlyDay;
    } else {
      errors.push('Monthly day must be between 1 and 31.');
    }
  }

  if (source.onceAt !== undefined) {
    if (source.onceAt === '' || source.onceAt === null) {
      schedule.onceAt = '';
    } else {
      const parsed = parseLocalDateTime(source.onceAt);
      if (parsed) schedule.onceAt = localDateTimeString(parsed);
      else errors.push('One-time date and time is invalid.');
    }
  }

  if (source.repeatYearly !== undefined) {
    if (typeof source.repeatYearly === 'boolean') schedule.repeatYearly = source.repeatYearly;
    else errors.push('Yearly repeat must be on or off.');
  }

  if (source.startupDelayMinutes !== undefined) {
    if (Number.isInteger(source.startupDelayMinutes)
      && source.startupDelayMinutes >= 0
      && source.startupDelayMinutes <= 1440) {
      schedule.startupDelayMinutes = source.startupDelayMinutes;
    } else {
      errors.push('Startup delay must be between 0 and 1440 minutes.');
    }
  }

  if (source.idleMinutes !== undefined) {
    if (Number.isInteger(source.idleMinutes) && source.idleMinutes >= 1 && source.idleMinutes <= 480) {
      schedule.idleMinutes = source.idleMinutes;
    } else {
      errors.push('Idle time must be between 1 and 480 minutes.');
    }
  }

  if (source.focusMinutes !== undefined) {
    if (Number.isInteger(source.focusMinutes) && source.focusMinutes >= 5 && source.focusMinutes <= 180) {
      schedule.focusMinutes = source.focusMinutes;
    } else {
      errors.push('Focus length must be between 5 and 180 minutes.');
    }
  }

  if (source.breakMinutes !== undefined) {
    if (Number.isInteger(source.breakMinutes) && source.breakMinutes >= 1 && source.breakMinutes <= 60) {
      schedule.breakMinutes = source.breakMinutes;
    } else {
      errors.push('Break length must be between 1 and 60 minutes.');
    }
  }

  const startMinutes = source.activeStart === undefined ? parseClock(schedule.activeStart) : parseClock(source.activeStart);
  const endMinutes = source.activeEnd === undefined ? parseClock(schedule.activeEnd) : parseClock(source.activeEnd);
  if (startMinutes === null) errors.push('Active hours start time is invalid.');
  if (endMinutes === null) errors.push('Active hours end time is invalid.');
  if (startMinutes !== null && endMinutes !== null) {
    if (startMinutes === endMinutes) {
      errors.push('Active hours must have different start and end times.');
    } else {
      schedule.activeStart = source.activeStart ?? schedule.activeStart;
      schedule.activeEnd = source.activeEnd ?? schedule.activeEnd;
    }
  }

  if (source.days !== undefined) {
    const days = sortedUniqueDays(source.days);
    if (days) schedule.days = days;
    else errors.push('Choose at least one active day.');
  }

  if (source.startDate !== undefined) {
    if (source.startDate === null || source.startDate === '') {
      schedule.startDate = null;
    } else if (parseDateKey(source.startDate)) {
      schedule.startDate = source.startDate;
    } else {
      errors.push('Start date is invalid.');
    }
  }

  if (source.endDate !== undefined) {
    if (source.endDate === null || source.endDate === '') {
      schedule.endDate = null;
    } else if (parseDateKey(source.endDate)) {
      schedule.endDate = source.endDate;
    } else {
      errors.push('End date is invalid.');
    }
  }

  if (schedule.startDate && schedule.endDate && schedule.endDate < schedule.startDate) {
    errors.push('End date must be on or after the start date.');
  }

  for (const [key, message] of [
    ['skipPaused', 'Skip while paused setting must be on or off.'],
    ['skipDnd', 'Skip during Do Not Disturb setting must be on or off.'],
    ['skipLocked', 'Skip while locked setting must be on or off.']
  ]) {
    if (source[key] === undefined) continue;
    if (typeof source[key] === 'boolean') schedule[key] = source[key];
    else errors.push(message);
  }

  if (source.missedPolicy !== undefined) {
    if (MISSED_POLICIES.includes(source.missedPolicy)) schedule.missedPolicy = source.missedPolicy;
    else errors.push('Missed reminder policy is invalid.');
  }

  if (schedule.kind === 'once' && !schedule.onceAt) {
    errors.push('Choose a date and time for the one-time reminder.');
  }

  if (strict && errors.length > 0) throw new ValidationError(errors);
  return { schedule, errors };
}

function normalizeButton(raw, index, errors) {
  if (!isPlainObject(raw)) {
    errors.push(`Button ${index + 1} is invalid.`);
    return null;
  }
  const id = typeof raw.id === 'string' && isValidIdentifier(raw.id, 40)
    ? raw.id
    : createId('b');
  if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.trim().length > 40) {
    errors.push(`Button ${index + 1} needs a label of 1–40 characters.`);
    return null;
  }
  if (!BUTTON_ACTIONS.includes(raw.action)) {
    errors.push(`Button “${raw.label.trim()}” has an invalid action.`);
    return null;
  }
  const button = {
    id,
    label: raw.label.trim(),
    action: raw.action,
    reaction: REACTIONS.includes(raw.reaction) ? raw.reaction : raw.action
  };
  if (raw.icon !== undefined) {
    if (typeof raw.icon === 'string' && raw.icon.length <= 16) button.icon = raw.icon.trim();
    else errors.push(`Button “${raw.label.trim()}” has an invalid icon.`);
  }
  return button;
}

function normalizeButtons(raw, type, errors) {
  if (type === 'note') {
    if (Array.isArray(raw) && raw.length > 0) errors.push('Message-only reminders cannot have buttons.');
    return [];
  }

  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
    if (type === 'choice') {
      errors.push('Choice reminders need between 2 and 4 buttons.');
      return [];
    }
    return cloneButtons(type);
  }
  if (!Array.isArray(raw)) {
    errors.push('Buttons must be a list.');
    return cloneButtons(type);
  }
  if (raw.length < 1 || raw.length > MAX_BUTTONS) {
    errors.push(`A reminder can have between 1 and ${MAX_BUTTONS} buttons.`);
    return cloneButtons(type);
  }
  if (type === 'choice' && raw.length < 2) {
    errors.push('Choice reminders need at least 2 buttons.');
  }

  const buttons = [];
  const seen = new Set();
  for (let index = 0; index < raw.length; index += 1) {
    const button = normalizeButton(raw[index], index, errors);
    if (!button) continue;
    if (seen.has(button.id)) button.id = createId('b');
    seen.add(button.id);
    buttons.push(button);
  }
  if (buttons.length === 0) return cloneButtons(type);
  return buttons;
}

function normalizeCharacter(raw, errors) {
  const character = defaultCharacter();
  if (raw === undefined || raw === null) return character;
  if (!isPlainObject(raw)) {
    errors.push('Character settings must be an object.');
    return character;
  }

  if (raw.mode !== undefined) {
    if (CHARACTER_MODES.includes(raw.mode)) character.mode = raw.mode;
    else errors.push('Character mode is invalid.');
  }
  if (raw.id !== undefined) {
    if (typeof raw.id === 'string' && (raw.id === '' || isValidIdentifier(raw.id, 80))) character.id = raw.id;
    else errors.push('Character selection is invalid.');
  }
  if (raw.scale !== undefined) {
    if (Number.isInteger(raw.scale) && raw.scale >= 50 && raw.scale <= 200) character.scale = raw.scale;
    else errors.push('Character size must be between 50 and 200 percent.');
  }
  if (raw.sound !== undefined) {
    if (SOUND_MODES.includes(raw.sound)) character.sound = raw.sound;
    else errors.push('Sound choice is invalid.');
  }
  if (raw.soundFile !== undefined) {
    if (typeof raw.soundFile === 'string' && raw.soundFile.length <= 200
      && (raw.soundFile === '' || /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(raw.soundFile))) {
      character.soundFile = raw.soundFile;
    } else {
      errors.push('Custom sound file name is invalid.');
    }
  }
  if (character.mode === 'specific' && !character.id) {
    errors.push('Choose a character or use the default character.');
  }
  if (character.sound === 'custom' && !character.soundFile) {
    errors.push('Choose a custom sound file, or use the default chime.');
  }
  return character;
}

function normalizeSnooze(raw, errors) {
  const snooze = defaultSnooze();
  if (raw === undefined || raw === null) return snooze;
  if (!isPlainObject(raw)) {
    errors.push('Snooze settings must be an object.');
    return snooze;
  }
  if (raw.minutes !== undefined) {
    if (Number.isInteger(raw.minutes) && raw.minutes >= 1 && raw.minutes <= 120) snooze.minutes = raw.minutes;
    else errors.push('Snooze time must be between 1 and 120 minutes.');
  }
  if (raw.max !== undefined) {
    if (Number.isInteger(raw.max) && raw.max >= 0 && raw.max <= 10) snooze.max = raw.max;
    else errors.push('Maximum snoozes must be between 0 and 10.');
  }
  if (raw.escalate !== undefined) {
    if (ESCALATIONS.includes(raw.escalate)) snooze.escalate = raw.escalate;
    else errors.push('Snooze escalation choice is invalid.');
  }
  return snooze;
}

function normalizeTracking(raw, errors) {
  const tracking = defaultTracking();
  if (raw === undefined || raw === null) return tracking;
  if (!isPlainObject(raw)) {
    errors.push('Tracking settings must be an object.');
    return tracking;
  }
  if (raw.log !== undefined) {
    if (typeof raw.log === 'boolean') tracking.log = raw.log;
    else errors.push('History logging must be on or off.');
  }
  if (raw.dailyGoal !== undefined) {
    if (raw.dailyGoal === null || raw.dailyGoal === '') tracking.dailyGoal = null;
    else if (Number.isInteger(raw.dailyGoal) && raw.dailyGoal >= 1 && raw.dailyGoal <= 50) tracking.dailyGoal = raw.dailyGoal;
    else errors.push('Daily goal must be between 1 and 50.');
  }
  return tracking;
}

function normalizeReminder(raw, { strict = true, now = new Date() } = {}) {
  const errors = [];
  const fallback = baseReminder(now);
  if (!isPlainObject(raw)) {
    errors.push('Reminder must be an object.');
    if (strict) throw new ValidationError(errors);
    return fallback;
  }

  const reminder = { ...fallback };

  if (raw.id !== undefined) {
    if (isValidIdentifier(raw.id, 80)) reminder.id = raw.id;
    else errors.push('Reminder identifier is invalid.');
  }

  if (raw.title !== undefined) {
    if (typeof raw.title === 'string' && raw.title.trim() && raw.title.trim().length <= MAX_TITLE_LENGTH) {
      reminder.title = raw.title.trim();
    } else {
      errors.push(`Reminder title must be 1–${MAX_TITLE_LENGTH} characters.`);
    }
  } else if (strict) {
    errors.push('Reminder title is required.');
  }

  if (raw.icon !== undefined) {
    if (typeof raw.icon === 'string' && raw.icon.trim() && raw.icon.trim().length <= 16) {
      reminder.icon = raw.icon.trim();
    } else {
      errors.push('Reminder icon is invalid.');
    }
  }

  if (raw.color !== undefined) {
    if (typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color)) reminder.color = raw.color.toLowerCase();
    else errors.push('Reminder color must be a six-digit hex color.');
  }

  if (raw.category !== undefined) {
    if (typeof raw.category === 'string' && raw.category.trim() && raw.category.trim().length <= 40) {
      reminder.category = raw.category.trim();
    } else {
      errors.push('Reminder category is invalid.');
    }
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') reminder.enabled = raw.enabled;
    else errors.push('Reminder enabled setting must be on or off.');
  }

  if (raw.type !== undefined) {
    if (TYPES.includes(raw.type)) reminder.type = raw.type;
    else errors.push('Reminder type is invalid.');
  }

  if (raw.messages !== undefined) {
    const normalized = normalizeMessages(raw.messages);
    reminder.messages = normalized.messages;
    errors.push(...normalized.errors);
  }

  reminder.buttons = normalizeButtons(raw.buttons, reminder.type, errors);

  reminder.character = normalizeCharacter(raw.character, errors);
  const scheduleResult = normalizeSchedule(raw.schedule, { strict: false });
  reminder.schedule = scheduleResult.schedule;
  errors.push(...scheduleResult.errors);
  reminder.snooze = normalizeSnooze(raw.snooze, errors);
  reminder.tracking = normalizeTracking(raw.tracking, errors);
  if (reminder.type === 'note') reminder.tracking.log = raw.tracking?.log ?? false;

  if (raw.priority !== undefined) {
    if (PRIORITIES.includes(raw.priority)) reminder.priority = raw.priority;
    else errors.push('Priority must be normal or high.');
  }

  if (raw.notes !== undefined) {
    if (typeof raw.notes === 'string' && raw.notes.length <= MAX_NOTE_LENGTH) reminder.notes = raw.notes;
    else errors.push(`Notes can be up to ${MAX_NOTE_LENGTH} characters.`);
  }

  if (raw.specialAnimation !== undefined) {
    if (SPECIAL_ANIMATIONS.includes(raw.specialAnimation)) reminder.specialAnimation = raw.specialAnimation;
    else errors.push('Special animation choice is invalid.');
  }

  if (raw.timeoutAction !== undefined) {
    if (TIMEOUT_ACTIONS.includes(raw.timeoutAction)) reminder.timeoutAction = raw.timeoutAction;
    else errors.push('Timeout action is invalid.');
  } else if (reminder.type === 'note') {
    reminder.timeoutAction = 'dismiss';
  }

  if (raw.timerMinutes !== undefined) {
    if (Number.isInteger(raw.timerMinutes) && raw.timerMinutes >= 1 && raw.timerMinutes <= 180) {
      reminder.timerMinutes = raw.timerMinutes;
    } else {
      errors.push('Timer length must be between 1 and 180 minutes.');
    }
  }

  if (raw.autoDismissSeconds !== undefined) {
    if (Number.isInteger(raw.autoDismissSeconds)
      && raw.autoDismissSeconds >= 3
      && raw.autoDismissSeconds <= 120) {
      reminder.autoDismissSeconds = raw.autoDismissSeconds;
    } else {
      errors.push('Auto-dismiss delay must be between 3 and 120 seconds.');
    }
  }

  if (raw.templateId !== undefined) {
    if (raw.templateId === null) reminder.templateId = null;
    else if (typeof raw.templateId === 'string' && raw.templateId.length <= 40) reminder.templateId = raw.templateId;
    else errors.push('Template identifier is invalid.');
  }

  for (const key of ['createdAt', 'updatedAt']) {
    if (raw[key] !== undefined) {
      const date = typeof raw[key] === 'string' ? new Date(raw[key]) : null;
      if (date && !Number.isNaN(date.getTime())) reminder[key] = date.toISOString();
      else errors.push(`${key === 'createdAt' ? 'Creation' : 'Update'} timestamp is invalid.`);
    }
  }
  reminder.updatedAt = now.toISOString();

  if (reminder.type === 'timer' && reminder.buttons.length === 0) reminder.buttons = cloneButtons('timer');
  if (reminder.type === 'timer') reminder.specialAnimation = 'none';

  if (strict && errors.length > 0) throw new ValidationError([...new Set(errors)]);
  return reminder;
}

function normalizeReminderList(raw, { strict = false, now = new Date() } = {}) {
  if (!Array.isArray(raw)) {
    if (strict) throw new ValidationError(['Reminders must be a list.']);
    return [];
  }
  if (raw.length > MAX_REMINDERS) {
    if (strict) throw new ValidationError([`At most ${MAX_REMINDERS} reminders can be stored.`]);
  }

  const reminders = [];
  const seen = new Set();
  const errors = [];
  for (const item of raw.slice(0, MAX_REMINDERS)) {
    try {
      const reminder = normalizeReminder(item, { strict: false, now });
      if (seen.has(reminder.id)) reminder.id = createId('r');
      seen.add(reminder.id);
      reminders.push(reminder);
    } catch (error) {
      errors.push(...(error.errors || [error.message]));
      if (strict) break;
    }
  }
  if (strict && errors.length > 0) throw new ValidationError([...new Set(errors)]);
  return reminders;
}

function daysLabel(days) {
  const list = sortedUniqueDays(days) || [];
  if (list.length === 7) return 'Every day';
  if (list.length === 5 && list.every((day) => day >= 1 && day <= 5)) return 'Weekdays';
  if (list.length === 2 && list.includes(0) && list.includes(6)) return 'Weekends';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return [...list].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => names[day]).join(', ');
}

function formatDateKey(value) {
  if (!value) return '';
  const date = parseDateKey(value);
  if (!date) return value;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function scheduleSummary(reminder) {
  const schedule = reminder?.schedule || defaultSchedule();
  switch (schedule.kind) {
    case 'interval': {
      const minutes = schedule.intervalMinutes;
      const interval = minutes % 60 === 0 && minutes >= 60
        ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
        : `${minutes} min`;
      return `Every ${interval} · ${schedule.activeStart}–${schedule.activeEnd} · ${daysLabel(schedule.days)}`;
    }
    case 'pomodoro':
      return `${schedule.focusMinutes}/${schedule.breakMinutes} focus cycle · ${schedule.activeStart}–${schedule.activeEnd} · ${daysLabel(schedule.days)}`;
    case 'times':
      return `${schedule.times.join(', ')} · ${daysLabel(schedule.days)}`;
    case 'monthly':
      return `Day ${schedule.monthlyDay} of each month · ${schedule.times[0] || '09:00'}`;
    case 'once': {
      const date = parseLocalDateTime(schedule.onceAt);
      const label = date
        ? new Intl.DateTimeFormat(undefined, {
          year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        }).format(date)
        : 'No date selected';
      return schedule.repeatYearly ? `Yearly · ${label}` : `Once · ${label}`;
    }
    case 'startup':
      return schedule.startupDelayMinutes === 0
        ? 'When Remind Buddy starts'
        : `${schedule.startupDelayMinutes} min after Remind Buddy starts`;
    case 'idle':
      return `After ${schedule.idleMinutes} min idle · ${schedule.activeStart}–${schedule.activeEnd} · ${daysLabel(schedule.days)}`;
    default:
      return 'Schedule not set';
  }
}

function applyTemplate(templateId, { now = new Date(), id = createId('r') } = {}) {
  const meta = TEMPLATE_META.find((entry) => entry.id === templateId);
  if (!meta) throw new Error(`Unknown reminder template: ${templateId}`);
  const stamp = now.toISOString();

  const template = {
    id,
    title: meta.name,
    icon: meta.icon,
    color: meta.color,
    category: meta.category,
    enabled: true,
    templateId: meta.id,
    createdAt: stamp,
    updatedAt: stamp
  };

  if (templateId === 'water') {
    Object.assign(template, {
      type: 'yesno',
      messages: {
        question: ['Did you drink water?', 'Time for a sip — did you drink water?'],
        positive: ['Logged. Lovely work!'],
        negative: ["Okay — I'll check in again soon."]
      },
      notes: '',
      schedule: {
        kind: 'interval', intervalMinutes: 60, activeStart: '09:00', activeEnd: '21:00', days: [...ALL_DAYS]
      },
      snooze: { minutes: 10, max: 4, escalate: 'none' },
      tracking: { log: true, dailyGoal: 8 },
      priority: 'normal',
      specialAnimation: 'drinking',
      timeoutAction: 'negative',
      character: { mode: 'default', sound: 'default' }
    });
  } else if (templateId === 'medicine') {
    Object.assign(template, {
      type: 'confirm',
      messages: {
        question: ['Time to take your medicine.', 'Medicine check — all done?'],
        positive: ['Dose logged. Thank you.'],
        negative: ["Noted. I'll come back soon."]
      },
      notes: 'Take with water.',
      schedule: { kind: 'times', times: ['08:00', '20:00'], days: [...ALL_DAYS], missedPolicy: 'show' },
      snooze: { minutes: 15, max: 4, escalate: 'frequent' },
      tracking: { log: true, dailyGoal: 2 },
      priority: 'high',
      timeoutAction: 'negative',
      autoDismissSeconds: 10
    });
  } else if (templateId === 'stretch') {
    Object.assign(template, {
      type: 'confirm',
      messages: {
        question: ['Stand up and stretch for a minute?', 'Quick stretch break?'],
        positive: ['That counts. Nicely done.'],
        negative: ['No worries — move when you can.']
      },
      schedule: {
        kind: 'interval', intervalMinutes: 90, activeStart: '09:00', activeEnd: '17:30', days: [1, 2, 3, 4, 5]
      },
      snooze: { minutes: 10, max: 3, escalate: 'none' },
      tracking: { log: true, dailyGoal: null },
      specialAnimation: 'exercise',
      priority: 'normal'
    });
  } else if (templateId === 'eye-rest') {
    Object.assign(template, {
      type: 'note',
      messages: {
        question: ['20-20-20: look 20 feet away for 20 seconds.', 'Give your eyes a 20-second break.']
      },
      notes: '',
      schedule: {
        kind: 'interval', intervalMinutes: 20, activeStart: '09:00', activeEnd: '18:00', days: [1, 2, 3, 4, 5]
      },
      tracking: { log: false, dailyGoal: null },
      autoDismissSeconds: 8,
      snooze: { minutes: 5, max: 2, escalate: 'none' },
      priority: 'normal',
      character: { mode: 'default', sound: 'chime' }
    });
  } else if (templateId === 'posture') {
    Object.assign(template, {
      type: 'yesno',
      messages: {
        question: ['Check your posture — shoulders back?', 'Quick posture check?'],
        positive: ['Reset done.'],
        negative: ['Okay — try again next time.']
      },
      schedule: {
        kind: 'interval', intervalMinutes: 30, activeStart: '09:00', activeEnd: '17:00', days: [1, 2, 3, 4, 5]
      },
      tracking: { log: true, dailyGoal: null },
      priority: 'normal'
    });
  } else if (templateId === 'meal') {
    Object.assign(template, {
      type: 'confirm',
      messages: {
        question: ['Time to eat — have you had something?', 'Meal check. Eaten yet?'],
        positive: ['Good. Fuel for the day.'],
        negative: ["No pressure — I'll remind you later."]
      },
      schedule: { kind: 'times', times: ['08:00', '12:30', '18:30'], days: [...ALL_DAYS] },
      tracking: { log: true, dailyGoal: 3 },
      snooze: { minutes: 20, max: 2, escalate: 'none' },
      icon: '🍎',
      priority: 'normal'
    });
  } else if (templateId === 'walk') {
    Object.assign(template, {
      type: 'confirm',
      messages: {
        question: ['Time for a short walk?', 'Fancy a few minutes outside?'],
        positive: ['Steps logged. Enjoy the fresh air.'],
        negative: ['Maybe later. I’ll keep it on the list.']
      },
      schedule: { kind: 'times', times: ['10:00', '15:00'], days: [...ALL_DAYS] },
      tracking: { log: true, dailyGoal: 2 },
      specialAnimation: 'exercise',
      priority: 'normal'
    });
  } else if (templateId === 'break') {
    Object.assign(template, {
      type: 'yesno',
      messages: {
        question: ['Take a break from the screen?', 'Time to step away for a moment?'],
        positive: ['Break noted. Hope it helped.'],
        neutral: ['Fine — back to it when you’re ready.']
      },
      schedule: {
        kind: 'interval', intervalMinutes: 60, activeStart: '10:00', activeEnd: '16:00', days: [1, 2, 3, 4, 5]
      },
      tracking: { log: true, dailyGoal: null },
      snooze: { minutes: 10, max: 3, escalate: 'none' },
      priority: 'normal'
    });
  } else if (templateId === 'sleep') {
    Object.assign(template, {
      type: 'confirm',
      messages: {
        question: ['Time to wind down for sleep.', 'Ready to call it a night?'],
        positive: ['Goodnight. Rest well.'],
        negative: ["Okay — I'll check in again in a bit."]
      },
      schedule: { kind: 'times', times: ['22:30'], days: [...ALL_DAYS] },
      snooze: { minutes: 15, max: 2, escalate: 'none' },
      tracking: { log: true, dailyGoal: 1 },
      priority: 'normal',
      icon: '🌙'
    });
  } else if (templateId === 'pomodoro') {
    Object.assign(template, {
      type: 'note',
      messages: {
        question: ['Pomodoro time.'],
        pomodoroFocus: ["Break's over — start your next 25-minute focus block."],
        pomodoroBreak: ['Focus block complete — take 5 minutes away from the screen.']
      },
      schedule: {
        kind: 'pomodoro',
        focusMinutes: 25,
        breakMinutes: 5,
        activeStart: '09:00',
        activeEnd: '17:00',
        days: [1, 2, 3, 4, 5]
      },
      tracking: { log: true, dailyGoal: null },
      autoDismissSeconds: 12,
      snooze: { minutes: 5, max: 2, escalate: 'frequent' },
      priority: 'normal'
    });
  } else if (templateId === 'bills') {
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 9, 0, 0, 0);
    Object.assign(template, {
      type: 'confirm',
      messages: {
        question: ['Rent and bills check — all paid?', 'Monthly bills: done?'],
        positive: ['Paid and logged. Nice.'],
        negative: ["I'll keep reminding you. Bills can't wait."]
      },
      schedule: {
        kind: 'monthly', monthlyDay: 1, times: ['09:00'], days: [...ALL_DAYS], missedPolicy: 'show'
      },
      priority: 'high',
      snooze: { minutes: 30, max: 4, escalate: 'frequent' },
      tracking: { log: true, dailyGoal: 1 },
      timeoutAction: 'negative',
      notes: `Next due ${formatDateKey(dateKey(nextMonth))}.`
    });
  } else if (templateId === 'birthday') {
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate(), 9, 0, 0, 0);
    Object.assign(template, {
      type: 'note',
      messages: {
        question: ['Happy birthday / anniversary!', 'A special day worth celebrating.']
      },
      schedule: {
        kind: 'once', onceAt: localDateTimeString(nextMonth), repeatYearly: true, days: [...ALL_DAYS]
      },
      tracking: { log: false, dailyGoal: null },
      autoDismissSeconds: 15,
      icon: '🎂',
      priority: 'normal',
      notes: 'Edit the date, time, and title to match the occasion.'
    });
  } else {
    Object.assign(template, {
      type: 'yesno',
      messages: { question: ['{title}'] },
      schedule: { kind: 'interval', intervalMinutes: 60, activeStart: '09:00', activeEnd: '21:00', days: [...ALL_DAYS] },
      category: 'Custom',
      tracking: { log: true, dailyGoal: null }
    });
  }

  if (template.schedule && !template.schedule.kind) template.schedule.kind = 'interval';
  return normalizeReminder(template, { strict: true, now });
}

function createReminderFromTemplate(templateId, options = {}) {
  return applyTemplate(templateId, options);
}

function defaultReminders(now = new Date()) {
  return ['water', 'stretch', 'break'].map((templateId) => createReminderFromTemplate(templateId, { now }));
}

function legacyWaterReminder(legacySettings, { now = new Date(), id = createId('r') } = {}) {
  const settings = isPlainObject(legacySettings) ? legacySettings : {};
  const reminder = createReminderFromTemplate('water', { now, id });
  const intervalMinutes = Number.isInteger(settings.intervalMinutes) ? settings.intervalMinutes : 60;
  const start = parseClock(settings.activeStart) === null ? '09:00' : settings.activeStart;
  const end = parseClock(settings.activeEnd) === null ? '21:00' : settings.activeEnd;
  const days = sortedUniqueDays(settings.activeDays) || [...ALL_DAYS];
  reminder.schedule = {
    ...reminder.schedule,
    kind: 'interval',
    intervalMinutes,
    activeStart: start,
    activeEnd: end,
    days
  };
  if (Number.isInteger(settings.snoozeMinutes)) {
    reminder.snooze.minutes = Math.min(120, Math.max(1, settings.snoozeMinutes));
  }
  if (Number.isInteger(settings.dailyGoal)) {
    reminder.tracking.dailyGoal = Math.min(50, Math.max(1, settings.dailyGoal));
  }
  if (settings.soundEnabled === false) reminder.character.sound = 'none';
  reminder.createdAt = now.toISOString();
  reminder.updatedAt = now.toISOString();
  return normalizeReminder(reminder, { strict: true, now });
}

function duplicateReminder(reminder, { now = new Date() } = {}) {
  const copy = JSON.parse(JSON.stringify(reminder));
  copy.id = createId('r');
  copy.title = `${reminder.title} copy`.slice(0, MAX_TITLE_LENGTH);
  copy.enabled = false;
  copy.createdAt = now.toISOString();
  copy.updatedAt = now.toISOString();
  return normalizeReminder(copy, { strict: true, now });
}

function buttonSnoozeAvailable(reminder, snoozeCount) {
  const max = reminder?.snooze?.max ?? 3;
  return max > 0 && snoozeCount < max;
}

function effectiveTimeoutAction(reminder, settings) {
  if (reminder?.priority === 'high') return null;
  if (reminder?.type === 'note') return 'dismiss';
  if (reminder?.type === 'timer') return 'positive';
  return reminder?.timeoutAction || settings?.defaultTimeoutAction || 'negative';
}

module.exports = {
  BUTTON_ACTIONS,
  CHARACTER_MODES,
  DEFAULT_BUTTONS,
  ESCALATIONS,
  MAX_BUTTONS,
  MAX_REMINDERS,
  MAX_TIMES,
  MISSED_POLICIES,
  PRIORITIES,
  REACTIONS,
  SCHEDULE_KINDS,
  SOUND_MODES,
  SPECIAL_ANIMATIONS,
  TEMPLATE_META,
  TYPES,
  applyTemplate,
  baseReminder,
  buttonSnoozeAvailable,
  cloneButtons,
  createReminderFromTemplate,
  daysLabel,
  defaultCharacter,
  defaultReminders,
  defaultSchedule,
  duplicateReminder,
  effectiveTimeoutAction,
  formatDateKey,
  legacyWaterReminder,
  normalizeButtons,
  normalizeCharacter,
  normalizeReminder,
  normalizeReminderList,
  normalizeSchedule,
  scheduleSummary
};
