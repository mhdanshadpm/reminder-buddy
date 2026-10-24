'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
  globalShortcut
} = require('electron');
const { ValidationError, isPlainObject } = require('./lib/common');
const { DataStore } = require('./lib/storage');
const {
  dndWindowFor,
  isDndActive,
  normalizeSettings
} = require('./lib/settings');
const {
  TEMPLATE_META,
  buttonSnoozeAvailable,
  createReminderFromTemplate,
  duplicateReminder,
  effectiveTimeoutAction,
  normalizeReminder,
  scheduleSummary
} = require('./lib/reminders');
const {
  ReminderQueue,
  ReminderScheduler,
  findMissedReminders,
  localKey,
  nextTrigger,
  systemClock
} = require('./lib/scheduler');
const {
  messageContext,
  renderMessage,
  resolveMessages
} = require('./lib/messages');
const {
  appendEvent,
  countOutcomes,
  eventsForDay,
  eventsToCsv,
  summarizeDays
} = require('./lib/history');
const { createQuickAddReminder, parseQuickAdd } = require('./lib/quick-add');
const characters = require('./lib/characters');
const login = require('./lib/login');

const APP_NAME = 'Remind Buddy';
const APP_ID = 'com.remindbuddy.desktop';
const TEST_MODE = process.env.REMIND_BUDDY_TEST === '1' && !app.isPackaged;
const PROMPT_TIMEOUT_OVERRIDE = readPromptTimeoutOverride();
const MAX_CHARACTER_BYTES = 20 * 1024 * 1024;
const MAX_CHARACTER_CONFIG_BYTES = 200 * 1024;
const MAX_SOUND_BYTES = 10 * 1024 * 1024;
const QUEUE_RETRY_MS = 4_000;
const HEARTBEAT_MS = 60_000;
const MAX_OVERLAY_HEIGHT = 760;

app.setName(APP_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const userDataOverride = TEST_MODE && process.env.REMIND_BUDDY_USER_DATA
  ? path.resolve(process.env.REMIND_BUDDY_USER_DATA)
  : path.join(app.getPath('appData'), APP_NAME);
app.setPath('userData', userDataOverride);

const legacyDataDir = TEST_MODE
  ? (process.env.REMIND_BUDDY_LEGACY_DIR ? path.resolve(process.env.REMIND_BUDDY_LEGACY_DIR) : null)
  : path.join(app.getPath('appData'), 'Water Buddy');

function readPromptTimeoutOverride() {
  if (!TEST_MODE) return null;
  const raw = process.env.REMIND_BUDDY_PROMPT_TIMEOUT_MS;
  const candidate = Number.parseInt(raw, 10);
  if (!Number.isFinite(candidate)) return null;
  return Math.max(800, Math.min(600_000, candidate));
}

let store = null;
let settings = null;
let reminders = [];
let events = [];
let runtime = { version: 1, lastCheckAt: null, pausedUntil: null, reminderStates: {} };
let reminderStates = {};
let pausedUntil = null;
let appStartedAt = Date.now();
let lastCheckpointMs = null;

let mainWindow = null;
let quickAddWindow = null;
let pendingTab = 'reminders';
let mainWindowShouldShow = false;
let settingsWasRequested = false;
let isQuitting = false;
let screenLocked = false;
let secondInstanceCount = 0;
let tray = null;
let currentTrayMenu = null;
let trayMenuActions = new Map();

let queue = null;
let scheduler = null;
let presenting = false;
let overlayState = null;
let overlayWindows = [];
let overlayHitPollTimer = null;
let overlayHoverOverride = null;
let pumpTimer = null;
let pumpWakeAt = 0;
let pauseTimer = null;
let heartbeatTimer = null;
let runtimeSaveTimer = null;
let historySaveTimer = null;
let syncTimer = null;
let broadcastTimer = null;

let characterCatalog = { items: [], warnings: [] };
let characterScanWarning = null;
const sheetCache = new Map();

let quickAddShortcutError = null;
let lastSyncError = null;

function isPaused(now = Date.now()) {
  return pausedUntil !== null && pausedUntil > now;
}

function localeTag() {
  return settings?.language && settings.language !== 'system' ? settings.language : undefined;
}

function formatClock(ms) {
  if (!ms) return '';
  return new Intl.DateTimeFormat(localeTag(), { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

function formatWhen(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (sameDay) return formatClock(ms);
  if (date.toDateString() === tomorrow.toDateString()) {
    return `Tomorrow ${formatClock(ms)}`;
  }
  return new Intl.DateTimeFormat(localeTag(), {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function isoTimestamp(ms) {
  return new Date(ms).toISOString();
}

function parseTimestamp(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function ensureReminderState(reminderId) {
  if (!reminderStates[reminderId]) reminderStates[reminderId] = {};
  return reminderStates[reminderId];
}

function startupState() {
  try {
    return login.getStartupState();
  } catch (error) {
    return { supported: true, enabled: false, error: error.message };
  }
}

// ---------- Storage ----------

function syncReminderRuntimeReference() {
  runtime.reminderStates = reminderStates;
}

function saveRuntimeSoon(delay = 700) {
  if (!store) return;
  if (runtimeSaveTimer) clearTimeout(runtimeSaveTimer);
  syncReminderRuntimeReference();
  runtimeSaveTimer = setTimeout(async () => {
    runtimeSaveTimer = null;
    try {
      await store.writeRuntime(runtime);
    } catch (error) {
      console.error('Unable to save reminder runtime:', error);
    }
  }, delay);
}

function saveHistorySoon(delay = 1200) {
  if (!store) return;
  if (historySaveTimer) clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(async () => {
    historySaveTimer = null;
    try {
      await store.writeHistory(events);
      syncSoon();
    } catch (error) {
      console.error('Unable to save reminder history:', error);
    }
  }, delay);
}

async function saveRemindersNow() {
  await store.writeReminders(reminders);
  syncSoon();
}

async function saveSettingsNow() {
  await store.writeSettings(settings);
  syncSoon();
}

function syncSoon() {
  if (!settings?.syncFolder || !store) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    try {
      await store.writeSyncSnapshot(settings.syncFolder);
      lastSyncError = null;
    } catch (error) {
      lastSyncError = error.message;
      console.error('Unable to update the sync folder:', error);
    }
  }, 1600);
}

async function flushRuntimeNow() {
  if (!store) return;
  if (runtimeSaveTimer) {
    clearTimeout(runtimeSaveTimer);
    runtimeSaveTimer = null;
  }
  syncReminderRuntimeReference();
  try {
    await store.writeRuntime(runtime);
  } catch (error) {
    console.error('Unable to flush reminder runtime:', error);
  }
}

async function flushHistoryNow() {
  if (!store) return;
  if (historySaveTimer) {
    clearTimeout(historySaveTimer);
    historySaveTimer = null;
  }
  try {
    await store.writeHistory(events);
  } catch (error) {
    console.error('Unable to flush reminder history:', error);
  }
}

function flushStateSync() {
  if (!store) return;
  try {
    syncReminderRuntimeReference();
    writeJsonSync(store.paths.runtime, { version: 1, savedAt: new Date().toISOString(), ...runtime });
    writeJsonSync(store.paths.history, { version: 1, savedAt: new Date().toISOString(), events });
    writeJsonSync(store.paths.reminders, { version: 1, updatedAt: new Date().toISOString(), reminders });
    writeJsonSync(store.paths.settings, { version: 1, updatedAt: new Date().toISOString(), settings });
  } catch (error) {
    console.error('Unable to finish saving data on quit:', error);
  }
}

function writeJsonSync(target, payload) {
  const temporary = `${target}.${process.pid}.quit.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

// ---------- Characters ----------

function characterDirectories() {
  return {
    bundledDir: path.join(__dirname, 'assets', 'character'),
    userDir: path.join(store?.dir || app.getPath('userData'), 'characters')
  };
}

function readCharacterImageSize(sheetPath) {
  const image = nativeImage.createFromPath(sheetPath);
  if (image.isEmpty()) throw new Error('The sheet is not a readable image.');
  return image.getSize();
}

async function previewDataForCharacter(entry) {
  if (!entry.hasPreview || !entry.previewPath) return null;
  try {
    const stat = await fsp.stat(entry.previewPath);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return null;
    const image = nativeImage.createFromBuffer(await fsp.readFile(entry.previewPath));
    if (image.isEmpty()) return null;
    const png = image.toPNG();
    return png?.length ? `data:image/png;base64,${png.toString('base64')}` : null;
  } catch {
    return null;
  }
}

function publicCharacter(entry) {
  return {
    id: entry.id,
    name: entry.name,
    source: entry.source,
    valid: entry.valid,
    warning: entry.warning,
    hasPreview: entry.hasPreview,
    imageWidth: entry.imageWidth,
    imageHeight: entry.imageHeight,
    config: characters.cloneCharacterConfig(entry.config)
  };
}

function characterStateForSettings() {
  const { userDir } = characterDirectories();
  const wanted = settings.defaultCharacterId;
  const selected = characterCatalog.items.find(
    (item) => item.id.toLocaleLowerCase() === wanted.toLocaleLowerCase()
  ) || null;
  const selection = characters.resolveCharacterSelection(characterCatalog.items, {
    characterId: wanted,
    randomCharacter: false
  });
  return {
    items: characterCatalog.items.map(publicCharacter),
    userDir,
    selectedId: wanted,
    selectedName: selected?.name || null,
    selectedFound: Boolean(selected),
    selectedValid: Boolean(selected?.valid),
    effectiveId: selection.character?.id || null,
    builtinFallback: !characterCatalog.items.some((item) => item.valid),
    scanWarnings: [characterScanWarning, ...characterCatalog.warnings].filter(Boolean)
  };
}

async function scanCharacters({ broadcast = true } = {}) {
  const { bundledDir, userDir } = characterDirectories();
  characterScanWarning = null;
  try {
    await fsp.mkdir(userDir, { recursive: true });
  } catch (error) {
    characterScanWarning = `Could not prepare the characters folder: ${error.message}`;
  }

  try {
    characterCatalog = await characters.scanCharacterDirectories({
      bundledDir,
      userDir,
      readImageSize: async (sheetPath) => readCharacterImageSize(sheetPath)
    });
  } catch (error) {
    characterCatalog = { items: [], warnings: [] };
    characterScanWarning = `Could not scan characters: ${error.message}`;
    console.error('Unable to scan character folders:', error);
  }

  if (broadcast) broadcastState();
  return characterCatalog;
}

async function sheetDataForCharacter(entry) {
  const stat = await fsp.stat(entry.sheetPath);
  const cacheKey = `${stat.mtimeMs}:${stat.size}`;
  const cached = sheetCache.get(entry.id);
  if (cached && cached.key === cacheKey) return cached.value;

  const bytes = await fsp.readFile(entry.sheetPath);
  if (bytes.length === 0) throw new Error('The sheet file is empty.');
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('The sheet could not be decoded as an image.');
  const size = image.getSize();
  const geometry = characters.validateSheetGeometry(size.width, size.height, entry.config);
  if (!geometry.valid) throw new Error(geometry.errors.join(' '));
  const png = image.toPNG();
  if (!png || png.length === 0) throw new Error('The sheet could not be prepared.');
  const value = {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width: size.width,
    height: size.height
  };
  sheetCache.set(entry.id, { key: cacheKey, value });
  return value;
}

async function resolveReminderCharacter(reminder) {
  let characterId = settings.defaultCharacterId;
  let random = settings.randomCharacter;
  if (reminder.character?.mode === 'specific') {
    characterId = reminder.character.id;
    random = false;
  } else if (reminder.character?.mode === 'random') {
    random = true;
  }

  const selection = characters.resolveCharacterSelection(characterCatalog.items, {
    characterId,
    randomCharacter: random
  });
  const candidates = [];
  if (selection.character) candidates.push(selection.character);
  for (const item of characterCatalog.items) {
    if (!item.valid || candidates.includes(item)) continue;
    candidates.push(item);
  }

  for (const candidate of candidates) {
    try {
      const sheet = await sheetDataForCharacter(candidate);
      return {
        character: {
          ...publicCharacter(candidate),
          imageWidth: sheet.width,
          imageHeight: sheet.height
        },
        sheetDataUrl: sheet.dataUrl,
        requestedId: characterId,
        random: selection.random,
        usedFallback: selection.missing || candidate.id !== selection.character?.id
      };
    } catch (error) {
      console.warn(`Character "${candidate.id}" could not be loaded:`, error.message);
    }
  }

  return {
    character: null,
    sheetDataUrl: null,
    requestedId: characterId,
    random: selection.random,
    usedFallback: true
  };
}

function effectiveCharacterPercent(reminder, state) {
  const own = Math.max(50, Math.min(200, Number(reminder.character?.scale) || 100));
  const global = Math.max(50, Math.min(200, Number(settings.defaultCharacterScale) || 100));
  let percent = Math.round((own * global) / 100);
  if (reminder.snooze?.escalate === 'bigger' && state?.snoozeCount) {
    percent += Math.min(80, 20 * state.snoozeCount);
  }
  return Math.max(50, Math.min(200, percent));
}

async function characterDirectoryExists(dirPath) {
  try {
    await fsp.access(dirPath);
    return true;
  } catch {
    return false;
  }
}

async function nextCharacterFolder(userDir, name) {
  const base = characters.slugifyCharacterName(name);
  let candidate = base;
  let suffix = 2;
  while (await characterDirectoryExists(path.join(userDir, candidate))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
    if (suffix > 999) break;
  }
  return candidate;
}

function bytesFromPayload(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

async function addCharacterFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: ['Invalid character request.'] };
  }
  const nameError = characters.validateCharacterName(payload.name);
  if (nameError) return { ok: false, errors: [nameError] };
  const name = String(payload.name).trim();
  const sheetBytes = bytesFromPayload(payload.sheetBytes);
  if (!sheetBytes || sheetBytes.length === 0) {
    return { ok: false, errors: ['Choose a sheet.png file.'] };
  }
  if (sheetBytes.length > MAX_CHARACTER_BYTES) {
    return { ok: false, errors: ['That sheet is larger than 20 MB.'] };
  }

  let configSource = {};
  if (payload.configText !== undefined && payload.configText !== null && String(payload.configText).trim()) {
    const configText = String(payload.configText);
    if (Buffer.byteLength(configText, 'utf8') > MAX_CHARACTER_CONFIG_BYTES) {
      return { ok: false, errors: ['That character.json file is too large.'] };
    }
    try {
      configSource = JSON.parse(configText);
    } catch (error) {
      return { ok: false, errors: [`character.json is not valid JSON: ${error.message}`] };
    }
  }

  const normalized = characters.normalizeCharacterConfig(configSource, {
    folderName: characters.slugifyCharacterName(name)
  });
  if (normalized.errors.length > 0) {
    return { ok: false, errors: normalized.errors.map((error) => error.replace(/^character\.json /, '')) };
  }

  const image = nativeImage.createFromBuffer(sheetBytes);
  if (image.isEmpty()) {
    return { ok: false, errors: ['That file could not be read as a sheet image. Choose a PNG image.'] };
  }
  const size = image.getSize();
  const geometry = characters.validateSheetGeometry(size.width, size.height, normalized.config);
  if (!geometry.valid) {
    return {
      ok: false,
      errors: [
        ...geometry.errors,
        `A ${normalized.config.columns} × ${normalized.config.rows} grid needs pixel dimensions that divide evenly.`
      ]
    };
  }

  const { userDir } = characterDirectories();
  let folderName;
  let folderPath;
  try {
    await fsp.mkdir(userDir, { recursive: true });
    folderName = await nextCharacterFolder(userDir, name);
    folderPath = path.join(userDir, folderName);
    await fsp.mkdir(folderPath);
    await fsp.writeFile(path.join(folderPath, 'sheet.png'), sheetBytes);
    const savedConfig = { ...normalized.config, name };
    await fsp.writeFile(
      path.join(folderPath, 'character.json'),
      `${JSON.stringify(savedConfig, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    if (folderPath) {
      try {
        await fsp.rm(folderPath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of a partially copied character.
      }
    }
    return { ok: false, errors: [`Could not add the character: ${error.message}`] };
  }

  sheetCache.delete(folderName);
  await scanCharacters();
  return {
    ok: true,
    addedId: folderName,
    warnings: normalized.warnings,
    state: buildPublicState()
  };
}

// ---------- Sounds ----------

function soundsDirectory() {
  return path.join(store?.dir || app.getPath('userData'), 'sounds');
}

function audioMime(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.wav') return 'audio/wav';
  if (extension === '.mp3') return 'audio/mpeg';
  if (extension === '.ogg' || extension === '.oga') return 'audio/ogg';
  if (extension === '.m4a') return 'audio/mp4';
  if (extension === '.flac') return 'audio/flac';
  return null;
}

async function readCustomSound(fileName) {
  if (!fileName || path.basename(fileName) !== fileName) return null;
  const mime = audioMime(fileName);
  if (!mime) return null;
  const filePath = path.join(soundsDirectory(), fileName);
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_SOUND_BYTES) return null;
    const bytes = await fsp.readFile(filePath);
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

async function chooseSoundFile() {
  const result = await dialog.showOpenDialog(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    title: 'Choose a reminder sound',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'm4a', 'flac'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  const source = result.filePaths[0];
  let stat;
  try {
    stat = await fsp.stat(source);
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
  if (!stat.isFile() || stat.size > MAX_SOUND_BYTES) {
    return { ok: false, errors: ['Choose an audio file smaller than 10 MB.'] };
  }
  const extension = path.extname(source).toLowerCase();
  if (!audioMime(`sound${extension}`)) {
    return { ok: false, errors: ['Choose a WAV, MP3, OGG, M4A, or FLAC file.'] };
  }
  const safeBase = path.basename(source, extension)
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .slice(0, 60) || 'sound';
  const fileName = `${safeBase}-${Date.now()}${extension}`;
  try {
    await fsp.mkdir(soundsDirectory(), { recursive: true });
    await fsp.copyFile(source, path.join(soundsDirectory(), fileName));
  } catch (error) {
    return { ok: false, errors: [`Could not copy the sound: ${error.message}`] };
  }
  return { ok: true, fileName, label: path.basename(source) };
}

async function overlaySoundFor(reminder) {
  if (!settings.soundEnabled) return null;
  const choice = reminder.character?.sound || 'default';
  if (choice === 'none') return null;
  let customDataUrl = null;
  let fallback = false;
  if (choice === 'custom') {
    customDataUrl = await readCustomSound(reminder.character.soundFile);
    if (!customDataUrl) fallback = true;
  }
  return {
    volume: Math.max(0, Math.min(100, Number(settings.soundVolume) || 0)) / 100,
    customDataUrl,
    fallback
  };
}

// ---------- Messages and overlay payload ----------

function renderedVariations(list, context) {
  return (Array.isArray(list) ? list : [])
    .map((entry) => renderMessage(entry, context).trim())
    .filter(Boolean);
}

function snoozeDelayFor(reminder, state = {}) {
  const base = Math.max(1, Number(reminder.snooze?.minutes) || 10);
  const nextCount = (Number(state.snoozeCount) || 0) + 1;
  if (reminder.snooze?.escalate === 'frequent' && nextCount > 1) {
    return Math.max(1, Math.round(base / Math.pow(1.6, nextCount - 1)));
  }
  return base;
}

function renderMessagesFor(reminder, { phase = null, missedCount = 0, state = {} } = {}) {
  const resolved = resolveMessages(reminder.messages, settings.messages);
  const context = messageContext(reminder, new Date(), {
    snoozeMinutes: snoozeDelayFor(reminder, state),
    count: missedCount
  });

  let questionSource = resolved.question;
  if (phase === 'break' && resolved.pomodoroBreak.length > 0) {
    questionSource = resolved.pomodoroBreak;
  } else if (phase === 'focus' && resolved.pomodoroFocus.length > 0) {
    questionSource = resolved.pomodoroFocus;
  }

  const question = renderedVariations(questionSource, context);
  return {
    context,
    question: question.length > 0 ? question : [reminder.title],
    positive: renderedVariations(resolved.positive, context),
    negative: renderedVariations(resolved.negative, context),
    neutral: renderedVariations(resolved.neutral, context),
    snooze: renderedVariations(resolved.snooze, context),
    skip: renderedVariations(resolved.skipped, context),
    skipped: renderedVariations(resolved.skipped, context),
    note: renderMessage(reminder.notes || '', context).trim()
  };
}

function timeoutSpecFor(reminder, state) {
  if (reminder.type === 'note') {
    return {
      timeoutMs: Math.max(3, Number(reminder.autoDismissSeconds) || 8) * 1000,
      timeoutAction: 'dismiss',
      timeoutSource: 'auto'
    };
  }
  if (reminder.type === 'timer' || reminder.priority === 'high') {
    return { timeoutMs: null, timeoutAction: null, timeoutSource: null };
  }
  let action = effectiveTimeoutAction(reminder, settings) || 'negative';
  if (action === 'snooze' && !buttonSnoozeAvailable(reminder, state.snoozeCount || 0)) {
    action = 'negative';
  }
  let timeoutMs = Math.max(10, Number(settings.defaultTimeoutSeconds) || 60) * 1000;
  if (PROMPT_TIMEOUT_OVERRIDE) timeoutMs = Math.min(timeoutMs, PROMPT_TIMEOUT_OVERRIDE);
  return { timeoutMs, timeoutAction: action, timeoutSource: 'timeout' };
}

async function buildOverlayPayload(reminder, item, { test = false } = {}) {
  const state = reminderStates[reminder.id] || {};
  const characterState = await resolveReminderCharacter(reminder);
  const messages = renderMessagesFor(reminder, {
    phase: item.trigger?.phase || null,
    missedCount: item.missedCount || 0,
    state
  });
  const snoozeAvailable = buttonSnoozeAvailable(reminder, state.snoozeCount || 0);
  const timeout = timeoutSpecFor(reminder, state);
  const activeButtons = reminder.type === 'note' ? [] : reminder.buttons.map((button) => ({
    id: button.id,
    label: button.label,
    icon: button.icon || '',
    action: button.action,
    reaction: button.reaction,
    disabled: button.action === 'snooze' && !snoozeAvailable
  }));

  return {
    appName: APP_NAME,
    reminder: {
      id: reminder.id,
      title: reminder.title,
      icon: reminder.icon,
      color: reminder.color,
      category: reminder.category,
      type: reminder.type,
      priority: reminder.priority,
      notes: messages.note,
      specialAnimation: reminder.specialAnimation,
      timerMinutes: reminder.timerMinutes,
      autoDismissSeconds: reminder.autoDismissSeconds
    },
    question: messages.question,
    messages: {
      question: messages.question,
      positive: messages.positive,
      negative: messages.negative,
      neutral: messages.neutral,
      snooze: messages.snooze,
      skip: messages.skip,
      skipped: messages.skipped
    },
    note: messages.note,
    buttons: activeButtons,
    missed: Boolean(item.missed),
    missedCount: item.missedCount || 1,
    test: Boolean(test),
    phase: item.trigger?.phase || null,
    dueAt: item.dueAt || item.trigger?.at || Date.now(),
    source: item.reason || 'schedule',
    character: characterState.character,
    sheetDataUrl: characterState.sheetDataUrl,
    sizePercent: effectiveCharacterPercent(reminder, state),
    sound: await overlaySoundFor(reminder),
    theme: settings.theme,
    language: settings.language,
    timeoutMs: timeout.timeoutMs,
    timeoutAction: timeout.timeoutAction,
    timeoutSource: timeout.timeoutSource,
    timerSeconds: reminder.type === 'timer' ? Math.max(1, Number(reminder.timerMinutes) || 10) * 60 : null,
    queueCount: queue ? queue.size : 0
  };
}

// ---------- Public state ----------

function nextForReminder(reminder, now) {
  if (!reminder.enabled) return null;
  if (overlayState?.reminderId === reminder.id) {
    return { at: now, reason: 'showing', phase: overlayState.trigger?.phase || null };
  }
  const queued = queue?.toArray().find((item) => item.reminderId === reminder.id);
  if (queued) {
    return {
      at: queued.dueAt,
      reason: queued.missed ? 'missed' : queued.reason,
      phase: queued.phase || null
    };
  }
  const trigger = nextTrigger(reminder, {
    clock: systemClock,
    now,
    runtime: reminderStates[reminder.id] || {},
    settings,
    pausedUntil,
    appStartedAt
  });
  return trigger
    ? { at: trigger.at, reason: trigger.reason, phase: trigger.phase || null }
    : null;
}

function buildPublicState() {
  const nowDate = new Date();
  const now = nowDate.getTime();
  const dayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const tomorrowStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1).getTime();
  const dayEvents = eventsForDay(events, nowDate);
  const todayCounts = countOutcomes(dayEvents);
  const nextById = {};

  for (const reminder of reminders) {
    nextById[reminder.id] = nextForReminder(reminder, now);
  }

  const upcomingToday = reminders
    .map((reminder) => {
      const next = nextById[reminder.id];
      if (!next || next.reason === 'showing') return null;
      if (next.at < now || next.at >= tomorrowStart) return null;
      return {
        reminderId: reminder.id,
        title: reminder.title,
        icon: reminder.icon,
        color: reminder.color,
        at: next.at,
        reason: next.reason,
        phase: next.phase || null
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.at - right.at)
    .slice(0, 24);

  const goals = reminders
    .filter((reminder) => reminder.tracking?.dailyGoal)
    .map((reminder) => {
      const done = dayEvents.filter((event) => event.reminderId === reminder.id && event.outcome === 'done').length;
      const goal = reminder.tracking.dailyGoal;
      return {
        reminderId: reminder.id,
        title: reminder.title,
        icon: reminder.icon,
        color: reminder.color,
        done,
        goal,
        percent: goal > 0 ? Math.min(100, Math.round((done / goal) * 100)) : 0,
        streak: computeStreak(reminder.id, nowDate)
      };
    });

  const overlaySummary = overlayState
    ? {
      visible: true,
      reminderId: overlayState.reminderId,
      title: overlayState.reminder.title,
      icon: overlayState.reminder.icon,
      test: overlayState.test,
      missed: overlayState.missed,
      missedCount: overlayState.missedCount,
      promptShown: overlayState.promptShown,
      resolved: overlayState.resolved,
      source: overlayState.item.reason || 'schedule',
      windowCount: overlayWindows.length
    }
    : null;

  const nextCandidates = Object.values(nextById)
    .filter((next) => next && next.reason !== 'showing')
    .sort((left, right) => left.at - right.at);
  const nextAt = nextCandidates.length > 0 ? nextCandidates[0].at : null;

  return {
    appName: APP_NAME,
    appVersion: app.getVersion(),
    now: nowDate.toISOString(),
    settings,
    reminders,
    templates: TEMPLATE_META,
    characters: characterStateForSettings(),
    nextById,
    schedule: {
      nextAt,
      pausedUntil: pausedUntil ? isoTimestamp(pausedUntil) : null,
      paused: isPaused(now),
      dndActive: isDndActive(settings.dnd, nowDate),
      queue: queue ? queue.toArray().map((item) => ({
        id: item.id,
        reminderId: item.reminderId,
        title: item.title,
        dueAt: item.dueAt,
        missed: item.missed,
        missedCount: item.missedCount
      })) : []
    },
    overlay: overlaySummary,
    today: {
      dateKey: localKey(systemClock, now),
      events: dayEvents.slice().sort((left, right) => new Date(right.at) - new Date(left.at)),
      counts: todayCounts,
      goals,
      upcoming: upcomingToday,
      missed: dayEvents.filter((event) => event.outcome === 'missed').length
    },
    history: {
      days7: summarizeDays(events, 7, nowDate),
      days30: summarizeDays(events, 30, nowDate),
      counts: countOutcomes(events)
    },
    startup: startupState(),
    quickAdd: {
      shortcut: settings.quickAddShortcut,
      error: quickAddShortcutError
    },
    data: {
      path: store?.dir || '',
      dataFile: store?.paths.settings || '',
      warnings: [...(store?.warnings || []), ...(lastSyncError ? [`Sync folder: ${lastSyncError}`] : [])],
      syncFolder: settings.syncFolder,
      migrated: Boolean(store?.data?.migrated),
      seedsCreated: Boolean(store?.data?.seedsCreated)
    },
    promptTimeoutMs: Math.max(10, Number(settings.defaultTimeoutSeconds) || 60) * 1000
  };
}

function computeStreak(reminderId, nowDate) {
  const keys = new Set();
  for (const event of events) {
    if (event.reminderId !== reminderId || event.outcome !== 'done') continue;
    keys.add(localKey(systemClock, new Date(event.at).getTime()));
  }
  if (keys.size === 0) return 0;
  let cursor = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 12);
  if (!keys.has(localKey(systemClock, cursor.getTime()))) {
    cursor = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 1, 12);
    if (!keys.has(localKey(systemClock, cursor.getTime()))) return 0;
  }
  let streak = 0;
  while (keys.has(localKey(systemClock, cursor.getTime()))) {
    streak += 1;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1, 12);
  }
  return streak;
}

function broadcastStateSoon() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastState();
  }, 120);
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoadingMainFrame()) return;
  try {
    mainWindow.webContents.send('app:state', buildPublicState());
  } catch (error) {
    console.error('Unable to update the main window:', error);
  }
}

// ---------- Tray ----------

function globalNext() {
  const now = Date.now();
  let best = null;
  for (const reminder of reminders) {
    if (!reminder.enabled) continue;
    if (overlayState?.reminderId === reminder.id) continue;
    if (queue?.has(reminder.id)) {
      const item = queue.toArray().find((entry) => entry.reminderId === reminder.id);
      if (item && (!best || item.dueAt < best.at)) {
        best = { at: item.dueAt, reminder, reason: item.reason };
      }
      continue;
    }
    const trigger = nextTrigger(reminder, {
      clock: systemClock,
      now,
      runtime: reminderStates[reminder.id] || {},
      settings,
      pausedUntil,
      appStartedAt
    });
    if (trigger && (!best || trigger.at < best.at)) {
      best = { at: trigger.at, reminder, reason: trigger.reason };
    }
  }
  return best;
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const paused = isPaused();
  const menuActions = new Map();
  const action = (label, handler) => {
    menuActions.set(label, handler);
    return { label, click: handler };
  };
  const next = globalNext();
  const nextLabel = paused
    ? `Paused until ${formatClock(pausedUntil)}`
    : (next ? `Next: ${next.reminder.title} · ${formatWhen(next.at)}` : 'No upcoming reminders');

  const template = [
    action('Open Remind Buddy', () => showMainWindow('reminders')),
    action('Quick add…', () => openQuickAddWindow()),
    { type: 'separator' },
    { label: nextLabel, enabled: false },
    { type: 'separator' },
    action('Pause for 30 minutes', () => pauseFor(30)),
    action('Pause for 1 hour', () => pauseFor(60)),
    action('Pause until tomorrow', () => pauseUntilTomorrow()),
    action('Resume reminders', () => resumeReminders()),
    { type: 'separator' },
    action('Quit', () => quitApp())
  ];

  const [openItem, quickItem, , nextItem, separatorA, pause30, pause60, pauseTomorrow, resume, , quitItem] = template;
  if (resume) resume.enabled = paused;
  if (nextItem) nextItem.enabled = false;
  if (pause30) pause30.enabled = !paused;
  if (pause60) pause60.enabled = !paused;
  if (pauseTomorrow) pauseTomorrow.enabled = !paused;
  if (openItem) openItem.visible = true;
  if (quickItem) quickItem.visible = true;
  if (separatorA) separatorA.visible = true;
  if (quitItem) quitItem.visible = true;

  currentTrayMenu = Menu.buildFromTemplate(template);
  trayMenuActions = menuActions;
  tray.setContextMenu(currentTrayMenu);

  let tooltip = APP_NAME;
  if (overlayState && !overlayState.resolved) {
    tooltip += ` - waiting: ${overlayState.reminder.title}`;
  } else if (paused) {
    tooltip += ` - paused until ${formatClock(pausedUntil)}`;
  } else if (next) {
    tooltip += ` - next: ${next.reminder.title} at ${formatClock(next.at)}`;
  }
  tray.setToolTip(tooltip);
}

function createTray() {
  const iconName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const iconPath = path.join(__dirname, 'assets', iconName);
  let image = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') image.setTemplateImage(true);
  if (image.isEmpty()) {
    console.error(`Could not load tray icon from ${iconPath}`);
  }

  tray = new Tray(image);
  tray.on('double-click', () => showMainWindow('reminders'));
  if (process.platform === 'win32') {
    tray.on('click', () => showMainWindow('reminders'));
  }
  refreshTray();
}

// ---------- Windows ----------

function secureWindowOptions() {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false
  };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 920,
    minHeight: 640,
    show: false,
    title: `${APP_NAME}`,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#f6f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      ...secureWindowOptions(),
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => {
    if (mainWindowShouldShow) {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('app:navigate', { tab: pendingTab });
    mainWindow.webContents.send('app:state', buildPublicState());
  });
  mainWindow.on('show', () => {
    if (!mainWindow || mainWindow.webContents.isLoadingMainFrame()) return;
    mainWindow.webContents.send('app:navigate', { tab: pendingTab });
    mainWindow.webContents.send('app:state', buildPublicState());
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'app.html'));
}

function showMainWindow(tab = 'reminders') {
  if (isQuitting) return;
  pendingTab = tab;
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindowShouldShow = true;
    createMainWindow();
    return;
  }
  mainWindowShouldShow = true;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (!mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.send('app:navigate', { tab });
    mainWindow.webContents.send('app:state', buildPublicState());
  }
}

function openQuickAddWindow(prefill = '') {
  if (isQuitting) return;
  if (!quickAddWindow || quickAddWindow.isDestroyed()) {
    quickAddWindow = new BrowserWindow({
      width: 560,
      height: 360,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Quick add reminder',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      backgroundColor: '#f6f7fb',
      alwaysOnTop: true,
      autoHideMenuBar: true,
      webPreferences: {
        ...secureWindowOptions(),
        preload: path.join(__dirname, 'preload.js')
      }
    });
    quickAddWindow.setMenuBarVisibility(false);
    quickAddWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    quickAddWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    quickAddWindow.once('ready-to-show', () => {
      quickAddWindow?.show();
      quickAddWindow?.focus();
    });
    quickAddWindow.webContents.on('did-finish-load', () => {
      quickAddWindow?.webContents.send('quickadd:prefill', { text: prefill });
    });
    quickAddWindow.on('closed', () => {
      quickAddWindow = null;
    });
    quickAddWindow.loadFile(path.join(__dirname, 'renderer', 'quick-add.html'));
    return;
  }

  if (quickAddWindow.isMinimized()) quickAddWindow.restore();
  quickAddWindow.show();
  quickAddWindow.focus();
  if (!quickAddWindow.webContents.isLoadingMainFrame()) {
    quickAddWindow.webContents.send('quickadd:prefill', { text: prefill });
  }
}

function quitApp() {
  if (isQuitting) return;
  isQuitting = true;
  try {
    scheduler?.stop();
  } catch {
    // Ignore shutdown errors.
  }
  clearRuntimeTimers();
  globalShortcut.unregisterAll();
  closeOverlayWindows();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  mainWindow = null;
  if (quickAddWindow && !quickAddWindow.isDestroyed()) quickAddWindow.destroy();
  quickAddWindow = null;
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
  flushStateSync();
  app.quit();
}

// ---------- Timers ----------

function clearPauseTimer() {
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = null;
}

function clearPumpTimer() {
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpTimer = null;
  pumpWakeAt = 0;
}

function clearOverlayTimers(overlay) {
  if (!overlay) return;
  if (overlay.promptTimer) clearTimeout(overlay.promptTimer);
  if (overlay.loadGuard) clearTimeout(overlay.loadGuard);
  if (overlay.doneGuard) clearTimeout(overlay.doneGuard);
  overlay.promptTimer = null;
  overlay.loadGuard = null;
  overlay.doneGuard = null;
}

function clearRuntimeTimers() {
  clearPauseTimer();
  clearPumpTimer();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (runtimeSaveTimer) clearTimeout(runtimeSaveTimer);
  runtimeSaveTimer = null;
  if (historySaveTimer) clearTimeout(historySaveTimer);
  historySaveTimer = null;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = null;
  stopOverlayHitPolling();
}

function armPauseTimer() {
  clearPauseTimer();
  if (!pausedUntil || isQuitting) return;
  const remaining = pausedUntil - Date.now();
  if (remaining <= 0) {
    expirePause();
    return;
  }
  pauseTimer = setTimeout(() => {
    pauseTimer = null;
    expirePause();
  }, remaining + 40);
}

function pauseFor(minutes) {
  setPausedUntil(Date.now() + Math.max(1, minutes) * 60_000);
}

function pauseUntilTomorrow() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  setPausedUntil(tomorrow.getTime());
}

function setPausedUntil(ms) {
  pausedUntil = ms;
  runtime.pausedUntil = ms ? isoTimestamp(ms) : null;
  armPauseTimer();
  saveRuntimeSoon(100);
  scheduler?.refresh();
  refreshTray();
  broadcastStateSoon();
  clearPumpTimer();
  pumpQueue();
}

function resumeReminders() {
  pausedUntil = null;
  runtime.pausedUntil = null;
  clearPauseTimer();
  saveRuntimeSoon(100);
  scheduler?.refresh();
  refreshTray();
  broadcastStateSoon();
  pumpQueue();
}

function expirePause() {
  if (!pausedUntil) return;
  pausedUntil = null;
  runtime.pausedUntil = null;
  clearPauseTimer();
  saveRuntimeSoon(100);
  scheduler?.refresh();
  refreshTray();
  broadcastStateSoon();
  pumpQueue();
}

function schedulePump(delay = QUEUE_RETRY_MS) {
  if (isQuitting) return;
  const wait = Math.max(40, delay);
  const wakeAt = Date.now() + wait;
  if (pumpTimer) {
    if (wakeAt >= pumpWakeAt) return;
    clearTimeout(pumpTimer);
    pumpTimer = null;
  }
  pumpWakeAt = wakeAt;
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    pumpWakeAt = 0;
    pumpQueue();
  }, wait);
}

// ---------- Scheduler ----------

function schedulerState() {
  const pendingIds = [];
  if (overlayState?.reminderId) pendingIds.push(overlayState.reminderId);
  if (queue) {
    for (const item of queue.toArray()) {
      if (!pendingIds.includes(item.reminderId)) pendingIds.push(item.reminderId);
    }
  }
  return {
    reminders,
    runtime: { reminderStates },
    settings,
    pausedUntil,
    appStartedAt,
    pendingIds,
    getIdleSeconds: () => {
      try {
        return powerMonitor.getSystemIdleTime();
      } catch {
        return 0;
      }
    }
  };
}

function handleDue({ reminder, trigger, reason }) {
  if (isQuitting) return;
  const current = reminders.find((entry) => entry.id === reminder.id);
  if (!current || !current.enabled) return;
  const now = Date.now();
  const state = ensureReminderState(reminder.id);
  if (reason === 'idle') {
    state.lastIdleFiredAt = isoTimestamp(now);
  } else {
    state.lastDueAt = isoTimestamp(trigger.at);
    state.lastFiredAt = isoTimestamp(now);
  }
  if (reason === 'startup') state.startupDoneAt = isoTimestamp(now);
  if (trigger.phase) {
    state.pomodoro = { phase: trigger.phase, startedAt: isoTimestamp(trigger.at) };
  }

  queue.enqueue(reminder, trigger);
  saveRuntimeSoon(150);
  refreshTray();
  broadcastStateSoon();
  pumpQueue();
}

function initializeScheduler() {
  queue = new ReminderQueue({ now: () => Date.now() });
  scheduler = new ReminderScheduler({
    getState: schedulerState,
    onDue: handleDue,
    onError: (error) => console.error('Reminder scheduler error:', error)
  });
  scheduler.start();
}

// ---------- Missed reminders ----------

function catchUpMissed() {
  if (!queue) return;
  const now = Date.now();
  if (lastCheckpointMs === null) {
    lastCheckpointMs = now;
    runtime.lastCheckAt = isoTimestamp(now);
    saveRuntimeSoon(500);
    return;
  }
  if (now - lastCheckpointMs < 2_000) return;

  const findings = findMissedReminders(reminders, {
    now: new Date(now),
    lastSeenAt: new Date(lastCheckpointMs),
    runtime,
    settings: { ...settings, missedPolicy: 'show' }
  });

  let changed = false;
  for (const finding of findings) {
    const reminder = finding.reminder;
    const policy = reminder.schedule.missedPolicy && reminder.schedule.missedPolicy !== 'inherit'
      ? reminder.schedule.missedPolicy
      : settings.missedPolicy;
    const state = ensureReminderState(reminder.id);
    state.lastDueAt = isoTimestamp(finding.at);
    changed = true;

    if (policy !== 'show') continue;
    if (reminder.tracking.log) {
      events = appendEvent(events, {
        reminderId: reminder.id,
        reminderTitle: reminder.title,
        icon: reminder.icon,
        outcome: 'missed',
        at: isoTimestamp(finding.at),
        dueAt: isoTimestamp(finding.at),
        source: 'missed'
      }, new Date(now));
    }
    const trigger = {
      at: finding.at,
      reason: 'missed',
      phase: finding.phase || null,
      key: `missed:${isoTimestamp(finding.at)}`
    };
    queue.enqueue(reminder, trigger, {
      missed: true,
      missedCount: finding.missedCount || 1
    });
  }

  lastCheckpointMs = now;
  runtime.lastCheckAt = isoTimestamp(now);
  if (changed) {
    saveHistorySoon(100);
    saveRuntimeSoon(100);
    scheduler?.refresh();
    refreshTray();
    broadcastStateSoon();
    pumpQueue();
  } else {
    saveRuntimeSoon(500);
  }
}

// ---------- Queue and overlay ----------

function fullscreenLikely() {
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return display.bounds.width === display.workArea.width
      && display.bounds.height === display.workArea.height;
  } catch {
    return false;
  }
}

function queueItemHoldReason(item, reminder, now) {
  if (item.test) return null;
  if (isPaused(now) && reminder.priority !== 'high' && reminder.schedule.skipPaused !== false) {
    return { until: pausedUntil };
  }
  if (reminder.schedule.skipDnd !== false) {
    const window = dndWindowFor(new Date(now), settings.dnd);
    if (window) return { until: window.end.getTime() };
  }
  if (screenLocked && reminder.schedule.skipLocked !== false) {
    return { until: null };
  }
  if (settings.skipFullscreen && reminder.priority !== 'high' && fullscreenLikely()) {
    return { until: null };
  }
  return null;
}

function pumpQueue() {
  if (isQuitting || overlayState || presenting) return;
  clearPumpTimer();
  if (!queue || queue.size === 0) return;

  const item = queue.peek();
  if (!item) return;
  const reminder = reminders.find((entry) => entry.id === item.reminderId);
  if (!reminder || !reminder.enabled) {
    queue.remove(item.reminderId);
    scheduler?.refresh();
    schedulePump(200);
    return;
  }

  const now = Date.now();
  const hold = queueItemHoldReason(item, reminder, now);
  if (hold) {
    if (hold.until && hold.until > now) {
      schedulePump(Math.min(hold.until - now + 500, 24 * 60 * 60 * 1000));
    } else if (!screenLocked) {
      schedulePump(QUEUE_RETRY_MS);
    }
    return;
  }

  if (!settings.overlayEnabled && !item.test) {
    const shifted = queue.shift();
    if (shifted) {
      if (settings.notifyFallback) notifyReminder(reminder, shifted);
      scheduler?.refresh();
    }
    schedulePump(1200);
    return;
  }

  const shifted = queue.shift();
  if (!shifted) {
    schedulePump(900);
    return;
  }
  presentReminder(reminder, shifted, { test: Boolean(shifted.test) })
    .then((result) => {
      if (!result.ok) {
        if (!presenting && !overlayState) schedulePump(1200);
      }
    })
    .catch((error) => {
      console.error('Unable to present reminder:', error);
      schedulePump(2000);
    });
}

function notifyReminder(reminder, item) {
  if (!settings.notifyFallback) return;
  let body = reminder.title;
  try {
    const messages = renderMessagesFor(reminder, {
      phase: item.trigger?.phase || null,
      missedCount: item.missedCount || 0,
      state: reminderStates[reminder.id] || {}
    });
    body = messages.question[0] || reminder.title;
    if (messages.note) body = `${body} ${messages.note}`.trim();
  } catch {
    // Fall back to the reminder title if message rendering fails.
  }
  if (item.missed) body = `Missed reminder: ${body}`;
  try {
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: `${reminder.icon} ${item.missed ? 'Missed: ' : ''}${reminder.title}`,
        body,
        silent: !settings.soundEnabled,
        icon: path.join(__dirname, 'assets', 'icon.png')
      });
      notification.on('click', () => showMainWindow('today'));
      notification.show();
      return;
    }
    if (tray && !tray.isDestroyed()) {
      tray.displayBalloon({
        title: `${reminder.icon} ${reminder.title}`,
        content: body,
        icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'))
      });
    }
  } catch (error) {
    console.error('Unable to show a fallback notification:', error);
  }
}

function overlayDisplays() {
  const cursor = screen.getCursorScreenPoint();
  if (settings.display === 'primary') return [screen.getPrimaryDisplay()];
  if (settings.display === 'all') {
    const displays = screen.getAllDisplays();
    return displays.length > 0 ? displays : [screen.getPrimaryDisplay()];
  }
  return [screen.getDisplayNearestPoint(cursor)];
}

function pointInRegions(point, bounds, regions) {
  for (const region of regions) {
    if (
      point.x >= bounds.x + region.x
      && point.x <= bounds.x + region.x + region.width
      && point.y >= bounds.y + region.y
      && point.y <= bounds.y + region.y + region.height
    ) {
      return true;
    }
  }
  return false;
}

function applyOverlayIgnore(entry, ignore) {
  if (!entry || !entry.win || entry.win.isDestroyed()) return;
  if (entry.ignoring === ignore) return;
  entry.ignoring = ignore;
  try {
    if (ignore) entry.win.setIgnoreMouseEvents(true, { forward: true });
    else entry.win.setIgnoreMouseEvents(false);
  } catch {
    // Window may be closing.
  }
}

function pollOverlayHitRegions() {
  if (!overlayState) {
    stopOverlayHitPolling();
    return;
  }
  const point = overlayHoverOverride || screen.getCursorScreenPoint();
  for (const entry of overlayWindows) {
    if (!entry.win || entry.win.isDestroyed()) continue;
    let ignore = true;
    if (!overlayState.resolved && entry.hitRegions.length > 0) {
      const bounds = entry.win.getContentBounds();
      ignore = !pointInRegions(point, bounds, entry.hitRegions);
    }
    applyOverlayIgnore(entry, ignore);
  }
}

function startOverlayHitPolling() {
  if (overlayHitPollTimer) return;
  overlayHitPollTimer = setInterval(pollOverlayHitRegions, 120);
}

function stopOverlayHitPolling() {
  if (overlayHitPollTimer) clearInterval(overlayHitPollTimer);
  overlayHitPollTimer = null;
}

function createOverlayWindow(display) {
  const area = display.workArea;
  const win = new BrowserWindow({
    x: Math.round(area.x),
    y: Math.round(area.y),
    width: Math.round(area.width),
    height: Math.round(area.height),
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      ...secureWindowOptions(),
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform !== 'win32') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  const entry = {
    win,
    displayId: display.id,
    hitRegions: [],
    ignoring: true
  };

  const ready = new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    win.webContents.once('did-finish-load', () => settle(true));
    win.webContents.once('did-fail-load', () => settle(false));
    setTimeout(() => settle(false), 12_000);
  });

  win.on('closed', () => {
    const index = overlayWindows.indexOf(entry);
    if (index !== -1) overlayWindows.splice(index, 1);
    if (overlayState && !overlayState.resolved && overlayWindows.length === 0 && !isQuitting) {
      closeActiveOverlay();
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'overlay.html')).catch(() => {});
  return { entry, ready };
}

async function presentReminder(reminder, item, { test = false } = {}) {
  if (isQuitting) return { ok: false, error: 'The app is closing.' };
  if (overlayState) return { ok: false, error: 'A reminder is already on screen.' };
  if (presenting) return { ok: false, error: 'A reminder is already being prepared.' };
  if (!test && !settings.overlayEnabled) {
    if (settings.notifyFallback) notifyReminder(reminder, item);
    return { ok: false, fallback: true, error: 'The overlay is turned off.' };
  }

  presenting = true;
  let createdState = null;
  try {
    const payload = await buildOverlayPayload(reminder, item, { test });
    if (isQuitting) return { ok: false, error: 'The app is closing.' };

    const displays = overlayDisplays();
    const overlay = {
      reminderId: reminder.id,
      reminder,
      item,
      trigger: item.trigger || { at: item.dueAt || Date.now(), reason: item.reason || 'manual' },
      dueAt: item.dueAt || Date.now(),
      test,
      missed: Boolean(item.missed),
      missedCount: item.missedCount || 1,
      resolved: false,
      answer: null,
      source: null,
      promptShown: false,
      promptTimer: null,
      loadGuard: null,
      doneGuard: null,
      payload,
      windows: []
    };
    overlayState = overlay;
    createdState = overlay;

    const creations = displays.map((display) => createOverlayWindow(display));
    overlayWindows = creations.map((created) => created.entry);
    overlay.windows = overlayWindows;

    const loaded = await Promise.all(creations.map((created) => created.ready));
    if (overlayState !== overlay) {
      return { ok: false, error: 'The reminder was cancelled.' };
    }
    const liveEntries = overlayWindows.filter((entry) => entry.win && !entry.win.isDestroyed());
    if (liveEntries.length === 0 || !loaded.some(Boolean)) {
      throw new Error('The reminder window could not be loaded.');
    }

    liveEntries.forEach((entry, index) => {
      try {
        entry.win.webContents.send('overlay:show', {
          ...payload,
          playSound: index === 0
        });
        entry.win.showInactive();
      } catch (error) {
        console.error('Unable to show the reminder window:', error);
      }
    });

    startOverlayHitPolling();
    overlay.loadGuard = setTimeout(() => {
      if (overlayState !== overlay || overlay.promptShown || overlay.resolved) return;
      console.error('The reminder overlay did not become ready in time.');
      closeActiveOverlay();
      if (settings.notifyFallback) notifyReminder(reminder, item);
      schedulePump(1200);
    }, 12_000);

    refreshTray();
    broadcastStateSoon();
    return { ok: true };
  } catch (error) {
    console.error('Unable to show reminder:', error);
    if (overlayState && overlayState === createdState) closeActiveOverlay();
    if (!test && settings.notifyFallback) notifyReminder(reminder, item);
    return { ok: false, error: error.message };
  } finally {
    presenting = false;
  }
}

function sendToOverlayWindows(channel, payload) {
  for (const entry of overlayWindows) {
    if (!entry.win || entry.win.isDestroyed()) continue;
    try {
      entry.win.webContents.send(channel, payload);
    } catch {
      // The window may be closing.
    }
  }
}

function startPromptTimeout(overlay) {
  if (!overlay || overlay.resolved || !overlay.payload.timeoutMs) return;
  if (overlay.promptTimer) clearTimeout(overlay.promptTimer);
  overlay.promptTimer = setTimeout(() => {
    if (overlayState !== overlay || overlay.resolved) return;
    resolveActiveOverlay({ answer: '__timeout__', source: overlay.payload.timeoutSource || 'timeout' });
  }, Math.max(500, overlay.payload.timeoutMs));
}

function behaviorOutcome(behavior) {
  switch (behavior) {
    case 'positive':
    case 'neutral':
      return 'done';
    case 'negative':
    case 'skip':
      return 'skipped';
    case 'snooze':
      return 'snoozed';
    case 'dismiss':
      return 'ignored';
    default:
      return null;
  }
}

function applyOverlayResolution(overlay, resolution) {
  if (overlay.test) return;
  const reminder = overlay.reminder;
  const state = ensureReminderState(reminder.id);
  const now = Date.now();
  const nowIso = isoTimestamp(now);
  const behavior = resolution.behavior;

  if (behavior === 'snooze') {
    const minutes = snoozeDelayFor(reminder, state);
    state.snoozeCount = (Number(state.snoozeCount) || 0) + 1;
    state.snoozeUntil = isoTimestamp(now + minutes * 60_000);
    state.lastSnoozeAt = nowIso;
  } else {
    state.snoozeUntil = null;
    state.snoozeCount = 0;
  }

  if (behavior === 'skip') {
    state.skippedOn = localKey(systemClock, now);
  }
  if (reminder.schedule.kind === 'startup') {
    state.startupDoneAt = nowIso;
  }

  const outcome = behaviorOutcome(behavior);
  const shouldLog = reminder.tracking?.log !== false && !(reminder.type === 'note' && overlay.source === 'auto');
  if (outcome && shouldLog) {
    const event = {
      reminderId: reminder.id,
      reminderTitle: reminder.title,
      icon: reminder.icon,
      outcome,
      at: nowIso,
      dueAt: isoTimestamp(overlay.dueAt),
      source: overlay.source || 'button',
      late: overlay.missed
    };
    if (overlay.answer) {
      event.answerId = overlay.answer.id;
      event.answerLabel = overlay.answer.label;
    }
    if (behavior === 'snooze') {
      event.snoozeMinutes = snoozeDelayFor(reminder, { snoozeCount: (state.snoozeCount || 0) - 1 });
    }
    events = appendEvent(events, event, new Date(now));
    saveHistorySoon(100);
  }

  saveRuntimeSoon(100);
  scheduler?.refresh();
  refreshTray();
  broadcastStateSoon();
}

function resolveActiveOverlay({ answer, source = 'button' }) {
  const overlay = overlayState;
  if (!overlay) return { ok: false, error: 'No reminder is waiting.' };
  if (overlay.resolved) return { ok: false, error: 'This reminder was already answered.' };

  let behavior = null;
  let reaction = null;
  let answerRecord = null;

  if (answer === '__timeout__') {
    behavior = overlay.payload.timeoutAction || 'negative';
    reaction = behavior;
    source = overlay.payload.timeoutSource || 'timeout';
  } else if (answer === '__timer__') {
    if (overlay.reminder.type !== 'timer') return { ok: false, error: 'This reminder has no timer.' };
    behavior = 'positive';
    reaction = 'positive';
    source = 'timer';
  } else {
    const button = overlay.reminder.buttons.find((entry) => entry.id === answer);
    if (!button) return { ok: false, error: 'That answer is not available.' };
    if (button.action === 'snooze'
      && !buttonSnoozeAvailable(overlay.reminder, reminderStates[overlay.reminderId]?.snoozeCount || 0)) {
      return { ok: false, error: 'You have reached the snooze limit for this reminder.' };
    }
    behavior = button.action;
    reaction = button.reaction || button.action;
    answerRecord = { id: button.id, label: button.label };
    source = source === 'timeout' ? 'timeout' : 'button';
  }

  if (behavior === 'snooze'
    && !buttonSnoozeAvailable(overlay.reminder, reminderStates[overlay.reminderId]?.snoozeCount || 0)) {
    behavior = 'negative';
    reaction = 'negative';
  }

  overlay.resolved = true;
  overlay.answer = answerRecord;
  overlay.source = source;
  clearOverlayTimers(overlay);
  overlay.doneGuard = setTimeout(() => {
    if (!overlayState || overlayState !== overlay) return;
    closeActiveOverlay();
  }, 10_000);

  applyOverlayResolution(overlay, { behavior, reaction, answer: answerRecord });

  const result = {
    action: reaction || 'dismiss',
    behavior,
    outcome: overlay.test ? null : behaviorOutcome(behavior),
    source,
    late: overlay.missed,
    test: overlay.test
  };
  sendToOverlayWindows('overlay:resolve', result);
  refreshTray();
  return { ok: true, ...result };
}

function closeOverlayWindows() {
  stopOverlayHitPolling();
  for (const entry of overlayWindows) {
    if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
  }
  overlayWindows = [];
}

function closeActiveOverlay() {
  const overlay = overlayState;
  if (overlay) clearOverlayTimers(overlay);
  closeOverlayWindows();
  overlayState = null;
  overlayHoverOverride = null;
  presenting = false;
  scheduler?.refresh();
  refreshTray();
  broadcastStateSoon();
  schedulePump(300);
}

// ---------- History and data operations ----------

function filteredEvents(payload = {}) {
  let filtered = events.slice();
  const from = parseTimestamp(payload.from);
  const to = parseTimestamp(payload.to);
  if (from !== null) filtered = filtered.filter((event) => new Date(event.at).getTime() >= from);
  if (to !== null) filtered = filtered.filter((event) => new Date(event.at).getTime() <= to);
  if (typeof payload.reminderId === 'string' && payload.reminderId) {
    filtered = filtered.filter((event) => event.reminderId === payload.reminderId);
  }
  if (Array.isArray(payload.outcomes) && payload.outcomes.length > 0) {
    const allowed = new Set(payload.outcomes);
    filtered = filtered.filter((event) => allowed.has(event.outcome));
  }
  return filtered;
}

function queryHistory(payload = {}) {
  const filtered = filteredEvents(payload);
  const now = new Date();
  const reminderId = typeof payload.reminderId === 'string' && payload.reminderId ? payload.reminderId : null;
  return {
    events: filtered.slice(-1500).reverse(),
    total: filtered.length,
    counts: countOutcomes(filtered),
    summaries: {
      days7: summarizeDays(filtered, 7, now, reminderId),
      days30: summarizeDays(filtered, 30, now, reminderId)
    },
    streak: reminderId ? computeStreak(reminderId, now) : null
  };
}

function reminderPreview(rawReminder) {
  let reminder;
  try {
    reminder = normalizeReminder(rawReminder, { strict: false });
  } catch {
    return { ok: false, errors: ['The reminder draft could not be read.'] };
  }
  const messages = renderMessagesFor(reminder, {
    state: reminderStates[reminder.id] || {}
  });
  return {
    ok: true,
    question: messages.question,
    messages: {
      positive: messages.positive,
      negative: messages.negative,
      neutral: messages.neutral,
      snooze: messages.snooze,
      skip: messages.skip,
      skipped: messages.skipped
    },
    note: messages.note,
    buttons: reminder.buttons,
    schedule: scheduleSummary(reminder),
    title: reminder.title,
    icon: reminder.icon,
    color: reminder.color,
    type: reminder.type,
    sizePercent: effectiveCharacterPercent(reminder, reminderStates[reminder.id] || {})
  };
}

async function saveReminder(raw) {
  if (!isPlainObject(raw)) return { ok: false, errors: ['Invalid reminder payload.'] };
  let reminder;
  try {
    reminder = normalizeReminder(raw, { strict: true });
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, errors: error.errors };
    return { ok: false, errors: [error.message] };
  }

  const index = reminders.findIndex((entry) => entry.id === reminder.id);
  if (index === -1) {
    let duplicateId = reminders.some((entry) => entry.id === reminder.id);
    while (duplicateId) {
      reminder = normalizeReminder({ ...reminder, id: undefined }, { strict: true });
      duplicateId = reminders.some((entry) => entry.id === reminder.id);
    }
    if (reminders.length >= 500) {
      return { ok: false, errors: ['You can keep at most 500 reminders.'] };
    }
    reminders.push(reminder);
  } else {
    reminder.createdAt = reminders[index].createdAt;
    reminders[index] = reminder;
    if (!reminder.enabled) {
      queue?.remove(reminder.id);
      if (overlayState?.reminderId === reminder.id && !overlayState.resolved) closeActiveOverlay();
      delete reminderStates[reminder.id];
      saveRuntimeSoon(100);
    }
  }

  try {
    await saveRemindersNow();
  } catch (error) {
    return { ok: false, errors: [`Could not save the reminder: ${error.message}`] };
  }
  scheduler?.refresh();
  refreshTray();
  broadcastStateSoon();
  pumpQueue();
  return { ok: true, reminder, state: buildPublicState() };
}

async function deleteReminder(id) {
  const index = reminders.findIndex((entry) => entry.id === id);
  if (index === -1) return { ok: false, errors: ['That reminder no longer exists.'] };
  reminders.splice(index, 1);
  queue?.remove(id);
  if (overlayState?.reminderId === id) closeActiveOverlay();
  delete reminderStates[id];
  try {
    await saveRemindersNow();
    saveRuntimeSoon(100);
  } catch (error) {
    return { ok: false, errors: [`Could not delete the reminder: ${error.message}`] };
  }
  scheduler?.refresh();
  refreshTray();
  broadcastStateSoon();
  pumpQueue();
  return { ok: true, state: buildPublicState() };
}

async function toggleReminder(id, enabled) {
  const reminder = reminders.find((entry) => entry.id === id);
  if (!reminder) return { ok: false, errors: ['That reminder no longer exists.'] };
  reminder.enabled = Boolean(enabled);
  reminder.updatedAt = new Date().toISOString();
  if (!reminder.enabled) {
    queue?.remove(id);
    if (overlayState?.reminderId === id && !overlayState.resolved) closeActiveOverlay();
  }
  try {
    await saveRemindersNow();
  } catch (error) {
    return { ok: false, errors: [`Could not update the reminder: ${error.message}`] };
  }
  scheduler?.refresh();
  refreshTray();
  broadcastStateSoon();
  if (reminder.enabled) pumpQueue();
  return { ok: true, state: buildPublicState() };
}

async function duplicateExistingReminder(id) {
  const reminder = reminders.find((entry) => entry.id === id);
  if (!reminder) return { ok: false, errors: ['That reminder no longer exists.'] };
  let copy;
  try {
    copy = duplicateReminder(reminder);
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
  const index = reminders.findIndex((entry) => entry.id === id);
  reminders.splice(index + 1, 0, copy);
  try {
    await saveRemindersNow();
  } catch (error) {
    reminders.splice(reminders.indexOf(copy), 1);
    return { ok: false, errors: [`Could not duplicate the reminder: ${error.message}`] };
  }
  scheduler?.refresh();
  refreshTray();
  broadcastStateSoon();
  return { ok: true, reminder: copy, state: buildPublicState() };
}

async function reorderReminders(ids) {
  if (!Array.isArray(ids) || ids.length !== reminders.length) {
    return { ok: false, errors: ['The reminder order is invalid.'] };
  }
  const byId = new Map(reminders.map((reminder) => [reminder.id, reminder]));
  const reordered = [];
  for (const id of ids) {
    const reminder = byId.get(id);
    if (!reminder) return { ok: false, errors: ['The reminder order is invalid.'] };
    reordered.push(reminder);
    byId.delete(id);
  }
  if (byId.size !== 0) return { ok: false, errors: ['The reminder order is invalid.'] };
  reminders = reordered;
  try {
    await saveRemindersNow();
  } catch (error) {
    return { ok: false, errors: [`Could not save the reminder order: ${error.message}`] };
  }
  refreshTray();
  broadcastStateSoon();
  return { ok: true, state: buildPublicState() };
}

function testOverlayItem(reminder, now) {
  return {
    reminderId: reminder.id,
    title: reminder.title,
    priority: reminder.priority,
    type: reminder.type,
    dueAt: now,
    reason: 'test',
    missed: false,
    missedCount: 1,
    test: true,
    trigger: { at: now, reason: 'test', key: `test:${now}` }
  };
}

async function showReminderTest(reminder) {
  if (overlayState) return { ok: false, errors: ['Finish the reminder that is on screen first.'] };
  if (presenting) return { ok: false, errors: ['Another reminder is being prepared.'] };
  const now = Date.now();
  const result = await presentReminder(reminder, testOverlayItem(reminder, now), { test: true });
  return result.ok ? { ok: true } : { ok: false, errors: [result.error || 'Could not show the reminder.'] };
}

async function testReminderNow(id) {
  const reminder = reminders.find((entry) => entry.id === id);
  if (!reminder) return { ok: false, errors: ['That reminder no longer exists.'] };
  return showReminderTest(reminder);
}

async function testReminderDraft(raw) {
  if (!isPlainObject(raw)) return { ok: false, errors: ['Invalid reminder payload.'] };
  let reminder;
  try {
    reminder = normalizeReminder(raw, { strict: true });
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, errors: error.errors };
    return { ok: false, errors: [error.message] };
  }
  return showReminderTest(reminder);
}

async function saveSettingsPayload(payload) {
  if (!isPlainObject(payload) || !isPlainObject(payload.settings)) {
    return { ok: false, errors: ['Invalid settings request.'] };
  }
  let nextSettings;
  try {
    nextSettings = normalizeSettings(payload.settings, { strict: true });
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, errors: error.errors };
    return { ok: false, errors: [error.message] };
  }

  let startupError = null;
  if (typeof payload.startAtLogin === 'boolean') {
    try {
      login.setStartupEnabled(payload.startAtLogin);
    } catch (error) {
      startupError = error.message;
    }
  }

  settings = nextSettings;
  nativeTheme.themeSource = settings.theme;
  registerQuickAddShortcut();
  try {
    await saveSettingsNow();
  } catch (error) {
    return { ok: false, errors: [`Could not save settings: ${error.message}`] };
  }
  scheduler?.refresh();
  refreshTray();
  broadcastStateSoon();
  return { ok: true, state: buildPublicState(), startupError, shortcutError: quickAddShortcutError };
}

function registerQuickAddShortcut() {
  quickAddShortcutError = null;
  globalShortcut.unregisterAll();
  const accelerator = settings?.quickAddShortcut;
  if (!accelerator) return;
  try {
    const registered = globalShortcut.register(accelerator, () => openQuickAddWindow());
    if (!registered) quickAddShortcutError = `The shortcut ${accelerator} is already used by another app.`;
  } catch (error) {
    quickAddShortcutError = `The shortcut ${accelerator} could not be registered: ${error.message}`;
  }
}

// ---------- Backup ----------

async function exportBackup() {
  const result = await dialog.showSaveDialog(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    title: 'Export Remind Buddy data',
    defaultPath: path.join(app.getPath('documents'), `remind-buddy-backup-${localKey(systemClock, Date.now())}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    const payload = store.exportData();
    await fsp.writeFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    return { ok: false, errors: [`Could not export data: ${error.message}`] };
  }
}

async function exportHistoryCsv(payload) {
  const result = await dialog.showSaveDialog(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    title: 'Export reminder history',
    defaultPath: path.join(app.getPath('documents'), `remind-buddy-history-${localKey(systemClock, Date.now())}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    await fsp.writeFile(result.filePath, eventsToCsv(filteredEvents(payload)), 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    return { ok: false, errors: [`Could not export history: ${error.message}`] };
  }
}

async function importBackup() {
  const result = await dialog.showOpenDialog(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    title: 'Import Remind Buddy data',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  const filePath = result.filePaths[0];
  let payload;
  try {
    payload = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`That file is not valid JSON: ${error.message}`] };
  }
  const confirmation = await dialog.showMessageBox(
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    {
      type: 'warning',
      buttons: ['Cancel', 'Replace my data'],
      defaultId: 1,
      cancelId: 0,
      title: 'Replace Remind Buddy data?',
      message: 'Importing this backup will replace all reminders, history, and settings.',
      detail: 'Your current data is backed up automatically in the app data folder before the import is written.'
    }
  );
  if (confirmation.response !== 1) return { ok: false, canceled: true };

  try {
    const imported = await store.importData(payload);
    settings = imported.settings;
    reminders = imported.reminders;
    events = imported.events;
    runtime = imported.runtime;
    reminderStates = runtime.reminderStates || {};
    pausedUntil = runtime.pausedUntil ? parseTimestamp(runtime.pausedUntil) : null;
    lastCheckpointMs = Date.now();
    runtime.lastCheckAt = isoTimestamp(lastCheckpointMs);
    queue?.clear();
    if (overlayState) closeActiveOverlay();
    nativeTheme.themeSource = settings.theme;
    registerQuickAddShortcut();
    await saveRuntimeNowAfterImport();
    await scanCharacters({ broadcast: false });
    scheduler?.refresh();
    refreshTray();
    broadcastStateSoon();
    pumpQueue();
    return { ok: true, state: buildPublicState() };
  } catch (error) {
    return { ok: false, errors: [`Could not import data: ${error.message}`] };
  }
}

async function saveRuntimeNowAfterImport() {
  syncReminderRuntimeReference();
  await store.writeRuntime(runtime);
}

async function chooseSyncFolder() {
  const result = await dialog.showOpenDialog(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    title: 'Choose a sync folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  const folder = result.filePaths[0];
  settings = { ...settings, syncFolder: folder };
  try {
    await saveSettingsNow();
    await store.writeSyncSnapshot(folder);
    lastSyncError = null;
  } catch (error) {
    lastSyncError = error.message;
    return { ok: false, errors: [`Could not use that sync folder: ${error.message}`] };
  }
  broadcastStateSoon();
  return { ok: true, folder, state: buildPublicState() };
}

async function syncNow() {
  if (!settings.syncFolder) return { ok: false, errors: ['Choose a sync folder first.'] };
  try {
    const target = await store.writeSyncSnapshot(settings.syncFolder);
    lastSyncError = null;
    broadcastStateSoon();
    return { ok: true, filePath: target };
  } catch (error) {
    lastSyncError = error.message;
    return { ok: false, errors: [`Could not update the sync folder: ${error.message}`] };
  }
}

// ---------- IPC ----------

function isMainSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

function isQuickAddSender(event) {
  return Boolean(quickAddWindow && !quickAddWindow.isDestroyed() && event.sender === quickAddWindow.webContents);
}

function overlayEntryFor(event) {
  return overlayWindows.find((entry) => entry.win && !entry.win.isDestroyed() && entry.win.webContents === event.sender) || null;
}

function registerIpc() {
  ipcMain.handle('app:get-state', (event) => {
    if (!isMainSender(event)) return null;
    return buildPublicState();
  });

  ipcMain.handle('app:save-settings', async (event, payload) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    return saveSettingsPayload(payload);
  });

  ipcMain.handle('app:open-data-folder', async (event) => {
    if (!isMainSender(event)) return { ok: false, error: 'Unauthorized request.' };
    const error = await shell.openPath(store.dir);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('app:quit', (event) => {
    if (!isMainSender(event)) return { ok: false };
    quitApp();
    return { ok: true };
  });

  ipcMain.handle('app:pause', (event, payload) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    const minutes = payload && payload.untilTomorrow ? null : Number(payload?.minutes);
    if (minutes === null) {
      pauseUntilTomorrow();
    } else if (Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60) {
      pauseFor(minutes);
    } else {
      return { ok: false, errors: ['Invalid pause duration.'] };
    }
    return { ok: true, state: buildPublicState() };
  });

  ipcMain.handle('app:resume', (event) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    resumeReminders();
    return { ok: true, state: buildPublicState() };
  });

  ipcMain.handle('reminders:save', async (event, raw) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    return saveReminder(raw);
  });

  ipcMain.handle('reminders:delete', async (event, id) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    if (typeof id !== 'string') return { ok: false, errors: ['Invalid reminder.'] };
    return deleteReminder(id);
  });

  ipcMain.handle('reminders:toggle', async (event, payload) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    if (!payload || typeof payload.id !== 'string' || typeof payload.enabled !== 'boolean') {
      return { ok: false, errors: ['Invalid reminder update.'] };
    }
    return toggleReminder(payload.id, payload.enabled);
  });

  ipcMain.handle('reminders:duplicate', async (event, id) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    if (typeof id !== 'string') return { ok: false, errors: ['Invalid reminder.'] };
    return duplicateExistingReminder(id);
  });

  ipcMain.handle('reminders:reorder', async (event, ids) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    return reorderReminders(ids);
  });

  ipcMain.handle('reminders:test', async (event, id) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    if (typeof id !== 'string') return { ok: false, errors: ['Invalid reminder.'] };
    return testReminderNow(id);
  });

  ipcMain.handle('reminders:test-draft', async (event, raw) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    return testReminderDraft(raw);
  });

  ipcMain.handle('reminders:template', (event, templateId) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    if (typeof templateId !== 'string' || templateId.length === 0 || templateId.length > 40) {
      return { ok: false, errors: ['Invalid template selection.'] };
    }
    try {
      return { ok: true, reminder: createReminderFromTemplate(templateId) };
    } catch (error) {
      return { ok: false, errors: [error.message] };
    }
  });

  ipcMain.handle('reminders:preview', (event, raw) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    return reminderPreview(raw);
  });

  ipcMain.handle('history:query', (event, payload) => {
    if (!isMainSender(event)) return null;
    return queryHistory(isPlainObject(payload) ? payload : {});
  });

  ipcMain.handle('history:export', async (event, payload) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    return exportHistoryCsv(isPlainObject(payload) ? payload : {});
  });

  ipcMain.handle('backup:export', async (event) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    return exportBackup();
  });

  ipcMain.handle('backup:import', async (event) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    return importBackup();
  });

  ipcMain.handle('backup:choose-sync-folder', async (event) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    return chooseSyncFolder();
  });

  ipcMain.handle('backup:sync-now', async (event) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    return syncNow();
  });

  ipcMain.handle('sound:choose', async (event) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    return chooseSoundFile();
  });

  ipcMain.handle('characters:rescan', async (event) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    await scanCharacters({ broadcast: false });
    broadcastStateSoon();
    return { ok: true, state: buildPublicState() };
  });

  ipcMain.handle('characters:sheet', async (event, rawId) => {
    if (!isMainSender(event)) return { ok: false, error: 'Unauthorized request.' };
    if (typeof rawId !== 'string' || rawId.length === 0 || rawId.length > 80) {
      return { ok: false, error: 'Invalid character selection.' };
    }
    const entry = characterCatalog.items.find(
      (item) => item.id.toLocaleLowerCase() === rawId.toLocaleLowerCase()
    );
    if (!entry) return { ok: false, error: 'That character is no longer available.' };
    if (!entry.valid) {
      return { ok: false, error: entry.warning || 'That character sheet is not usable.', character: publicCharacter(entry) };
    }
    try {
      const sheet = await sheetDataForCharacter(entry);
      return {
        ok: true,
        dataUrl: sheet.dataUrl,
        width: sheet.width,
        height: sheet.height,
        previewDataUrl: await previewDataForCharacter(entry),
        character: {
          ...publicCharacter(entry),
          imageWidth: sheet.width,
          imageHeight: sheet.height
        }
      };
    } catch (error) {
      return { ok: false, error: error.message, character: publicCharacter(entry) };
    }
  });

  ipcMain.handle('characters:add', async (event, payload) => {
    if (!isMainSender(event)) return { ok: false, errors: ['Unauthorized request.'] };
    try {
      return await addCharacterFromPayload(payload);
    } catch (error) {
      console.error('Unable to add character:', error);
      return { ok: false, errors: [`Could not add the character: ${error.message}`] };
    }
  });

  ipcMain.handle('characters:open-folder', async (event) => {
    if (!isMainSender(event)) return { ok: false, error: 'Unauthorized request.' };
    const { userDir } = characterDirectories();
    try {
      await fsp.mkdir(userDir, { recursive: true });
      const error = await shell.openPath(userDir);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('quickadd:open', (event) => {
    if (!isMainSender(event)) return { ok: false, error: 'Unauthorized request.' };
    openQuickAddWindow();
    return { ok: true };
  });

  ipcMain.handle('quickadd:parse', (event, text) => {
    if (!isMainSender(event) && !isQuickAddSender(event)) {
      return { ok: false, error: 'Unauthorized request.' };
    }
    if (typeof text !== 'string' || text.length > 240) {
      return { ok: false, error: 'Type a short reminder first.' };
    }
    return parseQuickAdd(text, { now: new Date() });
  });

  ipcMain.handle('quickadd:save', async (event, text) => {
    if (!isMainSender(event) && !isQuickAddSender(event)) {
      return { ok: false, errors: ['Unauthorized request.'] };
    }
    if (typeof text !== 'string' || text.length > 240) {
      return { ok: false, errors: ['Type a short reminder first.'] };
    }
    let created;
    try {
      created = createQuickAddReminder(text, { now: new Date() });
    } catch (error) {
      return { ok: false, errors: [error.message] };
    }
    if (!created.ok) return { ok: false, errors: [created.error] };
    if (reminders.length >= 500) return { ok: false, errors: ['You can keep at most 500 reminders.'] };
    reminders.push(created.reminder);
    try {
      await saveRemindersNow();
    } catch (error) {
      reminders.pop();
      return { ok: false, errors: [`Could not add the reminder: ${error.message}`] };
    }
    scheduler?.refresh();
    refreshTray();
    broadcastStateSoon();
    if (quickAddWindow && !quickAddWindow.isDestroyed()) quickAddWindow.hide();
    pumpQueue();
    return { ok: true, reminder: created.reminder, state: buildPublicState() };
  });

  ipcMain.on('quickadd:close', (event) => {
    if (!isQuickAddSender(event)) return;
    quickAddWindow?.hide();
  });

  ipcMain.on('overlay:prompt-shown', (event) => {
    if (!overlayEntryFor(event) || !overlayState) return;
    if (overlayState.promptShown || overlayState.resolved) return;
    overlayState.promptShown = true;
    if (overlayState.loadGuard) {
      clearTimeout(overlayState.loadGuard);
      overlayState.loadGuard = null;
    }
    startPromptTimeout(overlayState);
    broadcastStateSoon();
  });

  ipcMain.on('overlay:set-click-through', (event, ignore) => {
    const entry = overlayEntryFor(event);
    if (!entry) return;
    applyOverlayIgnore(entry, Boolean(ignore));
  });

  ipcMain.on('overlay:set-hit-regions', (event, rawRegions) => {
    const entry = overlayEntryFor(event);
    if (!entry) return;
    if (!Array.isArray(rawRegions) || rawRegions.length > 8) {
      entry.hitRegions = [];
      pollOverlayHitRegions();
      return;
    }
    entry.hitRegions = rawRegions
      .filter((region) => region && typeof region === 'object')
      .map((region) => ({
        x: Math.max(0, Math.round(Number(region.x) || 0)),
        y: Math.max(0, Math.round(Number(region.y) || 0)),
        width: Math.max(0, Math.min(20_000, Math.round(Number(region.width) || 0))),
        height: Math.max(0, Math.min(20_000, Math.round(Number(region.height) || 0)))
      }))
      .filter((region) => region.width > 0 && region.height > 0);
    pollOverlayHitRegions();
  });

  ipcMain.handle('overlay:respond', (event, answer) => {
    if (!overlayEntryFor(event) || !overlayState) {
      return { ok: false, error: 'No reminder is waiting.' };
    }
    if (typeof answer !== 'string') return { ok: false, error: 'Invalid answer.' };
    return resolveActiveOverlay({ answer, source: 'button' });
  });

  ipcMain.on('overlay:finished', (event) => {
    if (!overlayEntryFor(event) || !overlayState) return;
    if (!overlayState.resolved) return;
    closeActiveOverlay();
  });
}

// ---------- Power and display observers ----------

function installPowerObservers() {
  powerMonitor.on('suspend', () => {
    void flushRuntimeNow();
    void flushHistoryNow();
  });
  powerMonitor.on('resume', () => {
    catchUpMissed();
    scheduler?.refresh();
    refreshTray();
    pumpQueue();
  });
  powerMonitor.on('lock-screen', () => {
    screenLocked = true;
  });
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false;
    catchUpMissed();
    scheduler?.refresh();
    pumpQueue();
  });

  screen.on('display-added', handleDisplayChange);
  screen.on('display-removed', handleDisplayChange);
  screen.on('display-metrics-changed', handleDisplayChange);
}

function handleDisplayChange() {
  if (overlayState) closeActiveOverlay();
  refreshTray();
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (isQuitting) return;
    const now = Date.now();
    if (lastCheckpointMs !== null && now - lastCheckpointMs > HEARTBEAT_MS + 30_000) {
      catchUpMissed();
    } else {
      lastCheckpointMs = now;
      runtime.lastCheckAt = isoTimestamp(now);
      saveRuntimeSoon(1000);
    }
    refreshTray();
    pumpQueue();
  }, HEARTBEAT_MS);
}

// ---------- Test hooks ----------

function installTestHooks() {
  if (!TEST_MODE) return;
  const hooks = {
    ready: () => Boolean(store && tray && !tray.isDestroyed() && scheduler),
    snapshot: () => ({
      settings: JSON.parse(JSON.stringify(settings)),
      reminders: JSON.parse(JSON.stringify(reminders)),
      events: JSON.parse(JSON.stringify(events)),
      runtime: JSON.parse(JSON.stringify(runtime)),
      nextReminderAt: scheduler?.getNextAt() ?? null,
      schedulerPlan: scheduler?.getPlan() || [],
      pausedUntil,
      queue: queue ? queue.toArray() : [],
      trayExists: Boolean(tray && !tray.isDestroyed()),
      trayMenuLabels: currentTrayMenu ? currentTrayMenu.items.map((item) => item.label || item.type) : [],
      overlay: overlayState
        ? {
          reminderId: overlayState.reminderId,
          title: overlayState.reminder.title,
          resolved: overlayState.resolved,
          promptShown: overlayState.promptShown,
          answer: overlayState.answer,
          source: overlayState.source,
          test: overlayState.test,
          missed: overlayState.missed,
          windows: overlayWindows.length,
          hitRegions: overlayWindows.map((entry) => entry.hitRegions.map((region) => ({ ...region })))
        }
        : null,
      overlayVisible: overlayWindows.some((entry) => entry.win && !entry.win.isDestroyed() && entry.win.isVisible()),
      characters: {
        ids: characterCatalog.items.map((item) => item.id),
        validIds: characterCatalog.items.filter((item) => item.valid).map((item) => item.id),
        warnings: [characterScanWarning, ...characterCatalog.warnings].filter(Boolean),
        ...characterStateForSettings()
      },
      settingsOpen: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
      quickAddOpen: Boolean(quickAddWindow && !quickAddWindow.isDestroyed() && quickAddWindow.isVisible()),
      secondInstanceCount,
      promptTimeoutMs: overlayState?.payload?.timeoutMs || null,
      quickAddShortcutError,
      dataFile: store ? store.dir : null
    }),
    openApp: (tab = 'reminders') => showMainWindow(tab),
    openSettings: (tab = 'settings') => showMainWindow(tab),
    clickTray: (label) => {
      if (!trayMenuActions.has(label)) throw new Error(`Tray item not found: ${label}`);
      return trayMenuActions.get(label)();
    },
    openReminder: (id = null) => {
      const reminder = id
        ? reminders.find((entry) => entry.id === id)
        : reminders.find((entry) => entry.enabled);
      if (!reminder) return { ok: false, error: 'No reminder found.' };
      return testReminderNow(reminder.id);
    },
    closeOverlay: () => {
      closeActiveOverlay();
      return true;
    },
    forceTimeout: () => resolveActiveOverlay({ answer: '__timeout__', source: 'timeout' }),
    resolveOverlay: (answer) => resolveActiveOverlay({ answer, source: 'button' }),
    dismissOverlay: () => resolveActiveOverlay({ answer: '__timer__', source: 'timer' }),
    getStartupState: () => startupState(),
    setStartupEnabled: (enabled) => login.setStartupEnabled(Boolean(enabled)),
    setHoverPoint: (point) => {
      overlayHoverOverride = point
        ? { x: Math.round(Number(point.x) || 0), y: Math.round(Number(point.y) || 0) }
        : null;
      pollOverlayHitRegions();
      return overlayWindows.map((entry) => entry.ignoring);
    },
    pause: (minutes) => { pauseFor(Number(minutes) || 30); return pausedUntil; },
    pauseUntilTomorrow: () => { pauseUntilTomorrow(); return pausedUntil; },
    resume: () => { resumeReminders(); return true; },
    quickAdd: (text) => {
      const created = createQuickAddReminder(text, { now: new Date() });
      if (!created.ok) return created;
      reminders.push(created.reminder);
      return saveRemindersNow().then(() => {
        scheduler?.refresh();
        refreshTray();
        return { ok: true, reminder: created.reminder, state: buildPublicState() };
      });
    },
    saveReminder: (raw) => saveReminder(raw),
    deleteReminder: (id) => deleteReminder(id),
    toggleReminder: (id, enabled) => toggleReminder(id, enabled),
    testReminder: (id) => testReminderNow(id),
    enqueueReminder: (id, { missed = false, missedCount = 1 } = {}) => {
      const reminder = reminders.find((entry) => entry.id === id);
      if (!reminder) return null;
      const now = Date.now();
      const state = ensureReminderState(id);
      state.lastDueAt = isoTimestamp(now);
      state.lastFiredAt = isoTimestamp(now);
      const item = queue.enqueue(reminder, {
        at: now,
        reason: missed ? 'missed' : 'scheduled',
        key: `manual:${now}:${id}`
      }, { missed, missedCount });
      scheduler?.refresh();
      pumpQueue();
      return item;
    },
    catchUpMissed: () => { catchUpMissed(); return queue ? queue.toArray() : []; },
    setCheckpoint: (ms) => {
      lastCheckpointMs = Number(ms);
      runtime.lastCheckAt = isoTimestamp(Number(ms));
      return runtime.lastCheckAt;
    },
    setReminderState: (id, patch) => {
      const state = ensureReminderState(id);
      Object.assign(state, patch || {});
      saveRuntimeSoon(50);
      scheduler?.refresh();
      return state;
    },
    tickScheduler: () => scheduler?.tick(),
    queryHistory: (payload) => queryHistory(payload || {}),
    getQuickAddPreview: (text) => parseQuickAdd(text, { now: new Date() }),
    buildState: () => buildPublicState(),
    isPaused: () => isPaused(),
    flush: async () => {
      await flushRuntimeNow();
      await flushHistoryNow();
      return true;
    }
  };
  global.__remindBuddyTest = hooks;
}

// ---------- Initialization ----------

async function initializeStore() {
  store = new DataStore(app.getPath('userData'), {
    legacyDir: legacyDataDir,
    now: () => new Date()
  });
  const snapshot = await store.init();
  settings = snapshot.settings;
  reminders = snapshot.reminders;
  events = snapshot.events;
  runtime = snapshot.runtime;
  reminderStates = runtime.reminderStates || {};
  pausedUntil = runtime.pausedUntil ? parseTimestamp(runtime.pausedUntil) : null;
  if (pausedUntil !== null && pausedUntil <= Date.now()) pausedUntil = null;
  runtime.pausedUntil = pausedUntil ? isoTimestamp(pausedUntil) : null;
  lastCheckpointMs = runtime.lastCheckAt ? parseTimestamp(runtime.lastCheckAt) : null;
  nativeTheme.themeSource = settings.theme;
  if (store.warnings.length > 0) {
    for (const warning of store.warnings) console.warn(warning);
  }
}

function initializeSessionSecurity() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}

async function initialize() {
  try {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    initializeSessionSecurity();
    await initializeStore();
    appStartedAt = Date.now();
    await scanCharacters({ broadcast: false });
    registerIpc();
    createTray();
    installPowerObservers();
    initializeScheduler();
    installTestHooks();
    registerQuickAddShortcut();
    startHeartbeat();
    armPauseTimer();

    catchUpMissed();
    lastCheckpointMs = Date.now();
    runtime.lastCheckAt = isoTimestamp(lastCheckpointMs);
    saveRuntimeSoon(500);
    scheduler.refresh();
    refreshTray();
    broadcastStateSoon();
    pumpQueue();

    const firstRun = Boolean(store.data?.seedsCreated);
    const requested = settingsWasRequested || process.argv.includes('--open-settings');
    const hiddenLaunch = process.argv.includes('--hidden') || settings.startMinimized;
    if (requested) {
      showMainWindow('settings');
    } else if (firstRun || !hiddenLaunch) {
      showMainWindow('reminders');
    }
  } catch (error) {
    console.error('Remind Buddy failed to start:', error);
    try {
      dialog.showErrorBox('Remind Buddy could not start', error.message);
    } catch {
      // The dialog may be unavailable in a headless environment.
    }
    app.quit();
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    secondInstanceCount += 1;
    if (app.isReady()) {
      showMainWindow('reminders');
    } else {
      settingsWasRequested = true;
    }
  });

  app.on('before-quit', () => {
    if (!isQuitting) {
      isQuitting = true;
      try {
        scheduler?.stop();
      } catch {
        // Ignore shutdown errors.
      }
      clearRuntimeTimers();
      globalShortcut.unregisterAll();
      flushStateSync();
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    // Remind Buddy lives in the tray; only the tray Quit action exits.
  });

  app.on('activate', () => {
    if (app.isReady()) showMainWindow('reminders');
  });

  app.whenReady().then(initialize);
}
