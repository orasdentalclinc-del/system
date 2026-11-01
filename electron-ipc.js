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

function registerClinicIpc({ ipcMain, store, keyVault, getAutomaticUnlock, getWindow, dialog, shell, app, indexPath, unlockPath }) {
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
    const exists = store.exists();
    const automatic = getAutomaticUnlock();
    if (!exists && (keyVault.exists() || automatic.state !== 'NEW_DATABASE')) {
      return { ok: true, exists: false, blocked: true,
        message: 'ملف قاعدة البيانات المتوقع مفقود. لم ننشئ قاعدة فارغة؛ أعد ملف البيانات أو استعد نسخة احتياطية.' };
    }
    const message = automatic.state === 'FAILED'
      ? 'تعذّر الفتح التلقائي. أدخل عبارة التشفير الأصلية للتحقق؛ لم تُحذف البيانات.'
      : automatic.state === 'UNAVAILABLE'
        ? 'حماية Windows للمفتاح غير متاحة الآن. أدخل العبارة لفتح قاعدة البيانات يدوياً.'
        : '';
    return { ok: true, exists, blocked: false, canRemember: keyVault.available(), message };
  });

  ipcMain.handle('oras:unlock', (event, passphrase) => {
    if (!trusted(event, unlockPath)) return denied();
    try {
      const existed = store.exists();
      const keyExists = keyVault.exists();
      const expectedDatabase = getAutomaticUnlock().state !== 'NEW_DATABASE';
      if (!existed && (keyExists || expectedDatabase)) {
        throw new StoreError('DATABASE_MISSING', 'ملف قاعدة البيانات المتوقع مفقود. لم تُنشأ قاعدة جديدة؛ استعد البيانات أولاً.');
      }
      // Never replace the saved key unless the entered phrase really opens
      // this database. The DB remains encrypted even if DPAPI is unavailable.
      // If an existing file disappears between these checks and opening it,
      // mustExist also prevents silently creating an empty database.
      const result = store.open(passphrase, { mustExist: existed || keyExists || expectedDatabase });
      let automatic = false;
      try { keyVault.save(passphrase); automatic = true; }
      catch { /* Keep the database open, report that the key was not saved. */ }
      return { ok: true, created: result.created, automatic,
        autoMessage: automatic ? '' : 'تعذّر حفظ مفتاح التشفير بحماية Windows. فُتحت القاعدة المشفّرة، لكن قد تحتاج إلى إدخال العبارة عند التشغيل القادم.' };
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
