'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function checked(result) {
  if (!result || !result.ok) {
    const err = new Error(result?.message || 'تعذّر الاتصال بالتخزين المشفّر.');
    err.code = result?.code || 'STORAGE_ERROR';
    throw err;
  }
  return result.value;
}
function storageRequest(operation, payload = {}) {
  return checked(ipcRenderer.sendSync('oras:storage', { operation, ...payload }));
}

// No require, Node objects, generic IPC or filesystem access reaches the page.
contextBridge.exposeInMainWorld('electronAPI', Object.freeze({
  isDesktop: true,
  storage: Object.freeze({
    getItem: key => storageRequest('get', { key }),
    setItem: (key, value) => storageRequest('set', { key, value }),
    removeItem: key => storageRequest('remove', { key }),
    setMany: entries => storageRequest('batch', { entries }),
    importLegacy: entries => storageRequest('import-legacy', { entries })
  }),
  databaseStatus: () => ipcRenderer.invoke('oras:database-status'),
  unlockDatabase: passphrase => ipcRenderer.invoke('oras:unlock', passphrase),
  enterClinic: () => ipcRenderer.send('oras:enter-clinic'),
  backupEncrypted: () => ipcRenderer.invoke('oras:backup-encrypted'),
  openExternal: url => ipcRenderer.send('oras:open-external', url)
}));
