'use strict';

(() => {
  const api = window.remindBuddyQuickAdd;
  if (!api) return;

  const $ = (id) => document.getElementById(id);
  const input = $('quick-input');
  const shell = $('input-shell');
  const clearButton = $('quick-clear');
  const saveButton = $('quick-save');
  const status = $('quick-status');
  const preview = $('quick-preview');
  const previewBadge = $('preview-badge');
  const previewTitle = $('preview-title');
  const previewSchedule = $('preview-schedule');
  const previewNote = $('preview-note');

  const IDLE_TITLE = 'Try “in 30 min call mom”';
  const IDLE_COPY = 'I’ll read the time, then add a simple Done / Later reminder.';
  const IDLE_NOTE = 'You can edit every detail after adding it.';

  let parsed = null;
  let parseToken = 0;
  let parseTimer = null;
  let saving = false;

  function setStatus(text, { success = false } = {}) {
    status.textContent = text;
    status.classList.toggle('is-success', Boolean(success));
  }

  function showIdle() {
    parsed = null;
    preview.classList.remove('is-ready', 'is-invalid');
    shell.classList.remove('is-invalid');
    previewBadge.textContent = '⏰';
    previewTitle.textContent = IDLE_TITLE;
    previewSchedule.textContent = IDLE_COPY;
    previewNote.textContent = IDLE_NOTE;
    saveButton.disabled = true;
    setStatus('');
    if (saving) return;
  }

  function showParsed(result) {
    parsed = result;
    preview.classList.add('is-ready');
    preview.classList.remove('is-invalid');
    shell.classList.remove('is-invalid');
    previewBadge.textContent = '✅';
    previewTitle.textContent = result.title;
    previewSchedule.textContent = result.description;
    previewNote.textContent = `Matched “${result.matched}” · adds a Done / Later reminder you can edit.`;
    saveButton.disabled = false;
    setStatus('');
  }

  function showParseError(message) {
    parsed = null;
    preview.classList.add('is-invalid');
    preview.classList.remove('is-ready');
    shell.classList.add('is-invalid');
    previewBadge.textContent = '🕓';
    previewTitle.textContent = 'Waiting for a time';
    previewSchedule.textContent = message;
    previewNote.textContent = 'Examples: “in 30 min call mom”, “tomorrow 9am pay rent”, “every day 8am take vitamins”.';
    saveButton.disabled = true;
  }

  function scheduleParse() {
    const text = input.value.trim();
    clearButton.hidden = text.length === 0;
    if (!text) {
      if (parseTimer) clearTimeout(parseTimer);
      parseTimer = null;
      showIdle();
      return;
    }

    const token = ++parseToken;
    if (parseTimer) clearTimeout(parseTimer);
    parseTimer = setTimeout(async () => {
      parseTimer = null;
      let result;
      try {
        result = await api.parse(text);
      } catch (error) {
        result = { ok: false, error: 'Quick add is unavailable right now.' };
      }
      if (token !== parseToken) return;
      if (!result || !result.ok) {
        showParseError(result?.error || 'I could not understand that time.');
        return;
      }
      showParsed(result);
    }, 90);
  }

  async function save() {
    if (saving || saveButton.disabled) {
      input.focus();
      return;
    }
    const text = input.value.trim();
    if (!text) {
      setStatus('Type a reminder first.');
      input.focus();
      return;
    }

    saving = true;
    saveButton.disabled = true;
    saveButton.textContent = 'Adding…';
    shell.classList.remove('is-invalid');
    setStatus('');
    try {
      const result = await api.save(text);
      if (!result || !result.ok) {
        showParseError(result?.errors?.[0] || 'Could not add that reminder.');
        setStatus(result?.errors?.[0] || 'Could not add that reminder.');
        return;
      }
      input.value = '';
      parsed = null;
      saving = false;
      saveButton.textContent = 'Add reminder';
      showIdle();
      clearButton.hidden = true;
      setStatus('Added.', { success: true });
    } catch (error) {
      setStatus(error.message || 'Could not add that reminder.');
      showParseError('Could not add that reminder.');
    } finally {
      saving = false;
      saveButton.textContent = 'Add reminder';
      saveButton.disabled = !parsed;
    }
  }

  clearButton.addEventListener('click', () => {
    input.value = '';
    input.focus();
    scheduleParse();
  });

  input.addEventListener('input', scheduleParse);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      api.close();
      return;
    }
    if (event.key === 'Enter') {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        save();
        return;
      }
      event.preventDefault();
      if (parseTimer) {
        clearTimeout(parseTimer);
        parseTimer = null;
      }
      save();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      api.close();
    }
  });

  saveButton.addEventListener('click', save);
  $('quick-close').addEventListener('click', () => api.close());

  document.querySelectorAll('[data-example]').forEach((button) => {
    button.addEventListener('click', () => {
      input.value = button.dataset.example || '';
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      const token = ++parseToken;
      if (parseTimer) clearTimeout(parseTimer);
      parseTimer = setTimeout(async () => {
        parseTimer = null;
        const text = input.value.trim();
        if (!text) {
          showIdle();
          return;
        }
        let result;
        try {
          result = await api.parse(text);
        } catch (error) {
          result = { ok: false, error: 'Quick add is unavailable right now.' };
        }
        if (token !== parseToken) return;
        if (result?.ok) showParsed(result);
        else showParseError(result?.error || 'I could not understand that time.');
        clearButton.hidden = false;
      }, 60);
    });
  });

  api.onPrefill(({ text } = {}) => {
    if (typeof text === 'string' && text) {
      input.value = text;
      scheduleParse();
      clearButton.hidden = false;
    }
    requestAnimationFrame(() => {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    });
  });

  showIdle();
  input.focus();
})();
