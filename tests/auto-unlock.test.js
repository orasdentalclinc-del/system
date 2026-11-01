'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { EncryptedStore } = require('../secure-database');
const { WindowsKeyVault, attemptAutomaticUnlock } = require('../key-vault');
const { registerClinicIpc } = require('../electron-ipc');

const PASS = 'EXISTING clinic-passphrase ضرس 2026';
const PATIENTS = 'oras-dental-patients-v3';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oras-auto-unlock-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

// Tests simulate OS account-bound cryptography. Actual Windows DPAPI is only
// available in Electron on Windows and still needs an on-device test.
function mockSafeStorage(masterKey = crypto.randomBytes(32), available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString(secret) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
      const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(blob) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, blob.subarray(0, 12));
      decipher.setAuthTag(blob.subarray(12, 28));
      return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}
function clinicIpc(store, keyVault, automatic = {opened:false,state:'KEY_MISSING'}) {
  const handlers = new Map();
  const indexPath = path.join(os.tmpdir(),'oras-test-index.html');
  const unlockPath = path.join(os.tmpdir(),'oras-test-unlock.html');
  const frame = {url:pathToFileURL(unlockPath).href};
  const wc = {mainFrame:frame};
  const win = {webContents:wc,isDestroyed:()=>false,loadFile:()=>{}};
  const event = {sender:wc,senderFrame:frame};
  registerClinicIpc({ipcMain:{handle:(key,fn)=>handlers.set(key,fn),on:()=>{}},store,keyVault,
    getAutomaticUnlock:()=>automatic,getWindow:()=>win,dialog:{},shell:{},app:{},indexPath,unlockPath});
  return {handlers,event};
}
function createExisting(filename) {
  const store = new EncryptedStore(filename);
  store.open(PASS);
  store.setItem(PATIENTS, '[{"id":"safe","fullName":"PRIVATE PATIENT"}]');
  store.close();
  return store;
}

test('Windows key vault stores only protected bytes and refuses unsupported or unavailable backends', t => {
  const dir = temporary(t), filename = path.join(dir, 'clinic-key.dpapi');
  const vault = new WindowsKeyVault(filename, mockSafeStorage(), 'win32');
  vault.save(PASS);
  assert.equal(vault.read(), PASS);
  assert.equal(fs.readFileSync(filename).includes(Buffer.from(PASS)), false);
  assert.equal(fs.readFileSync(filename).includes('EXISTING clinic-passphrase'), false);
  const original = digest(filename);
  vault.safeStorage = {isEncryptionAvailable:()=>true,encryptString:()=>{throw new Error('injected failure');}};
  assert.throws(()=>vault.save('replacement long passphrase'), /injected failure/);
  assert.equal(digest(filename), original, 'a failed rewrap must not destroy the previous key');
  const otherUser = new WindowsKeyVault(filename, mockSafeStorage(), 'win32');
  assert.throws(()=>otherUser.read());
  const unsupported = new WindowsKeyVault(path.join(dir,'linux.dpapi'), mockSafeStorage(), 'linux');
  assert.throws(()=>unsupported.save(PASS), {code:'UNAVAILABLE'});
  assert.equal(unsupported.exists(),false);
  const disabled = new WindowsKeyVault(path.join(dir,'disabled.dpapi'), mockSafeStorage(undefined,false), 'win32');
  assert.throws(()=>disabled.save(PASS), {code:'UNAVAILABLE'});
  assert.equal(disabled.exists(),false);
});

test('existing database needs its original phrase once, then opens automatically without changing encryption', t => {
  const dir=temporary(t), dbPath=path.join(dir,'clinic.sqlite3'), keyPath=path.join(dir,'clinic-key.dpapi');
  const store=createExisting(dbPath), vault=new WindowsKeyVault(keyPath,mockSafeStorage(),'win32');
  t.after(()=>store.close());
  assert.deepEqual(attemptAutomaticUnlock(store,vault),{opened:false,state:'KEY_MISSING'});
  const {handlers,event}=clinicIpc(store,vault);
  assert.equal(handlers.get('oras:database-status')(event).canRemember,true);
  assert.equal(handlers.get('oras:unlock')(event,'incorrect password').ok,false);
  assert.equal(vault.exists(),false,'a wrong phrase must not be saved');
  const first=handlers.get('oras:unlock')(event,PASS);
  assert.equal(first.ok,true); assert.equal(first.automatic,true); assert.equal(vault.exists(),true);
  store.close();
  const reopened=attemptAutomaticUnlock(store,vault);
  assert.deepEqual(reopened,{opened:true,state:'OPENED'});
  assert.match(store.getItem(PATIENTS),/PRIVATE PATIENT/);
  assert.equal(fs.readFileSync(dbPath).includes('PRIVATE PATIENT'),false);
  assert.equal(fs.readFileSync(keyPath).includes('EXISTING clinic-passphrase'),false);
});

test('a failed auto-unlock or changed Windows account never overwrites the database or key', t => {
  const dir=temporary(t), dbPath=path.join(dir,'clinic.sqlite3'), keyPath=path.join(dir,'clinic-key.dpapi');
  const store=createExisting(dbPath), accountA=mockSafeStorage(), accountB=mockSafeStorage();
  const vaultA=new WindowsKeyVault(keyPath,accountA,'win32');vaultA.save(PASS);
  const beforeDb=digest(dbPath), beforeKey=digest(keyPath);
  const vaultB=new WindowsKeyVault(keyPath,accountB,'win32');
  assert.deepEqual(attemptAutomaticUnlock(store,vaultB),{opened:false,state:'FAILED'});
  assert.equal(digest(dbPath),beforeDb); assert.equal(digest(keyPath),beforeKey);
  const {handlers,event}=clinicIpc(store,vaultB,{opened:false,state:'FAILED'});
  assert.match(handlers.get('oras:database-status')(event).message,/تعذّر الفتح التلقائي/);
  assert.equal(handlers.get('oras:unlock')(event,'wrong password').ok,false);
  assert.equal(digest(dbPath),beforeDb); assert.equal(digest(keyPath),beforeKey);
  assert.equal(handlers.get('oras:unlock')(event,PASS).automatic,true);
  store.close();
  assert.deepEqual(attemptAutomaticUnlock(store,vaultB),{opened:true,state:'OPENED'});
  assert.match(store.getItem(PATIENTS),/PRIVATE PATIENT/);store.close();
});

test('key storage failure is reported and continues only with the encrypted database', t => {
  const dir=temporary(t), dbPath=path.join(dir,'clinic.sqlite3'), keyPath=path.join(dir,'clinic-key.dpapi');
  const store=createExisting(dbPath), vault=new WindowsKeyVault(keyPath,mockSafeStorage(undefined,false),'win32');
  t.after(()=>store.close());
  const {handlers,event}=clinicIpc(store,vault);
  assert.equal(handlers.get('oras:database-status')(event).canRemember,false);
  const result=handlers.get('oras:unlock')(event,PASS);
  assert.equal(result.ok,true); assert.equal(result.automatic,false);
  assert.match(result.autoMessage,/تعذّر حفظ مفتاح التشفير/);
  assert.equal(vault.exists(),false);
  assert.match(store.getItem(PATIENTS),/PRIVATE PATIENT/);
  assert.equal(fs.readFileSync(dbPath).includes('PRIVATE PATIENT'),false);
});

test('a saved key with a missing database does not create or replace an empty database', t => {
  const dir=temporary(t), dbPath=path.join(dir,'missing.sqlite3'), keyPath=path.join(dir,'clinic-key.dpapi');
  const store=new EncryptedStore(dbPath), vault=new WindowsKeyVault(keyPath,mockSafeStorage(),'win32');
  vault.save(PASS); const beforeKey=digest(keyPath);
  assert.deepEqual(attemptAutomaticUnlock(store,vault),{opened:false,state:'DATABASE_MISSING'});
  const {handlers,event}=clinicIpc(store,vault,{opened:false,state:'DATABASE_MISSING'});
  const status=handlers.get('oras:database-status')(event);
  assert.equal(status.blocked,true);assert.match(status.message,/مفقود/);
  const result=handlers.get('oras:unlock')(event,PASS);
  assert.equal(result.ok,false);assert.equal(result.code,'DATABASE_MISSING');
  assert.equal(fs.existsSync(dbPath),false);assert.equal(digest(keyPath),beforeKey);
  assert.throws(()=>store.open(PASS,{mustExist:true}),{code:'DATABASE_MISSING'});
  assert.equal(fs.existsSync(dbPath),false);
});


test('an existing database removed after startup is never recreated when the key is not yet saved', t => {
  const dir=temporary(t), dbPath=path.join(dir,'clinic.sqlite3'), savedPath=path.join(dir,'clinic.saved');
  const store=createExisting(dbPath), vault=new WindowsKeyVault(path.join(dir,'key.dpapi'),mockSafeStorage(),'win32');
  const initial=attemptAutomaticUnlock(store,vault);
  assert.equal(initial.state,'KEY_MISSING');
  fs.renameSync(dbPath,savedPath);
  const {handlers,event}=clinicIpc(store,vault,initial);
  assert.equal(handlers.get('oras:database-status')(event).blocked,true);
  assert.equal(handlers.get('oras:unlock')(event,PASS).code,'DATABASE_MISSING');
  assert.equal(fs.existsSync(dbPath),false);
  assert.equal(fs.existsSync(savedPath),true);
});
