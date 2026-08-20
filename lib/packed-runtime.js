/**
 * Locate packed Auto runtime bits (node-pty + openzoo-claude) inside a
 * grokui dmg / exe / AppImage — extraResources, app.asar.unpacked,
 * resources/app/node_modules, or a grokui-app checkout.
 *
 * First boot copies these offline into ~/.local. No network npm / npx.
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const CANVAS_PTY_RECIPE = /install node-pty|\bconpty\b|PTY_WINDOWS|--print cannot grow/i;

export function packedResourceRoots({
  env = process.env,
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
  libDir = here,
} = {}) {
  const roots = [];
  const push = (p) => {
    if (p && existsSync(p)) roots.push(path.resolve(p));
  };
  if (env.OZ_PACKED_RESOURCES) push(env.OZ_PACKED_RESOURCES);
  if (resourcesPath) {
    push(resourcesPath);
    push(path.join(resourcesPath, 'app.asar.unpacked'));
    push(path.join(resourcesPath, 'app'));
  }
  const fromExec = resourcesFromExecPath(execPath);
  for (const r of fromExec) push(r);
  // grokui-app/lib (bundled) or repo lib/
  push(path.join(libDir, '..'));
  push(path.join(libDir, '..', 'grokui-app'));
  return [...new Set(roots)];
}

export function resourcesFromExecPath(execPath) {
  if (!execPath) return [];
  const dir = path.dirname(execPath);
  const out = [];
  // Foo.app/Contents/MacOS/Foo → Contents/Resources
  if (/MacOS$/i.test(dir)) {
    const resources = path.join(dir, '..', 'Resources');
    out.push(resources, path.join(resources, 'app'), path.join(resources, 'app.asar.unpacked'));
  }
  // win/linux: next to the binary, resources/ and resources/app
  out.push(path.join(dir, 'resources'));
  out.push(path.join(dir, 'resources', 'app'));
  out.push(path.join(dir, 'resources', 'app.asar.unpacked'));
  out.push(dir);
  return out;
}

function packageDir(root, name) {
  const candidates = [
    path.join(root, name),
    path.join(root, 'node_modules', name),
    path.join(root, 'app.asar.unpacked', 'node_modules', name),
    path.join(root, 'app', 'node_modules', name),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return null;
}

export function findPackedNodePty(opts = {}) {
  for (const root of packedResourceRoots(opts)) {
    const dir = packageDir(root, 'node-pty');
    if (dir) return dir;
  }
  return null;
}

export function findPackedOpenzooClaude(opts = {}) {
  for (const root of packedResourceRoots(opts)) {
    const dir = packageDir(root, 'openzoo-claude');
    if (dir) return dir;
  }
  return null;
}

export function openzooClaudeEntry(pkgDir) {
  if (!pkgDir) return null;
  try {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const bin = pkg.bin;
    const rel = typeof bin === 'string' ? bin : (bin && (bin['openzoo-claude'] || bin.occ || bin.claude));
    if (rel) {
      const abs = path.join(pkgDir, rel);
      if (existsSync(abs)) return abs;
    }
  } catch { /* fall through */ }
  for (const rel of ['v2/src/index.mjs', 'cli.js', 'index.js']) {
    const abs = path.join(pkgDir, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}

export function findNativeAddons(dir) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' && depth > 0) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('.node')) found.push(full);
    }
  };
  if (dir && existsSync(dir)) walk(dir, 0);
  return found;
}

export function hasConptyBackend(dir) {
  if (!dir || !existsSync(dir)) return false;
  let hit = false;
  const walk = (d, depth) => {
    if (hit || depth > 6) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (/conpty/i.test(e.name) || /^OpenConsole\.exe$/i.test(e.name)) {
        hit = true;
        return;
      }
      if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(dir, 0);
  if (hit) return true;
  // node-pty 1.x compiles conpty into the Windows .node — that IS the backend.
  return findNativeAddons(dir).length > 0;
}

export function loadNodePtyFrom(dir) {
  if (!dir) return null;
  try {
    const require = createRequire(import.meta.url);
    const mod = require(dir);
    return mod && typeof mod.spawn === 'function' ? mod : null;
  } catch {
    return null;
  }
}

export function resolvePackedOpenzooClaude(opts = {}) {
  const env = opts.env || process.env;
  if (env.OPENZOO_CLAUDE_PATH_ONLY === '1') return null;
  const pkgDir = findPackedOpenzooClaude(opts);
  const entry = openzooClaudeEntry(pkgDir);
  if (!entry) return null;
  const electron = opts.execPath || process.execPath;
  return {
    command: electron,
    prefixArgs: [entry],
    via: 'packed',
    pkgDir,
    entry,
  };
}
