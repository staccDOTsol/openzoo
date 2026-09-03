// Install a PATH shim so `openzoo` works without a system Node.
//
// grokui-app already ran the sidecar with Electron's own binary
// (`ELECTRON_RUN_AS_NODE=1`). That only helps the GUI. A packaged OpenZoo Bot
// also drops `~/.local/bin/openzoo` (Windows: %LOCALAPPDATA%\openzoo\bin)
// pointing at the same Electron + bundled bin/openzoo.js, so the CLI
// (`openzoo claude`, `openzoo balance`, …) works from a Finder/Dock launch
// that has no ~/.zshrc PATH and no npx.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function shimDir(home = homedir(), platform = process.platform) {
  if (platform === 'win32') return join(home, 'AppData', 'Local', 'openzoo', 'bin');
  return join(home, '.local', 'bin');
}

export function shimPath(home = homedir(), platform = process.platform) {
  const name = platform === 'win32' ? 'openzoo.cmd' : 'openzoo';
  return join(shimDir(home, platform), name);
}

export function unixShimBody({ execPath, openzooJs }) {
  return `#!/bin/sh
# Written by OpenZoo Bot. Electron-as-node — no system Node required.
export ELECTRON_RUN_AS_NODE=1
exec ${shellQuote(execPath)} ${shellQuote(openzooJs)} "$@"
`;
}

export function winShimBody({ execPath, openzooJs }) {
  return `@echo off
set ELECTRON_RUN_AS_NODE=1
"${execPath}" "${openzooJs}" %*
`;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function writeOpenzooShim({
  execPath,
  openzooJs,
  home = homedir(),
  platform = process.platform,
} = {}) {
  if (!execPath || !openzooJs) throw new Error('writeOpenzooShim needs execPath + openzooJs');
  if (!existsSync(openzooJs)) throw new Error(`openzoo.js missing: ${openzooJs}`);
  const dir = shimDir(home, platform);
  mkdirSync(dir, { recursive: true });
  const dest = shimPath(home, platform);
  const body = platform === 'win32'
    ? winShimBody({ execPath, openzooJs })
    : unixShimBody({ execPath, openzooJs });
  writeFileSync(dest, body, { encoding: 'utf8' });
  if (platform !== 'win32') chmodSync(dest, 0o755);
  return dest;
}
