'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ValidationError, dateKey } = require('../lib/common');
const {
  TEMPLATE_META,
  createReminderFromTemplate,
  defaultReminders,
  duplicateReminder,
  legacyWaterReminder,
  normalizeReminder,
  normalizeReminderList,
  scheduleSummary
} = require('../lib/reminders');
const {
  DEFAULT_SETTINGS,
  cloneDefaultSettings,
  isDndActive,
  normalizeSettings
} = require('../lib/settings');
const {
  appendEvent,
  sanitizeHistory,
  streakForReminder,
  summarizeDays,
  eventsToCsv
} = require('../lib/history');
const {
  messageContext,
  normalizeGlobalMessages,
  renderMessage,
  resolveMessages
} = require('../lib/messages');
const {
  createQuickAddReminder,
  parseQuickAdd,
  parseTimeToken
} = require('../lib/quick-add');
const { DataStore } = require('../lib/storage');

const NOW = new Date(2026, 9, 24, 12, 0, 0, 0);

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `remind-buddy-${label}-`));
}

test('all thirteen templates normalize into usable reminders', () => {
  assert.equal(TEMPLATE_META.length, 13);
  const ids = new Set();
  for (const meta of TEMPLATE_META) {
    const reminder = createReminderFromTemplate(meta.id, { now: NOW });
    assert.equal(reminder.title.length > 0, true, `${meta.id} has a title`);
    assert.equal(ids.has(reminder.id), false, 'template ids are unique');
    ids.add(reminder.id);
    assert.equal(reminder.templateId, meta.id);
    assert.ok(['yesno', 'confirm', 'choice', 'timer', 'note'].includes(reminder.type));
    assert.ok(reminder.schedule);
    assert.ok(scheduleSummary(reminder).length > 0);
    if (reminder.type === 'choice') assert.ok(reminder.buttons.length >= 2);
    if (reminder.type === 'note') assert.equal(reminder.buttons.length, 0);
    else assert.ok(reminder.buttons.length >= 1);
  }
});

test('first-run seeds contain water, stretch, and a break', () => {
  const seeds = defaultReminders(NOW);
  assert.equal(seeds.length, 3);
  assert.deepEqual(seeds.map((reminder) => reminder.templateId), ['water', 'stretch', 'break']);
  assert.equal(seeds[0].tracking.dailyGoal, 8);
  assert.equal(seeds[0].specialAnimation, 'drinking');
});

test('reminder validation reports invalid fields and keeps defaults in lenient mode', () => {
  assert.throws(() => normalizeReminder({
    title: '',
    type: 'unknown',
    buttons: [{ label: '', action: 'nope' }],
    schedule: { kind: 'once', onceAt: 'not-a-date' }
  }, { strict: true, now: NOW }), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.ok(error.errors.length >= 5);
    return true;
  });

  const lenient = normalizeReminder({
    title: 'Read a chapter',
    type: 'confirm',
    schedule: { kind: 'once', onceAt: 'bad-date' }
  }, { strict: false, now: NOW });
  assert.equal(lenient.title, 'Read a chapter');
  assert.equal(lenient.schedule.kind, 'once');
  assert.equal(lenient.schedule.onceAt, '');
  assert.deepEqual(lenient.buttons.map((button) => button.action), ['positive', 'snooze']);
});

test('choice reminders require two to four buttons', () => {
  const base = {
    title: 'Mood check',
    type: 'choice',
    schedule: { kind: 'times', times: ['09:00'] }
  };
  assert.throws(() => normalizeReminder({
    ...base,
    buttons: [{ label: 'Okay', action: 'neutral' }]
  }, { strict: true, now: NOW }), /at least 2 buttons/);
  const reminder = normalizeReminder({
    ...base,
    buttons: [
      { label: 'Great', action: 'positive' },
      { label: 'Okay', action: 'neutral' },
      { label: 'Rough', action: 'negative' }
    ]
  }, { strict: true, now: NOW });
  assert.deepEqual(reminder.buttons.map((button) => button.label), ['Great', 'Okay', 'Rough']);
  assert.deepEqual(reminder.buttons.map((button) => button.reaction), ['positive', 'neutral', 'negative']);
});

test('duplicate reminders get a new id and start disabled', () => {
  const reminder = createReminderFromTemplate('water', { now: NOW });
  const copy = duplicateReminder(reminder, { now: NOW });
  assert.notEqual(copy.id, reminder.id);
  assert.match(copy.title, /copy$/);
  assert.equal(copy.enabled, false);
});

test('legacy water settings migrate into a water reminder', () => {
  const reminder = legacyWaterReminder({
    intervalMinutes: 45,
    activeStart: '08:30',
    activeEnd: '19:30',
    activeDays: [1, 2, 3, 4, 5],
    snoozeMinutes: 7,
    dailyGoal: 6,
    soundEnabled: false
  }, { now: NOW });
  assert.equal(reminder.title, 'Drink water');
  assert.equal(reminder.schedule.intervalMinutes, 45);
  assert.equal(reminder.schedule.activeStart, '08:30');
  assert.deepEqual(reminder.schedule.days, [1, 2, 3, 4, 5]);
  assert.equal(reminder.snooze.minutes, 7);
  assert.equal(reminder.tracking.dailyGoal, 6);
  assert.equal(reminder.character.sound, 'none');
});

test('global settings normalize themes, volume, DND, and shortcuts', () => {
  const settings = normalizeSettings({
    theme: 'dark',
    language: 'fr',
    display: 'all',
    soundVolume: 72,
    quickAddShortcut: 'CommandOrControl+Shift+R',
    dnd: { enabled: true, start: '22:00', end: '07:00', days: [1, 2, 3, 4, 5] },
    messages: { positive: ['Yes!', 'Great!'], negative: ['Not now.'] }
  });
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.language, 'fr');
  assert.equal(settings.display, 'all');
  assert.equal(settings.soundVolume, 72);
  assert.equal(settings.dnd.enabled, true);
  assert.deepEqual(settings.messages.positive, ['Yes!', 'Great!']);
  assert.equal(isDndActive(settings.dnd, new Date(2026, 9, 26, 23, 0)), true);
  assert.equal(isDndActive(settings.dnd, new Date(2026, 9, 25, 12, 0)), false);
  assert.throws(() => normalizeSettings({ soundVolume: 101 }), ValidationError);
});

test('message placeholders and fallbacks render safely', () => {
  const reminder = createReminderFromTemplate('water', { now: NOW });
  const resolved = resolveMessages({ question: ['Hi {title} — {note} on {weekday}'], positive: [] }, DEFAULT_SETTINGS.messages);
  const context = messageContext({ ...reminder, notes: 'Take a sip' }, NOW);
  assert.equal(renderMessage(resolved.question[0], context), 'Hi Drink water — Take a sip on Saturday');
  assert.deepEqual(resolved.positive, DEFAULT_SETTINGS.messages.positive);
  assert.equal(renderMessage('Hello {unknown}', {}), 'Hello {unknown}');
  const normalized = normalizeGlobalMessages({ positive: ['  A  ', '', 'B'], negative: ['No'] });
  assert.deepEqual(normalized.messages.positive, ['A', 'B']);
});

test('history sanitizes events and computes streaks and summaries', () => {
  const reminder = createReminderFromTemplate('water', { now: NOW });
  let events = [];
  for (const day of [20, 21, 22, 23, 24]) {
    events = appendEvent(events, {
      reminderId: reminder.id,
      reminderTitle: reminder.title,
      icon: reminder.icon,
      outcome: 'done',
      at: new Date(2026, 9, day, 9, 0).toISOString(),
      source: 'button'
    }, NOW);
  }
  events = appendEvent(events, {
    reminderId: reminder.id,
    reminderTitle: reminder.title,
    outcome: 'skipped',
    at: new Date(2026, 9, 24, 10, 0).toISOString(),
    source: 'timeout'
  }, NOW);
  const sanitized = sanitizeHistory({ events: [...events, { nonsense: true }, { reminderId: reminder.id, outcome: 'done', at: 'bad' }] }, { now: NOW });
  assert.equal(sanitized.length, 6);
  assert.equal(streakForReminder(events, reminder.id, NOW), 5);
  const summary = summarizeDays(events, 7, NOW, reminder.id);
  assert.equal(summary.length, 7);
  assert.equal(summary.at(-1).done, 1);
  assert.equal(summary.at(-1).skipped, 1);
  const csv = eventsToCsv(events);
  assert.match(csv, /^Reminder,Outcome/);
  assert.match(csv, /Drink water,done/);
});

test('quick add parses relative, daily, weekly, monthly, and suffix times', () => {
  const relative = createQuickAddReminder('in 30 min call mom', { now: NOW });
  assert.equal(relative.ok, true);
  assert.equal(relative.title, 'Call mom');
  assert.equal(relative.reminder.schedule.kind, 'once');
  assert.equal(relative.reminder.schedule.onceAt, '2026-10-24T12:30');

  const tomorrow = parseQuickAdd('tomorrow 9am pay rent', { now: NOW });
  assert.equal(tomorrow.ok, true);
  assert.equal(tomorrow.title, 'Pay rent');
  assert.equal(tomorrow.schedule.onceAt, '2026-10-25T09:00');

  const daily = parseQuickAdd('every day at 8pm stretch', { now: NOW });
  assert.equal(daily.ok, true);
  assert.equal(daily.schedule.kind, 'times');
  assert.deepEqual(daily.schedule.times, ['20:00']);
  assert.equal(daily.schedule.days.length, 7);

  const weekly = parseQuickAdd('monday at 10:30 call the bank', { now: NOW });
  assert.equal(weekly.ok, true);
  assert.equal(weekly.schedule.onceAt, '2026-10-26T10:30');

  const monthly = parseQuickAdd('on the 1st at 9am pay rent', { now: NOW });
  assert.equal(monthly.ok, true);
  assert.equal(monthly.schedule.kind, 'monthly');
  assert.equal(monthly.schedule.monthlyDay, 1);

  const suffix = parseQuickAdd('call mom at 5pm', { now: NOW });
  assert.equal(suffix.ok, true);
  assert.equal(suffix.title, 'Call mom');
  assert.equal(suffix.schedule.onceAt, '2026-10-24T17:00');

  assert.equal(parseQuickAdd('call mom', { now: NOW }).ok, false);
  assert.equal(parseQuickAdd('tomorrow 9am', { now: NOW }).ok, false);
  assert.equal(parseTimeToken('9:30pm'), 21 * 60 + 30);
  assert.equal(parseTimeToken('noon'), 720);
});

test('storage migrates legacy water data and writes JSON files atomically', async () => {
  const root = tempDir('migration');
  const legacyDir = path.join(root, 'Water Buddy');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'water-buddy.json'), JSON.stringify({
    settings: {
      intervalMinutes: 45,
      activeStart: '08:00',
      activeEnd: '20:00',
      activeDays: [1, 2, 3, 4, 5],
      snoozeMinutes: 5,
      soundEnabled: false,
      dailyGoal: 6,
      characterId: 'buddy',
      characterScale: 125
    },
    history: {
      '2026-10-23': {
        drank: 2,
        skipped: 1,
        events: [
          { type: 'drank', at: '2026-10-23T09:00:00.000Z', source: 'button' },
          { type: 'skipped', at: '2026-10-23T10:00:00.000Z', source: 'timeout' }
        ]
      }
    }
  }));

  const dataDir = path.join(root, 'Remind Buddy');
  const store = new DataStore(dataDir, { legacyDir, now: () => NOW });
  const state = await store.init();
  assert.equal(state.migrated, true);
  assert.equal(state.reminders.length, 3);
  assert.equal(state.reminders[0].schedule.intervalMinutes, 45);
  assert.equal(state.reminders[0].tracking.dailyGoal, 6);
  assert.equal(state.events.length, 3);
  assert.equal(state.events.filter((event) => event.outcome === 'done').length, 2);
  assert.ok(fs.existsSync(path.join(dataDir, 'reminders.json')));
  assert.ok(fs.existsSync(path.join(dataDir, 'history.json')));
  assert.ok(fs.existsSync(path.join(dataDir, 'settings.json')));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'reminders.json'), 'utf8'));
  assert.equal(onDisk.reminders.length, 3);

  await store.writeSettings({ ...state.settings, theme: 'dark' });
  await store.writeSettings({ ...state.settings, theme: 'light' });
  const backups = fs.readdirSync(path.join(dataDir, 'backups'));
  assert.equal(backups.some((name) => name.startsWith('settings-')), true);
  const reloaded = await new DataStore(dataDir, { now: () => NOW }).init();
  assert.equal(reloaded.settings.theme, 'light');
  assert.equal(reloaded.reminders.length, 3);
});

test('storage seeds three reminders on a fresh profile', async () => {
  const dataDir = tempDir('fresh');
  const store = new DataStore(dataDir, { now: () => NOW });
  const state = await store.init();
  assert.equal(state.seedsCreated, true);
  assert.deepEqual(state.reminders.map((reminder) => reminder.title), ['Drink water', 'Stretch / stand up', 'Take a break']);
  assert.ok(fs.existsSync(path.join(dataDir, 'runtime.json')));
});

test('storage restores a corrupt reminders file from the latest backup', async () => {
  const dataDir = tempDir('restore');
  const store = new DataStore(dataDir, { now: () => NOW });
  const state = await store.init();
  const reminders = state.reminders;
  await store.writeReminders(reminders.map((reminder) => ({ ...reminder, title: `${reminder.title} v2` })));
  await store.writeReminders(reminders);
  fs.writeFileSync(path.join(dataDir, 'reminders.json'), '{ broken json', 'utf8');

  const restored = new DataStore(dataDir, { now: () => NOW });
  const loaded = await restored.init();
  assert.equal(loaded.reminders.length, 3);
  assert.equal(restored.warnings.some((warning) => /Restored reminders\.json/.test(warning)), true);
});

test('storage exports, imports, and syncs a complete backup', async () => {
  const sourceDir = tempDir('export');
  const source = new DataStore(sourceDir, { now: () => NOW });
  const state = await source.init();
  const first = state.reminders[0];
  const history = appendEvent([], {
    reminderId: first.id,
    reminderTitle: first.title,
    icon: first.icon,
    outcome: 'done',
    at: NOW.toISOString(),
    dueAt: NOW.toISOString(),
    source: 'button',
    answerLabel: 'Yes'
  }, NOW);
  await source.save({ settings: { ...state.settings, theme: 'dark' }, reminders: state.reminders, events: history });
  const payload = source.exportData();
  assert.equal(payload.app, 'Remind Buddy');
  assert.equal(payload.version, 1);
  assert.equal(payload.settings.theme, 'dark');
  assert.equal(payload.reminders.length, 3);
  assert.equal(payload.history.length, 1);

  const targetDir = tempDir('import');
  const target = new DataStore(targetDir, { now: () => NOW });
  await target.init();
  const imported = await target.importData(payload);
  assert.equal(imported.settings.theme, 'dark');
  assert.equal(imported.reminders.length, 3);
  assert.equal(imported.events.length, 1);
  assert.equal(imported.events[0].outcome, 'done');
  const reloaded = await new DataStore(targetDir, { now: () => NOW }).init();
  assert.equal(reloaded.settings.theme, 'dark');
  assert.equal(reloaded.reminders.length, 3);
  assert.equal(reloaded.events[0].answerLabel, 'Yes');
  await assert.rejects(
    () => target.importData({ hello: 'world' }),
    /does not contain a Remind Buddy backup/
  );

  const syncDir = tempDir('sync');
  const syncPath = await source.writeSyncSnapshot(syncDir);
  assert.equal(path.basename(syncPath), 'remind-buddy-sync.json');
  const syncPayload = JSON.parse(fs.readFileSync(syncPath, 'utf8'));
  assert.equal(syncPayload.settings.theme, 'dark');
  assert.equal(syncPayload.reminders.length, 3);
  assert.equal(syncPayload.history.length, 1);
});

test('normalizeReminderList drops duplicate ids and caps entries', () => {
  const base = createReminderFromTemplate('water', { now: NOW });
  const duplicate = { ...base };
  const list = normalizeReminderList([base, duplicate], { now: NOW });
  assert.equal(list.length, 2);
  assert.notEqual(list[0].id, list[1].id);
  assert.deepEqual(normalizeReminderList(null), []);
  assert.equal(dateKey(NOW), '2026-10-24');
  assert.deepEqual(cloneDefaultSettings(), DEFAULT_SETTINGS);
});
