'use strict';

(() => {
  const ROW_KEYS = Object.freeze(['walk', 'sad_walk', 'idle', 'happy', 'sad', 'drinking']);
  const OPTIONAL_ROW_KEYS = Object.freeze(['exercise', 'thinking']);
  const DEFAULT_CONFIG = Object.freeze({
    name: 'Character',
    columns: 6,
    rows: 6,
    fps: 8,
    scale: 1,
    facing: 'right',
    rows_map: Object.freeze({
      walk: 1,
      sad_walk: 2,
      idle: 3,
      happy: 4,
      sad: 5,
      drinking: 6
    }),
    frames_per_row: Object.freeze({
      walk: 6,
      sad_walk: 6,
      idle: 6,
      happy: 6,
      sad: 6,
      drinking: 6
    })
  });

  const FALLBACK_SIZE = 320;
  const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function normalizeConfig(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const columns = Number.isInteger(source.columns) ? clamp(source.columns, 1, 64) : 6;
    const rows = Number.isInteger(source.rows) ? clamp(source.rows, 1, 64) : 6;
    const rowsMap = { ...DEFAULT_CONFIG.rows_map };
    const framesPerRow = { ...DEFAULT_CONFIG.frames_per_row };

    for (const key of ROW_KEYS) {
      const row = source.rows_map?.[key];
      rowsMap[key] = Number.isInteger(row) ? clamp(row, 1, rows) : DEFAULT_CONFIG.rows_map[key];
      const frameCount = source.frames_per_row?.[key];
      framesPerRow[key] = Number.isInteger(frameCount)
        ? clamp(frameCount, 1, columns)
        : columns;
      if (rowsMap[key] > rows) rowsMap[key] = rows;
    }

    for (const key of OPTIONAL_ROW_KEYS) {
      const row = source.rows_map?.[key];
      if (!Number.isInteger(row) || row < 1 || row > rows) continue;
      rowsMap[key] = row;
      const frameCount = source.frames_per_row?.[key];
      framesPerRow[key] = Number.isInteger(frameCount)
        ? clamp(frameCount, 1, columns)
        : columns;
    }

    return {
      name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : 'Character',
      columns,
      rows,
      fps: Number.isFinite(source.fps) ? clamp(source.fps, 1, 30) : 8,
      scale: Number.isFinite(source.scale) ? clamp(source.scale, 0.25, 4) : 1,
      facing: source.facing === 'left' ? 'left' : 'right',
      rows_map: rowsMap,
      frames_per_row: framesPerRow
    };
  }

  function stateForSprite(config, state) {
    if (config.rows_map[state]) return state;
    if (OPTIONAL_ROW_KEYS.includes(state)) {
      return config.rows_map.happy ? 'happy' : 'idle';
    }
    return config.rows_map.idle ? 'idle' : config.rows_map.walk ? 'walk' : 'happy';
  }

  function rowForState(config, state) {
    return config.rows_map[stateForSprite(config, state)] || 1;
  }

  function frameCountFor(config, state) {
    const key = stateForSprite(config, state);
    return config.frames_per_row[key] || config.columns;
  }

  function shouldMirror(config, direction) {
    const nativeFacing = config?.facing === 'left' ? 'left' : 'right';
    return nativeFacing !== direction;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.addEventListener('load', () => resolve(image), { once: true });
      image.addEventListener('error', () => reject(new Error('The character sheet could not be loaded.')), { once: true });
      image.src = url;
    });
  }

  function sampleBorderKey(context, width, height) {
    const pixels = context.getImageData(0, 0, width, height).data;
    const samples = [];
    const steps = 24;
    const inset = Math.min(4, Math.max(1, Math.floor(Math.min(width, height) * 0.01)));

    const addSample = (x, y) => {
      const px = clamp(Math.round(x), 0, width - 1);
      const py = clamp(Math.round(y), 0, height - 1);
      const index = (py * width + px) * 4;
      samples.push({
        r: pixels[index],
        g: pixels[index + 1],
        b: pixels[index + 2],
        a: pixels[index + 3]
      });
    };

    for (let step = 0; step <= steps; step += 1) {
      const x = (width - 1) * (step / steps);
      const y = (height - 1) * (step / steps);
      addSample(x, inset);
      addSample(x, height - 1 - inset);
      addSample(inset, y);
      addSample(width - 1 - inset, y);
    }

    const opaque = samples.filter((sample) => sample.a >= 180);
    if (opaque.length < samples.length * 0.72) return null;

    const median = (channel) => {
      const values = opaque.map((sample) => sample[channel]).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    };
    const key = { r: median('r'), g: median('g'), b: median('b') };
    const close = opaque.filter((sample) => {
      const dr = sample.r - key.r;
      const dg = sample.g - key.g;
      const db = sample.b - key.b;
      return dr * dr + dg * dg + db * db <= 34 * 34;
    });
    if (close.length < opaque.length * 0.82) return null;
    return key;
  }

  function createKeyedCanvas(image) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('The character sheet is empty.');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('A canvas is not available for the character sheet.');
    context.drawImage(image, 0, 0);

    const key = sampleBorderKey(context, width, height);
    if (!key) return canvas;

    const frame = context.getImageData(0, 0, width, height);
    const pixels = frame.data;
    const greenKey = key.g > key.r + 40 && key.g > key.b + 40;
    const transparentDistanceSq = 30 * 30;
    const opaqueDistanceSq = 80 * 80;

    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const dr = red - key.r;
      const dg = green - key.g;
      const db = blue - key.b;
      const distanceSq = dr * dr + dg * dg + db * db;

      let alpha;
      if (distanceSq <= transparentDistanceSq) {
        alpha = 0;
      } else if (distanceSq >= opaqueDistanceSq) {
        alpha = 255;
      } else {
        alpha = Math.round((255 * (Math.sqrt(distanceSq) - 30)) / 50);
      }

      if (alpha > 0 && greenKey) {
        // Despill green bounce picked up along edges while keeping green props.
        const greenExcess = green - Math.max(red, blue);
        if (greenExcess > 20) {
          const strength = Math.min(1, (greenExcess - 20) / 40);
          pixels[index + 1] = Math.round(green * (1 - strength) + Math.max(red, blue) * strength);
        }
      }
      pixels[index + 3] = Math.min(pixels[index + 3], alpha);
    }

    context.putImageData(frame, 0, 0);
    return canvas;
  }

  function measureRowFrames(sheet, config, rowNumber, frameCount) {
    const context = sheet.getContext('2d', { willReadFrequently: true });
    const cellWidth = sheet.width / config.columns;
    const cellHeight = sheet.height / config.rows;
    const boxes = [];
    const rowIndex = rowNumber - 1;

    for (let column = 0; column < frameCount; column += 1) {
      const frame = context.getImageData(
        Math.round(column * cellWidth),
        Math.round(rowIndex * cellHeight),
        Math.max(1, Math.round(cellWidth)),
        Math.max(1, Math.round(cellHeight))
      ).data;
      const width = Math.max(1, Math.round(cellWidth));
      const height = Math.max(1, Math.round(cellHeight));
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (frame[(y * width + x) * 4 + 3] < 12) continue;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      boxes.push(maxX < 0
        ? { centerX: width / 2, maxY: height - 1, empty: true }
        : { centerX: (minX + maxX) / 2, maxY, empty: false });
    }
    return boxes;
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  }

  function calculateFrameOffsets(sheet, config) {
    const offsets = {};
    const rowsToAnchor = new Map();

    for (const key of ROW_KEYS) {
      if (key !== 'walk' && key !== 'sad_walk') continue;
      const row = rowForState(config, key);
      const frameCount = frameCountFor(config, key);
      const current = rowsToAnchor.get(row) || { frameCount: 0 };
      rowsToAnchor.set(row, { frameCount: Math.max(current.frameCount, frameCount) });
    }

    for (const [row, details] of rowsToAnchor) {
      const boxes = measureRowFrames(sheet, config, row, details.frameCount);
      const anchored = boxes.filter((box) => !box.empty);
      if (anchored.length === 0) {
        offsets[row] = Array.from({ length: details.frameCount }, () => ({ x: 0, y: 0 }));
        continue;
      }
      const anchorX = median(anchored.map((box) => box.centerX));
      const anchorBottom = median(anchored.map((box) => box.maxY));
      offsets[row] = boxes.map((box) => (box.empty
        ? { x: 0, y: 0 }
        : { x: anchorX - box.centerX, y: anchorBottom - box.maxY }));
    }

    return offsets;
  }

  async function prepareSprite(dataUrl, rawConfig) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      throw new Error('No character sheet was provided.');
    }
    const config = normalizeConfig(rawConfig);
    const image = await loadImage(dataUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('The character sheet is empty.');
    if (width % config.columns !== 0) {
      throw new Error(`Sheet width ${width}px is not divisible by ${config.columns} columns.`);
    }
    if (height % config.rows !== 0) {
      throw new Error(`Sheet height ${height}px is not divisible by ${config.rows} rows.`);
    }

    const sheet = createKeyedCanvas(image);
    const cellWidth = sheet.width / config.columns;
    const cellHeight = sheet.height / config.rows;
    return {
      kind: 'sprite',
      config,
      sheet,
      cellWidth,
      cellHeight,
      sourceWidth: width,
      sourceHeight: height,
      offsets: calculateFrameOffsets(sheet, config)
    };
  }

  function createFallback(rawConfig) {
    return {
      kind: 'fallback',
      config: normalizeConfig(rawConfig),
      sheet: null,
      cellWidth: FALLBACK_SIZE,
      cellHeight: FALLBACK_SIZE,
      sourceWidth: FALLBACK_SIZE,
      sourceHeight: FALLBACK_SIZE,
      offsets: {}
    };
  }

  function drawSpriteFrame(canvas, prepared, state, frameIndex) {
    const { config, sheet, cellWidth, cellHeight } = prepared;
    if (canvas.width !== Math.round(cellWidth) || canvas.height !== Math.round(cellHeight)) {
      canvas.width = Math.round(cellWidth);
      canvas.height = Math.round(cellHeight);
    }
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;

    const row = rowForState(config, state);
    const frameCount = frameCountFor(config, state);
    const frame = ((Math.floor(frameIndex) % frameCount) + frameCount) % frameCount;
    const offset = prepared.offsets[row]?.[frame] || { x: 0, y: 0 };
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      sheet,
      frame * cellWidth,
      (row - 1) * cellHeight,
      cellWidth,
      cellHeight,
      offset.x,
      offset.y,
      cellWidth,
      cellHeight
    );
  }

  function roundedRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function drawDropBody(context, state, time) {
    const sad = state === 'sad' || state === 'sad_walk';
    const happy = state === 'happy';
    const walking = state === 'walk' || state === 'sad_walk';
    const step = Math.sin(time * (walking ? 7 : 2.4));
    const squash = 1 + (walking ? Math.abs(step) * 0.018 : Math.sin(time * 2.1) * 0.008);
    const stretch = 1 - (squash - 1) * 0.65;
    const tilt = walking ? step * 0.035 : (sad ? -0.025 : Math.sin(time * 1.7) * 0.012);

    context.save();
    context.rotate(tilt);
    context.scale(1 / squash, squash);

    if (walking) {
      context.fillStyle = '#169ecb';
      context.beginPath();
      context.ellipse(-32, 2 + Math.max(0, step) * 5, 23, 9, -0.1, 0, Math.PI * 2);
      context.ellipse(31, 2 + Math.max(0, -step) * 5, 23, 9, 0.1, 0, Math.PI * 2);
      context.fill();
    }

    const bodyGradient = context.createLinearGradient(0, -205, 0, 15);
    bodyGradient.addColorStop(0, happy ? '#8ce7fb' : '#6cdcf7');
    bodyGradient.addColorStop(0.5, sad ? '#44c0e7' : '#31c1eb');
    bodyGradient.addColorStop(1, sad ? '#1a9bca' : '#0b8fc7');
    context.fillStyle = bodyGradient;
    context.beginPath();
    context.moveTo(0, -194 * stretch);
    context.bezierCurveTo(16, -158, 82, -119, 84, -61);
    context.bezierCurveTo(86, -17, 48, 0, 0, 0);
    context.bezierCurveTo(-48, 0, -86, -17, -84, -61);
    context.bezierCurveTo(-82, -119, -16, -158, 0, -194 * stretch);
    context.closePath();
    context.fill();

    context.save();
    context.globalAlpha = 0.45;
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.ellipse(-35, -136, 17, 29, -0.42, 0, Math.PI * 2);
    context.fill();
    context.restore();

    context.restore();
  }

  function drawArm(context, fromX, fromY, toX, toY, bend = 0) {
    context.save();
    context.strokeStyle = '#1ba7d4';
    context.lineWidth = 13;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.quadraticCurveTo((fromX + toX) / 2 + bend, (fromY + toY) / 2, toX, toY);
    context.stroke();
    context.restore();
  }

  function drawFace(context, state, time) {
    const sad = state === 'sad' || state === 'sad_walk';
    const happy = state === 'happy';
    const drinking = state === 'drinking';
    const blinkCycle = time % 4.2;
    const blinking = !happy && !sad && blinkCycle > 3.95;
    const blink = blinking ? 0.12 : 1;
    const eyeY = sad ? -100 : -108;
    const eyeSpread = sad ? 30 : 31;

    context.save();
    context.fillStyle = '#073f5b';
    for (const side of [-1, 1]) {
      context.beginPath();
      context.ellipse(side * eyeSpread, eyeY, 7.4, 11.5 * blink, 0, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#ffffff';
      context.globalAlpha = 0.85;
      context.beginPath();
      context.arc(side * eyeSpread - 2.2, eyeY - 4.1 * blink, 2.1, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#073f5b';
      context.globalAlpha = 1;
    }

    context.globalAlpha = 0.38;
    context.fillStyle = '#ff8f9e';
    context.beginPath();
    context.ellipse(-51, -85, 10, 5.5, 0, 0, Math.PI * 2);
    context.ellipse(51, -85, 10, 5.5, 0, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;

    context.strokeStyle = '#073f5b';
    context.lineWidth = 3.6;
    context.lineCap = 'round';
    if (happy) {
      context.fillStyle = '#0a5474';
      context.beginPath();
      context.ellipse(0, -82, 13, 12, 0, 0, Math.PI);
      context.fill();
      context.strokeStyle = '#6be0f8';
      context.lineWidth = 3.4;
      context.beginPath();
      context.arc(0, -81, 9, 0.15 * Math.PI, 0.85 * Math.PI);
      context.stroke();
    } else if (sad) {
      context.beginPath();
      context.arc(0, -69, 13, 1.16 * Math.PI, 1.84 * Math.PI);
      context.stroke();
    } else if (drinking) {
      context.beginPath();
      context.arc(0, -82, 6, 0.15 * Math.PI, 0.85 * Math.PI);
      context.stroke();
    } else {
      context.beginPath();
      context.arc(0, -88, 12, 0.18 * Math.PI, 0.82 * Math.PI);
      context.stroke();
    }
    context.restore();
  }

  function drawTears(context, state, time) {
    if (state !== 'sad' && state !== 'sad_walk') return;
    const cycle = time % 2.2;
    const progress = cycle / 2.2;
    context.save();
    context.globalAlpha = Math.max(0, 1 - progress);
    context.fillStyle = '#8fe8fb';
    context.beginPath();
    const x = 39;
    const y = -80 + progress * 88;
    context.moveTo(x, y - 12);
    context.bezierCurveTo(x + 10, y + 1, x + 7, y + 9, x, y + 9);
    context.bezierCurveTo(x - 7, y + 9, x - 10, y + 1, x, y - 12);
    context.fill();
    context.restore();
  }

  function drawSparkles(context, time) {
    context.save();
    context.fillStyle = '#ffe27a';
    for (let index = 0; index < 3; index += 1) {
      const angle = time * 1.1 + index * 2.1;
      const radius = 124 + Math.sin(time * 2 + index) * 8;
      const x = Math.cos(angle) * radius;
      const y = -118 + Math.sin(angle) * radius * 0.5;
      const size = 4 + (index % 2) * 2;
      context.save();
      context.translate(x, y);
      context.rotate(angle);
      context.fillRect(-size / 2, -size, size, size * 2);
      context.fillRect(-size, -size / 2, size * 2, size);
      context.restore();
    }
    context.restore();
  }

  function drawGlass(context, time) {
    context.save();
    const lift = 0.14 + Math.sin(time * 3.1) * 0.09;
    context.translate(34, -104);
    context.rotate(-lift);
    context.strokeStyle = '#0b6e91';
    context.lineWidth = 3;
    context.fillStyle = 'rgba(255, 255, 255, 0.72)';
    roundedRect(context, 0, -28, 43, 58, 8);
    context.fill();
    context.stroke();
    context.fillStyle = 'rgba(57, 198, 235, 0.78)';
    roundedRect(context, 4, 3, 35, 24, 5);
    context.fill();
    context.fillStyle = 'rgba(255, 255, 255, 0.55)';
    context.fillRect(9, -20, 5, 38);
    context.restore();
  }

  function drawFallbackFrame(canvas, state, timeMs) {
    if (canvas.width !== FALLBACK_SIZE || canvas.height !== FALLBACK_SIZE) {
      canvas.width = FALLBACK_SIZE;
      canvas.height = FALLBACK_SIZE;
    }
    if (state === 'exercise' || state === 'thinking') state = 'happy';
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;
    const time = reduceMotionQuery.matches ? 0 : timeMs / 1000;
    const walking = state === 'walk' || state === 'sad_walk';
    const sad = state === 'sad' || state === 'sad_walk';
    const happy = state === 'happy';
    const drinking = state === 'drinking';
    const step = Math.sin(time * (walking ? 7 : 2.4));
    const bob = walking
      ? Math.abs(step) * 10
      : (happy ? Math.abs(Math.sin(time * 4.2)) * 15 : Math.sin(time * 1.9) * 3.2 + 3.2);
    const drop = sad ? 7 : 0;

    context.clearRect(0, 0, FALLBACK_SIZE, FALLBACK_SIZE);
    context.save();
    context.translate(160, 287 - bob + drop);

    if (happy) {
      drawArm(context, -60, -92, -92, -158, -10);
      drawArm(context, 60, -92, 92, -158, 10);
    } else if (sad) {
      drawArm(context, -60, -92, -26, -22, 12);
      drawArm(context, 60, -92, 26, -22, -12);
    } else if (drinking) {
      drawArm(context, -64, -90, -24, -16, 8);
      drawArm(context, 62, -96, 57, -123, 10);
    } else if (state === 'idle') {
      drawArm(context, -62, -96, -21, -26, 9);
      drawArm(context, 62, -96, 72 + Math.sin(time * 3.2) * 15, -148, 8);
    } else {
      drawArm(context, -62, -94, -72 - step * 14, -30, 7);
      drawArm(context, 62, -94, 72 + step * 14, -30, -7);
    }

    drawDropBody(context, state, time);
    drawFace(context, state, time);

    if (drinking) drawGlass(context, time);
    if (sad) drawTears(context, state, time);
    if (happy) drawSparkles(context, time);
    context.restore();
  }

  function drawFrame(canvas, prepared, state, frameIndex, timeMs) {
    if (!prepared || prepared.kind === 'fallback') {
      drawFallbackFrame(canvas, state || 'idle', timeMs || 0);
      return;
    }
    drawSpriteFrame(canvas, prepared, state, frameIndex);
  }

  function hasState(prepared, state) {
    if (!prepared) return false;
    if (prepared.kind === 'fallback') return ROW_KEYS.includes(state);
    return Boolean(prepared.config.rows_map[state]);
  }

  window.WaterBuddyCharacterEngine = {
    DEFAULT_CONFIG,
    OPTIONAL_ROW_KEYS,
    ROW_KEYS,
    createFallback,
    drawFallbackFrame,
    drawFrame,
    frameCountFor,
    hasState,
    normalizeConfig,
    prepareSprite,
    rowForState,
    shouldMirror,
    stateForSprite
  };
})();
