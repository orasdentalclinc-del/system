'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { sameLocalPage } = require('../electron-ipc');

const root = path.resolve(__dirname, '..');
async function startMockMain(lock) {
  const windows = [], stores = [], registrations = [];
  class FakeApp extends EventEmitter {
    constructor() { super(); this.quitCalled = false; }
    requestSingleInstanceLock() { return lock; }
    quit() { this.quitCalled = true; }
    whenReady() { return Promise.resolve(); }
    getPath(name) { assert.equal(name, 'userData'); return path.join(root, 'fake-userdata'); }
  }
  const app = new FakeApp();
  class FakeWebContents extends EventEmitter { setWindowOpenHandler(fn) { this.handler = fn; } }
  class FakeWindow extends EventEmitter {
    constructor(options) { super(); this.options=options; this.webContents=new FakeWebContents(); windows.push(this); }
    loadFile(file) { this.loaded=file; return Promise.resolve(); }
    isMinimized() { return false; }
    focus() { this.focused = true; }
    static getAllWindows() { return windows; }
  }
  class FakeStore {
    constructor(filename) { this.filename=filename; stores.push(this); }
    close() { this.closed=true; }
  }
  const electron = { app, BrowserWindow:FakeWindow, Menu:{setApplicationMenu:()=>{}},
    ipcMain:{}, dialog:{showErrorBox:()=>{}}, shell:{} };
  const code = fs.readFileSync(path.join(root,'main.js'),'utf8');
  vm.runInNewContext(code, {
    __dirname:root, process, console,
    require(id) {
      if(id==='electron') return electron;
      if(id==='./secure-database') return {EncryptedStore:FakeStore};
      if(id==='./electron-ipc') return {registerClinicIpc: options=>registrations.push(options),sameLocalPage};
      return require(id);
    }
  });
  await new Promise(resolve=>setImmediate(resolve));
  return {app,windows,stores,registrations};
}

test('main process loads unlock first with isolation and retains the original app identity', async () => {
  const {app,windows,stores,registrations}=await startMockMain(true);
  assert.equal(require('../package.json').name,'oras-dental-clinic');
  assert.equal(windows.length,1); assert.equal(registrations.length,1);
  const win=windows[0];
  assert.equal(win.loaded,path.join(root,'unlock.html'));
  assert.equal(stores[0].filename,path.join(root,'fake-userdata','clinic-data','oras-dental.sqlite3'));
  assert.equal(win.options.webPreferences.nodeIntegration,false);
  assert.equal(win.options.webPreferences.contextIsolation,true);
  assert.equal(win.options.webPreferences.sandbox,true);
  assert.equal(win.options.webPreferences.spellcheck,false);
  assert.equal(win.webContents.handler().action,'deny');
  let denied=false;
  win.webContents.emit('will-navigate',{preventDefault(){denied=true;}},'https://untrusted.example/');
  assert.equal(denied,true);
  denied=false;
  win.webContents.emit('will-navigate',{preventDefault(){denied=true;}},pathToFileURL(path.join(root,'index.html')).href);
  assert.equal(denied,false);
  app.emit('second-instance'); assert.equal(win.focused,true);
  win.emit('closed'); assert.equal(stores[0].closed,true);
});

test('a second instance exits without opening a database or window', async () => {
  const {app,windows,stores}=await startMockMain(false);
  assert.equal(app.quitCalled,true);assert.equal(windows.length,0);assert.equal(stores.length,0);
});
