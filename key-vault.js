'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class KeyVaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KeyVaultError';
    this.code = code;
  }
}

// On Windows Electron's safeStorage uses the current user's DPAPI protection.
// Do not use Linux's optional basic_text backend or any plaintext fallback.
class WindowsKeyVault {
  constructor(filename, safeStorage, platform = process.platform) {
    this.filename = path.resolve(filename);
    this.safeStorage = safeStorage;
    this.platform = platform;
  }
  exists() { return fs.existsSync(this.filename); }
  available() {
    try {
      return this.platform === 'win32' && this.safeStorage?.isEncryptionAvailable() === true;
    } catch { return false; }
  }
  read() {
    if (!this.available()) throw new KeyVaultError('UNAVAILABLE', 'حماية Windows للمفتاح غير متاحة.');
    const stat = fs.statSync(this.filename);
    if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024) {
      throw new KeyVaultError('INVALID_KEY_FILE', 'ملف المفتاح المحمي غير صالح.');
    }
    const secret = this.safeStorage.decryptString(fs.readFileSync(this.filename));
    if (typeof secret !== 'string' || !secret || secret.includes('\0') || Buffer.byteLength(secret, 'utf8') > 4096) {
      throw new KeyVaultError('INVALID_KEY_FILE', 'ملف المفتاح المحمي غير صالح.');
    }
    return secret;
  }
  save(secret) {
    if (!this.available()) throw new KeyVaultError('UNAVAILABLE', 'حماية Windows للمفتاح غير متاحة.');
    if (typeof secret !== 'string' || !secret || secret.includes('\0') || Buffer.byteLength(secret, 'utf8') > 4096) {
      throw new KeyVaultError('INVALID_KEY', 'المفتاح غير صالح.');
    }
    // The old key file is left untouched unless encryption, verification, and
    // writing a complete temporary file have all succeeded.
    const encrypted = this.safeStorage.encryptString(secret);
    if (!Buffer.isBuffer(encrypted) || encrypted.length < 1 || encrypted.length > 64 * 1024 ||
        this.safeStorage.decryptString(encrypted) !== secret) {
      throw new KeyVaultError('PROTECTION_FAILED', 'تعذّر حماية المفتاح باستخدام Windows.');
    }
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temp = path.join(path.dirname(this.filename), `.${path.basename(this.filename)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.filename);
    } catch (err) {
      try { fs.unlinkSync(temp); } catch { /* there may be no temporary file */ }
      throw err;
    }
  }
}

// Never create or replace a database during automatic unlocking. If the key
// exists but the DB is gone, stop rather than silently starting an empty clinic.
function attemptAutomaticUnlock(store, vault) {
  try {
    const keyExists = vault.exists();
    if (!store.exists()) return { opened: false, state: keyExists ? 'DATABASE_MISSING' : 'NEW_DATABASE' };
    if (!keyExists) return { opened: false, state: 'KEY_MISSING' };
    if (!vault.available()) return { opened: false, state: 'UNAVAILABLE' };
    store.open(vault.read(), { mustExist: true });
    return { opened: true, state: 'OPENED' };
  } catch {
    // Leave the database and saved key in place. The unlock page offers the
    // existing passphrase instead of falling back to an unencrypted store.
    return { opened: false, state: 'FAILED' };
  }
}

module.exports = { WindowsKeyVault, KeyVaultError, attemptAutomaticUnlock };
