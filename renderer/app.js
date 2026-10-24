'use strict';

(() => {
  const api = window.remindBuddy;
  const engine = window.WaterBuddyCharacterEngine;
  const $ = (id) => document.getElementById(id);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const TAB_META = Object.freeze({
    reminders: {
      eyebrow: 'Plan',
      title: 'Reminders',
      subtitle: 'Everything you want a gentle nudge about.'
    },
    today: {
      eyebrow: 'Today',
      title: 'A day at a glance',
      subtitle: 'What has happened, what is next, and how the goals are going.'
    },
    history: {
      eyebrow: 'Insights',
      title: 'History',
      subtitle: 'Every answer, streak, and quiet miss in one place.'
    },
    characters: {
      eyebrow: 'Cast',
      title: 'Characters',
      subtitle: 'Pick the companion who walks in with each nudge.'
    },
    style: {
      eyebrow: 'Voice',
      title: 'Messages & style',
      subtitle: 'Set the theme, the language, and the fallback lines.'
    },
    settings: {
      eyebrow: 'Preferences',
      title: 'Settings',
      subtitle: 'Prompts, quiet hours, startup, sound, and your data.'
    }
  });

  const TYPE_LABELS = Object.freeze({
    yesno: 'Yes / No',
    confirm: 'Confirm',
    choice: 'Choice',
    timer: 'Timer',
    note: 'Message only'
  });

  const ACTION_LABELS = Object.freeze({
    positive: 'Done',
    negative: 'No',
    neutral: 'Neutral',
    snooze: 'Snooze',
    skip: 'Skip today'
  });

  const REACTION_LABELS = Object.freeze({
    positive: 'Happy',
    negative: 'Sad',
    neutral: 'Nod',
    snooze: 'Wave',
    skip: 'Tip hat'
  });

  const OUTCOME_LABELS = Object.freeze({
    done: 'Done',
    skipped: 'Skipped',
    snoozed: 'Snoozed',
    ignored: 'Ignored',
    missed: 'Missed'
  });

  const SOURCE_LABELS = Object.freeze({
    button: 'Answered',
    timeout: 'Timed out',
    timer: 'Timer finished',
    auto: 'Auto-closed',
    missed: 'Missed',
    startup: 'On startup',
    idle: 'After idle',
    snooze: 'Snoozed return',
    pomodoro: 'Pomodoro',
    focus: 'Focus block',
    break: 'Break',
    test: 'Test',
    schedule: 'Scheduled'
  });

  const DEFAULT_BUTTONS = Object.freeze({
    yesno: [
      { id: 'yes', label: 'Yes', action: 'positive', reaction: 'positive' },
      { id: 'no', label: 'No', action: 'negative', reaction: 'negative' }
    ],
    confirm: [
      { id: 'done', label: 'Done', action: 'positive', reaction: 'positive' },
      { id: 'later', label: 'Later', action: 'snooze', reaction: 'snooze' }
    ],
    timer: [
      { id: 'done', label: 'Done', action: 'positive', reaction: 'positive' },
      { id: 'snooze', label: 'Snooze', action: 'snooze', reaction: 'snooze' }
    ],
    choice: [
      { id: 'option-1', label: 'Option 1', action: 'positive', reaction: 'positive' },
      { id: 'option-2', label: 'Option 2', action: 'neutral', reaction: 'neutral' }
    ],
    note: []
  });

  const app = {
    state: null,
    activeTab: 'reminders',
    booted: false,
    history: {
      data: null,
      loading: false,
      requestId: 0,
      timer: null
    },
    settingsDirty: false,
    messagesDirty: false,
    editor: null,
    confirmResolver: null,
    toastTimer: null,
    styleStatusTimer: null,
    characterCanvases: new Map(),
    randomCharacterId: null
  };

  const sheetPromises = new Map();
  const preparedPromises = new Map();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---------- Small helpers ----------

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function numberValue(input, fallback) {
    const value = Number(input?.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function splitLines(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function linesOf(list) {
    return Array.isArray(list) ? list.join('\n') : '';
  }

  function hexToRgba(hex, alpha) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!match) return `rgba(47, 124, 246, ${alpha})`;
    const int = parseInt(match[1], 16);
    const r = (int >> 16) & 255;
    const g = (int >> 8) & 255;
    const b = int & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function locale() {
    const language = app.state?.settings?.language;
    return !language || language === 'system' ? undefined : language;
  }

  function dateFormatter(options) {
    try {
      return new Intl.DateTimeFormat(locale(), options);
    } catch {
      return new Intl.DateTimeFormat(undefined, options);
    }
  }

  function formatTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return dateFormatter({ hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function formatDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return dateFormatter({ month: 'short', day: 'numeric' }).format(date);
  }

  function formatFullDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return dateFormatter({ weekday: 'long', month: 'long', day: 'numeric' }).format(date);
  }

  function formatDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return dateFormatter({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function parseDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  }

  function formatDateKey(value) {
    const date = parseDateKey(value);
    if (!date) return String(value || '');
    return dateFormatter({ month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  }

  function localDateKey(date) {
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function localDatetimeValue(date) {
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function isSameDay(left, right) {
    return left.getFullYear() === right.getFullYear()
      && left.getMonth() === right.getMonth()
      && left.getDate() === right.getDate();
  }

  function relativeShort(at) {
    const diff = at - Date.now();
    if (diff <= 0) return 'now';
    if (diff < 60_000) return 'in a moment';
    if (diff < 3_600_000) return `in ${Math.ceil(diff / 60_000)} min`;
    if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)} h`;
    const days = Math.ceil(diff / 86_400_000);
    return days === 1 ? 'tomorrow' : `in ${days} days`;
  }

  function describeNext(at) {
    if (!Number.isFinite(at)) return 'Not scheduled';
    const date = new Date(at);
    const now = new Date();
    if (isSameDay(date, now)) return `${formatTime(date)} · ${relativeShort(at)}`;
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12);
    if (isSameDay(date, tomorrow)) return `tomorrow ${formatTime(date)}`;
    return `${formatDate(date)} · ${formatTime(date)}`;
  }

  function daysLabel(days) {
    const list = Array.isArray(days) ? [...days].sort((a, b) => a - b) : [];
    if (list.length === 7) return 'Every day';
    if (list.length === 5 && list.every((day) => day >= 1 && day <= 5)) return 'Weekdays';
    if (list.length === 2 && list.includes(0) && list.includes(6)) return 'Weekends';
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return list.map((day) => names[day]).join(', ');
  }

  function scheduleSummary(reminder) {
    const schedule = reminder?.schedule || {};
    let summary = 'Schedule not set';
    switch (schedule.kind) {
      case 'interval': {
        const minutes = Number(schedule.intervalMinutes) || 60;
        const interval = minutes % 60 === 0 && minutes >= 60
          ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
          : `${minutes} min`;
        summary = `Every ${interval} · ${schedule.activeStart || '09:00'}–${schedule.activeEnd || '21:00'} · ${daysLabel(schedule.days)}`;
        break;
      }
      case 'pomodoro':
        summary = `${schedule.focusMinutes || 25}/${schedule.breakMinutes || 5} focus cycle · ${schedule.activeStart || '09:00'}–${schedule.activeEnd || '17:00'} · ${daysLabel(schedule.days)}`;
        break;
      case 'times':
        summary = `${(schedule.times || []).join(', ') || 'No times'} · ${daysLabel(schedule.days)}`;
        break;
      case 'monthly':
        summary = `Day ${schedule.monthlyDay || 1} of each month · ${(schedule.times || ['09:00'])[0] || '09:00'}`;
        break;
      case 'once': {
        const date = schedule.onceAt ? new Date(schedule.onceAt) : null;
        summary = `${schedule.repeatYearly ? 'Yearly' : 'Once'} · ${date && !Number.isNaN(date.getTime()) ? formatDateTime(date) : 'No date selected'}`;
        break;
      }
      case 'startup':
        summary = schedule.startupDelayMinutes === 0
          ? 'When Remind Buddy starts'
          : `${schedule.startupDelayMinutes || 0} min after Remind Buddy starts`;
        break;
      case 'idle':
        summary = `After ${schedule.idleMinutes || 30} min idle · ${schedule.activeStart || '09:00'}–${schedule.activeEnd || '21:00'} · ${daysLabel(schedule.days)}`;
        break;
      default:
        break;
    }
    if (schedule.startDate || schedule.endDate) {
      const from = schedule.startDate ? formatDateKey(schedule.startDate) : 'now';
      const to = schedule.endDate ? formatDateKey(schedule.endDate) : 'ongoing';
      summary += ` · ${from} → ${to}`;
    }
    return summary;
  }

  function typeLabel(type) {
    return TYPE_LABELS[type] || String(type || 'Reminder');
  }

  function outcomeLabel(outcome) {
    return OUTCOME_LABELS[outcome] || String(outcome || '');
  }

  function sourceLabel(source) {
    return SOURCE_LABELS[source] || String(source || 'Scheduled');
  }

  function prettyShortcut(accelerator) {
    if (!accelerator) return '';
    const mac = /mac/i.test(navigator.platform || navigator.userAgent);
    return String(accelerator)
      .replace(/CommandOrControl/g, mac ? 'Cmd' : 'Ctrl')
      .replace(/Command/g, 'Cmd')
      .replace(/Control/g, 'Ctrl');
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function showToast(message, { error = false } = {}) {
    const toast = $('toast');
    if (!toast) return;
    clearTimeout(app.toastTimer);
    toast.textContent = message;
    toast.classList.toggle('is-error', Boolean(error));
    toast.hidden = false;
    app.toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, error ? 4800 : 3200);
  }

  function showErrors(element, errors) {
    if (!element) return;
    const list = (Array.isArray(errors) ? errors : [errors]).filter(Boolean);
    if (list.length === 0) {
      element.hidden = true;
      element.innerHTML = '';
      return;
    }
    element.innerHTML = list.length === 1
      ? escapeHtml(list[0])
      : `<ul>${list.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>`;
    element.hidden = false;
  }

  function showGlobalNotice(message) {
    const notice = $('global-notice');
    if (!notice) return;
    if (!message) {
      notice.hidden = true;
      notice.textContent = '';
      return;
    }
    notice.textContent = message;
    notice.hidden = false;
  }

  function findReminder(id) {
    return app.state?.reminders.find((reminder) => reminder.id === id) || null;
  }

  function findCharacter(id) {
    if (!id) return null;
    const wanted = String(id).toLocaleLowerCase();
    return app.state?.characters.items.find((item) => item.id.toLocaleLowerCase() === wanted) || null;
  }

  function outcomeCounts(events) {
    const counts = { done: 0, skipped: 0, snoozed: 0, ignored: 0, missed: 0, total: 0 };
    for (const event of events || []) {
      if (counts[event.outcome] !== undefined) counts[event.outcome] += 1;
      counts.total += 1;
    }
    return counts;
  }

  function applyState(next) {
    if (!next) return;
    app.state = next;
    applyTheme(next.settings?.theme || 'system');
    applyLanguage(next.settings?.language || 'system');
    renderAll();
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
  }

  function applyLanguage(language) {
    document.documentElement.lang = !language || language === 'system'
      ? (navigator.language || 'en')
      : language;
  }

  // ---------- Navigation ----------

  function activateTab(tab, { quiet = false } = {}) {
    const nextTab = TAB_META[tab] ? tab : 'reminders';
    app.activeTab = nextTab;
    for (const button of $$('.tab-button')) {
      const selected = button.dataset.tab === nextTab;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
    for (const panel of $$('.tab-panel')) {
      panel.hidden = panel.dataset.panel !== nextTab;
    }
    const meta = TAB_META[nextTab];
    $('tab-eyebrow').textContent = meta.eyebrow;
    $('tab-title').textContent = meta.title;
    $('tab-subtitle').textContent = meta.subtitle;

    if (!app.state) return;
    if (nextTab === 'history') {
      populateHistoryFilters();
      loadHistory();
    } else if (nextTab === 'characters') {
      renderCharacters();
    } else if (nextTab === 'style') {
      populateStyle();
    } else if (nextTab === 'settings') {
      populateSettings({ force: !app.settingsDirty });
      renderSettingsData();
    } else if (nextTab === 'today') {
      renderToday();
    } else {
      renderReminders();
    }
    if (!quiet) {
      document.querySelector('.panel-stack')?.scrollTo({ top: 0 });
    }
  }

  // ---------- Sidebar and topbar ----------

  function renderShell() {
    if (!app.state) return;
    const { schedule, settings, appVersion } = app.state;
    const nextById = app.state.nextById || {};
    const pausedUntil = schedule.pausedUntil ? new Date(schedule.pausedUntil) : null;
    const paused = Boolean(schedule.paused);
    const queue = schedule.queue || [];

    $('tab-count-reminders').textContent = String(app.state.reminders.length);
    $('app-version').textContent = `Remind Buddy ${appVersion || ''}`.trim();
    $('quick-add-shortcut').textContent = prettyShortcut(settings.quickAddShortcut || '');
    $('pause-card').classList.toggle('paused', paused);
    $('pause-title').textContent = paused ? 'Reminders paused' : 'Reminders on';
    $('resume-button').hidden = !paused;
    $('pause-actions').hidden = paused;

    if (paused) {
      $('pause-detail').textContent = pausedUntil
        ? `They will come back ${formatDateTime(pausedUntil)}.`
        : 'Reminders are paused.';
    } else {
      const nextEntry = app.state.reminders
        .map((reminder) => ({ reminder, next: nextById[reminder.id] }))
        .filter((entry) => entry.next && entry.next.reason !== 'showing')
        .sort((left, right) => left.next.at - right.next.at)[0];
      if (queue.length > 0) {
        $('pause-detail').textContent = `${queue.length} reminder${queue.length === 1 ? '' : 's'} waiting to appear.`;
      } else if (nextEntry) {
        $('pause-detail').textContent = `${nextEntry.reminder.title} ${relativeShort(nextEntry.next.at)}.`;
      } else {
        $('pause-detail').textContent = 'No upcoming reminders are scheduled.';
      }
    }
    $('dnd-note').hidden = !schedule.dndActive;

    const overlay = app.state.overlay;
    const overlayChip = $('overlay-chip');
    if (overlay?.visible) {
      overlayChip.hidden = false;
      overlayChip.textContent = `${overlay.icon || '🔔'} ${overlay.title} on screen`;
    } else {
      overlayChip.hidden = true;
      overlayChip.textContent = '';
    }

    const nextPill = $('next-pill');
    nextPill.classList.toggle('is-paused', paused || schedule.dndActive);
    if (overlay?.visible) {
      nextPill.textContent = overlay.test ? 'Test reminder on screen' : 'A reminder is waiting';
    } else if (paused) {
      nextPill.textContent = pausedUntil ? `Paused until ${formatDateTime(pausedUntil)}` : 'Paused';
    } else if (queue.length > 0) {
      nextPill.textContent = `${queue.length} reminder${queue.length === 1 ? '' : 's'} queued`;
    } else if (schedule.nextAt) {
      const upcoming = app.state.reminders
        .map((reminder) => ({ reminder, next: nextById[reminder.id] }))
        .filter((entry) => entry.next && entry.next.reason !== 'showing')
        .sort((left, right) => left.next.at - right.next.at)[0];
      nextPill.textContent = upcoming
        ? `Next: ${upcoming.reminder.title} ${describeNext(upcoming.next.at)}`
        : `Next ${describeNext(schedule.nextAt)}`;
    } else {
      nextPill.textContent = 'No scheduled reminders';
    }
  }

  function renderAll() {
    if (!app.state) return;
    renderShell();
    renderReminders();
    renderToday();
    if (app.activeTab === 'characters') renderCharacters();
    if (app.activeTab === 'settings') {
      renderSettingsData();
      if (!app.settingsDirty) populateSettings({ force: true });
    }
    if (app.activeTab === 'style' && !app.messagesDirty) populateStyle();
    if (app.activeTab === 'history' && app.history.data) scheduleHistoryRefresh();
  }

  // ---------- Reminders ----------

  function reminderMatches(reminder, query) {
    if (!query) return true;
    const haystack = [
      reminder.title,
      reminder.category,
      reminder.notes,
      ...(reminder.messages?.question || [])
    ].join(' ').toLocaleLowerCase();
    return haystack.includes(query);
  }

  function renderReminders() {
    if (!app.state) return;
    const { reminders } = app.state;
    const goals = new Map((app.state.today?.goals || []).map((goal) => [goal.reminderId, goal]));
    const query = $('reminder-search').value.trim().toLocaleLowerCase();
    const category = $('category-filter').value;
    const categories = [...new Set(reminders.map((reminder) => reminder.category).filter(Boolean))].sort();
    const categorySelect = $('category-filter');
    const selectedCategory = categories.includes(category) ? category : '';
    categorySelect.innerHTML = ['<option value="">All categories</option>', ...categories.map((name) => (
      `<option value="${escapeHtml(name)}"${name === selectedCategory ? ' selected' : ''}>${escapeHtml(name)}</option>`
    ))].join('');

    const filtered = reminders.filter((reminder) => (
      (!selectedCategory || reminder.category === selectedCategory)
      && reminderMatches(reminder, query)
    ));

    const enabled = reminders.filter((reminder) => reminder.enabled).length;
    const counts = app.state.today?.counts || outcomeCounts([]);
    $('reminder-stats').innerHTML = [
      `<span class="stat-pill success"><span class="dot"></span><strong>${enabled}</strong> enabled of ${reminders.length}</span>`,
      `<span class="stat-pill"><span class="dot"></span><strong>${counts.done}</strong> done today</span>`,
      counts.missed > 0
        ? `<span class="stat-pill warning"><span class="dot"></span><strong>${counts.missed}</strong> missed today</span>`
        : '',
      counts.snoozed > 0
        ? `<span class="stat-pill"><span class="dot"></span><strong>${counts.snoozed}</strong> snoozed today</span>`
        : ''
    ].filter(Boolean).join('');

    const list = $('reminder-list');
    const empty = $('reminder-empty');
    if (filtered.length === 0) {
      list.innerHTML = '';
      empty.hidden = false;
      const heading = empty.querySelector('h2');
      const copy = empty.querySelector('p');
      const action = $('empty-add-reminder');
      if (reminders.length === 0) {
        heading.textContent = 'No reminders here yet';
        copy.textContent = 'Start with a template, then make it yours.';
        action.textContent = 'Browse templates';
        action.dataset.mode = 'add';
      } else {
        heading.textContent = 'No reminders match';
        copy.textContent = 'Try another search or clear the category filter.';
        action.textContent = 'Clear filters';
        action.dataset.mode = 'clear';
      }
    } else {
      empty.hidden = true;
      list.innerHTML = filtered.map((reminder) => reminderRow(reminder, goals.get(reminder.id))).join('');
    }

    const paused = app.state.schedule.paused;
    for (const row of $$('.reminder-row', list)) {
      row.classList.toggle('is-disabled', !findReminder(row.dataset.id)?.enabled);
      row.classList.toggle('is-showing', app.state.overlay?.visible && app.state.overlay.reminderId === row.dataset.id);
    }
    $('reorder-hint').textContent = paused ? 'Paused — drag to reorder' : 'Drag rows to reorder';
  }

  function reminderRow(reminder, goal) {
    const next = app.state.nextById?.[reminder.id];
    const paused = app.state.schedule.paused;
    const nextChip = paused
      ? '<span class="next-chip">Paused</span>'
      : next?.reason === 'showing'
        ? '<span class="next-chip is-now">On screen now</span>'
        : next?.reason === 'missed'
          ? '<span class="next-chip is-now">Missed · answer waiting</span>'
          : next
            ? `<span class="next-chip">Next ${escapeHtml(describeNext(next.at))}</span>`
            : '<span class="next-chip">Not scheduled</span>';
    const goalMarkup = goal
      ? `<span class="goal-mini" title="Today's goal ${goal.done} of ${goal.goal}">
           <span class="goal-mini-track"><span class="goal-mini-fill" style="width:${goal.percent}%"></span></span>
           <span>${goal.done}/${goal.goal}</span>
         </span>`
      : '';
    const snoozeMeta = reminder.snooze?.max > 0
      ? `<span title="Snooze length">Snooze ${reminder.snooze.minutes} min</span>`
      : '<span title="Snooze disabled">No snooze</span>';
    const typeChip = `<span class="type-chip">${escapeHtml(typeLabel(reminder.type))}</span>`;
    const priorityChip = reminder.priority === 'high' ? '<span class="priority-chip high">High</span>' : '';
    const characterText = reminder.character?.mode === 'random'
      ? 'Random character'
      : reminder.character?.mode === 'specific'
        ? (findCharacter(reminder.character.id)?.name || 'Chosen character')
        : 'Default character';
    return `
      <article class="reminder-row${reminder.enabled ? '' : ' is-disabled'}" data-id="${escapeHtml(reminder.id)}">
        <button class="drag-handle" type="button" draggable="true" aria-label="Drag ${escapeHtml(reminder.title)} to reorder" title="Drag to reorder">⠿</button>
        <div class="reminder-avatar" style="background:${hexToRgba(reminder.color, 0.14)};color:${escapeHtml(reminder.color)}" aria-hidden="true">${escapeHtml(reminder.icon || '🔔')}</div>
        <div class="reminder-main">
          <div class="reminder-title-row">
            <span class="reminder-title">${escapeHtml(reminder.title)}</span>
            ${reminder.category ? `<span class="category-chip">${escapeHtml(reminder.category)}</span>` : ''}
            ${typeChip}
            ${priorityChip}
          </div>
          <p class="reminder-schedule">${escapeHtml(scheduleSummary(reminder))}</p>
          <div class="reminder-meta">
            ${nextChip}
            ${goalMarkup}
            ${snoozeMeta}
            <span>${escapeHtml(characterText)}</span>
          </div>
        </div>
        <div class="reminder-controls">
          <label class="switch-row compact row-switch" title="${reminder.enabled ? 'Turn off' : 'Turn on'}">
            <input type="checkbox" role="switch" data-reminder-toggle="${escapeHtml(reminder.id)}"${reminder.enabled ? ' checked' : ''} aria-label="${reminder.enabled ? 'Disable' : 'Enable'} ${escapeHtml(reminder.title)}">
            <span class="switch-ui" aria-hidden="true"></span>
          </label>
          <div class="row-actions">
            <button class="row-action" type="button" data-action="test" data-id="${escapeHtml(reminder.id)}" title="Test now" aria-label="Test ${escapeHtml(reminder.title)} now">▶</button>
            <button class="row-action" type="button" data-action="edit" data-id="${escapeHtml(reminder.id)}" title="Edit" aria-label="Edit ${escapeHtml(reminder.title)}">✎</button>
            <button class="row-action" type="button" data-action="duplicate" data-id="${escapeHtml(reminder.id)}" title="Duplicate" aria-label="Duplicate ${escapeHtml(reminder.title)}">⧉</button>
            <button class="row-action danger" type="button" data-action="delete" data-id="${escapeHtml(reminder.id)}" title="Delete" aria-label="Delete ${escapeHtml(reminder.title)}">🗑</button>
          </div>
        </div>
      </article>
    `;
  }

  async function toggleReminder(id, enabled) {
    const result = await api.reminders.toggle({ id, enabled });
    if (!result?.ok) {
      showToast(result?.errors?.[0] || 'Could not update the reminder.', { error: true });
      renderReminders();
      return;
    }
    if (result.state) applyState(result.state);
    showToast(enabled ? 'Reminder turned on.' : 'Reminder turned off.');
  }

  async function duplicateReminder(id) {
    const result = await api.reminders.duplicate(id);
    if (!result?.ok) {
      showToast(result?.errors?.[0] || 'Could not duplicate the reminder.', { error: true });
      return;
    }
    if (result.state) applyState(result.state);
    showToast('Reminder duplicated. The copy is off until you enable it.');
  }

  async function deleteReminderFromList(id) {
    const reminder = findReminder(id);
    if (!reminder) return;
    const confirmed = await askConfirm({
      heading: `Delete “${reminder.title}”?`,
      message: 'This removes the reminder and its schedule. Its history entries stay in your log.',
      okLabel: 'Delete reminder'
    });
    if (!confirmed) return;
    const result = await api.reminders.delete(id);
    if (!result?.ok) {
      showToast(result?.errors?.[0] || 'Could not delete the reminder.', { error: true });
      return;
    }
    if (result.state) applyState(result.state);
    showToast('Reminder deleted.');
  }

  async function testReminder(id) {
    const result = await api.reminders.test(id);
    if (!result?.ok) {
      showToast(result?.errors?.[0] || 'Could not show the reminder.', { error: true });
      return;
    }
    showToast('Test reminder is playing — no result will be logged.');
  }

  function setupReminderDrag() {
    const list = $('reminder-list');
    let dragged = null;
    let startOrder = '';

    list.addEventListener('dragstart', (event) => {
      const handle = event.target.closest('.drag-handle');
      if (!handle) {
        event.preventDefault();
        return;
      }
      dragged = handle.closest('.reminder-row');
      if (!dragged) return;
      startOrder = $$('.reminder-row', list).map((row) => row.dataset.id).join('|');
      dragged.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', dragged.dataset.id);
    });

    list.addEventListener('dragover', (event) => {
      if (!dragged) return;
      event.preventDefault();
      const row = event.target.closest('.reminder-row');
      if (!row || row === dragged) return;
      for (const other of $$('.reminder-row.drop-target', list)) other.classList.remove('drop-target');
      row.classList.add('drop-target');
      const rect = row.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      list.insertBefore(dragged, before ? row : row.nextSibling);
    });

    list.addEventListener('drop', (event) => {
      if (!dragged) return;
      event.preventDefault();
      for (const other of $$('.reminder-row.drop-target', list)) other.classList.remove('drop-target');
    });

    list.addEventListener('dragend', async () => {
      if (!dragged) return;
      dragged.classList.remove('dragging');
      for (const other of $$('.reminder-row.drop-target', list)) other.classList.remove('drop-target');
      const row = dragged;
      dragged = null;
      const ids = $$('.reminder-row', list).map((entry) => entry.dataset.id);
      if (ids.join('|') === startOrder) return;
      const result = await api.reminders.reorder(ids);
      if (!result?.ok) {
        showToast(result?.errors?.[0] || 'Could not save the new order.', { error: true });
        renderReminders();
        return;
      }
      if (result.state) applyState(result.state);
      showToast('Reminder order saved.');
      row.classList.remove('dragging');
    });
  }

  // ---------- Today ----------

  function renderToday() {
    if (!app.state) return;
    const { today } = app.state;
    const counts = today?.counts || outcomeCounts([]);
    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const overlay = app.state.overlay;
    const next = today?.upcoming?.[0] || null;
    const reminderCount = app.state.reminders.filter((reminder) => reminder.enabled).length;
    let nextMarkup = '';
    if (overlay?.visible) {
      nextMarkup = `<span class="next-reminder">⏳ ${escapeHtml(overlay.icon || '🔔')} ${escapeHtml(overlay.title)} is on screen now</span>`;
    } else if (next) {
      nextMarkup = `<span class="next-reminder">⏭ Next: ${escapeHtml(next.icon || '🔔')} ${escapeHtml(next.title)} · ${escapeHtml(describeNext(next.at))}</span>`;
    }
    const summary = counts.total === 0
      ? (reminderCount === 0
        ? 'No reminders are enabled yet. Add one whenever you are ready.'
        : `${reminderCount} reminder${reminderCount === 1 ? '' : 's'} ready. Nothing has been answered yet today.`)
      : `${counts.done} done, ${counts.snoozed} snoozed, and ${counts.missed} missed so far today.`;

    $('today-hero').innerHTML = `
      <section class="today-hero">
        <div class="today-hero-copy">
          <p class="eyebrow">${escapeHtml(formatFullDate(now))}</p>
          <h2>${greeting}. One gentle nudge at a time.</h2>
          <p>${escapeHtml(summary)}</p>
          ${nextMarkup}
        </div>
        <div class="hero-numbers">
          <div class="hero-stat"><strong>${counts.done}</strong><span>done today</span></div>
          <div class="hero-stat"><strong>${counts.snoozed}</strong><span>snoozed</span></div>
          <div class="hero-stat"><strong>${counts.missed}</strong><span>missed</span></div>
        </div>
      </section>
    `;

    const goals = today?.goals || [];
    $('today-goals').innerHTML = goals.length > 0
      ? goals.map((goal) => `
        <article class="goal-card">
          <div class="goal-head">
            <span class="goal-icon" style="background:${hexToRgba(goal.color, 0.14)}">${escapeHtml(goal.icon || '🎯')}</span>
            <span class="goal-title">${escapeHtml(goal.title)}</span>
            <span class="goal-count">${goal.done} / ${goal.goal}</span>
          </div>
          <div class="goal-track"><span class="goal-fill" style="width:${goal.percent}%;background:${escapeHtml(goal.color)}"></span></div>
          <div class="goal-foot">
            <span>${goal.percent}% of today's goal</span>
            <span>${goal.streak > 0 ? `🔥 ${goal.streak}-day streak` : 'No streak yet'}</span>
          </div>
        </article>
      `).join('')
      : `<div class="card timeline-empty">No daily goals set. Add one inside any reminder to track progress here.</div>`;

    const events = today?.events || [];
    $('today-events').innerHTML = events.length > 0
      ? events.slice(0, 40).map((event) => {
        const details = [];
        if (event.answerLabel) details.push(`“${event.answerLabel}”`);
        if (event.late) details.push('answered late');
        if (event.snoozeMinutes) details.push(`snoozed ${event.snoozeMinutes} min`);
        return `
          <div class="timeline-item">
            <span class="timeline-marker">${escapeHtml(event.icon || '🔔')}</span>
            <div class="timeline-copy">
              <div class="timeline-title">
                ${escapeHtml(event.reminderTitle)}
                <span class="outcome-badge ${escapeHtml(event.outcome)}">${escapeHtml(outcomeLabel(event.outcome))}</span>
              </div>
              <div class="timeline-detail">
                <span class="timeline-time">${escapeHtml(formatTime(event.at))}</span>
                ${details.length ? ` · ${escapeHtml(details.join(' · '))}` : ''}
              </div>
            </div>
          </div>
        `;
      }).join('')
      : '<div class="timeline-empty">Nothing has happened yet today. Answers will appear here.</div>';

    const upcoming = today?.upcoming || [];
    $('today-upcoming').innerHTML = upcoming.length > 0
      ? upcoming.slice(0, 20).map((item) => {
        const reminder = findReminder(item.reminderId);
        const phase = item.phase === 'focus'
          ? 'Focus block'
          : item.phase === 'break'
            ? 'Break'
            : item.reason === 'startup'
              ? 'On startup'
              : item.reason === 'idle'
                ? 'After idle'
                : reminder?.category || typeLabel(reminder?.type);
        return `
          <div class="timeline-item">
            <span class="timeline-marker">${escapeHtml(item.icon || '🔔')}</span>
            <div class="timeline-copy">
              <div class="timeline-title">
                ${escapeHtml(item.title)}
                <span class="outcome-badge upcoming-badge">${escapeHtml(phase)}</span>
              </div>
              <div class="timeline-detail"><span class="timeline-time">${escapeHtml(formatTime(item.at))}</span> · ${escapeHtml(relativeShort(item.at))}</div>
            </div>
          </div>
        `;
      }).join('')
      : '<div class="timeline-empty">You are all caught up for today.</div>';
  }

  // ---------- History ----------

  function populateHistoryFilters() {
    if (!app.state) return;
    const select = $('history-reminder');
    const previous = select.value;
    select.innerHTML = '<option value="">All reminders</option>' + app.state.reminders.map((reminder) => (
      `<option value="${escapeHtml(reminder.id)}">${escapeHtml(reminder.icon || '🔔')} ${escapeHtml(reminder.title)}</option>`
    )).join('');
    if (app.state.reminders.some((reminder) => reminder.id === previous)) select.value = previous;
  }

  function historyPayload() {
    const range = $('history-range').value;
    const now = new Date();
    let from;
    if (range !== 'all') {
      const days = Number(range) || 30;
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1, 0, 0, 0).toISOString();
    }
    const outcomes = $$('#history-outcomes input:checked').map((input) => input.value);
    const payload = {
      to: now.toISOString(),
      outcomes
    };
    if (from) payload.from = from;
    const reminderId = $('history-reminder').value;
    if (reminderId) payload.reminderId = reminderId;
    return payload;
  }

  async function loadHistory() {
    if (!app.state) return;
    const requestId = ++app.history.requestId;
    app.history.loading = true;
    $('history-total-note').textContent = 'Loading…';
    $('history-refresh').disabled = true;
    const data = await api.history.query(historyPayload());
    if (requestId !== app.history.requestId) return;
    app.history.loading = false;
    $('history-refresh').disabled = false;
    if (!data) {
      $('history-total-note').textContent = 'Could not load history.';
      return;
    }
    app.history.data = data;
    renderHistory();
  }

  const scheduleHistoryRefresh = debounce(() => {
    if (app.activeTab === 'history' && !app.history.loading) loadHistory();
  }, 500);

  function zeroSummary(days) {
    const result = [];
    const now = new Date();
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, 12);
      result.push({
        dateKey: localDateKey(date),
        isToday: offset === 0,
        done: 0,
        skipped: 0,
        snoozed: 0,
        ignored: 0,
        missed: 0,
        total: 0
      });
    }
    return result;
  }

  function renderHistory() {
    const data = app.history.data;
    const counts = data?.counts || outcomeCounts([]);
    $('history-stats').innerHTML = [
      `<span class="stat-pill"><span class="dot"></span><strong>${counts.total}</strong> responses</span>`,
      `<span class="stat-pill success"><span class="dot"></span><strong>${counts.done}</strong> done</span>`,
      `<span class="stat-pill"><span class="dot"></span><strong>${counts.skipped}</strong> skipped</span>`,
      `<span class="stat-pill"><span class="dot"></span><strong>${counts.snoozed}</strong> snoozed</span>`,
      `<span class="stat-pill"><span class="dot"></span><strong>${counts.ignored}</strong> ignored</span>`,
      counts.missed > 0
        ? `<span class="stat-pill warning"><span class="dot"></span><strong>${counts.missed}</strong> missed</span>`
        : ''
    ].filter(Boolean).join('');

    const days7 = data?.summaries?.days7 || zeroSummary(7);
    const days30 = data?.summaries?.days30 || zeroSummary(30);
    renderHistoryChart($('history-chart-7'), days7, 7);
    renderHistoryChart($('history-chart-30'), days30, 30);
    $('history-7-total').textContent = `${days7.reduce((sum, day) => sum + day.total, 0)} responses`;
    $('history-30-total').textContent = `${days30.reduce((sum, day) => sum + day.total, 0)} responses`;

    const selectedId = $('history-reminder').value;
    const selected = findReminder(selectedId);
    if (selected) {
      $('history-streak').textContent = String(data?.streak ?? 0);
      $('history-streak-copy').textContent = `${selected.title} · current streak of answered days.`;
    } else {
      $('history-streak').textContent = '—';
      $('history-streak-copy').textContent = 'Pick a reminder to see its streak.';
    }

    const events = data?.events || [];
    $('history-table-body').innerHTML = events.map((event) => {
      const details = [];
      if (event.answerLabel) details.push(`“${event.answerLabel}”`);
      if (event.late) details.push('late answer');
      if (event.snoozeMinutes) details.push(`snoozed ${event.snoozeMinutes} min`);
      if (event.dueAt) details.push(`due ${formatDateTime(event.dueAt)}`);
      return `
        <tr>
          <td><span class="history-reminder"><span class="icon">${escapeHtml(event.icon || '🔔')}</span>${escapeHtml(event.reminderTitle)}</span></td>
          <td><span class="outcome-badge ${escapeHtml(event.outcome)}">${escapeHtml(outcomeLabel(event.outcome))}</span></td>
          <td>${escapeHtml(formatDateTime(event.at))}</td>
          <td><span class="source-chip">${escapeHtml(sourceLabel(event.source))}</span></td>
          <td>${details.length ? escapeHtml(details.join(' · ')) : '—'}</td>
        </tr>
      `;
    }).join('');
    $('history-empty').hidden = events.length > 0;
    $('history-total-note').textContent = data
      ? `${counts.total} response${counts.total === 1 ? '' : 's'}`
      : '';
  }

  function renderHistoryChart(container, days, count) {
    const max = Math.max(1, ...days.map((day) => day.total));
    container.innerHTML = days.map((day, index) => {
      const other = day.total - day.done;
      const date = parseDateKey(day.dateKey);
      let label = '';
      if (count === 7 && date) {
        label = dateFormatter({ weekday: 'short' }).format(date);
      } else if (count === 30 && date && (index % 5 === 4 || index === days.length - 1)) {
        label = String(date.getDate());
      }
      const title = `${day.dateKey}: ${day.done} done, ${other} other`;
      return `
        <div class="bar-column" title="${escapeHtml(title)}">
          <span class="bar-stack">
            <span class="bar-other" style="height:${(other / max) * 100}%"></span>
            <span class="bar-done" style="height:${(day.done / max) * 100}%"></span>
          </span>
          <span class="bar-label">${escapeHtml(label)}</span>
        </div>
      `;
    }).join('');
  }

  async function exportHistory() {
    const result = await api.history.exportCsv(historyPayload());
    if (!result?.ok) {
      if (!result?.canceled) showToast(result?.errors?.[0] || 'Could not export history.', { error: true });
      return;
    }
    showToast('History exported to CSV.');
  }

  // ---------- Characters ----------

  function clearCharacterCaches() {
    sheetPromises.clear();
    preparedPromises.clear();
    app.characterCanvases.clear();
  }

  function loadSheet(id) {
    if (!id) return Promise.reject(new Error('No character selected.'));
    if (!sheetPromises.has(id)) {
      const promise = api.characters.sheet(id).then((result) => {
        if (!result?.ok) throw new Error(result?.error || 'That character could not be loaded.');
        return {
          dataUrl: result.dataUrl,
          config: result.character?.config
        };
      });
      sheetPromises.set(id, promise);
      promise.catch(() => sheetPromises.delete(id));
    }
    return sheetPromises.get(id);
  }

  function preparedCharacter(id) {
    if (!id) return Promise.reject(new Error('No character selected.'));
    if (!preparedPromises.has(id)) {
      const promise = loadSheet(id).then((sheet) => engine.prepareSprite(sheet.dataUrl, sheet.config));
      preparedPromises.set(id, promise);
      promise.catch(() => preparedPromises.delete(id));
    }
    return preparedPromises.get(id);
  }

  function attachCharacterCanvas(canvas, item) {
    const fallback = () => engine.createFallback(item?.config);
    preparedCharacter(item?.id)
      .catch(() => fallback())
      .then((prepared) => {
        if (!canvas.isConnected) return;
        app.characterCanvases.set(canvas, {
          prepared: prepared || fallback(),
          frame: Math.floor(Math.random() * 4)
        });
        engine.drawFrame(canvas, prepared || fallback(), 'idle', 0, performance.now());
      });
  }

  function renderCharacters() {
    if (!app.state) return;
    const characters = app.state.characters;
    const size = app.state.settings.defaultCharacterScale;
    const sizeInput = $('character-size');
    if (document.activeElement !== sizeInput) sizeInput.value = String(size);
    $('character-size-value').textContent = `${size}%`;
    $('random-character').checked = Boolean(app.state.settings.randomCharacter);

    const warnings = [
      ...(characters.scanWarnings || []),
      ...(characters.selectedId && !characters.selectedFound
        ? [`The saved default character “${characters.selectedId}” is missing. A usable character is shown instead.`]
        : []),
      ...(characters.selectedFound && !characters.selectedValid && characters.selectedName
        ? [`“${characters.selectedName}” could not be used. A usable character is shown instead.`]
        : [])
    ];
    $('character-warnings').innerHTML = warnings.length
      ? `<ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`
      : '';
    $('character-warnings').hidden = warnings.length === 0;

    const selectedId = String(characters.selectedId || '').toLocaleLowerCase();
    $('character-grid').innerHTML = characters.items.map((item) => {
      const isSelected = item.id.toLocaleLowerCase() === selectedId;
      const source = item.source === 'user' ? 'Yours' : 'Bundled';
      const meta = `${item.config?.columns || 6} × ${item.config?.rows || 6} · ${item.config?.fps || 8} fps`;
      return `
        <article class="character-card${isSelected ? ' selected' : ''}" data-character-id="${escapeHtml(item.id)}">
          ${isSelected ? '<span class="selected-badge">Default</span>' : ''}
          <div class="character-stage">
            <canvas data-character-canvas="${escapeHtml(item.id)}" width="150" height="150" aria-label="${escapeHtml(item.name)}"></canvas>
          </div>
          <div class="character-card-body">
            <div class="character-card-title">
              <strong>${escapeHtml(item.name)}</strong>
              <span class="character-source">${escapeHtml(source)}</span>
            </div>
            <p class="character-meta">${escapeHtml(meta)} · ${escapeHtml(item.id)}</p>
            ${item.valid
              ? ''
              : `<p class="character-warning">${escapeHtml(item.warning || 'This character sheet is not usable.')}</p>`}
            <div class="character-card-actions">
              <button class="quiet-button" type="button" data-character-select="${escapeHtml(item.id)}"${isSelected || !item.valid ? ' disabled' : ''}>
                ${isSelected ? 'Default character' : item.valid ? 'Use by default' : 'Unavailable'}
              </button>
            </div>
          </div>
        </article>
      `;
    }).join('');

    for (const canvas of $$('[data-character-canvas]', $('character-grid'))) {
      const item = findCharacter(canvas.dataset.characterCanvas);
      if (item) attachCharacterCanvas(canvas, item);
    }
  }

  async function saveCharacterPreference(patch, message) {
    const ok = await saveSettingsPatch(patch, message);
    if (!ok) {
      renderCharacters();
      return false;
    }
    renderCharacters();
    return true;
  }

  function openCharacterDialog() {
    const dialog = $('character-dialog');
    $('character-form').reset();
    showErrors($('character-errors'), []);
    $('character-submit').disabled = false;
    $('character-submit').textContent = 'Add character';
    if (!dialog.open) dialog.showModal();
    setTimeout(() => $('character-name').focus(), 30);
  }

  async function submitCharacterForm(event) {
    event.preventDefault();
    const name = $('character-name').value.trim();
    const sheetFile = $('character-sheet-file').files?.[0];
    const configFile = $('character-config-file').files?.[0];
    const errors = [];
    if (!name) errors.push('Give the character a name.');
    if (!sheetFile) errors.push('Choose a sprite sheet image.');
    if (errors.length) {
      showErrors($('character-errors'), errors);
      return;
    }
    const button = $('character-submit');
    button.disabled = true;
    button.textContent = 'Adding…';
    try {
      const sheetBytes = new Uint8Array(await sheetFile.arrayBuffer());
      const configText = configFile ? await configFile.text() : '';
      const result = await api.characters.add({ name, sheetBytes, configText });
      if (!result?.ok) {
        showErrors($('character-errors'), result?.errors || ['Could not add the character.']);
        button.disabled = false;
        button.textContent = 'Add character';
        return;
      }
      $('character-dialog').close();
      clearCharacterCaches();
      if (result.state) applyState(result.state);
      renderCharacters();
      const warning = result.warnings?.[0];
      showToast(warning || `${name} joined the cast.`, { error: Boolean(warning) });
    } catch (error) {
      showErrors($('character-errors'), [`Could not read those files: ${error.message}`]);
      button.disabled = false;
      button.textContent = 'Add character';
    }
  }

  // ---------- Messages & style ----------

  function populateStyle() {
    if (!app.state) return;
    const { settings } = app.state;
    for (const input of $$('input[name="theme"]')) {
      input.checked = input.value === settings.theme;
    }
    $('style-language').value = settings.language || 'system';
    if (!app.messagesDirty) {
      const messages = settings.messages || {};
      $('global-positive').value = linesOf(messages.positive);
      $('global-negative').value = linesOf(messages.negative);
      $('global-neutral').value = linesOf(messages.neutral);
      $('global-snooze').value = linesOf(messages.snooze);
      $('global-skipped').value = linesOf(messages.skipped);
    }
  }

  async function changeTheme(theme) {
    applyTheme(theme);
    const ok = await saveSettingsPatch({ theme });
    if (!ok) {
      applyTheme(app.state?.settings?.theme || 'system');
      populateStyle();
    }
  }

  async function changeLanguage(language) {
    applyLanguage(language);
    const ok = await saveSettingsPatch({ language });
    if (!ok) {
      applyLanguage(app.state?.settings?.language || 'system');
      populateStyle();
    }
  }

  async function saveGlobalMessages(event) {
    event.preventDefault();
    const messages = {
      positive: splitLines($('global-positive').value),
      negative: splitLines($('global-negative').value),
      neutral: splitLines($('global-neutral').value),
      snooze: splitLines($('global-snooze').value),
      skipped: splitLines($('global-skipped').value)
    };
    const status = $('global-messages-status');
    status.textContent = '';
    const ok = await saveSettingsPatch({ messages });
    if (!ok) return;
    app.messagesDirty = false;
    populateStyle();
    status.textContent = 'Saved.';
    clearTimeout(app.styleStatusTimer);
    app.styleStatusTimer = setTimeout(() => {
      status.textContent = '';
    }, 2400);
    showToast('Default messages saved.');
  }

  async function saveSettingsPatch(patch, message) {
    if (!app.state) return false;
    const settings = clone(app.state.settings);
    Object.assign(settings, patch);
    if (patch.messages) settings.messages = { ...clone(app.state.settings.messages), ...patch.messages };
    if (patch.dnd) settings.dnd = { ...clone(app.state.settings.dnd), ...patch.dnd };
    const result = await api.saveSettings({ settings });
    if (!result?.ok) {
      showToast(result?.errors?.[0] || 'Could not save the setting.', { error: true });
      return false;
    }
    if (result.startupError) showToast(result.startupError, { error: true });
    if (result.state) {
      app.state = result.state;
      applyTheme(result.state.settings.theme);
      applyLanguage(result.state.settings.language);
      renderAll();
    }
    if (message) showToast(message);
    return true;
  }

  // ---------- Settings ----------

  function populateSettings({ force = false } = {}) {
    if (!app.state) return;
    if (app.settingsDirty && !force) return;
    const { settings, startup } = app.state;
    $('setting-overlay-enabled').checked = Boolean(settings.overlayEnabled);
    $('setting-notify-fallback').checked = Boolean(settings.notifyFallback);
    $('setting-skip-fullscreen').checked = Boolean(settings.skipFullscreen);
    $('setting-display').value = settings.display;
    $('setting-missed-policy').value = settings.missedPolicy;
    $('setting-timeout').value = String(settings.defaultTimeoutSeconds);
    $('setting-timeout-action').value = settings.defaultTimeoutAction;
    $('setting-sound-enabled').checked = Boolean(settings.soundEnabled);
    $('setting-sound-volume').value = String(settings.soundVolume);
    $('setting-sound-volume-value').textContent = `${settings.soundVolume}%`;
    $('setting-start-minimized').checked = Boolean(settings.startMinimized);
    $('setting-quick-add').value = settings.quickAddShortcut || '';
    $('setting-dnd-enabled').checked = Boolean(settings.dnd?.enabled);
    $('setting-dnd-start').value = settings.dnd?.start || '22:00';
    $('setting-dnd-end').value = settings.dnd?.end || '07:00';
    for (const input of $$('#dnd-days input')) {
      input.checked = (settings.dnd?.days || []).includes(Number(input.value));
    }

    const startInput = $('setting-start-at-login');
    const supported = startup?.supported !== false;
    startInput.disabled = !supported;
    startInput.checked = supported && Boolean(startup?.enabled);
    $('startup-help').textContent = supported
      ? (startup?.wasOpenedAtLogin
        ? 'Remind Buddy was started with the system this time.'
        : 'Runs quietly in the tray.')
      : 'Startup integration is not available on this system.';

    $('shortcut-status').textContent = app.state.quickAdd?.error || '';
    app.settingsDirty = false;
  }

  function renderSettingsData() {
    if (!app.state) return;
    const { data, quickAdd } = app.state;
    $('data-path').textContent = `Data folder: ${data?.path || '—'}`;
    $('data-path').title = data?.dataFile || '';
    $('sync-path').hidden = !data?.syncFolder;
    $('sync-path').textContent = data?.syncFolder ? `Sync folder: ${data.syncFolder}` : '';
    $('data-warnings').innerHTML = (data?.warnings || []).map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
    $('shortcut-status').textContent = quickAdd?.error || '';
  }

  function collectSettings() {
    const base = clone(app.state.settings);
    base.overlayEnabled = $('setting-overlay-enabled').checked;
    base.notifyFallback = $('setting-notify-fallback').checked;
    base.skipFullscreen = $('setting-skip-fullscreen').checked;
    base.display = $('setting-display').value;
    base.missedPolicy = $('setting-missed-policy').value;
    base.defaultTimeoutSeconds = clamp(Math.round(numberValue($('setting-timeout'), 60)), 10, 600);
    base.defaultTimeoutAction = $('setting-timeout-action').value;
    base.soundEnabled = $('setting-sound-enabled').checked;
    base.soundVolume = clamp(Math.round(numberValue($('setting-sound-volume'), 60)), 0, 100);
    base.startMinimized = $('setting-start-minimized').checked;
    base.quickAddShortcut = $('setting-quick-add').value.trim();
    base.dnd = {
      enabled: $('setting-dnd-enabled').checked,
      start: $('setting-dnd-start').value || base.dnd.start,
      end: $('setting-dnd-end').value || base.dnd.end,
      days: $$('#dnd-days input:checked').map((input) => Number(input.value)).sort((a, b) => a - b)
    };
    return base;
  }

  async function saveSettingsForm(event) {
    event.preventDefault();
    const errors = $('settings-errors');
    showErrors(errors, []);
    const status = $('settings-status');
    status.textContent = '';
    const startAtLogin = $('setting-start-at-login').checked;
    const result = await api.saveSettings({ settings: collectSettings(), startAtLogin });
    if (!result?.ok) {
      showErrors(errors, result?.errors || ['Could not save settings.']);
      showToast(result?.errors?.[0] || 'Could not save settings.', { error: true });
      return;
    }
    if (result.state) {
      app.state = result.state;
      applyTheme(result.state.settings.theme);
      applyLanguage(result.state.settings.language);
    }
    app.settingsDirty = false;
    populateSettings({ force: true });
    renderAll();
    const issues = [result.startupError, result.shortcutError].filter(Boolean);
    showErrors(errors, issues);
    if (issues.length > 0) showToast(issues[0], { error: true });
    else {
      status.textContent = 'Saved.';
      setTimeout(() => {
        if (status.textContent === 'Saved.') status.textContent = '';
      }, 2400);
      showToast('Settings saved.');
    }
  }

  // ---------- Dialogs ----------

  function askConfirm({ heading, message, okLabel = 'Delete' }) {
    return new Promise((resolve) => {
      if (app.confirmResolver) app.confirmResolver(false);
      app.confirmResolver = resolve;
      $('confirm-heading').textContent = heading;
      $('confirm-message').textContent = message;
      $('confirm-ok').textContent = okLabel;
      const dialog = $('confirm-dialog');
      if (!dialog.open) dialog.showModal();
    });
  }

  function settleConfirm(value) {
    const resolve = app.confirmResolver;
    app.confirmResolver = null;
    const dialog = $('confirm-dialog');
    if (dialog.open) dialog.close();
    if (resolve) resolve(value);
  }

  function openTemplatePicker() {
    if (!app.state) return;
    const grid = $('template-grid');
    grid.innerHTML = app.state.templates.map((template) => `
      <button class="template-card" type="button" data-template="${escapeHtml(template.id)}">
        <span class="template-icon" aria-hidden="true">${escapeHtml(template.icon)}</span>
        <span class="template-name">${escapeHtml(template.name)}</span>
        <span class="template-description">${escapeHtml(template.description)}</span>
        <span class="template-category">${escapeHtml(template.category)}</span>
      </button>
    `).join('');
    const dialog = $('template-dialog');
    if (!dialog.open) dialog.showModal();
  }

  async function addFromTemplate(templateId, button) {
    if (button) button.disabled = true;
    const result = await api.reminders.template(templateId);
    if (button) button.disabled = false;
    if (!result?.ok) {
      showToast(result?.errors?.[0] || 'Could not create that reminder.', { error: true });
      return;
    }
    const dialog = $('template-dialog');
    if (dialog.open) dialog.close();
    openEditor(result.reminder, { isNew: true });
  }

  // ---------- Editor ----------

  function editorCharacterTarget() {
    if (!app.state || !app.editor) return { id: app.state?.characters?.effectiveId || null, label: 'Default character' };
    const mode = $('edit-character-mode').value;
    if (mode === 'random') {
      return {
        id: app.editor.randomId || app.state.characters.effectiveId || null,
        label: 'Random character each time'
      };
    }
    if (mode === 'specific') {
      const id = $('edit-character-id').value;
      const item = findCharacter(id);
      return {
        id: id || null,
        label: item ? item.name : 'Chosen character (not available)'
      };
    }
    const item = findCharacter(app.state.characters.effectiveId);
    return {
      id: app.state.characters.effectiveId || null,
      label: item ? `${item.name} (default)` : 'Default character'
    };
  }

  async function refreshEditorCharacter() {
    if (!app.editor) return;
    const token = ++app.editor.characterToken;
    const target = editorCharacterTarget();
    let prepared = null;
    try {
      prepared = target.id ? await preparedCharacter(target.id) : null;
    } catch {
      prepared = null;
    }
    if (!app.editor || token !== app.editor.characterToken) return;
    const config = findCharacter(target.id)?.config;
    app.editor.prepared = prepared || engine.createFallback(config);
    $('preview-character-name').textContent = `Character: ${target.label}`;
    startEditorCharacterLoop();
  }

  function startEditorCharacterLoop() {
    if (!app.editor) return;
    clearInterval(app.editor.characterTimer);
    const canvas = $('editor-character-canvas');
    let frame = 0;
    const draw = () => {
      if (!app.editor?.prepared) return;
      engine.drawFrame(canvas, app.editor.prepared, 'idle', frame, performance.now());
      frame += 1;
    };
    draw();
    if (!reduceMotion.matches) app.editor.characterTimer = setInterval(draw, 130);
  }

  function defaultButtonsFor(type) {
    return clone(DEFAULT_BUTTONS[type] || []);
  }

  function reactionOptions(selected) {
    return Object.entries(REACTION_LABELS).map(([value, label]) => (
      `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`
    )).join('');
  }

  function actionOptions(selected) {
    return Object.entries(ACTION_LABELS).map(([value, label]) => (
      `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`
    )).join('');
  }

  function renderEditorButtons(buttons) {
    const container = $('edit-buttons');
    container.innerHTML = (buttons || []).map((button, index) => `
      <div class="button-row" data-button-id="${escapeHtml(button.id || `button-${index + 1}`)}">
        <input type="text" data-field="label" maxlength="40" placeholder="Button label" value="${escapeHtml(button.label || '')}" aria-label="Button ${index + 1} label">
        <input type="text" data-field="icon" maxlength="16" placeholder="Icon" value="${escapeHtml(button.icon || '')}" aria-label="Button ${index + 1} icon">
        <select data-field="action" aria-label="Button ${index + 1} outcome">${actionOptions(button.action || 'positive')}</select>
        <select data-field="reaction" aria-label="Button ${index + 1} reaction">${reactionOptions(button.reaction || button.action || 'positive')}</select>
        <button class="remove-button" type="button" data-remove-button aria-label="Remove button ${index + 1}">×</button>
      </div>
    `).join('');
    updateEditorButtonAvailability();
  }

  function updateEditorButtonAvailability() {
    const type = $('edit-type').value;
    const count = $$('#edit-buttons .button-row').length;
    const add = $('add-editor-button');
    add.hidden = type === 'note';
    add.disabled = type === 'note' || count >= 4;
  }

  function updateEditorTypeVisibility() {
    const type = $('edit-type').value;
    const kind = $('edit-schedule-kind').value;
    $('buttons-section').hidden = type === 'note';
    $('timer-minutes-field').hidden = type !== 'timer';
    $('auto-dismiss-field').hidden = !(type === 'note' || kind === 'pomodoro');
    updateEditorButtonAvailability();
  }

  function updateScheduleEditorVisibility() {
    const kind = $('edit-schedule-kind').value;
    for (const group of $$('.schedule-group')) {
      group.hidden = group.dataset.schedule !== kind;
    }
    const activeWindow = $('schedule-active-window');
    const timeRow = activeWindow.querySelector('.form-grid.two');
    const daysLegend = $('edit-days').closest('fieldset');
    const showTimes = ['interval', 'idle', 'pomodoro'].includes(kind);
    const showDays = ['interval', 'times', 'idle', 'pomodoro'].includes(kind);
    if (timeRow) timeRow.hidden = !showTimes;
    if (daysLegend) daysLegend.hidden = !showDays;
    activeWindow.hidden = !showTimes && !showDays;
    $('pomodoro-messages').hidden = kind !== 'pomodoro';
    updateEditorTypeVisibility();
  }

  function populateEditorCharacterSelect(reminder) {
    const select = $('edit-character-id');
    const valid = (app.state.characters.items || []).filter((item) => item.valid);
    const selectedId = reminder.character.mode === 'specific' ? reminder.character.id : '';
    const selectedItem = findCharacter(selectedId);
    const options = valid.map((item) => (
      `<option value="${escapeHtml(item.id)}"${item.id.toLocaleLowerCase() === String(selectedId).toLocaleLowerCase() ? ' selected' : ''}>${escapeHtml(item.name)}</option>`
    ));
    if (selectedId && !selectedItem) {
      options.unshift(`<option value="${escapeHtml(selectedId)}" selected>${escapeHtml(selectedId)} (missing)</option>`);
    } else if (!selectedId && options.length > 0) {
      options[0] = options[0].replace('<option ', '<option selected ');
    }
    if (options.length === 0) {
      select.innerHTML = '<option value="">No usable characters</option>';
    } else {
      select.innerHTML = options.join('');
    }
    $('edit-character-id-field').hidden = reminder.character.mode !== 'specific';
  }

  function fillEditorForm(reminder) {
    $('edit-title').value = reminder.title || '';
    $('edit-category').value = reminder.category || '';
    $('edit-icon').value = reminder.icon || '';
    $('edit-color').value = /^#[0-9a-f]{6}$/i.test(reminder.color || '') ? reminder.color : '#17a9df';
    $('edit-type').value = reminder.type || 'yesno';
    $('edit-priority').value = reminder.priority || 'normal';
    $('edit-enabled').checked = reminder.enabled !== false;
    $('edit-question').value = linesOf(reminder.messages?.question);
    $('edit-positive').value = linesOf(reminder.messages?.positive);
    $('edit-negative').value = linesOf(reminder.messages?.negative);
    $('edit-neutral').value = linesOf(reminder.messages?.neutral);
    $('edit-snooze').value = linesOf(reminder.messages?.snooze);
    $('edit-skipped').value = linesOf(reminder.messages?.skipped);
    $('edit-pomodoro-focus').value = linesOf(reminder.messages?.pomodoroFocus);
    $('edit-pomodoro-break').value = linesOf(reminder.messages?.pomodoroBreak);
    $('edit-notes').value = reminder.notes || '';
    $('edit-special').value = reminder.specialAnimation || 'none';
    $('edit-timeout-action').value = reminder.timeoutAction || 'negative';
    $('edit-timer-minutes').value = String(reminder.timerMinutes ?? 10);
    $('edit-auto-dismiss').value = String(reminder.autoDismissSeconds ?? 10);
    $('edit-snooze-minutes').value = String(reminder.snooze?.minutes ?? 10);
    $('edit-snooze-max').value = String(reminder.snooze?.max ?? 3);
    $('edit-escalate').value = reminder.snooze?.escalate || 'none';
    $('edit-log').checked = reminder.tracking?.log !== false;
    $('edit-daily-goal').value = reminder.tracking?.dailyGoal ? String(reminder.tracking.dailyGoal) : '';
    $('edit-character-mode').value = reminder.character?.mode || 'default';
    $('edit-character-scale').value = String(reminder.character?.scale ?? 100);
    $('edit-character-scale-value').textContent = `${reminder.character?.scale ?? 100}%`;
    $('edit-sound').value = reminder.character?.sound || 'default';
    app.editor.soundFile = reminder.character?.soundFile || '';
    $('custom-sound-name').textContent = app.editor.soundFile || 'No file selected';
    $('custom-sound-row').hidden = reminder.character?.sound !== 'custom';
    populateEditorCharacterSelect(reminder);
    renderEditorButtons(reminder.type === 'note' ? [] : (reminder.buttons || []));

    const schedule = reminder.schedule || {};
    $('edit-schedule-kind').value = schedule.kind || 'interval';
    $('edit-interval').value = String(schedule.intervalMinutes ?? 60);
    $('edit-times').value = (schedule.times || ['09:00']).join(', ');
    $('edit-monthly-day').value = String(schedule.monthlyDay ?? 1);
    $('edit-monthly-time').value = (schedule.times || ['09:00'])[0] || '09:00';
    $('edit-once-at').value = schedule.onceAt || '';
    $('edit-repeat-yearly').checked = Boolean(schedule.repeatYearly);
    $('edit-startup-delay').value = String(schedule.startupDelayMinutes ?? 5);
    $('edit-idle-minutes').value = String(schedule.idleMinutes ?? 30);
    $('edit-focus-minutes').value = String(schedule.focusMinutes ?? 25);
    $('edit-break-minutes').value = String(schedule.breakMinutes ?? 5);
    $('edit-active-start').value = schedule.activeStart || '09:00';
    $('edit-active-end').value = schedule.activeEnd || '21:00';
    for (const input of $$('#edit-days input')) {
      input.checked = (schedule.days || []).includes(Number(input.value));
    }
    $('edit-start-date').value = schedule.startDate || '';
    $('edit-end-date').value = schedule.endDate || '';
    $('edit-missed-policy').value = schedule.missedPolicy || 'inherit';
    $('edit-skip-paused').checked = schedule.skipPaused !== false;
    $('edit-skip-dnd').checked = schedule.skipDnd !== false;
    $('edit-skip-locked').checked = schedule.skipLocked !== false;

    const categories = [...new Set([
      ...app.state.reminders.map((entry) => entry.category),
      ...app.state.templates.map((entry) => entry.category)
    ].filter(Boolean))].sort();
    $('category-suggestions').innerHTML = categories.map((category) => (
      `<option value="${escapeHtml(category)}"></option>`
    )).join('');

    updateEditorTypeVisibility();
    updateScheduleEditorVisibility();
    scheduleEditorPreview();
    refreshEditorCharacter();
  }

  function openEditor(reminder, { isNew = false } = {}) {
    if (!reminder) return;
    closeEditor();
    const validCharacters = (app.state?.characters.items || []).filter((item) => item.valid);
    app.editor = {
      reminder: clone(reminder),
      isNew: Boolean(isNew),
      dirty: false,
      saving: false,
      testing: false,
      formType: reminder.type,
      soundFile: reminder.character?.soundFile || '',
      previewSeq: 0,
      previewTimer: null,
      characterTimer: null,
      characterToken: 0,
      prepared: null,
      randomId: validCharacters.length > 0
        ? validCharacters[Math.floor(Math.random() * validCharacters.length)].id
        : null
    };
    $('editor-eyebrow').textContent = isNew ? 'New reminder' : 'Edit reminder';
    $('editor-heading').textContent = isNew ? 'Add reminder' : `Edit “${reminder.title}”`;
    $('editor-subcopy').textContent = isNew
      ? 'Every template is a starting point — make it sound like you.'
      : 'Change the rhythm, the words, and the reaction.';
    $('editor-delete').hidden = isNew;
    $('editor-delete').disabled = false;
    $('editor-save').disabled = false;
    $('editor-test').disabled = false;
    $('preview-test-chip').hidden = true;
    showErrors($('editor-errors'), []);
    fillEditorForm(reminder);
    const dialog = $('editor-dialog');
    if (!dialog.open) dialog.showModal();
    setTimeout(() => $('edit-title').focus(), 40);
  }

  function closeEditor() {
    const current = app.editor;
    if (!current) return;
    clearTimeout(current.previewTimer);
    clearInterval(current.characterTimer);
    app.editor = null;
    const dialog = $('editor-dialog');
    if (dialog.open) dialog.close();
  }

  function markEditorDirty() {
    if (!app.editor) return;
    app.editor.dirty = true;
    const chip = $('preview-test-chip');
    chip.hidden = false;
    chip.textContent = app.editor.isNew ? 'Draft' : 'Unsaved';
    scheduleEditorPreview();
  }

  function readEditorButtons(type) {
    if (type === 'note') return [];
    return $$('#edit-buttons .button-row').map((row, index) => {
      const label = row.querySelector('[data-field="label"]').value.trim();
      const icon = row.querySelector('[data-field="icon"]').value.trim();
      const action = row.querySelector('[data-field="action"]').value;
      const reaction = row.querySelector('[data-field="reaction"]').value;
      return {
        id: row.dataset.buttonId || `button-${index + 1}`,
        label,
        icon,
        action,
        reaction
      };
    }).filter((button) => button.label);
  }

  function readEditorDraft() {
    const base = app.editor?.reminder || {};
    const type = $('edit-type').value;
    const kind = $('edit-schedule-kind').value;
    const characterMode = $('edit-character-mode').value;
    const sound = $('edit-sound').value;
    const days = $$('#edit-days input:checked').map((input) => Number(input.value)).sort((a, b) => a - b);
    const times = $('edit-times').value.split(',').map((value) => value.trim()).filter(Boolean);
    const monthlyTime = $('edit-monthly-time').value || '09:00';
    const goal = $('edit-daily-goal').value;
    return {
      ...clone(base),
      title: $('edit-title').value.trim(),
      icon: $('edit-icon').value.trim(),
      color: $('edit-color').value,
      category: $('edit-category').value.trim(),
      enabled: $('edit-enabled').checked,
      type,
      priority: $('edit-priority').value,
      messages: {
        question: splitLines($('edit-question').value),
        positive: splitLines($('edit-positive').value),
        negative: splitLines($('edit-negative').value),
        neutral: splitLines($('edit-neutral').value),
        snooze: splitLines($('edit-snooze').value),
        skipped: splitLines($('edit-skipped').value),
        pomodoroFocus: splitLines($('edit-pomodoro-focus').value),
        pomodoroBreak: splitLines($('edit-pomodoro-break').value)
      },
      buttons: readEditorButtons(type),
      notes: $('edit-notes').value,
      specialAnimation: $('edit-special').value,
      timeoutAction: $('edit-timeout-action').value,
      timerMinutes: Math.round(numberValue($('edit-timer-minutes'), 10)),
      autoDismissSeconds: Math.round(numberValue($('edit-auto-dismiss'), 10)),
      character: {
        mode: characterMode,
        id: characterMode === 'specific' ? $('edit-character-id').value : '',
        scale: Math.round(numberValue($('edit-character-scale'), 100)),
        sound,
        soundFile: sound === 'custom' ? app.editor?.soundFile || '' : ''
      },
      snooze: {
        minutes: Math.round(numberValue($('edit-snooze-minutes'), 10)),
        max: Math.round(numberValue($('edit-snooze-max'), 3)),
        escalate: $('edit-escalate').value
      },
      tracking: {
        log: $('edit-log').checked,
        dailyGoal: goal === '' ? null : Math.round(Number(goal))
      },
      schedule: {
        kind,
        intervalMinutes: Math.round(numberValue($('edit-interval'), 60)),
        times: kind === 'monthly' ? [monthlyTime] : times,
        monthlyDay: Math.round(numberValue($('edit-monthly-day'), 1)),
        onceAt: $('edit-once-at').value,
        repeatYearly: $('edit-repeat-yearly').checked,
        startupDelayMinutes: Math.round(numberValue($('edit-startup-delay'), 5)),
        idleMinutes: Math.round(numberValue($('edit-idle-minutes'), 30)),
        focusMinutes: Math.round(numberValue($('edit-focus-minutes'), 25)),
        breakMinutes: Math.round(numberValue($('edit-break-minutes'), 5)),
        activeStart: $('edit-active-start').value || '09:00',
        activeEnd: $('edit-active-end').value || '21:00',
        days,
        startDate: $('edit-start-date').value || null,
        endDate: $('edit-end-date').value || null,
        skipPaused: $('edit-skip-paused').checked,
        skipDnd: $('edit-skip-dnd').checked,
        skipLocked: $('edit-skip-locked').checked,
        missedPolicy: $('edit-missed-policy').value
      }
    };
  }

  function scheduleEditorPreview() {
    if (!app.editor) return;
    clearTimeout(app.editor.previewTimer);
    app.editor.previewTimer = setTimeout(updateEditorPreview, 170);
  }

  async function updateEditorPreview() {
    if (!app.editor) return;
    const seq = ++app.editor.previewSeq;
    const draft = readEditorDraft();
    let preview = null;
    try {
      const result = await api.reminders.preview(draft);
      if (result?.ok) preview = result;
    } catch {
      preview = null;
    }
    if (!app.editor || seq !== app.editor.previewSeq) return;
    applyEditorPreview(draft, preview);
  }

  function applyEditorPreview(draft, preview) {
    const question = Array.isArray(preview?.question)
      ? (preview.question[0] || draft.title || 'Your question appears here.')
      : (preview?.question || (draft.messages.question[0] || draft.title || 'Your question appears here.'));
    const icon = preview?.icon || draft.icon || '🔔';
    const color = /^#[0-9a-f]{6}$/i.test(preview?.color || draft.color || '') ? (preview?.color || draft.color) : '#17a9df';
    $('preview-icon').textContent = icon;
    $('preview-kicker').textContent = draft.category || typeLabel(draft.type);
    $('preview-question').textContent = question;
    $('preview-bubble').style.setProperty('--accent', color);
    $('preview-bubble').style.setProperty('--accent-soft', hexToRgba(color, 0.14));

    const note = preview?.note || draft.notes || '';
    $('preview-note').textContent = note;
    $('preview-note').hidden = !note;

    const buttons = preview?.buttons || draft.buttons || [];
    $('preview-buttons').innerHTML = draft.type === 'note' || buttons.length === 0
      ? ''
      : buttons.map((button) => {
        const reaction = button.reaction || button.action || 'positive';
        return `<span class="preview-button ${escapeHtml(reaction)}${button.disabled ? ' disabled' : ''}">${escapeHtml(button.icon ? `${button.icon} ` : '')}${escapeHtml(button.label)}</span>`;
      }).join('');

    const timeout = app.state?.settings?.defaultTimeoutSeconds || 60;
    if (draft.type === 'note') {
      $('preview-wait').textContent = `Closes on its own after ${draft.autoDismissSeconds || 10}s`;
    } else if (draft.type === 'timer') {
      $('preview-wait').textContent = `${draft.timerMinutes || 10} min timer · happy finish`;
    } else if (draft.priority === 'high') {
      $('preview-wait').textContent = 'Stays until you answer';
    } else {
      const action = draft.timeoutAction === 'snooze'
        ? 'snoozes'
        : draft.timeoutAction === 'dismiss'
          ? 'closes quietly'
          : 'counts as No';
      $('preview-wait').textContent = `Waits ${timeout}s, then ${action}`;
    }

    const messages = preview?.messages || {};
    const reactionRows = [
      ['positive', messages.positive?.[0]],
      ['negative', messages.negative?.[0]],
      ['neutral', messages.neutral?.[0]],
      ['snooze', messages.snooze?.[0]],
      ['skipped', messages.skipped?.[0] || messages.skip?.[0]]
    ].filter((entry) => entry[1]);
    $('preview-reactions').innerHTML = reactionRows.map(([key, text]) => (
      `<li class="preview-reaction"><strong>${escapeHtml(key === 'skipped' ? 'Skip' : key)}</strong><span>${escapeHtml(text)}</span></li>`
    )).join('');
    $('preview-schedule').textContent = preview?.schedule || scheduleSummary(draft);
    const target = editorCharacterTarget();
    $('preview-character-name').textContent = `Character: ${target.label}`;
    $('preview-test-chip').hidden = !app.editor?.dirty && !app.editor?.isNew;
  }

  async function saveEditor() {
    if (!app.editor || app.editor.saving) return;
    const draft = readEditorDraft();
    showErrors($('editor-errors'), []);
    app.editor.saving = true;
    $('editor-save').disabled = true;
    const result = await api.reminders.save(draft);
    if (!app.editor) return;
    app.editor.saving = false;
    $('editor-save').disabled = false;
    if (!result?.ok) {
      showErrors($('editor-errors'), result?.errors || ['Could not save the reminder.']);
      showToast(result?.errors?.[0] || 'Could not save the reminder.', { error: true });
      return;
    }
    const wasNew = app.editor.isNew;
    closeEditor();
    if (result.state) applyState(result.state);
    else renderAll();
    showToast(wasNew ? 'Reminder added.' : 'Reminder saved.');
  }

  async function testEditor() {
    if (!app.editor || app.editor.testing) return;
    const draft = readEditorDraft();
    showErrors($('editor-errors'), []);
    app.editor.testing = true;
    $('editor-test').disabled = true;
    const result = await api.reminders.testDraft(draft);
    if (!app.editor) return;
    app.editor.testing = false;
    $('editor-test').disabled = false;
    if (!result?.ok) {
      showErrors($('editor-errors'), result?.errors || ['The test reminder could not be shown.']);
      showToast(result?.errors?.[0] || 'The test reminder could not be shown.', { error: true });
      return;
    }
    showToast('Test reminder is playing — nothing is logged.');
  }

  async function deleteEditorReminder() {
    if (!app.editor || app.editor.isNew) return;
    const reminder = app.editor.reminder;
    const confirmed = await askConfirm({
      heading: `Delete “${reminder.title}”?`,
      message: 'This removes the reminder and its schedule. Its history entries stay in your log.',
      okLabel: 'Delete reminder'
    });
    if (!confirmed || !app.editor) return;
    const result = await api.reminders.delete(reminder.id);
    if (!result?.ok) {
      showErrors($('editor-errors'), result?.errors || ['Could not delete the reminder.']);
      toastError(result?.errors?.[0] || 'Could not delete the reminder.');
      return;
    }
    closeEditor();
    if (result.state) applyState(result.state);
    showToast('Reminder deleted.');
  }

  function toastError(message) {
    showToast(message, { error: true });
  }

  function handleTypeChange() {
    if (!app.editor) return;
    const type = $('edit-type').value;
    if (type !== app.editor.formType) {
      renderEditorButtons(defaultButtonsFor(type));
      app.editor.formType = type;
    }
    if (type === 'timer') {
      $('edit-special').value = 'none';
      if (!numberValue($('edit-timer-minutes'), 0)) $('edit-timer-minutes').value = '10';
    }
    if (type === 'note' && !numberValue($('edit-auto-dismiss'), 0)) {
      $('edit-auto-dismiss').value = '10';
    }
    updateEditorTypeVisibility();
    scheduleEditorPreview();
  }

  function handleScheduleKindChange() {
    const kind = $('edit-schedule-kind').value;
    if (kind === 'once' && !$('edit-once-at').value) {
      $('edit-once-at').value = localDatetimeValue(new Date(Date.now() + 60 * 60 * 1000));
    }
    if (kind === 'times' && !$('edit-times').value.trim()) $('edit-times').value = '09:00';
    if (kind === 'monthly' && !$('edit-monthly-time').value) $('edit-monthly-time').value = '09:00';
    if (kind === 'interval' && !numberValue($('edit-interval'), 0)) $('edit-interval').value = '60';
    updateScheduleEditorVisibility();
    scheduleEditorPreview();
  }

  function handleCharacterModeChange() {
    $('edit-character-id-field').hidden = $('edit-character-mode').value !== 'specific';
    refreshEditorCharacter();
    scheduleEditorPreview();
  }

  function handleSoundChange() {
    $('custom-sound-row').hidden = $('edit-sound').value !== 'custom';
    scheduleEditorPreview();
  }

  async function chooseEditorSound() {
    const result = await api.sounds.choose();
    if (!result?.ok) {
      if (!result?.canceled) showToast(result?.errors?.[0] || 'Could not use that sound.', { error: true });
      return;
    }
    if (!app.editor) return;
    app.editor.soundFile = result.fileName;
    $('custom-sound-name').textContent = result.label || result.fileName;
    markEditorDirty();
  }

  // ---------- Event wiring ----------

  function bindNavigation() {
    for (const button of $$('.tab-button')) {
      button.addEventListener('click', () => activateTab(button.dataset.tab));
    }
    for (const button of $$('[data-nav]')) {
      button.addEventListener('click', () => activateTab(button.dataset.nav));
    }
    $('sidebar-quick-add').addEventListener('click', () => {
      api.openQuickAdd();
    });
    $('open-data-folder').addEventListener('click', async () => {
      const result = await api.openDataFolder();
      if (!result?.ok) showToast(result?.error || 'Could not open the data folder.', { error: true });
    });

    $('pause-actions').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-pause]');
      if (!button) return;
      const value = button.dataset.pause;
      const result = value === 'tomorrow'
        ? await api.pause({ untilTomorrow: true })
        : await api.pause({ minutes: Number(value) });
      if (!result?.ok) {
        showToast(result?.errors?.[0] || 'Could not pause reminders.', { error: true });
        return;
      }
      if (result.state) applyState(result.state);
      showToast(value === 'tomorrow' ? 'Reminders paused until tomorrow.' : `Reminders paused for ${value} minutes.`);
    });

    $('resume-button').addEventListener('click', async () => {
      const result = await api.resume();
      if (!result?.ok) {
        showToast(result?.errors?.[0] || 'Could not resume reminders.', { error: true });
        return;
      }
      if (result.state) applyState(result.state);
      showToast('Reminders resumed.');
    });
  }

  function bindReminders() {
    $('reminder-search').addEventListener('input', renderReminders);
    $('category-filter').addEventListener('change', renderReminders);
    $('add-reminder').addEventListener('click', openTemplatePicker);
    $('empty-add-reminder').addEventListener('click', () => {
      if ($('empty-add-reminder').dataset.mode === 'clear') {
        $('reminder-search').value = '';
        $('category-filter').value = '';
        renderReminders();
        return;
      }
      openTemplatePicker();
    });

    $('reminder-list').addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]');
      if (action) {
        const id = action.dataset.id;
        if (action.dataset.action === 'edit') {
          const reminder = findReminder(id);
          if (reminder) openEditor(reminder, { isNew: false });
        } else if (action.dataset.action === 'test') {
          testReminder(id);
        } else if (action.dataset.action === 'duplicate') {
          duplicateReminder(id);
        } else if (action.dataset.action === 'delete') {
          deleteReminderFromList(id);
        }
        return;
      }
      if (event.target.closest('button, input, label, select, a')) return;
      const row = event.target.closest('.reminder-row');
      if (!row) return;
      const reminder = findReminder(row.dataset.id);
      if (reminder) openEditor(reminder, { isNew: false });
    });

    $('reminder-list').addEventListener('change', (event) => {
      const toggle = event.target.closest('[data-reminder-toggle]');
      if (!toggle) return;
      toggleReminder(toggle.dataset.reminderToggle, toggle.checked);
    });

    setupReminderDrag();
  }

  function bindToday() {
    $('today-hero').addEventListener('click', (event) => {
      if (event.target.closest('[data-nav]')) activateTab(event.target.closest('[data-nav]').dataset.nav);
    });
  }

  function bindHistory() {
    $('history-reminder').addEventListener('change', loadHistory);
    $('history-range').addEventListener('change', loadHistory);
    $('history-refresh').addEventListener('click', loadHistory);
    $('history-export').addEventListener('click', exportHistory);
    $('history-outcomes').addEventListener('change', (event) => {
      const checked = $$('#history-outcomes input:checked');
      if (checked.length === 0 && event.target.matches('input')) {
        event.target.checked = true;
      }
      loadHistory();
    });
  }

  function bindCharacters() {
    $('open-characters-folder').addEventListener('click', async () => {
      const result = await api.characters.openFolder();
      if (!result?.ok) showToast(result?.error || 'Could not open the characters folder.', { error: true });
    });
    $('rescan-characters').addEventListener('click', async () => {
      const result = await api.characters.rescan();
      if (!result?.ok) {
        showToast(result?.errors?.[0] || 'Could not rescan characters.', { error: true });
        return;
      }
      clearCharacterCaches();
      if (result.state) applyState(result.state);
      renderCharacters();
      showToast('Character folder rescanned.');
    });
    $('add-character').addEventListener('click', openCharacterDialog);
    $('character-size').addEventListener('input', () => {
      $('character-size-value').textContent = `${$('character-size').value}%`;
    });
    $('character-size').addEventListener('change', async () => {
      await saveCharacterPreference(
        { defaultCharacterScale: Number($('character-size').value) },
        'Default character size saved.'
      );
    });
    $('random-character').addEventListener('change', async () => {
      await saveCharacterPreference(
        { randomCharacter: $('random-character').checked },
        $('random-character').checked ? 'Surprise-me characters on.' : 'Character choice is now fixed.'
      );
    });
    $('character-grid').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-character-select]');
      if (!button) return;
      const item = findCharacter(button.dataset.characterSelect);
      if (!item?.valid) return;
      button.disabled = true;
      await saveCharacterPreference(
        { defaultCharacterId: item.id },
        `${item.name} is now the default character.`
      );
    });
    $('character-form').addEventListener('submit', submitCharacterForm);
  }

  function bindStyle() {
    for (const input of $$('input[name="theme"]')) {
      input.addEventListener('change', () => {
        if (input.checked) changeTheme(input.value);
      });
    }
    $('style-language').addEventListener('change', () => changeLanguage($('style-language').value));
    for (const area of $$('#global-messages-form textarea')) {
      area.addEventListener('input', () => {
        app.messagesDirty = true;
        $('global-messages-status').textContent = '';
      });
    }
    $('global-messages-form').addEventListener('submit', saveGlobalMessages);
  }

  function bindSettings() {
    $('settings-form').addEventListener('input', () => {
      app.settingsDirty = true;
      $('settings-status').textContent = '';
      showErrors($('settings-errors'), []);
    });
    $('settings-form').addEventListener('change', () => {
      app.settingsDirty = true;
    });
    $('settings-form').addEventListener('submit', saveSettingsForm);
    $('setting-sound-volume').addEventListener('input', () => {
      $('setting-sound-volume-value').textContent = `${$('setting-sound-volume').value}%`;
    });
    $('export-data').addEventListener('click', async () => {
      const result = await api.backup.exportData();
      if (!result?.ok) {
        if (!result?.canceled) showToast(result?.errors?.[0] || 'Could not export data.', { error: true });
        return;
      }
      showToast('Backup exported.');
    });
    $('import-data').addEventListener('click', async () => {
      const result = await api.backup.importData();
      if (!result?.ok) {
        if (!result?.canceled) showToast(result?.errors?.[0] || 'Could not import data.', { error: true });
        return;
      }
      clearCharacterCaches();
      app.messagesDirty = false;
      app.settingsDirty = false;
      if (result.state) {
        applyState(result.state);
        populateStyle();
        populateSettings({ force: true });
      } else {
        renderAll();
      }
      showToast('Backup imported.');
    });
    $('choose-sync-folder').addEventListener('click', async () => {
      const result = await api.backup.chooseSyncFolder();
      if (!result?.ok) {
        if (!result?.canceled) showToast(result?.errors?.[0] || 'Could not choose a sync folder.', { error: true });
        return;
      }
      if (result.state) applyState(result.state);
      renderSettingsData();
      showToast('Sync folder saved.');
    });
    $('sync-now').addEventListener('click', async () => {
      const result = await api.backup.syncNow();
      if (!result?.ok) {
        showToast(result?.errors?.[0] || 'Could not sync.', { error: true });
        return;
      }
      showToast('Sync folder updated.');
    });
    $('quit-app').addEventListener('click', () => {
      api.quit();
    });
  }

  function bindDialogs() {
    for (const button of $$('[data-close-dialog]')) {
      button.addEventListener('click', () => {
        const dialog = $(button.dataset.closeDialog);
        if (dialog?.open) dialog.close();
      });
    }
    $('template-grid').addEventListener('click', (event) => {
      const card = event.target.closest('[data-template]');
      if (!card) return;
      addFromTemplate(card.dataset.template, card);
    });
    $('confirm-cancel').addEventListener('click', () => settleConfirm(false));
    $('confirm-ok').addEventListener('click', () => settleConfirm(true));
    $('confirm-dialog').addEventListener('cancel', (event) => {
      event.preventDefault();
      settleConfirm(false);
    });

    $('editor-close').addEventListener('click', closeEditor);
    $('editor-cancel').addEventListener('click', closeEditor);
    $('editor-form').addEventListener('submit', (event) => {
      event.preventDefault();
      saveEditor();
    });
    $('editor-test').addEventListener('click', testEditor);
    $('editor-delete').addEventListener('click', deleteEditorReminder);
    $('editor-dialog').addEventListener('cancel', (event) => {
      event.preventDefault();
      closeEditor();
    });

    $('editor-form').addEventListener('input', () => {
      markEditorDirty();
      if (document.activeElement?.id === 'edit-character-scale') {
        $('edit-character-scale-value').textContent = `${$('edit-character-scale').value}%`;
      }
    });
    $('editor-form').addEventListener('change', (event) => {
      markEditorDirty();
      if (event.target.id === 'edit-type') handleTypeChange();
      else if (event.target.id === 'edit-schedule-kind') handleScheduleKindChange();
      else if (event.target.id === 'edit-character-mode' || event.target.id === 'edit-character-id') handleCharacterModeChange();
      else if (event.target.id === 'edit-sound') handleSoundChange();
      else if (event.target.id === 'edit-character-scale') {
        $('edit-character-scale-value').textContent = `${$('edit-character-scale').value}%`;
      }
    });

    $('add-editor-button').addEventListener('click', () => {
      if (!app.editor) return;
      const type = $('edit-type').value;
      const buttons = readEditorButtons(type);
      if (buttons.length >= 4) return;
      buttons.push({ id: `button-${buttons.length + 1}-${Date.now().toString(36)}`, label: '', action: 'positive', reaction: 'positive' });
      renderEditorButtons(buttons);
      markEditorDirty();
      const rows = $$('#edit-buttons .button-row');
      rows[rows.length - 1]?.querySelector('[data-field="label"]')?.focus();
    });

    $('edit-buttons').addEventListener('click', (event) => {
      const remove = event.target.closest('[data-remove-button]');
      if (!remove || !app.editor) return;
      const type = $('edit-type').value;
      const buttons = readEditorButtons(type);
      const minimum = type === 'choice' ? 2 : 1;
      if (buttons.length <= minimum) {
        showToast(type === 'choice' ? 'A choice reminder needs at least two buttons.' : 'This reminder needs at least one button.');
        return;
      }
      const row = remove.closest('.button-row');
      row.remove();
      updateEditorButtonAvailability();
      markEditorDirty();
    });

    $('choose-sound').addEventListener('click', chooseEditorSound);
  }

  function bindAppEvents() {
    if (api.onState) {
      api.onState((next) => {
        if (!next) return;
        app.state = next;
        applyTheme(next.settings?.theme || 'system');
        applyLanguage(next.settings?.language || 'system');
        renderAll();
        if (app.activeTab === 'history') scheduleHistoryRefresh();
      });
    }
    if (api.onNavigate) {
      api.onNavigate((payload) => {
        if (payload?.tab) activateTab(payload.tab, { quiet: true });
      });
    }
    window.addEventListener('beforeunload', () => {
      if (app.editor) closeEditor();
    });
    setInterval(() => {
      for (const [canvas, entry] of app.characterCanvases) {
        if (!canvas.isConnected) {
          app.characterCanvases.delete(canvas);
          continue;
        }
        entry.frame += 1;
        engine.drawFrame(canvas, entry.prepared, 'idle', entry.frame, performance.now());
      }
    }, 130);
  }

  async function boot() {
    if (!api || !engine) {
      showGlobalNotice('Remind Buddy could not connect to its main process. Try restarting the app.');
      return;
    }
    bindNavigation();
    bindReminders();
    bindToday();
    bindHistory();
    bindCharacters();
    bindStyle();
    bindSettings();
    bindDialogs();
    bindAppEvents();
    try {
      const initialState = await api.getState();
      if (!initialState) {
        showGlobalNotice('The reminder data could not be loaded. Try restarting Remind Buddy.');
        return;
      }
      app.booted = true;
      applyState(initialState);
      activateTab('reminders', { quiet: true });
    } catch (error) {
      showGlobalNotice(`Remind Buddy could not load: ${error.message}`);
    }
  }

  window.__remindBuddyApp = {
    getState: () => app.state,
    getActiveTab: () => app.activeTab,
    activateTab,
    openTemplatePicker,
    openEditorById: (id) => {
      const reminder = findReminder(id);
      if (reminder) openEditor(reminder, { isNew: false });
    },
    getEditorDraft: () => (app.editor ? readEditorDraft() : null),
    saveEditor,
    testEditor,
    loadHistory
  };

  boot();
})();
