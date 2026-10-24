'use strict';

(() => {
  const api = window.remindBuddyOverlay;
  const engine = window.WaterBuddyCharacterEngine;
  if (!api || !engine) return;

  const stage = document.getElementById('stage');
  const statusPill = document.getElementById('status-pill');
  const actor = document.getElementById('actor');
  const mascot = document.getElementById('mascot');
  const bubble = document.getElementById('bubble');
  const bubbleIcon = document.getElementById('bubble-icon');
  const bubbleKicker = document.getElementById('bubble-kicker');
  const bubbleTitle = document.getElementById('bubble-title');
  const bubbleNote = document.getElementById('bubble-note');
  const timerBlock = document.getElementById('timer-block');
  const timerValue = document.getElementById('timer-value');
  const timerLabel = document.getElementById('timer-label');
  const timerFill = document.getElementById('timer-fill');
  const actions = document.getElementById('bubble-actions');
  const waitRow = document.getElementById('wait-row');
  const waitFill = document.getElementById('wait-fill');
  const waitLabel = document.getElementById('wait-label');
  const footer = document.getElementById('bubble-footer');
  const queueChip = document.getElementById('queue-chip');
  const testChip = document.getElementById('test-chip');
  const chime = document.getElementById('chime');
  const canvas = document.getElementById('mascot-canvas');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const ACTOR_BOTTOM = 14;
  const BASE_ACTOR_HEIGHT = 196;
  const NARROW_ACTOR_HEIGHT = 168;
  const MAX_ACTOR_FACTOR = 2.5;
  const ENTRY_WALK_MS = 1450;
  const EXIT_WALK_MS = 1350;
  const REACTION_HOLD_MS = 1400;
  const TYPE_LABELS = {
    yesno: 'Check-in',
    confirm: 'Reminder',
    choice: 'Reminder',
    timer: 'Timer',
    note: 'Note'
  };
  const BUTTON_CLASSES = {
    positive: 'positive',
    negative: 'negative',
    neutral: 'neutral',
    snooze: 'snooze',
    skip: 'skip'
  };

  let phase = 'hidden';
  let showRun = 0;
  let prepared = null;
  let payload = null;
  let promptWasSent = false;
  let resolved = false;
  let activeMove = null;
  let currentX = 0;
  let targetX = 0;

  let activeState = 'walk';
  let stateStartedAt = 0;
  let lastFrameIndex = -1;
  let frameLoop = 0;

  let countdownTimer = 0;
  let timerDeadline = 0;
  let timerTotal = 0;
  let waitDeadline = 0;
  let waitTotal = 0;
  let timerExpired = false;
  let animTimer = 0;

  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const pick = (list) => (Array.isArray(list) && list.length > 0
    ? list[Math.floor(Math.random() * list.length)]
    : '');

  function setPhase(next) {
    phase = next;
    stage.dataset.phase = next;
  }

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme;
    } else {
      delete document.documentElement.dataset.theme;
    }
  }

  function normalizeColor(value) {
    const input = typeof value === 'string' ? value.trim() : '';
    if (/^#[0-9a-f]{6}$/i.test(input)) return input;
    if (/^#[0-9a-f]{3}$/i.test(input)) {
      return `#${input[1]}${input[1]}${input[2]}${input[2]}${input[3]}${input[3]}`;
    }
    return '#17a9df';
  }

  function applyAccent(value) {
    const color = normalizeColor(value);
    const red = parseInt(color.slice(1, 3), 16);
    const green = parseInt(color.slice(3, 5), 16);
    const blue = parseInt(color.slice(5, 7), 16);
    const root = document.documentElement.style;
    root.setProperty('--accent', color);
    root.setProperty('--accent-soft', `rgba(${red}, ${green}, ${blue}, 0.14)`);
  }

  function actorSizeFor(preparedCharacter, sizePercent) {
    const narrow = window.innerWidth <= 620;
    const userScale = clamp(Number(sizePercent) / 100 || 1, 0.5, 2);
    const sheetScale = Number(preparedCharacter.config.scale) || 1;
    const factor = clamp(userScale * sheetScale, 0.4, MAX_ACTOR_FACTOR);
    const aspect = preparedCharacter.cellHeight > 0
      ? preparedCharacter.cellWidth / preparedCharacter.cellHeight
      : 1;

    let height = (narrow ? NARROW_ACTOR_HEIGHT : BASE_ACTOR_HEIGHT) * factor;
    let width = height * aspect;

    const maxHeight = Math.max(80, window.innerHeight - ACTOR_BOTTOM - 10);
    const maxWidth = Math.max(80, window.innerWidth - 36);
    if (height > maxHeight) {
      height = maxHeight;
      width = height * aspect;
    }
    if (width > maxWidth) {
      width = maxWidth;
      height = width / aspect;
    }

    return {
      width: Math.round(width),
      height: Math.round(height),
      factor
    };
  }

  function applyActorSize(preparedCharacter, sizePercent) {
    const size = actorSizeFor(preparedCharacter, sizePercent);
    const root = document.documentElement.style;
    root.setProperty('--actor-width', `${size.width}px`);
    root.setProperty('--actor-height', `${size.height}px`);
    root.setProperty('--actor-bottom', `${ACTOR_BOTTOM}px`);
    mascot.dataset.scaleFactor = String(Math.round(size.factor * 100) / 100);
    return size;
  }

  function calculateTargetX(actorWidth) {
    const width = window.innerWidth;
    if (width <= 620) {
      const desired = Math.min(Math.max(width * 0.12, 32), 260);
      return Math.max(12, Math.min(desired, width - actorWidth - 12));
    }
    const desired = Math.min(Math.max(width * 0.12, 44), 260);
    const maxWithoutOverflow = Math.max(12, width - actorWidth - 16);
    const maxForBubble = Math.max(12, width - 382 - actorWidth * 0.8);
    return Math.max(12, Math.min(desired, maxWithoutOverflow, maxForBubble));
  }

  function positionBubble() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const actorWidth = actor.offsetWidth;
    const actorHeight = actor.offsetHeight;
    const root = document.documentElement.style;

    if (width <= 620) {
      root.setProperty('--bubble-left', '20px');
      const bottom = ACTOR_BOTTOM + actorHeight + 12;
      root.setProperty('--bubble-bottom', `${Math.max(12, Math.min(bottom, height - 120))}px`);
      return;
    }

    const bubbleHeight = bubble.offsetHeight || 210;
    const bubbleWidth = bubble.offsetWidth || 366;
    const above = ACTOR_BOTTOM + actorHeight + 10 + bubbleHeight <= height - 10;
    const bottom = above
      ? ACTOR_BOTTOM + actorHeight + 10
      : ACTOR_BOTTOM + Math.round(actorHeight * 0.57);
    let left = above
      ? targetX + Math.round(actorWidth * 0.35)
      : targetX + Math.round(actorWidth * 0.8);
    left = Math.round(clamp(left, 12, Math.max(12, width - bubbleWidth - 12)));
    root.setProperty('--bubble-left', `${left}px`);
    root.setProperty('--bubble-bottom', `${bottom}px`);
  }

  function setVisualState(state, mood, facing, displayState = state) {
    activeState = state;
    stateStartedAt = performance.now();
    lastFrameIndex = -1;
    mascot.dataset.state = displayState;
    mascot.dataset.mood = mood;
    mascot.dataset.facing = facing;
    mascot.dataset.mirrored = String(engine.shouldMirror(prepared?.config, facing));
    if (prepared) {
      const config = prepared.config;
      mascot.dataset.row = String(engine.rowForState(config, state));
      mascot.dataset.frameRate = String(clamp(Number(config.fps) || 8, 1, 30));
    }
  }

  function render(now) {
    if (!prepared) return;
    const config = prepared.config;
    const elapsed = Math.max(0, now - stateStartedAt);
    const frameCount = engine.frameCountFor(config, activeState);
    const fps = clamp(Number(config.fps) || 8, 1, 30);
    const frameIndex = reduceMotion.matches
      ? 0
      : Math.floor((elapsed / 1000) * fps) % frameCount;

    mascot.dataset.row = String(engine.rowForState(config, activeState));
    mascot.dataset.frameRate = String(fps);
    mascot.dataset.frame = String(frameIndex + 1);

    if (prepared.kind !== 'fallback' && frameIndex === lastFrameIndex) return;
    lastFrameIndex = frameIndex;
    engine.drawFrame(canvas, prepared, activeState, frameIndex, elapsed);
  }

  function startFrameLoop() {
    if (frameLoop) return;
    const tick = (now) => {
      frameLoop = window.requestAnimationFrame(tick);
      render(now);
    };
    frameLoop = window.requestAnimationFrame(tick);
  }

  function pulseAnim(name) {
    if (animTimer) window.clearTimeout(animTimer);
    mascot.removeAttribute('data-anim');
    void mascot.offsetWidth;
    mascot.dataset.anim = name;
  }

  function clearAnim() {
    if (animTimer) {
      window.clearTimeout(animTimer);
      animTimer = 0;
    }
    delete mascot.dataset.anim;
  }

  function playChime(data) {
    const sound = data?.sound;
    if (!sound || data.playSound === false) return;
    const volume = clamp(Number(sound.volume), 0, 1);
    if (!(volume > 0)) return;
    const source = typeof sound.customDataUrl === 'string' && sound.customDataUrl.startsWith('data:audio/')
      ? sound.customDataUrl
      : '../assets/soft-chime.wav';
    try {
      if (chime.getAttribute('src') !== source) chime.setAttribute('src', source);
      chime.volume = volume;
      chime.currentTime = 0;
      const result = chime.play();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Audio is decorative; the reminder must keep working without it.
    }
  }

  async function prepareCharacter(data) {
    const config = data?.character?.config || engine.DEFAULT_CONFIG;
    if (data?.sheetDataUrl) {
      try {
        const sprite = await engine.prepareSprite(data.sheetDataUrl, config);
        mascot.dataset.spriteReady = 'true';
        return sprite;
      } catch (error) {
        console.error('Unable to prepare the character sheet; using the built-in drop:', error);
      }
    }
    mascot.dataset.spriteReady = 'fallback';
    return engine.createFallback(config);
  }

  function animateActor(toX, duration, runId) {
    return new Promise((resolve) => {
      if (runId !== showRun) {
        resolve(false);
        return;
      }
      const fromX = currentX;
      activeMove = actor.animate(
        [
          { transform: `translate3d(${fromX}px, 0, 0)` },
          { transform: `translate3d(${toX}px, 0, 0)` }
        ],
        {
          duration,
          easing: 'cubic-bezier(0.3, 0.72, 0.42, 1)',
          fill: 'forwards'
        }
      );
      activeMove.finished
        .then(() => {
          if (runId !== showRun) {
            resolve(false);
            return;
          }
          currentX = toX;
          actor.style.transform = `translate3d(${toX}px, 0, 0)`;
          activeMove?.cancel();
          activeMove = null;
          resolve(true);
        })
        .catch(() => resolve(false));
    });
  }

  function reportHitRegions(active) {
    if (!active) {
      api.setHitRegions([]);
      return;
    }
    const padding = 8;
    const regions = [];
    for (const element of [bubble, mascot]) {
      if (!element || element.hidden) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      regions.push({
        x: Math.max(0, Math.round(rect.left - padding)),
        y: Math.max(0, Math.round(rect.top - padding)),
        width: Math.max(0, Math.round(rect.width + padding * 2)),
        height: Math.max(0, Math.round(rect.height + padding * 2))
      });
    }
    api.setHitRegions(regions);
  }

  function showStatus(text) {
    statusPill.textContent = text;
    statusPill.hidden = false;
    void statusPill.offsetWidth;
    statusPill.classList.add('visible');
  }

  function hideStatus() {
    statusPill.classList.remove('visible');
    window.setTimeout(() => {
      if (!statusPill.classList.contains('visible')) statusPill.hidden = true;
    }, 200);
  }

  function formatClock(totalSeconds) {
    const seconds = Math.max(0, Math.ceil(totalSeconds));
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function formatLate(dueAt) {
    const diff = Math.max(0, Date.now() - (Number(dueAt) || Date.now()));
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
    return new Date(dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function actionClass(action) {
    return BUTTON_CLASSES[action] || 'skip';
  }

  function makeButtons(entries) {
    actions.textContent = '';
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `button button-${actionClass(entry.action)}`;
      button.dataset.answer = entry.id;
      button.dataset.action = entry.action;
      if (entry.disabled) {
        button.disabled = true;
        button.title = 'You have reached the snooze limit for this reminder.';
      }
      if (entry.icon) {
        const icon = document.createElement('span');
        icon.className = 'button-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = entry.icon;
        button.appendChild(icon);
      }
      const label = document.createElement('span');
      label.textContent = entry.label;
      button.appendChild(label);
      button.addEventListener('click', () => {
        void submitAnswer(entry.id);
      });
      actions.appendChild(button);
    }
  }

  function setButtonsDisabled(disabled) {
    for (const button of actions.querySelectorAll('button')) {
      button.disabled = disabled;
    }
  }

  function resetBubble() {
    bubble.className = 'speech-bubble';
    bubble.hidden = true;
    bubble.removeAttribute('data-reaction');
    bubble.removeAttribute('data-type');
    timerBlock.hidden = true;
    waitRow.hidden = true;
    footer.hidden = true;
    queueChip.hidden = true;
    testChip.hidden = true;
    bubbleNote.hidden = true;
    bubbleNote.textContent = '';
    actions.textContent = '';
    hideStatus();
  }

  function buildPrompt(data) {
    applyTheme(data.theme);
    applyAccent(data.reminder?.color);

    const reminder = data.reminder;
    bubble.dataset.type = reminder.type;
    bubble.classList.toggle('is-note', reminder.type === 'note');

    bubbleIcon.textContent = reminder.icon || '🔔';
    const category = reminder.category || TYPE_LABELS[reminder.type] || 'Reminder';
    bubbleKicker.classList.toggle('is-missed', Boolean(data.missed));
    bubbleKicker.textContent = data.missed ? `Missed · ${category}` : category;

    const question = pick(data.question) || reminder.title;
    bubbleTitle.textContent = question;

    const note = typeof data.note === 'string' ? data.note.trim() : '';
    bubbleNote.textContent = note;
    bubbleNote.hidden = !note;

    makeButtons(Array.isArray(data.buttons) ? data.buttons : []);

    if (data.missed) {
      const count = Math.max(1, Number(data.missedCount) || 1);
      showStatus(count > 1
        ? `Catching up on ${count} missed reminders`
        : `Missed ${formatLate(data.dueAt)} — you can still answer`);
    } else {
      hideStatus();
    }

    if (Number(data.queueCount) > 0) {
      queueChip.hidden = false;
      queueChip.textContent = `${Number(data.queueCount)} more waiting`;
    }
    if (data.test) {
      testChip.hidden = false;
    }
    footer.hidden = queueChip.hidden && testChip.hidden;

    if (reminder.type === 'note') {
      waitLabel.textContent = `Closes in ${Math.max(1, Math.round((Number(data.timeoutMs) || 8000) / 1000))}s`;
    } else if (Number(data.timeoutMs) > 0) {
      waitLabel.textContent = `I'll wait ${Math.ceil(Number(data.timeoutMs) / 1000)}s`;
    }

    mascot.dataset.reminderId = reminder.id || '';
    mascot.dataset.reminderType = reminder.type || '';
    mascot.dataset.specialAnimation = reminder.specialAnimation || 'none';
  }

  function stopCountdown() {
    if (countdownTimer) {
      window.clearInterval(countdownTimer);
      countdownTimer = 0;
    }
  }

  function startCountdowns() {
    stopCountdown();
    const reminder = payload?.reminder;
    if (!reminder) return;

    if (reminder.type === 'timer' && Number(payload.timerSeconds) > 0) {
      timerTotal = Number(payload.timerSeconds) * 1000;
      timerDeadline = performance.now() + timerTotal;
      timerExpired = false;
      timerBlock.hidden = false;
      waitRow.hidden = true;
      timerLabel.textContent = payload.phase === 'break' ? 'Break time left' : 'Time left';
      timerValue.textContent = formatClock(timerTotal / 1000);
      timerFill.style.transform = 'scaleX(1)';
      countdownTimer = window.setInterval(() => {
        const remaining = Math.max(0, timerDeadline - performance.now());
        timerValue.textContent = formatClock(remaining / 1000);
        timerFill.style.transform = `scaleX(${clamp(remaining / timerTotal, 0, 1)})`;
        if (remaining <= 0 && !timerExpired) {
          timerExpired = true;
          if (phase === 'waiting') void submitAnswer('__timer__');
        }
      }, 200);
      return;
    }

    if (Number(payload.timeoutMs) > 0) {
      waitTotal = Number(payload.timeoutMs);
      waitDeadline = performance.now() + waitTotal;
      waitRow.hidden = false;
      waitFill.style.transform = 'scaleX(1)';
      const isNote = reminder.type === 'note';
      const tick = () => {
        const remaining = Math.max(0, waitDeadline - performance.now());
        waitFill.style.transform = `scaleX(${clamp(remaining / waitTotal, 0, 1)})`;
        if (isNote) {
          waitLabel.textContent = remaining > 0
            ? `Closes in ${Math.ceil(remaining / 1000)}s`
            : 'Closing…';
        } else {
          waitLabel.textContent = remaining > 0
            ? `I'll wait ${Math.ceil(remaining / 1000)}s`
            : 'Closing…';
        }
      };
      tick();
      countdownTimer = window.setInterval(tick, 250);
    }
  }

  function hideBubble() {
    bubble.classList.remove('visible');
    bubble.classList.add('leaving');
    window.setTimeout(() => {
      if (!bubble.classList.contains('visible')) {
        bubble.hidden = true;
        bubble.classList.remove('leaving');
      }
    }, 180);
  }

  function showReactionText(behavior) {
    const list = payload?.messages?.[behavior === 'skip' ? 'skip' : behavior];
    const text = pick(list);
    if (!text) {
      hideBubble();
      return false;
    }
    bubble.className = 'speech-bubble is-reaction';
    if (payload?.reminder?.type === 'note') bubble.classList.add('is-note');
    bubble.dataset.reaction = behavior;
    bubbleIcon.textContent = payload.reminder.icon || '🔔';
    bubbleKicker.className = 'bubble-kicker';
    bubbleKicker.textContent = payload.reminder.title || 'Reminder';
    bubbleTitle.textContent = text;
    bubbleNote.hidden = true;
    timerBlock.hidden = true;
    waitRow.hidden = true;
    footer.hidden = true;
    actions.textContent = '';
    hideStatus();
    bubble.hidden = false;
    positionBubble();
    void bubble.offsetWidth;
    bubble.classList.add('visible');
    return true;
  }

  async function submitAnswer(answerId) {
    if (phase !== 'waiting') return;
    setPhase('submitted');
    setButtonsDisabled(true);
    api.setClickThrough(true);
    api.setHitRegions([]);
    let response;
    try {
      response = await api.respond(answerId);
    } catch {
      response = { ok: false, error: 'The reminder did not accept the answer.' };
    }
    if (resolved) return;
    if (response && response.ok) {
      handleResolve(response);
      return;
    }
    setPhase('waiting');
    setButtonsDisabled(false);
    reportHitRegions(true);
  }

  function normalizeBehavior(result) {
    const behavior = result?.behavior || result?.action;
    if (['positive', 'negative', 'neutral', 'snooze', 'skip', 'dismiss'].includes(behavior)) {
      return behavior;
    }
    return 'dismiss';
  }

  async function playReaction(result, runId) {
    const behavior = normalizeBehavior(result);
    mascot.dataset.reaction = behavior;
    if (behavior !== 'dismiss') showReactionText(behavior);
    else hideBubble();

    const speed = reduceMotion.matches ? 0.15 : 1;
    const hold = (ms) => wait(Math.max(50, Math.round(ms * speed)));
    const duration = (ms) => Math.max(120, Math.round(ms * speed));
    const exitRight = async (ms) => {
      clearAnim();
      setVisualState('walk', behavior === 'negative' ? 'sad' : 'happy', 'right', 'walking-out');
      await animateActor(window.innerWidth + 40, duration(ms), runId);
    };
    const exitLeft = async (ms, state = 'walk', mood = 'idle') => {
      clearAnim();
      setVisualState(state, mood, 'left', 'walking-out');
      await wait(Math.round(90 * speed));
      await animateActor(-actor.offsetWidth - 40, duration(ms), runId);
    };

    if (!prepared) {
      await hold(600);
    } else if (behavior === 'positive') {
      const special = payload?.reminder?.specialAnimation;
      const specialSupported = (special === 'drinking' || special === 'exercise')
        && engine.hasState(prepared, special);
      if (specialSupported) {
        setVisualState(special, 'happy', 'right');
        await hold(REACTION_HOLD_MS);
      } else {
        setVisualState('happy', 'happy', 'right');
        pulseAnim('cheer');
        await hold(950);
      }
      if (runId !== showRun) return;
      setVisualState('happy', 'happy', 'right');
      await hold(650);
      if (runId !== showRun) return;
      hideBubble();
      await exitRight(EXIT_WALK_MS);
    } else if (behavior === 'negative') {
      setVisualState('sad', 'sad', 'right');
      await hold(REACTION_HOLD_MS);
      if (runId !== showRun) return;
      hideBubble();
      await exitLeft(EXIT_WALK_MS, 'sad_walk', 'sad');
    } else if (behavior === 'neutral') {
      setVisualState('idle', 'idle', 'right');
      pulseAnim('nod');
      await hold(1000);
      if (runId !== showRun) return;
      hideBubble();
      await exitRight(EXIT_WALK_MS);
    } else if (behavior === 'snooze') {
      setVisualState('idle', 'idle', 'left');
      pulseAnim('wave');
      await hold(1050);
      if (runId !== showRun) return;
      hideBubble();
      await exitLeft(EXIT_WALK_MS);
    } else if (behavior === 'skip') {
      setVisualState('idle', 'idle', 'left');
      pulseAnim('tip');
      await hold(1100);
      if (runId !== showRun) return;
      hideBubble();
      await exitLeft(EXIT_WALK_MS);
    } else {
      await exitLeft(850);
    }

    if (runId !== showRun) return;
    await wait(60);
    if (runId !== showRun) return;
    setPhase('done');
    api.finished();
  }

  function handleResolve(result) {
    if (!result || resolved) return;
    if (!['waiting', 'submitted', 'arriving', 'entering'].includes(phase)) return;
    resolved = true;
    const runId = showRun;
    setPhase('reacting');
    stopCountdown();
    setButtonsDisabled(true);
    api.setClickThrough(true);
    api.setHitRegions([]);
    hideStatus();
    void playReaction(result, runId);
  }

  async function beginReminder(data) {
    const runId = ++showRun;
    payload = data;
    prepared = null;
    resolved = false;
    promptWasSent = false;
    timerExpired = false;
    stopCountdown();
    clearAnim();
    activeMove?.cancel();
    activeMove = null;
    resetBubble();
    setPhase('entering');
    api.setClickThrough(true);
    api.setHitRegions([]);

    const nextPrepared = await prepareCharacter(data);
    if (runId !== showRun || phase !== 'entering') return;
    prepared = nextPrepared;

    const character = data?.character;
    mascot.dataset.characterId = character?.id || 'builtin';
    mascot.dataset.characterName = character?.name || prepared.config.name || 'Built-in drop';
    mascot.dataset.kind = prepared.kind;
    canvas.setAttribute('aria-label', `${mascot.dataset.characterName} character`);

    buildPrompt(data);

    const size = applyActorSize(prepared, data?.sizePercent);
    targetX = calculateTargetX(size.width);
    currentX = -size.width - 28;
    actor.style.transform = `translate3d(${currentX}px, 0, 0)`;
    setVisualState('walk', 'idle', 'right', 'walking-in');
    render(performance.now());
    startFrameLoop();

    window.setTimeout(() => {
      if (runId === showRun) playChime(data);
    }, 120);

    const arrived = await animateActor(targetX, ENTRY_WALK_MS, runId);
    if (!arrived || runId !== showRun || phase !== 'entering') return;

    setVisualState('idle', 'idle', 'right');
    setPhase('arriving');
    await wait(110);
    if (runId !== showRun || phase !== 'arriving') return;

    bubble.hidden = false;
    positionBubble();
    void bubble.offsetWidth;
    bubble.classList.add('visible');
    setPhase('waiting');

    await wait(260);
    if (runId !== showRun || phase !== 'waiting') return;
    reportHitRegions(true);
    if (!promptWasSent) {
      promptWasSent = true;
      api.promptShown();
      startCountdowns();
    }
  }

  window.addEventListener('resize', () => {
    if (!prepared) return;
    if (phase === 'waiting' || phase === 'arriving' || phase === 'submitted') {
      positionBubble();
      if (phase === 'waiting') reportHitRegions(true);
    }
  });

  window.addEventListener('beforeunload', () => {
    showRun += 1;
    stopCountdown();
    activeMove?.cancel();
    if (animTimer) window.clearTimeout(animTimer);
    if (frameLoop) window.cancelAnimationFrame(frameLoop);
    frameLoop = 0;
  });

  api.onShow((data) => {
    void beginReminder(data);
  });
  api.onResolve(handleResolve);
})();
