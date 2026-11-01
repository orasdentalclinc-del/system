'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');

function getElectronPath() {
  try {
    const executable = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim();
    const result = path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronDir, 'dist'), executable);
    return fs.existsSync(result) ? result : null;
  } catch { return null; }
}

function main() {
  let executable = getElectronPath();
  if (!executable) {
    const installer = path.join(electronDir, 'install.js');
    if (!fs.existsSync(installer)) throw new Error('Electron is not installed. Run npm ci --ignore-scripts first.');
    console.log('Installing the official Electron runtime (internet is required the first time)...');
    const install = spawnSync(process.execPath, [installer], { cwd: root, env: process.env, stdio: 'inherit' });
    if (install.error || install.status !== 0) throw new Error('Electron download failed. Check the internet connection and run npm start again.');
    executable = getElectronPath();
    if (!executable) throw new Error('Electron runtime was not installed correctly.');
  }
  const child = spawnSync(executable, ['.'], { cwd: root, stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exitCode = child.status === null ? 1 : child.status;
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { getElectronPath };
