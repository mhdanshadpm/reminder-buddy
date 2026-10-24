'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const DESKTOP_FILE = 'remind-buddy.desktop';

function linuxAutostartPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(path.resolve(configHome), 'autostart', DESKTOP_FILE);
}

function quoteDesktopExec(value) {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/%/g, '%%');
  return `"${escaped}"`;
}

function linuxExecLine() {
  if (app.isPackaged) {
    const executable = process.env.APPIMAGE || process.execPath;
    return `${quoteDesktopExec(executable)} --hidden`;
  }
  return `${quoteDesktopExec(process.execPath)} ${quoteDesktopExec(app.getAppPath())} --hidden`;
}

function readLinuxAutostart() {
  const filePath = linuxAutostartPath();
  try {
    const contents = fs.readFileSync(filePath, 'utf8');
    const hidden = /^Hidden\s*=\s*true\s*$/im.test(contents);
    const disabled = /^X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(contents);
    return { supported: true, enabled: !hidden && !disabled, path: filePath };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { supported: true, enabled: false, path: filePath };
    }
    return { supported: true, enabled: false, path: filePath, error: error.message };
  }
}

function desktopEntriesWithDeveloperArgs() {
  if (process.platform !== 'win32' || app.isPackaged) {
    return { openAtLogin: false, openAsHidden: true };
  }
  return {
    openAtLogin: false,
    openAsHidden: true,
    path: process.execPath,
    args: [app.getAppPath(), '--hidden']
  };
}

function getStartupState() {
  if (process.platform === 'linux') {
    return readLinuxAutostart();
  }

  try {
    const query = process.platform === 'win32' && !app.isPackaged
      ? { path: process.execPath, args: [app.getAppPath(), '--hidden'] }
      : undefined;
    const current = app.getLoginItemSettings(query);
    return {
      supported: true,
      enabled: Boolean(current.openAtLogin),
      wasOpenedAtLogin: Boolean(current.wasOpenedAtLogin)
    };
  } catch (error) {
    return { supported: true, enabled: false, error: error.message };
  }
}

function setLinuxStartupEnabled(enabled) {
  const filePath = linuxAutostartPath();
  if (!enabled) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return readLinuxAutostart();
  }

  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const contents = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Remind Buddy',
    'Comment=Friendly desktop reminders',
    `Exec=${linuxExecLine()}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'Hidden=false',
    'StartupNotify=false',
    'Categories=Utility;'
  ].join('\n');
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${contents}\n`, { mode: 0o644 });
  fs.renameSync(temporaryPath, filePath);
  return readLinuxAutostart();
}

function setStartupEnabled(enabled) {
  if (typeof enabled !== 'boolean') {
    throw new Error('Startup setting must be a boolean.');
  }

  if (process.platform === 'linux') {
    return setLinuxStartupEnabled(enabled);
  }

  const options = {
    ...desktopEntriesWithDeveloperArgs(),
    openAtLogin: enabled,
    openAsHidden: true
  };
  app.setLoginItemSettings(options);

  const state = getStartupState();
  if (state.enabled !== enabled) {
    throw new Error('The operating system did not accept the startup setting.');
  }
  return state;
}

module.exports = {
  getStartupState,
  linuxAutostartPath,
  setStartupEnabled
};
