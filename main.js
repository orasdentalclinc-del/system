'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { EncryptedStore } = require('./secure-database');
const { registerClinicIpc, sameLocalPage } = require('./electron-ipc');
const { WindowsKeyVault, attemptAutomaticUnlock } = require('./key-vault');

const indexPath = path.join(__dirname, 'index.html');
const unlockPath = path.join(__dirname, 'unlock.html');
let win = null;
let store = null;
let keyVault = null;
let automaticUnlock = { opened: false, state: 'NEW_DATABASE' };

function createWindow() {
  // Runs only after app.whenReady(), as required by Electron safeStorage.
  automaticUnlock = attemptAutomaticUnlock(store, keyVault);
  const options = {
    width: 1366,
    height: 768,
    minWidth: 1000,
    minHeight: 600,
    title: 'أوراس | إدارة عيادة الأسنان',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  };
  const icon = path.join(__dirname, 'icon.ico');
  if (fs.existsSync(icon)) options.icon = icon;
  win = new BrowserWindow(options);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!sameLocalPage(url, indexPath) && !sameLocalPage(url, unlockPath)) event.preventDefault();
  });
  win.on('closed', () => {
    win = null;
    try { store?.close(); } catch { /* retain files for recovery */ }
  });
  win.loadFile(automaticUnlock.opened ? indexPath : unlockPath);
}

// A single application window/process avoids concurrent writers and makes
// the encrypted-file backup consistent. Preserve the original package name,
// so Electron uses the same userData/legacy localStorage location as before.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const dataDir = path.join(app.getPath('userData'), 'clinic-data');
    store = new EncryptedStore(path.join(dataDir, 'oras-dental.sqlite3'));
    keyVault = new WindowsKeyVault(path.join(dataDir, 'oras-dental-key.dpapi'), safeStorage);
    registerClinicIpc({ ipcMain, store, keyVault, getAutomaticUnlock: () => automaticUnlock,
      getWindow: () => win, dialog, shell, app, indexPath, unlockPath });
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch(err => {
    console.error('Application startup failed:', err && (err.code || err.name));
    dialog.showErrorBox('أوراس', 'تعذّر بدء التطبيق. لم تُحذف بياناتك.');
    app.quit();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => { try { store?.close(); } catch { /* no automatic deletion */ } });
}
