'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(__dirname, 'artifacts');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'remind-buddy-ui-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];

function log(message) {
  console.log(`[ui] ${message}`);
}

async function waitFor(fn, { timeout = 15_000, interval = 100, message = 'condition' } = {}) {
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

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const env = {
    ...process.env,
    REMIND_BUDDY_TEST: '1',
    REMIND_BUDDY_USER_DATA: USER_DATA,
    REMIND_BUDDY_PROMPT_TIMEOUT_MS: '8000'
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env, timeout: 30_000 });
  app.on('window', attach);
  for (const page of app.windows()) attach(page);
  const snapshot = () => app.evaluate(() => global.__remindBuddyTest.snapshot());
  let startupOriginal = null;

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
    await page.waitForTimeout(900);
    let state = await snapshot();
    assert.equal(state.reminders.length, 3);
    assert.equal(state.settingsOpen, true);
    assert.equal(state.quickAddShortcutError, null);
    assert.equal(await page.title(), 'Remind Buddy');
    assert.equal(await page.locator('.tab-button').count(), 6);
    assert.equal(await page.locator('#reminder-empty').isVisible(), false);
    assert.equal(await page.locator('#overlay-chip').isVisible(), false);
    for (const tab of ['today', 'history', 'characters', 'style', 'settings', 'reminders']) {
      await page.locator(`#tab-${tab}`).click();
      await page.waitForTimeout(250);
      assert.equal(await page.locator(`#panel-${tab}`).isVisible(), true, `${tab} panel should show`);
      await page.screenshot({ path: path.join(ARTIFACTS, `ui-00-${tab}.png`) });
    }
    log('main window tabs, seeded rows, and empty overlay chip verified');

    await page.locator('#add-reminder').click();
    await page.waitForSelector('#template-dialog[open]');
    const templateIds = await page.locator('#template-grid [data-template]').evaluateAll((nodes) => nodes.map((node) => node.dataset.template));
    assert.equal(templateIds.length, 13);
    await page.screenshot({ path: path.join(ARTIFACTS, 'ui-01-templates.png') });
    await page.locator('[data-template="medicine"]').click();
    await page.waitForSelector('#editor-dialog[open]');
    assert.equal(await page.locator('#edit-title').inputValue(), 'Take medicine');
    assert.equal(await page.locator('#edit-type').inputValue(), 'confirm');
    assert.deepEqual(await page.locator('#edit-buttons [data-field="label"]').evaluateAll((nodes) => nodes.map((node) => node.value)), ['Done', 'Later']);

    await page.locator('#edit-title').fill('');
    await page.locator('#editor-save').click();
    await page.waitForSelector('#editor-errors:not([hidden])');
    assert.match((await page.locator('#editor-errors').textContent()) || '', /title/i);
    assert.equal(await page.locator('#editor-dialog').evaluate((dialog) => dialog.open), true);

    await page.locator('#edit-title').fill('Take medicine nightly');
    await page.locator('#edit-type').selectOption('choice');
    await page.waitForFunction(() => document.querySelectorAll('#edit-buttons .button-row').length === 2);
    await page.locator('#edit-buttons .button-row').nth(0).locator('[data-field="label"]').fill('Pill taken');
    await page.locator('#edit-buttons .button-row').nth(1).locator('[data-field="label"]').fill('Skipped');
    await page.locator('#edit-buttons .button-row').nth(1).locator('[data-field="action"]').selectOption('skip');
    await page.locator('#edit-buttons .button-row').nth(1).locator('[data-field="reaction"]').selectOption('skip');
    await page.locator('#edit-question').fill('Which medicine did you take?');
    await page.waitForTimeout(400);
    assert.match((await page.locator('#preview-question').textContent()) || '', /Which medicine/);
    assert.match((await page.locator('#preview-buttons').textContent()) || '', /Pill taken.*Skipped/);
    await page.locator('#edit-schedule-kind').selectOption('times');
    await page.locator('#edit-times').fill('08:00, 20:00');
    await page.waitForTimeout(400);
    assert.match((await page.locator('#preview-schedule').textContent()) || '', /08:00/);
    await page.locator('#edit-character-mode').selectOption('specific');
    await page.waitForSelector('#edit-character-id-field:not([hidden])');
    const characterId = await page.locator('#edit-character-id').inputValue();
    assert.ok(characterId, 'a usable character should be selected');
    await page.locator('#edit-sound').selectOption('none');
    await page.locator('#edit-daily-goal').fill('2');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(ARTIFACTS, 'ui-02-editor-filled.png') });
    await page.locator('#editor-save').click();
    await waitFor(async () => {
      const current = await snapshot();
      return current.reminders.some((reminder) => reminder.title === 'Take medicine nightly');
    }, { message: 'saved medicine reminder' });
    state = await snapshot();
    const saved = state.reminders.find((reminder) => reminder.title === 'Take medicine nightly');
    assert.equal(saved.type, 'choice');
    assert.equal(saved.schedule.kind, 'times');
    assert.deepEqual(saved.schedule.times, ['08:00', '20:00']);
    assert.equal(saved.character.mode, 'specific');
    assert.equal(saved.character.id, characterId);
    assert.equal(saved.character.sound, 'none');
    assert.equal(saved.tracking.dailyGoal, 2);
    assert.deepEqual(saved.buttons.map((button) => [button.label, button.action]), [['Pill taken', 'positive'], ['Skipped', 'skip']]);
    assert.equal(await page.locator('#editor-dialog').evaluate((dialog) => dialog.open), false);
    log('editor save persisted type, buttons, schedule, character, sound, goal');

    const eventsBeforeTest = (await snapshot()).events.length;
    await page.locator(`[data-action="test"][data-id="${saved.id}"]`).click();
    const testOverlay = await waitFor(
      () => app.windows().find((candidate) => candidate.url().includes('overlay.html')),
      { message: 'test overlay' }
    );
    await testOverlay.waitForSelector('#bubble.visible', { timeout: 12_000 });
    await testOverlay.waitForTimeout(500);
    state = await snapshot();
    assert.equal(state.overlay?.test, true, 'Test now should flag the overlay as a test');
    await testOverlay.screenshot({ path: path.join(ARTIFACTS, 'ui-05-test-now.png') });
    await testOverlay.locator('#bubble-actions .button').first().click();
    await waitFor(() => !app.windows().some((candidate) => candidate.url().includes('overlay.html')), {
      timeout: 15_000,
      message: 'test overlay close'
    });
    await page.waitForTimeout(300);
    state = await snapshot();
    assert.equal(state.events.length, eventsBeforeTest, 'Test now must not write history');
    assert.equal(state.events.some((event) => event.reminderId === saved.id), false);
    log('Test now played the full overlay without logging history');

    const row = page.locator(`.reminder-row[data-id="${saved.id}"]`);
    await row.waitFor();
    await page.locator(`[data-reminder-toggle="${saved.id}"]`).click();
    await waitFor(async () => (await snapshot()).reminders.find((reminder) => reminder.id === saved.id)?.enabled === false, { message: 'toggle off' });
    await page.locator(`[data-reminder-toggle="${saved.id}"]`).click();
    await waitFor(async () => (await snapshot()).reminders.find((reminder) => reminder.id === saved.id)?.enabled === true, { message: 'toggle on' });
    log('reminder toggle verified');

    await page.locator(`[data-action="duplicate"][data-id="${saved.id}"]`).click();
    await waitFor(async () => (await snapshot()).reminders.length === 5, { message: 'duplicate' });
    state = await snapshot();
    const duplicate = state.reminders.find((reminder) => reminder.title === 'Take medicine nightly copy');
    assert.ok(duplicate, 'duplicated reminder should exist');
    assert.equal(duplicate.enabled, false);
    await page.locator(`[data-action="delete"][data-id="${duplicate.id}"]`).click();
    await page.waitForSelector('#confirm-dialog[open]');
    await page.locator('#confirm-ok').click();
    await waitFor(async () => (await snapshot()).reminders.length === 4, { message: 'delete duplicate' });
    log('duplicate and delete verified');

    await page.locator('#reminder-search').fill('medicine');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#reminder-list .reminder-row').count(), 1);
    await page.locator('#reminder-search').fill('');
    await page.locator('#category-filter').selectOption('Health');
    await page.waitForTimeout(250);
    const healthRows = await page.locator('#reminder-list .reminder-row .category-chip').allTextContents();
    assert.ok(healthRows.length >= 1 && healthRows.every((text) => text === 'Health'));
    await page.locator('#category-filter').selectOption('');
    log('search and category filter verified');

    const beforeOrder = (await snapshot()).reminders.map((reminder) => reminder.id);
    const lastId = beforeOrder[beforeOrder.length - 1];
    const dropResult = await page.evaluate((id) => {
      const list = document.getElementById('reminder-list');
      const source = document.querySelector(`.reminder-row[data-id="${id}"]`);
      const target = list?.querySelector('.reminder-row');
      if (!source || !target || target === source) return false;
      const handle = source.querySelector('.drag-handle');
      const transfer = new DataTransfer();
      handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: transfer, clientY: rect.top + 2
      }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      return true;
    }, lastId);
    assert.equal(dropResult, true);
    await waitFor(async () => (await snapshot()).reminders[0]?.id === lastId, { message: 'drag reorder' });
    log('drag reorder persisted');

    await page.locator('#tab-settings').click();
    await page.waitForTimeout(300);
    await page.locator('#setting-display').selectOption('primary');
    await page.locator('#setting-missed-policy').selectOption('skip');
    await page.locator('#setting-timeout').fill('30');
    await page.locator('#setting-timeout-action').selectOption('dismiss');
    await page.locator('#setting-sound-volume').fill('35');
    await page.locator('#setting-dnd-enabled').check();
    await page.locator('#setting-dnd-start').fill('22:15');
    await page.locator('#setting-dnd-end').fill('06:45');
    for (const input of await page.locator('#dnd-days input').all()) await input.uncheck();
    for (const value of ['1', '2', '3', '4', '5']) {
      await page.locator(`#dnd-days input[value="${value}"]`).check();
    }
    await page.locator('#save-settings').click();
    await waitFor(async () => (await snapshot()).settings.display === 'primary', { message: 'settings save' });
    await page.waitForFunction(() => document.querySelector('#settings-status')?.textContent === 'Saved.', { timeout: 5000 });
    state = await snapshot();
    assert.equal(state.settings.missedPolicy, 'skip');
    assert.equal(state.settings.defaultTimeoutSeconds, 30);
    assert.equal(state.settings.defaultTimeoutAction, 'dismiss');
    assert.equal(state.settings.soundVolume, 35);
    assert.equal(state.settings.dnd.enabled, true);
    assert.equal(state.settings.dnd.start, '22:15');
    assert.equal(state.settings.dnd.end, '06:45');
    assert.deepEqual(state.settings.dnd.days, [1, 2, 3, 4, 5]);
    await page.screenshot({ path: path.join(ARTIFACTS, 'ui-03-settings-saved.png') });
    log('settings form saved prompt, sound, and Do Not Disturb values');

    const startupBefore = await app.evaluate(() => global.__remindBuddyTest.getStartupState());
    log(`startup integration supported=${startupBefore.supported} enabled=${startupBefore.enabled}`);
    if (startupBefore.supported) {
      startupOriginal = Boolean(startupBefore.enabled);
      try {
        const next = !startupOriginal;
        if (next) await page.locator('#setting-start-at-login').check();
        else await page.locator('#setting-start-at-login').uncheck();
        await page.locator('#save-settings').click();
        await waitFor(async () => (await app.evaluate(() => global.__remindBuddyTest.getStartupState())).enabled === next, {
          message: 'startup checkbox applied to OS'
        });
        const applied = await app.evaluate(() => global.__remindBuddyTest.getStartupState());
        log(`startup checkbox changed OS state to enabled=${applied.enabled}`);
      } finally {
        await app.evaluate((_electron, original) => global.__remindBuddyTest.setStartupEnabled(original), startupOriginal);
        await waitFor(async () => (await app.evaluate(() => global.__remindBuddyTest.getStartupState())).enabled === startupOriginal, {
          message: 'startup state restore'
        });
        log('startup checkbox verified and OS login item restored');
      }
    }

    await page.locator('#tab-style').click();
    await page.waitForTimeout(250);
    await page.locator('input[name="theme"][value="dark"]').check();
    await waitFor(async () => (await snapshot()).settings.theme === 'dark', { message: 'theme applied' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.screenshot({ path: path.join(ARTIFACTS, 'ui-04-theme-dark.png') });
    await page.locator('#style-language').selectOption('de');
    await waitFor(async () => (await snapshot()).settings.language === 'de', { message: 'language applied' });
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'de');
    await page.locator('input[name="theme"][value="system"]').check();
    await waitFor(async () => (await snapshot()).settings.theme === 'system', { message: 'theme reset' });
    await page.locator('#style-language').selectOption('system');
    await waitFor(async () => (await snapshot()).settings.language === 'system', { message: 'language reset' });
    await page.locator('#global-positive').fill('Custom cheer for {title}');
    await page.locator('#global-messages-form .primary-button').click();
    await waitFor(async () => ((await snapshot()).settings.messages.positive || []).includes('Custom cheer for {title}'), {
      message: 'global messages saved'
    });
    log('theme, language, and global messages verified');

    const extraDir = path.join(USER_DATA, 'characters', 'extra');
    fs.mkdirSync(extraDir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'assets', 'character', 'buddy', 'sheet.png'), path.join(extraDir, 'sheet.png'));
    fs.writeFileSync(path.join(extraDir, 'character.json'), `${JSON.stringify({ name: 'Extra Buddy' }, null, 2)}\n`);
    await page.locator('#tab-characters').click();
    await page.waitForTimeout(250);
    await page.locator('#rescan-characters').click();
    await waitFor(async () => (await snapshot()).characters.ids.includes('extra'), { message: 'rescan character' });
    await page.waitForSelector('.character-card[data-character-id="extra"]');
    log('rescan picked up a character folder');

    await page.locator('#add-character').click();
    await page.waitForSelector('#character-dialog[open]');
    await page.locator('#character-name').fill('Copy Cat');
    await page.locator('#character-sheet-file').setInputFiles(path.join(ROOT, 'assets', 'character', 'buddy', 'sheet.png'));
    await page.locator('#character-submit').click();
    await waitFor(async () => (await snapshot()).characters.ids.includes('copy-cat'), { message: 'add character' });
    assert.equal(fs.existsSync(path.join(USER_DATA, 'characters', 'copy-cat', 'sheet.png')), true);
    assert.equal(await page.locator('#character-dialog').evaluate((dialog) => dialog.open), false);
    log('add-character flow copied the sheet into the user folder');

    await page.locator('#tab-reminders').click();
    await page.waitForTimeout(250);
    await page.locator('#sidebar-quick-add').click();
    const quick = await waitFor(
      () => app.windows().find((candidate) => candidate.url().includes('quick-add.html')),
      { message: 'quick add window' }
    );
    await quick.waitForLoadState('domcontentloaded');
    await quick.locator('#quick-input').fill('tomorrow 9am pay rent');
    await quick.waitForTimeout(300);
    await quick.locator('#quick-save').click();
    await quick.waitForTimeout(600);
    state = await snapshot();
    assert.ok(state.reminders.some((reminder) => reminder.title === 'Pay rent'), 'quick add should create pay rent');
    assert.equal(state.quickAddOpen, false, 'quick add should hide after save');
    log('quick add saved through the UI');

    await page.locator('#tab-history').click();
    await page.waitForTimeout(500);
    const historyRows = await page.locator('#history-table-body tr').count();
    assert.equal(historyRows, 0, 'no answers should be logged in this profile');
    assert.equal(await page.locator('#history-empty').isVisible(), true);
    assert.equal(await page.locator('#history-chart-7 .bar-column').count(), 7);
    assert.equal(await page.locator('#history-chart-30 .bar-column').count(), 30);
    log('history empty state and charts rendered');

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().includes('app.html'))
        ?.close();
    });
    await waitFor(async () => (await snapshot()).settingsOpen === false, { message: 'main window hide on close' });
    state = await snapshot();
    assert.equal(state.trayExists, true, 'tray should keep the app alive');
    await app.evaluate(() => global.__remindBuddyTest.openApp('reminders'));
    await waitFor(async () => (await snapshot()).settingsOpen === true, { message: 'reopen from tray hook' });
    log('closing the window hides it and the tray reopens it');

    console.log('ERRORS', errors.length ? JSON.stringify(errors, null, 2) : 'none');
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('UI ERROR', error);
    console.error(errors);
    throw error;
  } finally {
    if (startupOriginal !== null) {
      await app.evaluate((_electron, original) => global.__remindBuddyTest.setStartupEnabled(original), startupOriginal).catch(() => {});
    }
    await app.close();
    log('closed');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
