'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const normalizedPath = window.location.pathname.replace(/\\/g, '/');
const windowName = normalizedPath.split('/').pop();

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

if (windowName === 'overlay.html') {
  contextBridge.exposeInMainWorld('remindBuddyOverlay', {
    onShow: (callback) => subscribe('overlay:show', callback),
    onResolve: (callback) => subscribe('overlay:resolve', callback),
    promptShown: () => ipcRenderer.send('overlay:prompt-shown'),
    respond: (answer) => ipcRenderer.invoke('overlay:respond', answer),
    finished: () => ipcRenderer.send('overlay:finished'),
    setClickThrough: (ignore) => ipcRenderer.send('overlay:set-click-through', Boolean(ignore)),
    setHitRegions: (regions) => ipcRenderer.send('overlay:set-hit-regions', regions)
  });
} else if (windowName === 'quick-add.html') {
  contextBridge.exposeInMainWorld('remindBuddyQuickAdd', {
    onPrefill: (callback) => subscribe('quickadd:prefill', callback),
    parse: (text) => ipcRenderer.invoke('quickadd:parse', text),
    save: (text) => ipcRenderer.invoke('quickadd:save', text),
    close: () => ipcRenderer.send('quickadd:close')
  });
} else {
  contextBridge.exposeInMainWorld('remindBuddy', {
    getState: () => ipcRenderer.invoke('app:get-state'),
    onState: (callback) => subscribe('app:state', callback),
    onNavigate: (callback) => subscribe('app:navigate', callback),
    saveSettings: (payload) => ipcRenderer.invoke('app:save-settings', payload),
    pause: (payload) => ipcRenderer.invoke('app:pause', payload),
    resume: () => ipcRenderer.invoke('app:resume'),
    openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
    quit: () => ipcRenderer.invoke('app:quit'),
    openQuickAdd: () => ipcRenderer.invoke('quickadd:open'),
    reminders: {
      save: (reminder) => ipcRenderer.invoke('reminders:save', reminder),
      delete: (id) => ipcRenderer.invoke('reminders:delete', id),
      toggle: (payload) => ipcRenderer.invoke('reminders:toggle', payload),
      duplicate: (id) => ipcRenderer.invoke('reminders:duplicate', id),
      reorder: (ids) => ipcRenderer.invoke('reminders:reorder', ids),
      test: (id) => ipcRenderer.invoke('reminders:test', id),
      testDraft: (reminder) => ipcRenderer.invoke('reminders:test-draft', reminder),
      template: (id) => ipcRenderer.invoke('reminders:template', id),
      preview: (reminder) => ipcRenderer.invoke('reminders:preview', reminder)
    },
    history: {
      query: (payload) => ipcRenderer.invoke('history:query', payload),
      exportCsv: (payload) => ipcRenderer.invoke('history:export', payload)
    },
    backup: {
      exportData: () => ipcRenderer.invoke('backup:export'),
      importData: () => ipcRenderer.invoke('backup:import'),
      chooseSyncFolder: () => ipcRenderer.invoke('backup:choose-sync-folder'),
      syncNow: () => ipcRenderer.invoke('backup:sync-now')
    },
    sounds: {
      choose: () => ipcRenderer.invoke('sound:choose')
    },
    characters: {
      rescan: () => ipcRenderer.invoke('characters:rescan'),
      sheet: (id) => ipcRenderer.invoke('characters:sheet', id),
      add: (payload) => ipcRenderer.invoke('characters:add', payload),
      openFolder: () => ipcRenderer.invoke('characters:open-folder')
    }
  });
}
