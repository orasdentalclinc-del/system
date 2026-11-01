'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { StoreError } = require('./secure-database');

function sameLocalPage(url, pagePath) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' && path.resolve(fileURLToPath(parsed)) === path.resolve(pagePath);
  } catch { return false; }
}

function registerClinicIpc({ ipcMain, store, getWindow, dialog, shell, app, indexPath, unlockPath }) {
  function trusted(event, pagePath) {
    const win = getWindow();
    const frame = event.senderFrame;
    if (!win || win.isDestroyed() || event.sender !== win.webContents || !frame) return false;
    const mainFrame = win.webContents.mainFrame;
    // WebFrameMain wrappers may be represented by different JS objects for
    // the same frame, so compare the Electron routing identity as well.
    const isMain = frame === mainFrame || (mainFrame && Number.isInteger(frame.processId) &&
      Number.isInteger(frame.routingId) && frame.processId === mainFrame.processId && frame.routingId === mainFrame.routingId);
    return Boolean(isMain && sameLocalPage(frame.url, pagePath));
  }
  function failure(err, fallback) {
    // Never log a passphrase or records received from the renderer.
    if (err instanceof StoreError) return { ok: false, code: err.code, message: err.message };
    console.error('Clinic storage operation failed:', err && (err.code || err.name));
    return { ok: false, code: 'STORAGE_ERROR', message: fallback };
  }
  const denied = () => ({ ok: false, code: 'DENIED', message: 'طلب غير مسموح.' });

  ipcMain.handle('oras:database-status', event => {
    if (!trusted(event, unlockPath)) return denied();
    return { ok: true, exists: store.exists() };
  });

  ipcMain.handle('oras:unlock', (event, passphrase) => {
    if (!trusted(event, unlockPath)) return denied();
    try {
      const result = store.open(passphrase);
      return { ok: true, created: result.created };
    } catch (err) {
      return failure(err, 'تعذّر فتح قاعدة البيانات. تحقق من صلاحيات المجلد ومساحة القرص. لم تُستبدل البيانات.');
    }
  });

  ipcMain.on('oras:enter-clinic', event => {
    if (trusted(event, unlockPath) && store.db) getWindow().loadFile(indexPath);
  });

  // Synchronous, narrowly-scoped storage methods preserve the existing app's
  // synchronous persistence interface. There is no generic filesystem or IPC.
  ipcMain.on('oras:storage', (event, request) => {
    if (!trusted(event, indexPath)) { event.returnValue = denied(); return; }
    try {
      if (!request || typeof request !== 'object') throw new StoreError('INVALID_DATA', 'طلب التخزين غير صالح.');
      let value = null;
      switch (request.operation) {
        case 'get': value = store.getItem(request.key); break;
        case 'set': store.setItem(request.key, request.value); break;
        case 'remove': store.removeItem(request.key); break;
        case 'batch': store.setMany(request.entries); break;
        case 'import-legacy': value = store.importLegacy(request.entries); break;
        default: throw new StoreError('INVALID_OPERATION', 'عملية التخزين غير مسموحة.');
      }
      event.returnValue = { ok: true, value };
    } catch (err) {
      event.returnValue = failure(err, 'تعذّر الوصول إلى قاعدة البيانات المشفّرة. لم يتم تأكيد الحفظ.');
    }
  });

  ipcMain.handle('oras:backup-encrypted', async event => {
    if (!trusted(event, indexPath)) return denied();
    try {
      store.requireOpen();
      const day = new Date().toISOString().slice(0, 10);
      const result = await dialog.showSaveDialog(getWindow(), {
        title: 'حفظ نسخة احتياطية مشفّرة',
        defaultPath: path.join(app.getPath('documents'), `oras-encrypted-${day}.orasdb`),
        filters: [{ name: 'قاعدة بيانات أوراس المشفّرة', extensions: ['orasdb'] }]
      });
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      store.copyEncryptedTo(result.filePath);
      return { ok: true, canceled: false, path: result.filePath };
    } catch (err) {
      return failure(err, 'تعذّر إنشاء النسخة المشفّرة. تحقق من المسار ومساحة القرص.');
    }
  });

  ipcMain.on('oras:open-external', (event, url) => {
    if (!trusted(event, indexPath) || typeof url !== 'string') return;
    try {
      const parsed = new URL(url);
      // The app currently opens only WhatsApp Web. Never allow file:, shell
      // commands, arbitrary hosts or renderer-controlled protocol handlers.
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'web.whatsapp.com' || parsed.username || parsed.password) return;
      shell.openExternal(parsed.href).catch(() => {});
    } catch { /* reject invalid URLs */ }
  });
}

module.exports = { registerClinicIpc, sameLocalPage };
