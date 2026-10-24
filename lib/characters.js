'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const ROW_KEYS = Object.freeze(['walk', 'sad_walk', 'idle', 'happy', 'sad', 'drinking']);
const OPTIONAL_ROW_KEYS = Object.freeze(['exercise', 'thinking']);
const ROW_LABELS = Object.freeze({
  walk: 'Walk',
  sad_walk: 'Sad walk',
  idle: 'Idle',
  happy: 'Happy',
  sad: 'Sad',
  drinking: 'Drinking',
  exercise: 'Exercise',
  thinking: 'Thinking'
});
const DEFAULT_ROWS_MAP = Object.freeze({
  walk: 1,
  sad_walk: 2,
  idle: 3,
  happy: 4,
  sad: 5,
  drinking: 6
});
const DEFAULT_FRAMES_PER_ROW = Object.freeze({
  walk: 6,
  sad_walk: 6,
  idle: 6,
  happy: 6,
  sad: 6,
  drinking: 6
});
const DEFAULT_CHARACTER_CONFIG = Object.freeze({
  name: 'Character',
  columns: 6,
  rows: 6,
  fps: 8,
  scale: 1,
  facing: 'right',
  rows_map: DEFAULT_ROWS_MAP,
  frames_per_row: DEFAULT_FRAMES_PER_ROW
});

const MAX_GRID_SIZE = 64;
const MAX_FPS = 30;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const MAX_NAME_LENGTH = 60;
const MAX_FOLDER_LENGTH = 48;
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function cloneCharacterConfig(source = DEFAULT_CHARACTER_CONFIG) {
  const rowsMap = { ...DEFAULT_ROWS_MAP };
  const framesPerRow = { ...DEFAULT_FRAMES_PER_ROW };
  for (const key of OPTIONAL_ROW_KEYS) {
    if (Number.isInteger(source?.rows_map?.[key])) rowsMap[key] = source.rows_map[key];
    if (Number.isInteger(source?.frames_per_row?.[key])) framesPerRow[key] = source.frames_per_row[key];
  }
  return {
    name: source.name,
    columns: source.columns,
    rows: source.rows,
    fps: source.fps,
    scale: source.scale,
    facing: source.facing,
    rows_map: rowsMap,
    frames_per_row: framesPerRow
  };
}

function readableFolderName(folderName) {
  const cleaned = String(folderName || 'character')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Character';
  return cleaned.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeCharacterConfig(raw, { folderName = 'character' } = {}) {
  const errors = [];
  const warnings = [];
  const config = cloneCharacterConfig({ ...DEFAULT_CHARACTER_CONFIG, name: readableFolderName(folderName) });

  if (raw === undefined || raw === null) {
    return { config, errors, warnings };
  }
  if (!isPlainObject(raw)) {
    errors.push('character.json must contain a JSON object.');
    return { config, errors, warnings };
  }

  if (raw.name !== undefined) {
    if (typeof raw.name === 'string' && raw.name.trim()) {
      config.name = raw.name.trim().slice(0, MAX_NAME_LENGTH);
    } else {
      warnings.push('The character name in character.json is not text; the folder name is being used instead.');
    }
  }

  if (raw.columns !== undefined) {
    if (Number.isInteger(raw.columns) && raw.columns >= 1 && raw.columns <= MAX_GRID_SIZE) {
      config.columns = raw.columns;
    } else {
      errors.push(`character.json columns must be a whole number between 1 and ${MAX_GRID_SIZE}.`);
    }
  }

  if (raw.rows !== undefined) {
    if (Number.isInteger(raw.rows) && raw.rows >= 1 && raw.rows <= MAX_GRID_SIZE) {
      config.rows = raw.rows;
    } else {
      errors.push(`character.json rows must be a whole number between 1 and ${MAX_GRID_SIZE}.`);
    }
  }

  if (raw.fps !== undefined) {
    if (Number.isFinite(raw.fps) && raw.fps >= 1 && raw.fps <= MAX_FPS) {
      config.fps = raw.fps;
    } else {
      errors.push(`character.json fps must be a number between 1 and ${MAX_FPS}.`);
    }
  }

  if (raw.scale !== undefined) {
    if (Number.isFinite(raw.scale) && raw.scale >= MIN_SCALE && raw.scale <= MAX_SCALE) {
      config.scale = raw.scale;
    } else {
      errors.push(`character.json scale must be between ${MIN_SCALE} and ${MAX_SCALE}.`);
    }
  }

  if (raw.facing !== undefined) {
    if (raw.facing === 'left' || raw.facing === 'right') {
      config.facing = raw.facing;
    } else {
      errors.push('character.json facing must be "left" or "right".');
    }
  }

  if (raw.rows_map !== undefined) {
    if (!isPlainObject(raw.rows_map)) {
      errors.push('character.json rows_map must be an object.');
    } else {
      for (const key of ROW_KEYS) {
        if (raw.rows_map[key] === undefined) {
          const defaultRow = DEFAULT_ROWS_MAP[key];
          if (defaultRow <= config.rows) {
            config.rows_map[key] = defaultRow;
          } else {
            errors.push(`character.json rows_map is missing "${key}".`);
          }
        } else if (
          Number.isInteger(raw.rows_map[key])
          && raw.rows_map[key] >= 1
          && raw.rows_map[key] <= config.rows
        ) {
          config.rows_map[key] = raw.rows_map[key];
        } else {
          errors.push(`character.json rows_map.${key} must be between 1 and ${config.rows}.`);
        }
      }
    }
  } else if (config.rows < 6) {
    errors.push('character.json must define rows_map when rows is less than 6.');
  }

  for (const key of OPTIONAL_ROW_KEYS) {
    const value = isPlainObject(raw.rows_map) ? raw.rows_map[key] : undefined;
    if (value === undefined) continue;
    if (Number.isInteger(value) && value >= 1 && value <= config.rows) {
      config.rows_map[key] = value;
    } else {
      errors.push(`character.json rows_map.${key} must be between 1 and ${config.rows}.`);
    }
  }

  if (raw.frames_per_row !== undefined) {
    if (!isPlainObject(raw.frames_per_row)) {
      errors.push('character.json frames_per_row must be an object.');
    } else {
      for (const key of ROW_KEYS) {
        if (raw.frames_per_row[key] === undefined) {
          config.frames_per_row[key] = config.columns;
        } else if (
          Number.isInteger(raw.frames_per_row[key])
          && raw.frames_per_row[key] >= 1
          && raw.frames_per_row[key] <= config.columns
        ) {
          config.frames_per_row[key] = raw.frames_per_row[key];
        } else {
          errors.push(`character.json frames_per_row.${key} must be between 1 and ${config.columns}.`);
        }
      }
    }
  } else {
    for (const key of ROW_KEYS) config.frames_per_row[key] = config.columns;
  }

  for (const key of OPTIONAL_ROW_KEYS) {
    if (!config.rows_map[key]) continue;
    const value = raw.frames_per_row?.[key];
    if (value === undefined) {
      config.frames_per_row[key] = config.columns;
    } else if (Number.isInteger(value) && value >= 1 && value <= config.columns) {
      config.frames_per_row[key] = value;
    } else {
      errors.push(`character.json frames_per_row.${key} must be between 1 and ${config.columns}.`);
    }
  }

  return { config, errors, warnings };
}

function validateSheetGeometry(width, height, config) {
  const errors = [];
  if (!Number.isInteger(width) || width <= 0) errors.push('The sheet has no readable pixel width.');
  if (!Number.isInteger(height) || height <= 0) errors.push('The sheet has no readable pixel height.');

  if (errors.length === 0) {
    if (width % config.columns !== 0) {
      errors.push(`Sheet width ${width}px is not divisible by ${config.columns} columns.`);
    }
    if (height % config.rows !== 0) {
      errors.push(`Sheet height ${height}px is not divisible by ${config.rows} rows.`);
    }
  }

  const cellWidth = width / config.columns;
  const cellHeight = height / config.rows;
  return {
    valid: errors.length === 0,
    errors,
    cellWidth,
    cellHeight
  };
}

function validateCharacterName(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Enter a character name.';
  const trimmed = value.trim();
  if (trimmed.length > MAX_NAME_LENGTH) return `Character names can be at most ${MAX_NAME_LENGTH} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return 'Character names cannot contain control characters.';
  return null;
}

function slugifyCharacterName(name) {
  let slug = String(name || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_FOLDER_LENGTH)
    .replace(/-+$/g, '');
  if (!slug) slug = 'character';
  if (WINDOWS_RESERVED_NAMES.has(slug)) slug = `${slug}-character`;
  return slug;
}

async function readConfigJson(filePath) {
  const text = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(text);
}

async function findFile(entries, wantedName) {
  return entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === wantedName) || null;
}

async function buildCharacterEntry(rootDir, folderName, source, readImageSize) {
  const folderPath = path.join(rootDir, folderName);
  const entries = await fsp.readdir(folderPath, { withFileTypes: true });
  const sheetEntry = await findFile(entries, 'sheet.png');
  if (!sheetEntry) return null;

  const sheetPath = path.join(folderPath, sheetEntry.name);
  const configEntry = await findFile(entries, 'character.json');
  const previewEntry = await findFile(entries, 'preview.png');
  const errors = [];
  const warnings = [];
  let rawConfig;

  if (configEntry) {
    try {
      rawConfig = await readConfigJson(path.join(folderPath, configEntry.name));
    } catch (error) {
      errors.push(`character.json could not be read: ${error.message}`);
    }
  }

  const normalized = normalizeCharacterConfig(rawConfig, { folderName });
  errors.push(...normalized.errors);
  warnings.push(...normalized.warnings);

  let imageWidth = 0;
  let imageHeight = 0;
  try {
    const size = await readImageSize(sheetPath);
    imageWidth = Number(size?.width) || 0;
    imageHeight = Number(size?.height) || 0;
  } catch {
    errors.push('sheet.png could not be read as an image.');
  }

  const geometry = validateSheetGeometry(imageWidth, imageHeight, normalized.config);
  errors.push(...geometry.errors);

  return {
    id: folderName,
    name: normalized.config.name,
    source,
    sheetPath,
    previewPath: previewEntry ? path.join(folderPath, previewEntry.name) : null,
    hasPreview: Boolean(previewEntry),
    config: normalized.config,
    imageWidth,
    imageHeight,
    cellWidth: geometry.cellWidth,
    cellHeight: geometry.cellHeight,
    valid: errors.length === 0,
    warning: [...errors, ...warnings].join(' ') || null
  };
}

async function collectCharacters(rootDir, source, itemsByKey, warnings, readImageSize) {
  let entries;
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warnings.push(`Could not read the ${source} characters folder: ${error.message}`);
    }
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const character = await buildCharacterEntry(rootDir, entry.name, source, readImageSize);
      if (!character) continue;
      itemsByKey.set(character.id.toLocaleLowerCase(), character);
    } catch (error) {
      warnings.push(`Could not read character "${entry.name}": ${error.message}`);
    }
  }
}

async function scanCharacterDirectories({ bundledDir, userDir, readImageSize }) {
  const itemsByKey = new Map();
  const warnings = [];

  // User folders are collected second so they intentionally override bundled
  // characters that use the same folder name.
  await collectCharacters(bundledDir, 'bundled', itemsByKey, warnings, readImageSize);
  await collectCharacters(userDir, 'user', itemsByKey, warnings, readImageSize);

  const items = [...itemsByKey.values()].sort((left, right) => {
    const byName = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return left.id.localeCompare(right.id, undefined, { sensitivity: 'base' });
  });

  return { items, warnings };
}

function resolveCharacterSelection(items, { characterId = '', randomCharacter = false, random = Math.random } = {}) {
  const valid = items.filter((item) => item.valid);
  if (valid.length === 0) {
    return { character: null, random: false, missing: true };
  }
  if (randomCharacter) {
    const index = Math.min(valid.length - 1, Math.floor(random() * valid.length));
    return { character: valid[index], random: true, missing: false };
  }
  const wanted = String(characterId || '').toLocaleLowerCase();
  const selected = valid.find((item) => item.id.toLocaleLowerCase() === wanted);
  if (selected) return { character: selected, random: false, missing: false };
  return { character: valid[0], random: false, missing: true };
}

module.exports = {
  DEFAULT_CHARACTER_CONFIG,
  DEFAULT_FRAMES_PER_ROW,
  DEFAULT_ROWS_MAP,
  MAX_FPS,
  MAX_GRID_SIZE,
  MAX_SCALE,
  MIN_SCALE,
  OPTIONAL_ROW_KEYS,
  ROW_KEYS,
  ROW_LABELS,
  cloneCharacterConfig,
  normalizeCharacterConfig,
  readableFolderName,
  resolveCharacterSelection,
  scanCharacterDirectories,
  slugifyCharacterName,
  validateCharacterName,
  validateSheetGeometry
};
