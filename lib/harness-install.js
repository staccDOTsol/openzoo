/**
 * First-run / heal installer for grokui Auto.
 *
 * The dmg/exe/AppImage installs `openzoo-claude` itself (npm package ≥2.0.2)
 * using Electron-as-node or a host Node, and leaves `openzoo-claude`, `node`,
 * and `npx` in ~/.local/bin (already searched by claudeCodeBinDirs).
 *
 * Official Anthropic bun `claude` is NOT the Auto path.
 * Pay is OpenZoo subscription Bearer or x402 — never an Anthropic API key.
 * Do not dump an npx recipe as the product path.
 *
 * Idempotent. Does not block grokui listen / window paint — callers `void`
 * this after /threads answers (same rule as :8402).
 */
import { spawn } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCodeBinDirs, OPENZOO_CLAUDE_PACKAGE, resolveClaudeCli } from './launch.js';

export const MIN_OPENZOO_CLAUDE = '2.0.2';
export const OPENZOO_CLAUDE_SPEC = `${OPENZOO_CLAUDE_PACKAGE}@latest`;
export const HARNESS_STATUS = Object.freeze({
  node: 'Installing Node…',
  claude: 'Installing openzoo-claude…',
  ready: 'openzoo-claude is ready',
  skipped: 'openzoo-claude already installed',
});

const DEFAULT_STATE = () => ({
  ready: false,
  installing: false,
  skipped: false,
  step: '',
  message: '',
  error: '',
});

let state = DEFAULT_STATE();
let inflight = null;
let runnerOverride = null;

export function getHarnessState() {
  return { ...state };
}

export function setHarnessStateForTest(next) {
  state = { ...DEFAULT_STATE(), ...(next || {}) };
}

export function setHarnessInstallRunnerForTest(fn) {
  runnerOverride = typeof fn === 'function' ? fn : null;
}

export function shouldSkipHarnessAutostart(env = process.env) {
  return env.OZ_SKIP_HARNESS === '1' || env.OZ_AGENT_PORTS === '0';
}

export function localBinDir(home = os.homedir()) {
  return path.join(home, '.local', 'bin');
}

export function localPrefix(home = os.homedir()) {
  return path.join(home, '.local');
}

function exeName(name, platform = process.platform) {
  if (platform === 'win32' && !/\.\w+$/.test(name)) return `${name}.exe`;
  return name;
}

function whichOnPath(name, env = process.env, extras = [], exists = existsSync) {
  const names = platformNames(name, process.platform);
  const dirs = [...extras, ...String(env.PATH || '').split(path.delimiter)].filter(Boolean);
  for (const dir of dirs) {
    for (const n of names) {
      const f = path.join(dir, n);
      if (exists(f)) return f;
    }
  }
  return null;
}

function platformNames(name, platform = process.platform) {
  if (platform !== 'win32') return [name];
  if (/\.\w+$/.test(name)) return [name];
  return [`${name}.cmd`, `${name}.exe`, name];
}

export function listNvmNodes({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  readDir = readdirSync,
} = {}) {
  const node = exeName('node', platform);
  const bins = [];
  if (platform === 'win32') {
    const nvmHome = env.NVM_HOME
      || path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'nvm');
    const symlink = env.NVM_SYMLINK || path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs');
    bins.push(path.join(symlink, node));
    try {
      for (const d of readDir(nvmHome)) {
        if (/^v?\d+/.test(d)) bins.push(path.join(nvmHome, d, node));
      }
    } catch { /* no nvm */ }
    return bins.filter((p) => exists(p));
  }
  const nvmDir = env.NVM_DIR || path.join(home, '.nvm');
  try {
    const versions = path.join(nvmDir, 'versions', 'node');
    const dirs = readDir(versions).filter((d) => /^v\d+/.test(d))
      .sort((a, b) => parseInt(b.slice(1), 10) - parseInt(a.slice(1), 10));
    const prefer24 = dirs.filter((d) => /^v24\b/.test(d));
    for (const d of [...prefer24, ...dirs]) {
      bins.push(path.join(versions, d, 'bin', node));
    }
  } catch { /* no nvm */ }
  return [...new Set(bins)].filter((p) => exists(p));
}

export function resolveHostNode({
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const node = exeName('node', platform);
  const extras = [localBinDir(home), ...claudeCodeBinDirs(home)];
  const nvm = listNvmNodes({ home, env, platform, exists });
  const hardcoded = platform === 'win32'
    ? []
    : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].filter((p) => exists(p));
  const fromPath = whichOnPath(node, env, extras, exists);
  for (const p of [...nvm, ...hardcoded, fromPath].filter(Boolean)) {
    if (exists(p)) return p;
  }
  return null;
}

export function resolveHostNpx({
  env = process.env,
  home = os.homedir(),
  nodePath = null,
  exists = existsSync,
} = {}) {
  if (nodePath) {
    const sibling = path.join(path.dirname(nodePath), exeName('npx'));
    if (exists(sibling)) return sibling;
    const cmd = path.join(path.dirname(nodePath), 'npx.cmd');
    if (exists(cmd)) return cmd;
  }
  return whichOnPath('npx', env, [localBinDir(home), ...claudeCodeBinDirs(home)], exists);
}

export function resolveNpmCli({
  env = process.env,
  home = os.homedir(),
  nodePath = null,
  exists = existsSync,
} = {}) {
  const npm = whichOnPath('npm', env, [localBinDir(home), ...claudeCodeBinDirs(home)], exists);
  if (npm) return { command: npm, prefixArgs: [] };
  if (nodePath) {
    const sibling = path.join(path.dirname(nodePath), exeName('npm'));
    if (exists(sibling)) return { command: sibling, prefixArgs: [] };
    const cli = path.join(path.dirname(nodePath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (exists(cli)) return { command: nodePath, prefixArgs: [cli] };
  }
  return null;
}

export function detectHarness({
  env = process.env,
  home = os.homedir(),
  exists = existsSync,
  resolveClaude = resolveClaudeCli,
} = {}) {
  const extras = claudeCodeBinDirs(home);
  const pathEnv = {
    ...env,
    PATH: [...new Set([...extras, ...String(env.PATH || '').split(path.delimiter)])].join(path.delimiter),
  };
  const claudePath = resolveClaude(pathEnv);
  const nodePath = resolveHostNode({ env: pathEnv, home, exists });
  const npxPath = resolveHostNpx({ env: pathEnv, home, nodePath, exists });
  const local = localBinDir(home);
  const localClaude = claudePath && claudePath.startsWith(local);
  const localNode = nodePath && nodePath.startsWith(local);
  const localNpx = npxPath && npxPath.startsWith(local);
  const ready = Boolean(claudePath && nodePath && npxPath);
  return {
    claude: Boolean(claudePath),
    claudePath: claudePath || null,
    node: Boolean(nodePath),
    nodePath: nodePath || null,
    npx: Boolean(npxPath),
    npxPath: npxPath || null,
    localClaude: Boolean(localClaude),
    localNode: Boolean(localNode),
    localNpx: Boolean(localNpx),
    ready,
  };
}

export function electronAsNodeSpec(electronPath, extraEnv = {}) {
  return {
    command: electronPath,
    prefixArgs: [],
    env: { ...extraEnv, ELECTRON_RUN_AS_NODE: '1' },
    via: 'electron-as-node',
  };
}

export function writeUnixShim(file, command, extraEnv = {}) {
  const envLines = Object.entries(extraEnv)
    .map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`)
    .join('\n');
  const body = `#!/bin/sh\n${envLines ? `${envLines}\n` : ''}exec ${JSON.stringify(command)} "$@"\n`;
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

export function writeWinShim(file, command, extraEnv = {}) {
  const envLines = Object.entries(extraEnv)
    .map(([k, v]) => `set ${k}=${String(v)}`)
    .join('\r\n');
  const body = `@echo off\r\n${envLines ? `${envLines}\r\n` : ''}"${command}" %*\r\n`;
  writeFileSync(file, body);
  return file;
}

export function linkOrShim(dest, source, { platform = process.platform, extraEnv = {} } = {}) {
  mkdirSync(path.dirname(dest), { recursive: true });
  if (platform !== 'win32' && !Object.keys(extraEnv).length) {
    try {
      symlinkSync(source, dest);
      return dest;
    } catch {
      try { copyFileSync(source, dest); chmodSync(dest, 0o755); return dest; } catch { /* shim */ }
    }
  }
  return platform === 'win32'
    ? writeWinShim(dest, source, extraEnv)
    : writeUnixShim(dest, source, extraEnv);
}

/** Put node + npx on ~/.local/bin so Finder Electron (no nvm PATH) can see them. */
export function ensureLocalNodeNpx({
  home = os.homedir(),
  platform = process.platform,
  nodePath,
  npxPath,
  electronPath,
} = {}) {
  const bin = localBinDir(home);
  mkdirSync(bin, { recursive: true });
  const wrote = [];
  const nodeDest = path.join(bin, exeName('node', platform));
  const npxDest = path.join(bin, platform === 'win32' ? 'npx.cmd' : 'npx');
  if (nodePath) {
    linkOrShim(nodeDest, nodePath, { platform });
    wrote.push(nodeDest);
  } else if (electronPath) {
    const shim = platform === 'win32'
      ? writeWinShim(nodeDest, electronPath, { ELECTRON_RUN_AS_NODE: '1' })
      : writeUnixShim(nodeDest, electronPath, { ELECTRON_RUN_AS_NODE: '1' });
    wrote.push(shim);
  }
  if (npxPath) {
    linkOrShim(npxDest, npxPath, { platform });
    wrote.push(npxDest);
  } else if (electronPath) {
    const extra = { ELECTRON_RUN_AS_NODE: '1' };
    const shim = platform === 'win32'
      ? writeWinShim(npxDest, electronPath, extra)
      : writeUnixShim(npxDest, electronPath, extra);
    wrote.push(shim);
  }
  return { bin, wrote };
}

export function npmInstallArgs(prefix = localPrefix()) {
  return ['install', '-g', OPENZOO_CLAUDE_SPEC, '--prefix', prefix];
}

function runSpawn(command, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...opts,
    });
    let out = '';
    const take = (b) => { out += String(b); if (out.length > 8000) out = out.slice(-8000); };
    if (child.stdout) child.stdout.on('data', take);
    if (child.stderr) child.stderr.on('data', take);
    child.on('error', (e) => resolve({ ok: false, error: e.message, out }));
    child.on('exit', (code) => resolve({ ok: code === 0, code, out }));
  });
}

async function defaultInstall({
  home, env, electronPath, spawnFn = runSpawn,
} = {}) {
  const nodePath = resolveHostNode({ env, home });
  const npxPath = resolveHostNpx({ env, home, nodePath });
  const electron = electronPath
    || (env.ELECTRON_RUN_AS_NODE === '1' ? process.execPath : null)
    || process.execPath;
  ensureLocalNodeNpx({ home, nodePath, npxPath, electronPath: nodePath ? null : electron });

  const prefix = localPrefix(home);
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  const npm = resolveNpmCli({ env, home, nodePath: nodePath || null });
  const runner = nodePath
    ? { command: npm?.command || nodePath, prefixArgs: npm?.prefixArgs || [], env: { ...env } }
    : electronAsNodeSpec(electron, env);
  if (!npm && nodePath) {
    return { ok: false, error: 'npm not found next to node' };
  }
  const command = npm && nodePath ? (npm.command) : runner.command;
  const prefixArgs = npm && nodePath ? npm.prefixArgs : (
    npm ? npm.prefixArgs : []
  );
  const npmCli = npm && !nodePath ? npm : null;
  const args = npmCli && npmCli.command !== command
    ? [...runner.prefixArgs, ...npmCli.prefixArgs, ...npmInstallArgs(prefix)]
    : [...prefixArgs, ...npmInstallArgs(prefix)];
  const runEnv = {
    ...(npm && nodePath ? env : runner.env || env),
    PATH: [localBinDir(home), ...claudeCodeBinDirs(home), String(env.PATH || '')].join(path.delimiter),
  };
  const result = await spawnFn(command, args, { env: runEnv });
  if (!result.ok) return result;
  const again = detectHarness({ env: runEnv, home });
  if (!again.claude) return { ok: false, error: 'openzoo-claude missing after npm install', out: result.out };
  ensureLocalNodeNpx({
    home,
    nodePath: again.nodePath || nodePath,
    npxPath: again.npxPath || npxPath,
    electronPath: again.nodePath ? null : electron,
  });
  return { ok: true, via: nodePath ? 'node' : 'electron-as-node', ...again };
}

export async function ensureHarness(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  if (!opts.force && shouldSkipHarnessAutostart(env)) {
    state = { ...DEFAULT_STATE(), skipped: true, message: HARNESS_STATUS.skipped };
    return { skipped: true, ...state };
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const already = detectHarness({ env, home, resolveClaude: opts.resolveClaude });
      if (already.ready && already.localClaude) {
        state = { ...DEFAULT_STATE(), ready: true, skipped: true, message: HARNESS_STATUS.skipped };
        return { skipped: true, ready: true, ...already };
      }
      state = { ...DEFAULT_STATE(), installing: true, step: 'claude', message: HARNESS_STATUS.claude };
      const run = runnerOverride || defaultInstall;
      const result = await run({
        home, env, electronPath: opts.electronPath, spawnFn: opts.spawnFn,
      });
      const after = detectHarness({ env, home, resolveClaude: opts.resolveClaude });
      const ok = Boolean(result?.ok || after.claude);
      state = {
        ...DEFAULT_STATE(),
        ready: ok && after.ready,
        message: ok ? HARNESS_STATUS.ready : (result?.error || 'install failed'),
        error: ok ? '' : (result?.error || result?.out || ''),
      };
      return { ok, skipped: false, ...after, ...result, ...state };
    } catch (e) {
      state = { ...DEFAULT_STATE(), error: e.message || String(e) };
      return { ok: false, error: state.error };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function harnessStatusLine() {
  if (state.installing) return state.message || HARNESS_STATUS.claude;
  if (state.ready) return HARNESS_STATUS.ready;
  return state.message || '';
}
