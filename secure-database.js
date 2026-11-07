'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3-multiple-ciphers');

// These keys contain the clinic's collections. Migration is permitted only
// before any of them has been saved in the encrypted database.
const CLINICAL_KEYS = Object.freeze([
  'oras-dental-patients-v3', 'oras-dental-visits-v3',
  'oras-dental-procedures-v1', 'oras-dental-pricing-v1', 'oras-dental-lists-v1',
  'oras-dental-expenses-v1', 'oras-dental-inv-v1', 'oras-dental-labs-v1',
  'oras-dental-monthly-reports-v1', 'oras-dental-report-narratives-v1',
  'oras-dental-treatment-plans-v1', 'oras-dental-admin-v1',
  'oras-dental-data-v1'
]);
const MIGRATION_KEY = 'oras-dental-legacy-migrated-v1';
const MAX_VALUE_BYTES = 64 * 1024 * 1024;
const MAX_BATCH_BYTES = 128 * 1024 * 1024;

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function validateKey(key) {
  // The suffix also accommodates the app's preserved *.corrupt.TIMESTAMP keys.
  if (typeof key !== 'string' || !/^oras-dental-[a-z0-9][a-z0-9.-]{0,127}$/.test(key)) {
    throw new StoreError('INVALID_KEY', 'مفتاح التخزين غير صالح.');
  }
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 100) {
    throw new StoreError('INVALID_DATA', 'بيانات الحفظ غير صالحة.');
  }
  let total = 0;
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new StoreError('INVALID_DATA', 'بيانات الحفظ غير صالحة.');
    validateKey(entry.key);
    if (seen.has(entry.key)) throw new StoreError('INVALID_DATA', 'مفاتيح الحفظ مكررة.');
    seen.add(entry.key);
    if (entry.value !== null && typeof entry.value !== 'string') {
      throw new StoreError('INVALID_DATA', 'قيمة الحفظ غير صالحة.');
    }
    const size = entry.value === null ? 0 : Buffer.byteLength(entry.value, 'utf8');
    total += size;
    if (size > MAX_VALUE_BYTES || total > MAX_BATCH_BYTES) {
      throw new StoreError('TOO_LARGE', 'حجم البيانات يتجاوز حد الحفظ.');
    }
  }
}

function validatePassphrase(passphrase, creating) {
  if (typeof passphrase !== 'string' || passphrase.length === 0 ||
      passphrase.includes('\0') || Buffer.byteLength(passphrase, 'utf8') > 4096) {
    throw new StoreError('INVALID_PASSPHRASE', 'أدخل عبارة مرور صالحة.');
  }
  if (creating && Array.from(passphrase.trim()).length < 12) {
    throw new StoreError('WEAK_PASSPHRASE', 'اختر عبارة مرور من 12 حرفاً على الأقل.');
  }
}

class EncryptedStore {
  constructor(filename) {
    this.filename = path.resolve(filename);
    this.db = null;
  }

  exists() {
    return fs.existsSync(this.filename);
  }

  open(passphrase, { mustExist = false } = {}) {
    if (this.db) throw new StoreError('ALREADY_OPEN', 'قاعدة البيانات مفتوحة بالفعل.');
    const creating = !this.exists();
    if (mustExist && creating) {
      throw new StoreError('DATABASE_MISSING', 'ملف قاعدة البيانات مفقود. لم تُنشأ قاعدة جديدة؛ استعد البيانات أولاً.');
    }
    validatePassphrase(passphrase, creating);
    let db;
    let created = false;
    try {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      if (creating) {
        // Never replace an existing file, even if another process created it.
        const fd = fs.openSync(this.filename, 'wx', 0o600);
        fs.closeSync(fd);
        created = true;
      }
      db = new Database(this.filename, { fileMustExist: true, timeout: 5000 });
      // SQLite3MultipleCiphers' SQLCipher 4 compatibility mode. The key is
      // passed as bytes, not interpolated into SQL or stored in the database.
      db.pragma("cipher='sqlcipher'");
      db.pragma('legacy=4');
      const key = Buffer.from(passphrase, 'utf8');
      try { db.key(key, key.length); } finally { key.fill(0); }

      // This reads the encrypted schema and rejects a wrong password/corruption
      // before any DDL or writes are attempted on an existing file.
      try {
        db.prepare('SELECT count(*) AS count FROM sqlite_master').get();
      } catch (err) {
        if (!creating && /^SQLITE_(NOTADB|CORRUPT)/.test(err.code || '')) {
          throw new StoreError('WRONG_KEY_OR_CORRUPT', 'عبارة المرور غير صحيحة أو ملف قاعدة البيانات تالف. لم يُغيَّر الملف.');
        }
        throw err;
      }

      if (creating) {
        db.transaction(() => {
          db.exec('CREATE TABLE clinic_storage (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) WITHOUT ROWID');
          db.pragma('user_version = 1');
        })();
      } else {
        const schema = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clinic_storage'").get();
        if (!schema || db.pragma('user_version', { simple: true }) !== 1) {
          throw new StoreError('WRONG_DATABASE', 'الملف ليس قاعدة بيانات أوراس المدعومة. لم يُغيَّر الملف.');
        }
        // Check the expected columns before allowing writes to an existing DB.
        const columns = db.pragma('table_info(clinic_storage)').map(row => row.name);
        if (columns.length !== 2 || columns[0] !== 'key' || columns[1] !== 'value') {
          throw new StoreError('WRONG_DATABASE', 'بنية قاعدة البيانات غير مدعومة. لم يُغيَّر الملف.');
        }
      }

      // DELETE mode plus single-instance/synchronous access makes an encrypted
      // file copy a consistent backup between transactions (no WAL to omit).
      const mode = db.pragma('journal_mode = DELETE', { simple: true });
      if (String(mode).toLowerCase() !== 'delete') throw new StoreError('JOURNAL_MODE', 'تعذّر تهيئة التخزين الآمن.');
      db.pragma('synchronous = FULL');
      db.pragma('temp_store = MEMORY');
      db.pragma('secure_delete = ON');
      this.db = db;
      return { created: creating };
    } catch (err) {
      try { db?.close(); } catch { /* leave any files intact for recovery */ }
      // Only remove a file this call created if it is still empty. Never
      // discard an existing or partially initialized database automatically.
      if (created) {
        try { if (fs.statSync(this.filename).size === 0) fs.unlinkSync(this.filename); } catch { /* keep it */ }
      }
      throw err;
    }
  }

  requireOpen() {
    if (!this.db) throw new StoreError('LOCKED', 'قاعدة البيانات مقفلة.');
    return this.db;
  }

  getItem(key) {
    validateKey(key);
    const row = this.requireOpen().prepare('SELECT value FROM clinic_storage WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMany(entries) {
    validateEntries(entries); // Validate the complete batch before changing anything.
    const db = this.requireOpen();
    const put = db.prepare('INSERT INTO clinic_storage(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    const remove = db.prepare('DELETE FROM clinic_storage WHERE key = ?');
    db.transaction(() => {
      for (const { key, value } of entries) value === null ? remove.run(key) : put.run(key, value);
    }).immediate();
  }

  setItem(key, value) { this.setMany([{ key, value }]); }
  removeItem(key) { this.setMany([{ key, value: null }]); }

  importLegacy(entries) {
    validateEntries(entries);
    if (entries.length === 0) {
      throw new StoreError('NO_LEGACY_DATA', 'لم يتم العثور على بيانات قديمة للنقل.');
    }
    if (entries.some(({ value }) => value === null) || entries.some(({ key }) => key === MIGRATION_KEY)) {
      throw new StoreError('INVALID_DATA', 'بيانات النقل غير صالحة.');
    }
    const db = this.requireOpen();
    const existing = db.prepare(`SELECT count(*) AS count FROM clinic_storage WHERE key IN (${CLINICAL_KEYS.map(() => '?').join(',')})`);
    const putMissing = db.prepare('INSERT OR IGNORE INTO clinic_storage(key, value) VALUES (?, ?)');
    db.transaction(() => {
      if (existing.get(...CLINICAL_KEYS).count !== 0 || this.getItem(MIGRATION_KEY) !== null) {
        throw new StoreError('DATABASE_NOT_EMPTY', 'توجد بيانات محفوظة بالفعل في القاعدة المشفّرة؛ لن نستبدلها بالنقل التلقائي.');
      }
      for (const { key, value } of entries) putMissing.run(key, value);
      putMissing.run(MIGRATION_KEY, new Date().toISOString());
    }).immediate();
    return entries.length;
  }

  copyEncryptedTo(destination) {
    this.requireOpen();
    if (typeof destination !== 'string' || !destination) throw new StoreError('INVALID_PATH', 'مسار النسخة غير صالح.');
    const dest = path.resolve(destination);
    let sameFile = dest === this.filename;
    if (!sameFile && fs.existsSync(dest)) {
      const sourceStat = fs.statSync(this.filename);
      const destStat = fs.statSync(dest);
      sameFile = fs.realpathSync(dest) === fs.realpathSync(this.filename) ||
        (sourceStat.ino !== 0 && sourceStat.ino === destStat.ino && sourceStat.dev === destStat.dev);
    }
    if (sameFile) throw new StoreError('INVALID_PATH', 'اختر ملفاً مختلفاً عن قاعدة البيانات الحالية.');
    const temp = path.join(path.dirname(dest), `.${path.basename(dest)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      // All DB operations in the main process are synchronous, no other app
      // instance is allowed, and DELETE mode leaves no uncheckpointed WAL.
      fs.copyFileSync(this.filename, temp, fs.constants.COPYFILE_EXCL);
      // FlushFileBuffers on Windows requires a handle with write access.
      const fd = fs.openSync(temp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, dest);
    } catch (err) {
      try { fs.unlinkSync(temp); } catch { /* no temporary file */ }
      throw err;
    }
  }

  close() {
    if (this.db) {
      const db = this.db;
      this.db = null;
      db.close();
    }
  }
}

module.exports = { EncryptedStore, StoreError, CLINICAL_KEYS, MIGRATION_KEY };
