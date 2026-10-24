'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('playwright-core');
const { TEMPLATE_META } = require('../lib/reminders');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(__dirname, 'artifacts');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'remind-buddy-flows-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];

function log(message) {
  console.log(`[flows] ${message}`);
}

async function waitFor(fn, { timeout = 12_000, interval = 100, message = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${message}${last ? ` (${last.message})` : ''}`);
}

function attach(page) {
  page.on('pageerror', (error) => errors.push(`PAGEERROR ${page.url()} ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`CONSOLE ${page.url()} ${message.text()}`);
  });
  page.on('crash', () => errors.push(`CRASH ${page.url()}`));
}

function buildEnv() {
  const env = {
    ...process.env,
    REMIND_BUDDY_TEST: '1',
    REMIND_BUDDY_USER_DATA: USER_DATA,
    REMIND_BUDDY_PROMPT_TIMEOUT_MS: '8000'
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env: buildEnv(), timeout: 30_000 });
  app.on('window', attach);
  for (const page of app.windows()) attach(page);

  const snapshot = () => app.evaluate(() => global.__remindBuddyTest.snapshot());
  const history = () => app.evaluate(() => global.__remindBuddyTest.queryHistory({}));
  const save = async (raw) => {
    const result = await app.evaluate((_electron, payload) => global.__remindBuddyTest.saveReminder(payload), raw);
    assert.ok(result.ok, `Save failed: ${(result.errors || []).join('; ')}`);
    return result.reminder;
  };
  const closeOverlay = async () => {
    await app.evaluate(() => global.__remindBuddyTest.closeOverlay());
    await waitFor(() => !app.windows().some((page) => page.url().includes('overlay.html')), {
      message: 'overlay to close'
    });
    await sleep(450);
  };
  const overlayPage = () => waitFor(
    () => app.windows().find((page) => page.url().includes('overlay.html')),
    { message: 'overlay window' }
  );
  const showTest = async (id) => {
    const result = await app.evaluate((_electron, reminderId) => global.__remindBuddyTest.testReminder(reminderId), id);
    assert.ok(result.ok, `Test overlay failed: ${(result.errors || []).join('; ')}`);
    const page = await overlayPage();
    await page.waitForSelector('#bubble.visible', { timeout: 10_000 });
    return page;
  };
  const showQueued = async (id, missed = false) => {
    await app.evaluate((_electron, payload) => global.__remindBuddyTest.enqueueReminder(payload.id, { missed: payload.missed }), { id, missed });
    const page = await overlayPage();
    await page.waitForSelector('#bubble.visible', { timeout: 10_000 });
    const state = await snapshot();
    assert.ok(state.overlayVisible && state.overlay, 'state should report a visible overlay');
    return { page, state };
  };
  const readOverlay = async (page) => page.evaluate(() => ({
    title: document.getElementById('bubble-title')?.textContent,
    buttons: [...document.querySelectorAll('#bubble-actions .button')].map((button) => ({
      id: button.dataset.answer,
      label: button.textContent.trim(),
      disabled: button.disabled
    })),
    timerVisible: !document.getElementById('timer-block')?.hidden,
    waitVisible: !document.getElementById('wait-row')?.hidden,
    waitLabel: document.getElementById('wait-label')?.textContent,
    testChip: !document.getElementById('test-chip')?.hidden,
    missed: document.getElementById('bubble-kicker')?.classList.contains('is-missed'),
    queueChip: !document.getElementById('queue-chip')?.hidden,
    mascotState: document.getElementById('mascot')?.dataset.state,
    mascotReaction: document.getElementById('mascot')?.dataset.reaction || null,
    mascotFacing: document.getElementById('mascot')?.dataset.facing,
    note: document.getElementById('bubble-note')?.textContent
  }));

  try {
    await app.evaluate(async () => {
      const started = Date.now();
      while (!global.__remindBuddyTest?.ready()) {
        if (Date.now() - started > 20_000) throw new Error('main readiness timeout');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
    const page = await waitFor(
      () => app.windows().find((candidate) => candidate.url().includes('app.html')),
      { message: 'main window' }
    );
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(800);

    let state = await snapshot();
    assert.equal(state.reminders.length, 3, 'fresh profile should seed three reminders');
    assert.deepEqual(state.settings ? state.reminders.map((reminder) => reminder.title) : [], ['Drink water', 'Stretch / stand up', 'Take a break']);
    log(`seeded: ${state.reminders.map((reminder) => reminder.title).join(', ')}`);
    log(`tray labels: ${state.trayMenuLabels.join(' | ')}`);
    assert.ok(state.trayMenuLabels.includes('Quick add…'));
    assert.ok(state.trayMenuLabels.includes('Open Remind Buddy'));

    await app.evaluate(() => global.__remindBuddyTest.clickTray('Quick add…'));
    const quick = await waitFor(
      () => app.windows().find((candidate) => candidate.url().includes('quick-add.html')),
      { message: 'quick add window from tray' }
    );
    await quick.waitForLoadState('domcontentloaded');
    await quick.waitForTimeout(300);
    assert.equal(await quick.evaluate(() => document.querySelector('#quick-input') !== null), true);
    await quick.locator('#quick-input').fill('in 45 min stretch');
    await quick.waitForTimeout(350);
    assert.match(await quick.locator('#preview-title').textContent(), /Stretch/i);
    await quick.screenshot({ path: path.join(ARTIFACTS, 'flows-01-quick-add.png') });
    await quick.locator('#quick-save').click();
    await waitFor(async () => (await snapshot()).reminders.some((reminder) => reminder.title === 'Stretch'), {
      message: 'quick add save'
    });
    await waitFor(async () => (await snapshot()).quickAddOpen === false, {
      message: 'quick add hide after save'
    });
    state = await snapshot();
    assert.equal(state.quickAddOpen, false);
    log('tray quick add saved a natural-language reminder');

    await page.locator('#pause-actions button[data-pause="30"]').click();
    await page.waitForTimeout(400);
    state = await snapshot();
    assert.ok(state.trayMenuLabels.some((label) => label.startsWith('Paused until')), 'tray should show paused');
    await page.locator('#resume-button').click();
    await page.waitForTimeout(400);
    state = await snapshot();
    assert.equal(state.overlay, null);
    log('pause and resume through sidebar verified');

    assert.equal(TEMPLATE_META.length, 13, 'all 13 reminder templates should be available');
    log(`template catalog verified (${TEMPLATE_META.length} templates)`);

    const baseSchedule = { kind: 'once', onceAt: '2099-01-01T09:00' };
    const yesNo = await save({
      title: 'Yes or no check',
      icon: '💧',
      type: 'yesno',
      priority: 'normal',
      messages: {
        question: ['Did you do the thing?'],
        positive: ['Great work.'],
        negative: ['Maybe next time.']
      },
      buttons: [
        { id: 'yes', label: 'Yes', action: 'positive' },
        { id: 'no', label: 'No', action: 'negative' }
      ],
      tracking: { log: true, dailyGoal: 2 },
      schedule: baseSchedule
    });

    let { page: overlay, state: overlayState } = await showQueued(yesNo.id);
    let info = await readOverlay(overlay);
    assert.equal(info.title, 'Did you do the thing?');
    assert.deepEqual(info.buttons.map((button) => button.label), ['Yes', 'No']);
    assert.equal(info.waitVisible, true, 'normal reminders should show a timeout bar');
    assert.equal(overlayState.overlay.test, false);
    await overlay.locator('[data-answer="yes"]').click();
    await waitFor(async () => (await history()).events.some((event) => event.reminderId === yesNo.id && event.outcome === 'done'), {
      message: 'done history entry'
    });
    info = await readOverlay(overlay);
    assert.equal(info.mascotReaction, 'positive');
    assert.equal(info.mascotState, 'happy');
    assert.equal(info.mascotFacing, 'right');
    await overlay.screenshot({ path: path.join(ARTIFACTS, 'flows-02-happy.png') });
    await closeOverlay();
    let events = (await history()).events;
    let event = events.find((entry) => entry.reminderId === yesNo.id);
    assert.equal(event.outcome, 'done');
    assert.equal(event.answerLabel, 'Yes');
    log('Yes flow: happy reaction, done logged, right facing');

    ({ page: overlay } = await showQueued(yesNo.id));
    await overlay.locator('[data-answer="no"]').click();
    await waitFor(async () => (await history()).events.some((entry) => entry.reminderId === yesNo.id && entry.outcome === 'skipped'), {
      message: 'skipped history entry'
    });
    info = await readOverlay(overlay);
    assert.equal(info.mascotReaction, 'negative');
    assert.equal(info.mascotState, 'sad');
    await overlay.screenshot({ path: path.join(ARTIFACTS, 'flows-03-sad.png') });
    await closeOverlay();
    log('No flow: sad reaction and skipped logged');

    const confirm = await save({
      title: 'Confirm check',
      icon: '🧘',
      type: 'confirm',
      messages: { question: ['Ready to stretch?'], positive: ['Nice stretch.'], negative: ['Later then.'] },
      buttons: [
        { id: 'done', label: 'Done', action: 'positive' },
        { id: 'later', label: 'Later', action: 'snooze', reaction: 'snooze' }
      ],
      snooze: { minutes: 5, max: 2, escalate: 'none' },
      schedule: baseSchedule
    });
    ({ page: overlay, state: overlayState } = await showQueued(confirm.id));
    info = await readOverlay(overlay);
    assert.deepEqual(info.buttons.map((button) => button.label), ['Done', 'Later']);
    await overlay.locator('[data-answer="later"]').click();
    await waitFor(async () => (await history()).events.some((entry) => entry.reminderId === confirm.id && entry.outcome === 'snoozed'), {
      message: 'snoozed history entry'
    });
    info = await readOverlay(overlay);
    assert.equal(info.mascotReaction, 'snooze');
    assert.equal(info.mascotFacing, 'left');
    assert.equal(info.mascotState, 'idle');
    await overlay.screenshot({ path: path.join(ARTIFACTS, 'flows-04-snooze.png') });
    await closeOverlay();
    state = await snapshot();
    const confirmState = state.runtime.reminderStates?.[confirm.id];
    assert.ok(confirmState?.snoozeUntil, 'runtime should have a snooze target');
    log('Confirm + Later flow: wave, left facing, snooze logged');

    const choice = await save({
      title: 'Pick a stretch',
      icon: '🤸',
      type: 'choice',
      messages: {
        question: ['Which stretch?'],
        positive: ['Good choice.'],
        neutral: ['Okay, noted.'],
        negative: ['Maybe later.']
      },
      buttons: [
        { id: 'neck', label: 'Neck', action: 'positive' },
        { id: 'back', label: 'Back', action: 'neutral' },
        { id: 'skip', label: 'Skip', action: 'skip' }
      ],
      schedule: baseSchedule
    });
    ({ page: overlay } = await showQueued(choice.id));
    info = await readOverlay(overlay);
    assert.deepEqual(info.buttons.map((button) => button.label), ['Neck', 'Back', 'Skip']);
    await overlay.locator('[data-answer="back"]').click();
    await waitFor(async () => (await history()).events.some((entry) => entry.reminderId === choice.id && entry.outcome === 'done'), {
      message: 'neutral done history'
    });
    info = await readOverlay(overlay);
    assert.equal(info.mascotReaction, 'neutral');
    assert.equal(info.mascotState, 'idle');
    await overlay.screenshot({ path: path.join(ARTIFACTS, 'flows-05-neutral.png') });
    await closeOverlay();
    log('Choice + neutral flow: nod reaction and done logged');

    const skip = await save({
      title: 'Skip day check',
      icon: '☕',
      type: 'confirm',
      buttons: [
        { id: 'done', label: 'Done', action: 'positive' },
        { id: 'skip', label: 'Skip today', action: 'skip' }
      ],
      messages: { question: ['Coffee time?'], positive: ['Enjoy.'], skipped: ['Skipped until tomorrow.'] },
      schedule: baseSchedule
    });
    ({ page: overlay } = await showQueued(skip.id));
    await overlay.locator('[data-answer="skip"]').click();
    await waitFor(async () => (await history()).events.some((entry) => entry.reminderId === skip.id && entry.outcome === 'skipped'), {
      message: 'skip history'
    });
    info = await readOverlay(overlay);
    assert.equal(info.mascotReaction, 'skip');
    assert.equal(info.mascotFacing, 'left');
    await overlay.screenshot({ path: path.join(ARTIFACTS, 'flows-06-skip.png') });
    await closeOverlay();
    state = await snapshot();
    assert.ok(state.runtime.reminderStates?.[skip.id]?.skippedOn, 'skip should mark the reminder state');
    log('Skip today flow: tip reaction and skippedOn state');

    const timer = await save({
      title: 'Focus timer',
      icon: '⏳',
      type: 'timer',
      timerMinutes: 1,
      messages: { question: ['Focus for one minute.'], positive: ['Focus block done.'] },
      buttons: [
        { id: 'done', label: 'Done', action: 'positive' },
        { id: 'snooze', label: 'Snooze', action: 'snooze' }
      ],
      schedule: baseSchedule
    });
    ({ page: overlay, state: overlayState } = await showQueued(timer.id));
    info = await readOverlay(overlay);
    assert.equal(info.timerVisible, true, 'timer countdown should be visible');
    assert.equal(info.waitVisible, false, 'timer should not use the answer timeout');
    assert.equal(overlayState.overlay.windows, 1, 'only one overlay window should be open');
    await overlay.screenshot({ path: path.join(ARTIFACTS, 'flows-07-timer.png') });
    await app.evaluate(() => global.__remindBuddyTest.dismissOverlay());
    await waitFor(async () => (await history()).events.some((entry) => entry.reminderId === timer.id && entry.source === 'timer'), {
      message: 'timer completion history'
    });
    event = (await history()).events.find((entry) => entry.reminderId === timer.id);
    assert.equal(event.outcome, 'done');
    await closeOverlay();
    log('Timer flow: countdown shown, timer completion logs done');

    const note = await save({
      title: 'Heads up',
      icon: '📣',
      type: 'note',
      autoDismissSeconds: 3,
      messages: { question: ['This is a message.'] },
      notes: 'No buttons here.',
      tracking: { log: true, dailyGoal: null },
      schedule: baseSchedule
    });
    overlay = await showTest(note.id);
    info = await readOverlay(overlay);
    assert.deepEqual(info.buttons, [], 'note should not render buttons');
    assert.match(info.note, /No buttons here/);
    assert.match(info.waitLabel, /Closes in 3s/);
    await overlay.screenshot({ path: path.join(ARTIFACTS, 'flows-08-note.png') });
    await waitFor(() => !app.windows().some((candidate) => candidate.url().includes('overlay.html')), {
      timeout: 9000,
      message: 'note overlay auto-dismiss'
    });
    await sleep(300);
    assert.equal((await history()).events.some((entry) => entry.reminderId === note.id), false, 'note auto-dismiss should not log');
    log('Note flow: message-only, auto-dismiss after 3s, no history');
    await app.evaluate(() => global.__remindBuddyTest.closeOverlay());
    await sleep(400);

    const high = await save({
      title: 'High priority',
      icon: '❗',
      type: 'confirm',
      priority: 'high',
      buttons: [{ id: 'done', label: 'Acknowledge', action: 'positive' }],
      messages: { question: ['High priority nudge.'] },
      schedule: baseSchedule
    });
    ({ page: overlay, state: overlayState } = await showQueued(high.id));
    info = await readOverlay(overlay);
    assert.equal(info.waitVisible, false, 'high priority should stay on screen');
    assert.equal(overlayState.overlay ? overlayState.promptTimeoutMs : 0, null);
    await overlay.locator('[data-answer="done"]').click();
    await waitFor(async () => (await history()).events.some((entry) => entry.reminderId === high.id), { message: 'high priority history' });
    await closeOverlay();
    log('High priority overlay stays until answered');

    const missed = await save({
      title: 'Missed thing',
      icon: '😴',
      type: 'confirm',
      buttons: [{ id: 'done', label: 'Done late', action: 'positive' }],
      messages: { question: ['You missed this earlier.'] },
      schedule: baseSchedule
    });
    ({ page: overlay } = await showQueued(missed.id, true));
    info = await readOverlay(overlay);
    assert.equal(info.missed, true, 'missed badge should be visible');
    await overlay.screenshot({ path: path.join(ARTIFACTS, 'flows-09-missed.png') });
    await overlay.locator('[data-answer="done"]').click();
    await waitFor(async () => (await history()).events.some((entry) => entry.reminderId === missed.id), { message: 'late history' });
    event = (await history()).events.find((entry) => entry.reminderId === missed.id);
    assert.equal(event.late, true);
    await closeOverlay();
    log(`Missed overlay: badge, late answer logged (late=${event.late})`);

    const queueA = await save({
      title: 'Queue A', icon: '🅰️', type: 'confirm',
      buttons: [{ id: 'done', label: 'Done', action: 'positive' }],
      messages: { question: ['First queued.'] }, schedule: baseSchedule
    });
    const queueB = await save({
      title: 'Queue B', icon: '🅱️', type: 'confirm',
      buttons: [{ id: 'done', label: 'Done', action: 'positive' }],
      messages: { question: ['Second queued.'] }, schedule: baseSchedule
    });
    await app.evaluate((_electron, ids) => {
      global.__remindBuddyTest.enqueueReminder(ids.a);
      global.__remindBuddyTest.enqueueReminder(ids.b);
    }, { a: queueA.id, b: queueB.id });
    overlay = await overlayPage();
    await overlay.waitForSelector('#bubble.visible', { timeout: 10_000 });
    info = await readOverlay(overlay);
    assert.equal(info.title, 'First queued.');
    state = await snapshot();
    assert.equal(state.overlay?.reminderId, queueA.id, 'first reminder should be on screen');
    assert.ok(state.queue.some((item) => item.reminderId === queueB.id), 'second reminder should be queued');
    await overlay.locator('[data-answer="done"]').click();
    await waitFor(async () => (await history()).events.some((entry) => entry.reminderId === queueA.id), { message: 'first queue history' });
    await waitFor(() => !app.windows().some((candidate) => candidate.url().includes('overlay.html')), { message: 'first queue overlay close' });
    const secondOverlay = await waitFor(
      () => app.windows().find((candidate) => candidate.url().includes('overlay.html')),
      { timeout: 8000, message: 'second queued overlay' }
    );
    await secondOverlay.waitForSelector('#bubble.visible', { timeout: 10_000 });
    info = await readOverlay(secondOverlay);
    assert.equal(info.title, 'Second queued.');
    await secondOverlay.locator('[data-answer="done"]').click();
    await waitFor(async () => (await history()).events.some((entry) => entry.reminderId === queueB.id), { message: 'second queue history' });
    log('Overlap queue: A displayed, B queued and shown after A');
    await closeOverlay();

    const timeout = await save({
      title: 'Timeout check', icon: '⌛', type: 'yesno',
      buttons: [
        { id: 'yes', label: 'Yes', action: 'positive' },
        { id: 'no', label: 'No', action: 'negative' }
      ],
      messages: { question: ['Answer if you can.'] },
      timeoutAction: 'negative', schedule: baseSchedule
    });
    ({ page: overlay } = await showQueued(timeout.id));
    await app.evaluate(() => global.__remindBuddyTest.forceTimeout());
    await waitFor(async () => (await history()).events.some((entry) => entry.reminderId === timeout.id), { message: 'timeout history' });
    event = (await history()).events.find((entry) => entry.reminderId === timeout.id);
    assert.equal(event.outcome, 'skipped');
    assert.equal(event.source, 'timeout');
    await closeOverlay();
    log('Timeout path: logged skipped with timeout source');

    const missedAt = new Date(Date.now() - 5 * 60 * 1000);
    const missedTime = `${String(missedAt.getHours()).padStart(2, '0')}:${String(missedAt.getMinutes()).padStart(2, '0')}`;
    const missedLive = await save({
      title: 'Slept through this',
      icon: '🌙',
      type: 'confirm',
      buttons: [{ id: 'done', label: 'Done late', action: 'positive' }],
      messages: { question: ['This was missed while the computer slept.'] },
      schedule: {
        kind: 'times',
        times: [missedTime],
        days: [0, 1, 2, 3, 4, 5, 6],
        activeStart: '00:00',
        activeEnd: '23:59',
        missedPolicy: 'show'
      }
    });
    await app.evaluate(async (_electron, reminderId) => {
      const hooks = global.__remindBuddyTest;
      const current = hooks.snapshot();
      for (const reminder of current.reminders) {
        if (reminder.id !== reminderId && reminder.enabled) await hooks.toggleReminder(reminder.id, false);
      }
      hooks.setCheckpoint(Date.now() - 15 * 60 * 1000);
      return hooks.catchUpMissed();
    }, missedLive.id);
    overlay = await overlayPage();
    await overlay.waitForSelector('#bubble.visible', { timeout: 12_000 });
    await waitFor(async () => (await history()).events.some((entry) => (
      entry.reminderId === missedLive.id && entry.source === 'missed' && entry.outcome === 'missed'
    )), { message: 'catch-up missed event' });
    info = await readOverlay(overlay);
    assert.equal(info.missed, true, 'catch-up overlay should carry the missed badge');
    await overlay.screenshot({ path: path.join(ARTIFACTS, 'flows-10-catch-up-missed.png') });
    await overlay.locator('[data-answer="done"]').click();
    await waitFor(async () => (await history()).events.some((entry) => (
      entry.reminderId === missedLive.id && entry.outcome === 'done' && entry.late === true
    )), { message: 'late catch-up answer' });
    await closeOverlay();
    log('sleep catch-up: missed reminder queued, badged, and logged late answer');

    await page.locator('#tab-history').click();
    await page.waitForTimeout(800);
    const historyRows = await page.locator('#history-table-body tr').count();
    assert.ok(historyRows > 0, 'history table should list logged answers');
    assert.equal(await page.locator('#history-chart-7 .bar-column').count(), 7);
    assert.equal(await page.locator('#history-chart-30 .bar-column').count(), 30);
    assert.match((await page.locator('#history-stats').textContent()) || '', /\d+ responses/);
    assert.equal(await page.locator('#history-empty').isVisible(), false);
    await page.screenshot({ path: path.join(ARTIFACTS, 'flows-11-history.png') });
    log(`history tab rendered ${historyRows} rows with 7/30-day charts`);

    state = await snapshot();
    await app.evaluate(() => global.__remindBuddyTest.flush());
    const dataDir = await app.evaluate(() => global.__remindBuddyTest.snapshot().dataFile);
    assert.ok(fs.existsSync(path.join(dataDir, 'reminders.json')), 'reminders.json should exist');
    assert.ok(fs.existsSync(path.join(dataDir, 'history.json')), 'history.json should exist');
    log(`data files exist at ${dataDir}`);

    const electronBinary = require('electron');
    const second = spawn(electronBinary, [ROOT], {
      cwd: ROOT,
      env: buildEnv(),
      stdio: 'ignore',
      windowsHide: true
    });
    const secondExit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        second.kill();
        reject(new Error('Second instance did not exit promptly'));
      }, 20_000);
      second.once('error', reject);
      second.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.ok(secondExit === 0 || secondExit === null, `second instance exited with ${secondExit}`);
    await waitFor(async () => (await snapshot()).secondInstanceCount === 1, { message: 'single-instance handoff' });
    log('second launch exited and was handed to the running instance');

    await page.screenshot({ path: path.join(ARTIFACTS, 'flows-12-main-after.png') });
    log(`renderer errors: ${errors.length ? JSON.stringify(errors, null, 2) : 'none'}`);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('FLOW ERROR', error);
    console.error(errors);
    throw error;
  } finally {
    await app.close();
    log('closed');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
