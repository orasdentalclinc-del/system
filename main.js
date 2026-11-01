'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { EncryptedStore } = require('./secure-database');
const { registerClinicIpc, sameLocalPage } = require('./electron-ipc');

const indexPath = path.join(__dirname, 'index.html');
const unlockPath = path.join(__dirname, 'unlock.html');
let win = null;
let store = null;

function createWindow() {
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
  win.loadFile(unlockPath);
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
    store = new EncryptedStore(path.join(app.getPath('userData'), 'clinic-data', 'oras-dental.sqlite3'));
    registerClinicIpc({ ipcMain, store, getWindow: () => win, dialog, shell, app, indexPath, unlockPath });
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
