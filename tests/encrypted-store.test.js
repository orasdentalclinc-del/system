'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { EncryptedStore, MIGRATION_KEY } = require('../secure-database');
const { registerClinicIpc } = require('../electron-ipc');
const { ignoreUnneeded } = require('../scripts/build-win');

const PASS = "مفتاح قوي ' clinic 123";
const PATIENTS = 'oras-dental-patients-v3';
const VISITS = 'oras-dental-visits-v3';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oras-encrypted-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

test('database is encrypted, persists, rejects wrong keys and never overwrites an existing file', t => {
  const dir = temporary(t), filename = path.join(dir, 'data', 'clinic.sqlite3');
  const db = new EncryptedStore(filename);
  assert.throws(() => db.open('short'), { code: 'WEAK_PASSPHRASE' });
  assert.equal(fs.existsSync(filename), false);
  assert.deepEqual(db.open(PASS), { created: true });
  const sensitive = JSON.stringify([{ id: 'p1', fullName: 'PRIVATE-PATIENT-MARKER-الاسم' }]);
  db.setMany([{ key: PATIENTS, value: sensitive }, { key: VISITS, value: '[{"id":"v1"}]' }]);
  db.close();
  const bytes = fs.readFileSync(filename);
  assert.notEqual(bytes.subarray(0, 16).toString('ascii'), 'SQLite format 3\0');
  assert.equal(bytes.includes(Buffer.from('PRIVATE-PATIENT-MARKER')), false);
  const plain = new DatabaseSync(filename, { readOnly: true });
  try { assert.throws(() => plain.prepare('SELECT * FROM clinic_storage').all(), /not a database|encrypted/i); }
  finally { plain.close(); }
  const before = digest(filename);
  assert.throws(() => db.open('wrong passphrase'), { code: 'WRONG_KEY_OR_CORRUPT' });
  assert.equal(digest(filename), before, 'unlocking with a wrong key must not alter the database');
  assert.deepEqual(db.open(PASS), { created: false });
  assert.equal(db.getItem(PATIENTS), sensitive);
  assert.equal(db.getItem(VISITS), '[{"id":"v1"}]');
  db.close();
});

test('batch writes are transactional, including rollback on an injected SQL failure', t => {
  const dir = temporary(t), db = new EncryptedStore(path.join(dir, 'db.sqlite3'));
  db.open(PASS);
  t.after(() => db.close());
  db.setItem(PATIENTS, '[{"id":"original"}]');
  assert.throws(() => db.setMany([{ key: PATIENTS, value: 'changed' }, { key: 'wrong-key', value: 'x' }]), { code: 'INVALID_KEY' });
  assert.equal(db.getItem(PATIENTS), '[{"id":"original"}]');
  db.db.exec(`CREATE TRIGGER reject_visits BEFORE INSERT ON clinic_storage
    WHEN NEW.key='${VISITS}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
  assert.throws(() => db.setMany([{ key: PATIENTS, value: 'changed' }, { key: VISITS, value: 'new' }]), /injected failure/);
  assert.equal(db.getItem(PATIENTS), '[{"id":"original"}]');
  assert.equal(db.getItem(VISITS), null);
});

test('rollback journals do not contain plaintext patient markers', t => {
  const dir = temporary(t), filename = path.join(dir, 'db.sqlite3');
  const db = new EncryptedStore(filename); db.open(PASS); t.after(() => db.close());
  db.setItem(PATIENTS, 'JOURNAL-PRIVATE-OLD-MARKER');
  db.db.exec('BEGIN IMMEDIATE');
  try {
    db.db.prepare('UPDATE clinic_storage SET value=? WHERE key=?').run('JOURNAL-PRIVATE-NEW-MARKER', PATIENTS);
    const journal = fs.readFileSync(filename + '-journal');
    assert.equal(journal.includes('JOURNAL-PRIVATE-OLD-MARKER'), false);
    assert.equal(journal.includes('JOURNAL-PRIVATE-NEW-MARKER'), false);
  } finally { db.db.exec('ROLLBACK'); }
  assert.equal(db.getItem(PATIENTS), 'JOURNAL-PRIVATE-OLD-MARKER');
});

test('legacy import is one transaction, preserves data and refuses to overwrite an existing clinic', t => {
  const dir = temporary(t), db = new EncryptedStore(path.join(dir, 'db.sqlite3'));
  db.open(PASS); t.after(() => db.close());
  const old = [{ key: PATIENTS, value: '[{"id":"legacy"}]' }, { key: VISITS, value: '[{"id":"visit"}]' }];
  db.db.exec(`CREATE TRIGGER reject_legacy BEFORE INSERT ON clinic_storage
    WHEN NEW.key='${VISITS}' BEGIN SELECT RAISE(ABORT, 'migration failure'); END;`);
  assert.throws(() => db.importLegacy(old), /migration failure/);
  assert.equal(db.getItem(PATIENTS), null);
  assert.equal(db.getItem(MIGRATION_KEY), null);
  db.db.exec('DROP TRIGGER reject_legacy');
  assert.equal(db.importLegacy(old), 2);
  assert.equal(db.getItem(PATIENTS), old[0].value);
  assert.ok(db.getItem(MIGRATION_KEY));
  assert.throws(() => db.importLegacy([{ key: PATIENTS, value: 'overwrite' }]), { code: 'DATABASE_NOT_EMPTY' });
  assert.equal(db.getItem(PATIENTS), old[0].value);
});

test('encrypted backup is an independently readable copy and cannot replace the live database', t => {
  const dir = temporary(t), filename = path.join(dir, 'db.sqlite3');
  const backup = path.join(dir, 'backup.orasdb');
  const db = new EncryptedStore(filename); db.open(PASS); t.after(() => db.close());
  db.setItem(PATIENTS, 'EXCLUSIVE-SECRET-PATIENT-STRING');
  assert.throws(() => db.copyEncryptedTo(filename), { code: 'INVALID_PATH' });
  db.copyEncryptedTo(backup);
  assert.equal(fs.readFileSync(backup).includes('EXCLUSIVE-SECRET-PATIENT-STRING'), false);
  const copy = new EncryptedStore(backup);
  assert.throws(() => copy.open('bad password'), { code: 'WRONG_KEY_OR_CORRUPT' });
  copy.open(PASS);
  assert.equal(copy.getItem(PATIENTS), 'EXCLUSIVE-SECRET-PATIENT-STRING');
  copy.close();
  db.setItem(PATIENTS, 'new value');
  const restored = new EncryptedStore(backup); restored.open(PASS);
  assert.equal(restored.getItem(PATIENTS), 'EXCLUSIVE-SECRET-PATIENT-STRING');
  restored.close();
});

test('IPC accepts only the application main frame and exposes only the intended operations', async t => {
  const dir = temporary(t), filename = path.join(dir, 'db.sqlite3');
  const db = new EncryptedStore(filename); t.after(() => db.close());
  const handlers = new Map(), listeners = new Map(), opened = [];
  const ipcMain = { handle: (key, fn) => handlers.set(key, fn), on: (key, fn) => listeners.set(key, fn) };
  const index = path.join(dir, 'index.html'), unlock = path.join(dir, 'unlock.html');
  const frame = { url: pathToFileURL(unlock).href };
  const wc = { mainFrame: frame };
  const win = { webContents: wc, isDestroyed: () => false, loadFile: file => { frame.url = pathToFileURL(file).href; } };
  const event = { sender: wc, senderFrame: frame };
  const backup = path.join(dir, 'picked.orasdb');
  registerClinicIpc({ ipcMain, store: db, getWindow: () => win,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: backup }) },
    shell: { openExternal: url => { opened.push(url); return Promise.resolve(); } },
    app: { getPath: () => dir }, indexPath: index, unlockPath: unlock });
  assert.deepEqual(handlers.get('oras:database-status')(event), { ok: true, exists: false });
  assert.equal(handlers.get('oras:unlock')(event, PASS).ok, true);
  listeners.get('oras:enter-clinic')(event);
  assert.equal(frame.url, pathToFileURL(index).href);
  listeners.get('oras:storage')(event, { operation: 'set', key: PATIENTS, value: 'secret' });
  assert.equal(event.returnValue.ok, true);
  listeners.get('oras:storage')(event, { operation: 'get', key: PATIENTS });
  assert.equal(event.returnValue.value, 'secret');
  listeners.get('oras:storage')(event, { operation: 'read-arbitrary-file', path: '/etc/passwd' });
  assert.equal(event.returnValue.code, 'INVALID_OPERATION');
  const childEvent = { sender: wc, senderFrame: { url: frame.url } };
  listeners.get('oras:storage')(childEvent, { operation: 'get', key: PATIENTS });
  assert.equal(childEvent.returnValue.code, 'DENIED');
  frame.url = 'https://evil.example/';
  listeners.get('oras:storage')(event, { operation: 'get', key: PATIENTS });
  assert.equal(event.returnValue.code, 'DENIED');
  frame.url = pathToFileURL(index).href;
  listeners.get('oras:open-external')(event, 'file:///etc/passwd');
  listeners.get('oras:open-external')(event, 'https://web.whatsapp.com.evil.example/');
  listeners.get('oras:open-external')(event, 'https://web.whatsapp.com/send?phone=123');
  assert.deepEqual(opened, ['https://web.whatsapp.com/send?phone=123']);
  const result = await handlers.get('oras:backup-encrypted')(event);
  assert.equal(result.ok, true); assert.equal(fs.existsSync(backup), true);
});

test('preload presents a fixed bridge, propagates errors, and does not expose generic IPC', () => {
  let api; const requests = [];
  const ipcRenderer = {
    sendSync(channel, payload) {
      requests.push({ channel, payload });
      return payload.operation === 'get' ? { ok: true, value: 'saved' } : { ok: false, code: 'FAIL', message: 'failed' };
    },
    invoke: async () => ({ ok: true }),
    send: () => {}
  };
  const contextBridge = { exposeInMainWorld(name, object) { assert.equal(name, 'electronAPI'); api = object; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), {
    require: module => { assert.equal(module, 'electron'); return { ipcRenderer, contextBridge }; },
    Object, Error
  });
  assert.equal(api.storage.getItem(PATIENTS), 'saved');
  assert.throws(() => api.storage.setItem(PATIENTS, 'x'), { code: 'FAIL' });
  assert.equal(requests[0].channel, 'oras:storage');
  assert.equal(api.send, undefined);
  assert.equal(api.require, undefined);
  assert.equal(Object.isFrozen(api), true);
});

test('Windows build whitelist includes app resources but excludes local patient exports and backups', () => {
  for (const file of ['', '/index.html', '/unlock.js', '/vendor/xlsx.mini.min.js', '/node_modules/better-sqlite3-multiple-ciphers/prebuilds/win32-x64.node']) {
    assert.equal(ignoreUnneeded(file), false, file);
  }
  for (const file of ['/clinic-backup.json', '/secret.orasdb', '/patient.xlsx', '/.git', '/tests', '/vendor/secret.json', '/node_modules/.bin']) {
    assert.equal(ignoreUnneeded(file), true, file);
  }
});

test('Electron Packager filter keeps the native database dependency and offline assets', async () => {
  const root = path.resolve(__dirname, '..');
  const filterModule = pathToFileURL(path.join(root, 'node_modules/@electron/packager/dist/copy-filter.js')).href;
  const { userPathFilter } = await import(filterModule);
  const filter = userPathFilter({dir:root, out:path.join(root,'dist'), prune:true, ignore:ignoreUnneeded});
  for (const file of ['index.html','main.js','preload.js','unlock.html','vendor','vendor/xlsx.mini.min.js',
    'node_modules/better-sqlite3-multiple-ciphers', 'node_modules/node-addon-api',
    'node_modules/better-sqlite3-multiple-ciphers/prebuilds/win32-x64.node']) {
    assert.equal(await filter(path.join(root,file)), true, `Expected ${file} in package`);
  }
  for (const file of ['.git','tests','private-patient-backup.json','node_modules/electron','node_modules/@electron/packager']) {
    assert.equal(await filter(path.join(root,file)), false, `Expected ${file} to be excluded`);
  }
});
