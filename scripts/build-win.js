'use strict';

// Build the existing Electron application and its web assets together. The
// SQLCipher-compatible native dependency ships Windows x64 N-API binaries.
const fs = require('node:fs');
const path = require('node:path');

const appFiles = new Set([
  'package.json', 'main.js', 'preload.js', 'electron-ipc.js', 'secure-database.js', 'key-vault.js',
  'index.html', 'unlock.html', 'unlock.js', 'icon.ico', 'vendor', 'node_modules'
]);
const vendorFiles = new Set([
  'html2canvas.min.js', 'html2canvas-LICENSE.txt', 'jspdf.umd.min.js',
  'jspdf-LICENSE.txt', 'xlsx.mini.min.js', 'xlsx-LICENSE.txt'
]);
function ignoreUnneeded(file) {
  // Packager passes paths relative to dir with a leading slash. Whitelisting
  // avoids accidentally bundling clinic exports or database backups from the
  // source folder; production node_modules are further pruned by packager.
  const relative = file.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relative) return false;
  const parts = relative.split('/');
  if (!appFiles.has(parts[0])) return true;
  if (parts[0] === 'vendor' && parts.length > 1) return parts.length !== 2 || !vendorFiles.has(parts[1]);
  if (parts[0] === 'node_modules' && parts[1] === '.bin') return true;
  return false;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  for (const name of ['index.html', 'unlock.html', 'unlock.js', 'main.js', 'preload.js', 'electron-ipc.js', 'secure-database.js',
    'key-vault.js', 'vendor/html2canvas.min.js', 'vendor/jspdf.umd.min.js', 'vendor/xlsx.mini.min.js',
    'node_modules/better-sqlite3-multiple-ciphers/prebuilds/win32-x64.node']) {
    if (!fs.existsSync(path.join(root, name))) throw new Error(`Missing required file: ${name}. Run npm ci in the complete project.`);
  }
  const { packager } = await import('@electron/packager');
  const options = {
    dir: root,
    name: 'OrasDentalClinic',
    platform: 'win32',
    arch: 'x64',
    out: path.join(root, 'dist'),
    overwrite: true,
    prune: true,
    asar: false,
    ignore: ignoreUnneeded
  };
  const icon = path.join(root, 'icon.ico');
  if (fs.existsSync(icon)) options.icon = icon;
  else console.warn('icon.ico is not present; the default Electron icon will be used.');
  const paths = await packager(options);
  console.log(`\nWindows application: ${paths[0]}\nKeep the entire output folder with the EXE.`);
}

if (require.main === module) main().catch(err => {
  console.error(`Windows build failed: ${err.message}`);
  process.exitCode = 1;
});
module.exports = { ignoreUnneeded };
