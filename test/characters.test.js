'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_FRAMES_PER_ROW,
  DEFAULT_ROWS_MAP,
  normalizeCharacterConfig,
  resolveCharacterSelection,
  scanCharacterDirectories,
  slugifyCharacterName,
  validateCharacterName,
  validateSheetGeometry
} = require('../lib/characters');
const { ValidationError } = require('../lib/common');
const { DEFAULT_SETTINGS, normalizeSettings } = require('../lib/settings');

test('missing character config uses the default 6 x 6 layout', () => {
  const { config, errors, warnings } = normalizeCharacterConfig(undefined, { folderName: 'little-robot' });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(config.name, 'Little Robot');
  assert.equal(config.columns, 6);
  assert.equal(config.rows, 6);
  assert.equal(config.fps, 8);
  assert.equal(config.scale, 1);
  assert.equal(config.facing, 'right');
  assert.deepEqual(config.rows_map, DEFAULT_ROWS_MAP);
  assert.deepEqual(config.frames_per_row, DEFAULT_FRAMES_PER_ROW);
});

test('custom character config is normalized', () => {
  const { config, errors, warnings } = normalizeCharacterConfig({
    name: '  Robot  ',
    columns: 4,
    rows: 3,
    fps: 10.5,
    scale: 1.25,
    facing: 'left',
    rows_map: { walk: 1, sad_walk: 2, idle: 3, happy: 1, sad: 2, drinking: 3 },
    frames_per_row: { walk: 2, sad_walk: 2, idle: 2, happy: 2, sad: 2, drinking: 2 }
  }, { folderName: 'robot' });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(config.name, 'Robot');
  assert.equal(config.columns, 4);
  assert.equal(config.rows, 3);
  assert.equal(config.fps, 10.5);
  assert.equal(config.scale, 1.25);
  assert.equal(config.facing, 'left');
  assert.deepEqual(config.rows_map, { walk: 1, sad_walk: 2, idle: 3, happy: 1, sad: 2, drinking: 3 });
  assert.deepEqual(config.frames_per_row, { walk: 2, sad_walk: 2, idle: 2, happy: 2, sad: 2, drinking: 2 });
});

test('character config falls back to sane values and reports bad fields', () => {
  assert.match(normalizeCharacterConfig({ name: 42 }, { folderName: 'robot' }).warnings.join(' '), /not text/);

  const missingRowsMap = normalizeCharacterConfig({ rows: 3 }, { folderName: 'robot' });
  assert.ok(missingRowsMap.errors.some((error) => /rows_map/.test(error)));

  const tooManyFrames = normalizeCharacterConfig({
    columns: 2,
    rows: 3,
    rows_map: { walk: 1, sad_walk: 2, idle: 3, happy: 1, sad: 2, drinking: 3 },
    frames_per_row: { walk: 3, sad_walk: 2, idle: 2, happy: 2, sad: 2, drinking: 2 }
  }, { folderName: 'robot' });
  assert.ok(tooManyFrames.errors.some((error) => /frames_per_row\.walk/.test(error)));

  const badShape = normalizeCharacterConfig({
    columns: 0,
    rows: 65,
    fps: 31,
    scale: 4.5,
    facing: 'up'
  }, { folderName: 'robot' });
  assert.equal(badShape.errors.length, 5);
});

test('frame maps default to the grid width when a custom grid is used', () => {
  const { config, errors } = normalizeCharacterConfig({
    columns: 4,
    rows: 3,
    rows_map: { walk: 1, sad_walk: 2, idle: 3, happy: 1, sad: 2, drinking: 3 }
  }, { folderName: 'robot' });
  assert.deepEqual(errors, []);
  assert.equal(config.frames_per_row.walk, 4);
  assert.equal(config.frames_per_row.sad_walk, 4);
});

test('sheet geometry requires evenly divisible columns and rows', () => {
  const square = validateSheetGeometry(1254, 1254, { columns: 6, rows: 6 });
  assert.equal(square.valid, true);
  assert.equal(square.cellWidth, 209);
  assert.equal(square.cellHeight, 209);

  const broken = validateSheetGeometry(100, 100, { columns: 6, rows: 6 });
  assert.equal(broken.valid, false);
  assert.ok(broken.errors.some((error) => /width 100px is not divisible/.test(error)));
  assert.ok(broken.errors.some((error) => /height 100px is not divisible/.test(error)));

  const rectangular = validateSheetGeometry(300, 200, { columns: 3, rows: 2 });
  assert.equal(rectangular.valid, true);
  assert.equal(rectangular.cellWidth, 100);
  assert.equal(rectangular.cellHeight, 100);

  const empty = validateSheetGeometry(0, 0, { columns: 6, rows: 6 });
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.some((error) => /no readable pixel width/.test(error)));
});

test('character names are validated and slugged safely', () => {
  assert.equal(validateCharacterName('Buddy 2'), null);
  assert.ok(validateCharacterName(''));
  assert.ok(validateCharacterName('   '));
  assert.ok(validateCharacterName('a'.repeat(61)));
  assert.ok(validateCharacterName('bad\u0001name'));

  assert.equal(slugifyCharacterName('Little Robot'), 'little-robot');
  assert.equal(slugifyCharacterName('  Wörld 猫!! '), 'wörld-猫');
  assert.equal(slugifyCharacterName(''), 'character');
  assert.equal(slugifyCharacterName('   '), 'character');
  assert.equal(slugifyCharacterName('con'), 'con-character');
  assert.equal(slugifyCharacterName('COM1'), 'com1-character');
  assert.equal(slugifyCharacterName('a'.repeat(80)).length, 48);
});

test('directory scan merges bundled and user characters with user overrides', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remind-buddy-characters-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const bundledDir = path.join(root, 'bundled');
  const userDir = path.join(root, 'user');

  function writeCharacter(baseDir, folder, { sheet = true, config, rawConfig, extraFile } = {}) {
    const folderPath = path.join(baseDir, folder);
    fs.mkdirSync(folderPath, { recursive: true });
    if (sheet) fs.writeFileSync(path.join(folderPath, 'sheet.png'), 'placeholder');
    if (rawConfig !== undefined) {
      fs.writeFileSync(path.join(folderPath, 'character.json'), rawConfig);
    } else if (config !== undefined) {
      fs.writeFileSync(path.join(folderPath, 'character.json'), JSON.stringify(config));
    }
    if (extraFile) fs.writeFileSync(path.join(folderPath, extraFile), 'ignored');
  }

  writeCharacter(bundledDir, 'buddy', {
    config: { name: 'Buddy', columns: 6, rows: 6 }
  });
  writeCharacter(bundledDir, 'broken');
  writeCharacter(bundledDir, 'no-sheet', { sheet: false, extraFile: 'readme.txt' });
  writeCharacter(bundledDir, '.hidden');

  writeCharacter(userDir, 'buddy', {
    config: {
      name: 'Buddy',
      columns: 3,
      rows: 3,
      rows_map: { walk: 1, sad_walk: 2, idle: 3, happy: 1, sad: 2, drinking: 3 }
    }
  });
  writeCharacter(userDir, 'robot', {
    config: {
      name: 'Robot',
      columns: 3,
      rows: 3,
      fps: 10,
      rows_map: { walk: 1, sad_walk: 2, idle: 3, happy: 1, sad: 2, drinking: 3 }
    }
  });
  writeCharacter(userDir, 'casey', { rawConfig: '{ not json' });
  writeCharacter(userDir, 'faulty');

  const readImageSize = async (sheetPath) => {
    if (sheetPath.includes(`${path.sep}broken${path.sep}`)) return { width: 100, height: 100 };
    if (sheetPath.includes(`${path.sep}faulty${path.sep}`)) throw new Error('unreadable');
    return { width: 192, height: 192 };
  };

  const result = await scanCharacterDirectories({ bundledDir, userDir, readImageSize });
  assert.deepEqual(result.items.map((item) => item.id), ['broken', 'buddy', 'casey', 'faulty', 'robot']);
  assert.deepEqual(result.warnings, []);

  const buddy = result.items.find((item) => item.id === 'buddy');
  assert.equal(buddy.source, 'user');
  assert.equal(buddy.valid, true);
  assert.equal(buddy.config.columns, 3);
  assert.equal(buddy.cellWidth, 64);

  const broken = result.items.find((item) => item.id === 'broken');
  assert.equal(broken.valid, false);
  assert.match(broken.warning, /not divisible/i);

  const casey = result.items.find((item) => item.id === 'casey');
  assert.equal(casey.valid, false);
  assert.match(casey.warning, /character\.json could not be read/i);

  const faulty = result.items.find((item) => item.id === 'faulty');
  assert.equal(faulty.valid, false);
  assert.match(faulty.warning, /could not be read as an image/i);

  assert.equal(result.items.some((item) => item.id === 'no-sheet'), false);
  assert.equal(result.items.some((item) => item.id === '.hidden'), false);

  const empty = await scanCharacterDirectories({
    bundledDir: path.join(root, 'absent'),
    userDir: path.join(root, 'also-absent'),
    readImageSize
  });
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.warnings, []);
});

test('character selection falls back to the first usable sheet', () => {
  const items = [
    { id: 'buddy', name: 'Buddy', valid: true },
    { id: 'cat', name: 'Cat', valid: true },
    { id: 'broken', name: 'Broken', valid: false },
    { id: 'robot', name: 'Robot', valid: true }
  ];

  const chosen = resolveCharacterSelection(items, { characterId: 'cat' });
  assert.equal(chosen.character.id, 'cat');
  assert.equal(chosen.missing, false);
  assert.equal(chosen.random, false);

  const caseInsensitive = resolveCharacterSelection(items, { characterId: 'ROBOT' });
  assert.equal(caseInsensitive.character.id, 'robot');
  assert.equal(caseInsensitive.missing, false);

  const missing = resolveCharacterSelection(items, { characterId: 'ghost' });
  assert.equal(missing.character.id, 'buddy');
  assert.equal(missing.missing, true);

  const invalid = resolveCharacterSelection(items, { characterId: 'broken' });
  assert.equal(invalid.character.id, 'buddy');
  assert.equal(invalid.missing, true);

  const randomFirst = resolveCharacterSelection(items, { randomCharacter: true, random: () => 0 });
  assert.equal(randomFirst.character.id, 'buddy');
  assert.equal(randomFirst.random, true);
  const randomLast = resolveCharacterSelection(items, { randomCharacter: true, random: () => 0.999 });
  assert.equal(randomLast.character.id, 'robot');

  const none = resolveCharacterSelection([{ id: 'broken', valid: false }], { characterId: 'broken' });
  assert.equal(none.character, null);
  assert.equal(none.missing, true);
});

test('character settings default, validate, and sanitize', () => {
  assert.equal(DEFAULT_SETTINGS.defaultCharacterId, 'buddy');
  assert.equal(DEFAULT_SETTINGS.defaultCharacterScale, 100);
  assert.equal(DEFAULT_SETTINGS.randomCharacter, false);

  const normalized = normalizeSettings({
    defaultCharacterId: 'robot-2',
    defaultCharacterScale: 150,
    randomCharacter: true
  });
  assert.equal(normalized.defaultCharacterId, 'robot-2');
  assert.equal(normalized.defaultCharacterScale, 150);
  assert.equal(normalized.randomCharacter, true);

  assert.throws(
    () => normalizeSettings({
      defaultCharacterId: '../evil',
      defaultCharacterScale: 201,
      randomCharacter: 'yes'
    }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.errors.length, 3);
      assert.match(error.errors.join(' '), /Default character selection is invalid/);
      assert.match(error.errors.join(' '), /Default character size must be between 50 and 200 percent/);
      assert.match(error.errors.join(' '), /Random character setting/);
      return true;
    }
  );

  const lenient = normalizeSettings({
    defaultCharacterId: 'a/b',
    defaultCharacterScale: 49,
    randomCharacter: 'sometimes'
  }, { strict: false });
  assert.equal(lenient.defaultCharacterId, DEFAULT_SETTINGS.defaultCharacterId);
  assert.equal(lenient.defaultCharacterScale, DEFAULT_SETTINGS.defaultCharacterScale);
  assert.equal(lenient.randomCharacter, DEFAULT_SETTINGS.randomCharacter);

  for (const id of ['', ' leading', 'trailing ', '.hidden', 'a'.repeat(81), 'tab\tid']) {
    assert.throws(
      () => normalizeSettings({ defaultCharacterId: id }),
      /Default character selection is invalid/,
      `Expected "${id}" to be rejected`
    );
  }
  for (const scale of [49, 201, 100.5]) {
    assert.throws(
      () => normalizeSettings({ defaultCharacterScale: scale }),
      /Default character size must be between 50 and 200 percent/,
      `Expected ${scale}% to be rejected`
    );
  }
});
