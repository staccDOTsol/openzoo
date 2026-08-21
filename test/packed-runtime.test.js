import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  findPackedNodePty, findPackedOpenzooClaude, hasConptyBackend,
  loadNodePtyFrom, packedResourceRoots, resourcesFromExecPath,
} from '../lib/packed-runtime.js';

function nsisTree() {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-nsis-pack-'));
  const exe = path.join(dir, 'openzoo.exe');
  const resources = path.join(dir, 'resources');
  const pty = path.join(resources, 'node-pty');
  mkdirSync(path.join(pty, 'lib'), { recursive: true });
  mkdirSync(path.join(pty, 'build', 'Release'), { recursive: true });
  mkdirSync(path.join(pty, 'conpty'), { recursive: true });
  writeFileSync(exe, '');
  writeFileSync(path.join(pty, 'package.json'), JSON.stringify({
    name: 'node-pty', version: '1.1.0', main: 'lib/index.js',
  }));
  writeFileSync(path.join(pty, 'lib', 'index.js'), 'exports.spawn = () => ({});\n');
  writeFileSync(path.join(pty, 'build', 'Release', 'pty.node'), Buffer.from([0]));
  writeFileSync(path.join(pty, 'conpty', 'OpenConsole.exe'), '');
  const claude = path.join(resources, 'openzoo-claude');
  mkdirSync(path.join(claude, 'v2', 'src'), { recursive: true });
  writeFileSync(path.join(claude, 'package.json'), JSON.stringify({
    name: 'openzoo-claude', version: '2.0.2',
    bin: { 'openzoo-claude': 'v2/src/index.mjs' },
  }));
  writeFileSync(path.join(claude, 'v2', 'src', 'index.mjs'), 'export {}\n');
  return { dir, exe, resources, pty, claude };
}

test('resourcesFromExecPath includes NSIS extraResources next to the exe', () => {
  const roots = resourcesFromExecPath('C:\\\\Users\\\\stacc\\\\AppData\\\\Local\\\\Programs\\\\openzoo\\\\openzoo.exe');
  assert.ok(roots.some((r) => /resources$/.test(r)));
  assert.ok(roots.some((r) => /resources[/\\]app$/.test(r)));
});

test('findPackedNodePty loads node-pty from NSIS extraResources tree', () => {
  const { dir, exe, resources, pty } = nsisTree();
  try {
    const found = findPackedNodePty({
      execPath: exe,
      resourcesPath: resources,
      env: { HOME: path.join(dir, 'no-home'), OZ_PACKED_RESOURCES: resources },
      libDir: path.join(dir, 'no-lib'),
    });
    assert.equal(found, pty);
    assert.equal(hasConptyBackend(pty), true);
    const mod = loadNodePtyFrom(pty);
    assert.equal(typeof mod.spawn, 'function');
    const claude = findPackedOpenzooClaude({
      execPath: exe,
      resourcesPath: resources,
      env: { HOME: path.join(dir, 'no-home'), OZ_PACKED_RESOURCES: resources },
      libDir: path.join(dir, 'no-lib'),
    });
    assert.ok(claude);
    assert.match(claude, /openzoo-claude$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findPackedNodePty finds first-boot ~/.openzoo/packed copy', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-packed-home-'));
  try {
    const pty = path.join(dir, '.openzoo', 'packed', 'node-pty');
    mkdirSync(path.join(pty, 'build', 'Release'), { recursive: true });
    writeFileSync(path.join(pty, 'package.json'), JSON.stringify({
      name: 'node-pty', version: '1.1.0', main: 'lib/index.js',
    }));
    writeFileSync(path.join(pty, 'build', 'Release', 'pty.node'), Buffer.from([1]));
    const found = findPackedNodePty({
      execPath: path.join(dir, 'missing-exe'),
      resourcesPath: path.join(dir, 'missing-resources'),
      env: { HOME: dir, USERPROFILE: dir },
      libDir: path.join(dir, 'no-lib'),
    });
    assert.equal(found, pty);
    assert.equal(hasConptyBackend(pty), true);
    const roots = packedResourceRoots({
      env: { HOME: dir, USERPROFILE: dir },
      resourcesPath: path.join(dir, 'missing-resources'),
      execPath: path.join(dir, 'missing-exe'),
      libDir: path.join(dir, 'no-lib'),
    });
    assert.ok(roots.includes(path.join(dir, '.openzoo', 'packed')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasConptyBackend is true for a Windows .node without OpenConsole.exe', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-pty-node-'));
  try {
    mkdirSync(path.join(dir, 'build', 'Release'), { recursive: true });
    writeFileSync(path.join(dir, 'build', 'Release', 'conpty.node'), Buffer.from([0]));
    assert.equal(hasConptyBackend(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
