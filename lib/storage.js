'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { isPlainObject } = require('./common');
const {
  DEFAULT_SETTINGS,
  normalizeSettings
} = require('./settings');
const {
  createReminderFromTemplate,
  defaultReminders,
  legacyWaterReminder,
  normalizeReminderList
} = require('./reminders');
const {
  historyFilePayload,
  sanitizeHistory
} = require('./history');

const BACKUP_LIMIT = 5;
const FILES = Object.freeze({
  settings: 'settings.json',
  reminders: 'reminders.json',
  history: 'history.json',
  runtime: 'runtime.json'
});

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function backupStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function cleanRuntime(raw) {
  const runtime = {
    version: 1,
    lastCheckAt: null,
    pausedUntil: null,
    reminderStates: {}
  };
  if (!isPlainObject(raw)) return runtime;

  for (const key of ['lastCheckAt', 'pausedUntil']) {
    if (typeof raw[key] === 'string') {
      const date = new Date(raw[key]);
      if (!Number.isNaN(date.getTime())) runtime[key] = date.toISOString();
    }
  }

  if (isPlainObject(raw.reminderStates)) {
    for (const [id, entry] of Object.entries(raw.reminderStates)) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !isPlainObject(entry)) continue;
      const state = {};
      for (const key of [
        'snoozeUntil',
        'lastFiredAt',
        'lastDueAt',
        'lastIdleFiredAt',
        'startupDoneAt',
        'lastSnoozeAt',
        'nextDueAt'
      ]) {
        if (typeof entry[key] === 'string') {
          const date = new Date(entry[key]);
          if (!Number.isNaN(date.getTime())) state[key] = date.toISOString();
        }
      }
      if (Number.isInteger(entry.snoozeCount) && entry.snoozeCount >= 0 && entry.snoozeCount <= 100) {
        state.snoozeCount = entry.snoozeCount;
      }
      if (typeof entry.skippedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.skippedOn)) {
        state.skippedOn = entry.skippedOn;
      }
      if (typeof entry.lastOccurrenceKey === 'string' && entry.lastOccurrenceKey.length <= 80) {
        state.lastOccurrenceKey = entry.lastOccurrenceKey;
      }
      if (entry.pomodoro && isPlainObject(entry.pomodoro)) {
        const phase = entry.pomodoro.phase === 'break' ? 'break' : (entry.pomodoro.phase === 'focus' ? 'focus' : null);
        const startedAt = typeof entry.pomodoro.startedAt === 'string' ? new Date(entry.pomodoro.startedAt) : null;
        if (phase && startedAt && !Number.isNaN(startedAt.getTime())) {
          state.pomodoro = { phase, startedAt: startedAt.toISOString() };
        }
      }
      if (Object.keys(state).length > 0) runtime.reminderStates[id] = state;
    }
  }
  return runtime;
}

class DataStore {
  constructor(directory, { legacyDir = null, now = () => new Date(), logger = console } = {}) {
    this.dir = directory;
    this.legacyDir = legacyDir;
    this.now = now;
    this.logger = logger;
    this.backupsDir = path.join(directory, 'backups');
    this.paths = {
      settings: path.join(directory, FILES.settings),
      reminders: path.join(directory, FILES.reminders),
      history: path.join(directory, FILES.history),
      runtime: path.join(directory, FILES.runtime)
    };
    this.warnings = [];
    this.data = null;
  }

  warn(message) {
    this.warnings.push(message);
    this.logger?.warn?.(message);
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.mkdir(this.backupsDir, { recursive: true });

    const settingsState = await this.readJsonFile('settings', { backup: true });
    const remindersState = await this.readJsonFile('reminders', { backup: true });
    const historyState = await this.readJsonFile('history', { backup: true });
    const runtimeState = await this.readJsonFile('runtime', { backup: false });

    let migrated = false;
    let settings;
    let reminders;
    let events;

    if (settingsState.value) {
      settings = normalizeSettings(settingsState.value.settings ?? settingsState.value, { strict: false });
    }
    if (remindersState.value) {
      reminders = normalizeReminderList(remindersState.value.reminders ?? remindersState.value, {
        strict: false,
        now: this.now()
      });
    }
    if (historyState.value) {
      events = sanitizeHistory(historyState.value, { now: this.now() });
    }

    const needsMigration = remindersState.value === null && settingsState.value === null
      && await this.legacyDataAvailable();

    if (needsMigration) {
      const legacy = await this.readLegacyData();
      if (legacy) {
        migrated = true;
        settings = settings || legacy.settings;
        reminders = reminders || legacy.reminders;
        events = events || legacy.events;
        this.warn('Your Water Buddy settings and history were imported into Remind Buddy.');
      }
    }

    settings = settings || normalizeSettings({}, { strict: false });
    if (!remindersState.value && !migrated) {
      reminders = defaultReminders(this.now());
    }
    reminders = reminders || [];
    events = events || [];

    const runtime = cleanRuntime(runtimeState.value);

    this.data = {
      settings,
      reminders,
      events,
      runtime,
      migrated,
      seedsCreated: !remindersState.value && !migrated
    };

    if (!settingsState.value) await this.writeSettings(settings, { backup: false });
    if (!remindersState.value) await this.writeReminders(reminders, { backup: false });
    if (!historyState.value) await this.writeHistory(events, { backup: false });
    if (!runtimeState.value) await this.writeRuntime(runtime, { backup: false });

    return this.snapshot();
  }

  snapshot() {
    return {
      settings: this.data.settings,
      reminders: this.data.reminders,
      events: this.data.events,
      runtime: this.data.runtime,
      migrated: this.data.migrated,
      seedsCreated: this.data.seedsCreated,
      warnings: [...this.warnings],
      paths: { ...this.paths, characters: path.join(this.dir, 'characters') }
    };
  }

  async legacyDataAvailable() {
    if (!this.legacyDir) return false;
    const legacyPath = path.join(this.legacyDir, 'water-buddy.json');
    return fileExists(legacyPath);
  }

  async readLegacyData() {
    if (!this.legacyDir) return null;
    const legacyPath = path.join(this.legacyDir, 'water-buddy.json');
    try {
      const raw = JSON.parse(await fsp.readFile(legacyPath, 'utf8'));
      const legacySettings = isPlainObject(raw.settings) ? raw.settings : {};
      const settings = normalizeSettings({
        soundEnabled: legacySettings.soundEnabled,
        defaultCharacterId: typeof legacySettings.characterId === 'string' ? legacySettings.characterId : 'buddy',
        defaultCharacterScale: Number.isInteger(legacySettings.characterScale) ? legacySettings.characterScale : 100,
        randomCharacter: Boolean(legacySettings.randomCharacter),
        missedPolicy: 'show',
        defaultTimeoutSeconds: 60
      }, { strict: false });

      const water = legacyWaterReminder(legacySettings, { now: this.now() });
      const reminders = [
        water,
        createReminderFromTemplate('stretch', { now: this.now() }),
        createReminderFromTemplate('break', { now: this.now() })
      ];

      const events = [];
      const legacyHistory = isPlainObject(raw.history) ? raw.history : {};
      for (const [dayKey, entry] of Object.entries(legacyHistory)) {
        if (!isPlainObject(entry)) continue;
        const dayEvents = Array.isArray(entry.events) ? entry.events : [];
        for (const event of dayEvents) {
          if (!isPlainObject(event) || !['drank', 'skipped'].includes(event.type)) continue;
          const at = new Date(event.at);
          if (Number.isNaN(at.getTime())) continue;
          events.push({
            reminderId: water.id,
            reminderTitle: water.title,
            icon: water.icon,
            outcome: event.type === 'drank' ? 'done' : 'skipped',
            at: at.toISOString(),
            source: typeof event.source === 'string' && /^[a-z][a-z-]{0,30}$/.test(event.source) ? event.source : 'legacy',
            late: false
          });
        }
        const eventCounts = { done: 0, skipped: 0 };
        for (const event of dayEvents) {
          if (event?.type === 'drank') eventCounts.done += 1;
          if (event?.type === 'skipped') eventCounts.skipped += 1;
        }
        const missingDone = Math.max(0, (Number.isInteger(entry.drank) ? entry.drank : 0) - eventCounts.done);
        const missingSkipped = Math.max(0, (Number.isInteger(entry.skipped) ? entry.skipped : 0) - eventCounts.skipped);
        const fallbackAt = new Date(`${dayKey}T12:00:00`);
        if (!Number.isNaN(fallbackAt.getTime())) {
          for (let index = 0; index < missingDone; index += 1) {
            events.push({
              reminderId: water.id,
              reminderTitle: water.title,
              icon: water.icon,
              outcome: 'done',
              at: fallbackAt.toISOString(),
              source: 'legacy'
            });
          }
          for (let index = 0; index < missingSkipped; index += 1) {
            events.push({
              reminderId: water.id,
              reminderTitle: water.title,
              icon: water.icon,
              outcome: 'skipped',
              at: fallbackAt.toISOString(),
              source: 'legacy'
            });
          }
        }
      }

      return {
        settings,
        reminders,
        events: sanitizeHistory(events, { now: this.now() })
      };
    } catch (error) {
      this.warn(`Could not migrate the previous Water Buddy data: ${error.message}`);
      return null;
    }
  }

  backupPathFor(kind) {
    return path.join(this.backupsDir, path.basename(this.paths[kind], '.json'));
  }

  async readJsonFile(kind, { backup = true } = {}) {
    const filePath = this.paths[kind];
    if (fileExists(filePath)) {
      try {
        return { value: JSON.parse(await fsp.readFile(filePath, 'utf8')), restoredFrom: null };
      } catch (error) {
        this.warn(`${path.basename(filePath)} could not be read (${error.message}).`);
      }
    }
    if (backup) {
      const restored = await this.restoreBackup(kind);
      if (restored) return { value: restored.value, restoredFrom: restored.file };
    }
    return { value: null, restoredFrom: null };
  }

  async restoreBackup(kind) {
    const base = this.backupPathFor(kind);
    let entries;
    try {
      entries = await fsp.readdir(this.backupsDir);
    } catch {
      return null;
    }
    const prefix = `${path.basename(base)}-`;
    const candidates = entries
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort()
      .reverse();
    for (const name of candidates) {
      try {
        const value = JSON.parse(await fsp.readFile(path.join(this.backupsDir, name), 'utf8'));
        this.warn(`Restored ${path.basename(this.paths[kind])} from backup ${name}.`);
        return { value, file: name };
      } catch {
        // Try the next most recent backup.
      }
    }
    return null;
  }

  async backupFile(kind) {
    const source = this.paths[kind];
    if (!fileExists(source)) return null;
    const base = this.backupPathFor(kind);
    const stamp = backupStamp(this.now());
    let target = `${base}-${stamp}.json`;
    let suffix = 2;
    while (fileExists(target)) {
      target = `${base}-${stamp}-${suffix}.json`;
      suffix += 1;
    }
    try {
      await fsp.copyFile(source, target);
      const entries = (await fsp.readdir(this.backupsDir))
        .filter((name) => name.startsWith(`${path.basename(base)}-`) && name.endsWith('.json'))
        .sort();
      while (entries.length > BACKUP_LIMIT) {
        const oldest = entries.shift();
        await fsp.rm(path.join(this.backupsDir, oldest), { force: true });
      }
      return target;
    } catch (error) {
      this.warn(`Could not back up ${path.basename(source)}: ${error.message}`);
      return null;
    }
  }

  async writeJsonFile(kind, payload, { backup = true } = {}) {
    if (backup) await this.backupFile(kind);
    const target = this.paths[kind];
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    try {
      await fsp.writeFile(temporary, text, 'utf8');
      await fsp.rename(temporary, target);
    } catch (error) {
      try {
        await fsp.rm(temporary, { force: true });
      } catch {
        // Best-effort temporary file cleanup.
      }
      throw error;
    }
  }

  async writeSettings(settings, options = {}) {
    const stamp = this.now().toISOString();
    await this.writeJsonFile('settings', { version: 1, updatedAt: stamp, settings }, options);
    if (this.data) this.data.settings = settings;
  }

  async writeReminders(reminders, options = {}) {
    const stamp = this.now().toISOString();
    await this.writeJsonFile('reminders', { version: 1, updatedAt: stamp, reminders }, options);
    if (this.data) this.data.reminders = reminders;
  }

  async writeHistory(events, options = {}) {
    await this.writeJsonFile('history', historyFilePayload(events), options);
    if (this.data) this.data.events = events;
  }

  async writeRuntime(runtime, options = {}) {
    await this.writeJsonFile('runtime', { version: 1, savedAt: this.now().toISOString(), ...runtime }, { backup: false, ...options });
    if (this.data) this.data.runtime = runtime;
  }

  async save({
    settings = this.data?.settings,
    reminders = this.data?.reminders,
    events = this.data?.events,
    runtime = this.data?.runtime
  } = {}) {
    await this.writeSettings(settings);
    await this.writeReminders(reminders);
    await this.writeHistory(events);
    await this.writeRuntime(runtime);
    return this.snapshot();
  }

  exportData() {
    return {
      app: 'Remind Buddy',
      version: 1,
      exportedAt: this.now().toISOString(),
      settings: this.data.settings,
      reminders: this.data.reminders,
      history: this.data.events,
      runtime: this.data.runtime
    };
  }

  async importData(payload) {
    if (!isPlainObject(payload) || !Array.isArray(payload.reminders)) {
      throw new Error('This file does not contain a Remind Buddy backup.');
    }
    const settings = normalizeSettings(payload.settings ?? {}, { strict: true });
    const reminders = normalizeReminderList(payload.reminders, { strict: true, now: this.now() });
    const events = sanitizeHistory(payload.history ?? payload.events ?? [], { now: this.now() });
    const runtime = cleanRuntime(payload.runtime);

    await this.writeSettings(settings);
    await this.writeReminders(reminders);
    await this.writeHistory(events);
    await this.writeRuntime(runtime);
    this.data = {
      ...this.data,
      settings,
      reminders,
      events,
      runtime,
      migrated: this.data?.migrated || false,
      seedsCreated: false
    };
    return this.snapshot();
  }

  async writeSyncSnapshot(folder) {
    if (!folder) return null;
    await fsp.mkdir(folder, { recursive: true });
    const target = path.join(folder, 'remind-buddy-sync.json');
    const temporary = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(this.exportData(), null, 2)}\n`, 'utf8');
    await fsp.rename(temporary, target);
    return target;
  }
}

module.exports = {
  BACKUP_LIMIT,
  DataStore,
  FILES,
  cleanRuntime
};
