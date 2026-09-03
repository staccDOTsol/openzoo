import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  FEED_TARGETS,
  findAppBundle,
  githubAssetRegex,
  hostKey,
  installDest,
  installedBinary,
  matchGithubAsset,
  resolveGrokBotAsset,
} from '../lib/grokbotFetch.js';
import {
  shimDir,
  shimPath,
  unixShimBody as shimUnix,
  winShimBody,
  writeOpenzooShim,
} from '../lib/openzooPathShim.js';

const ASSETS = [
  { name: 'Grok_Bot_0.36.0_darwin-arm64.zip', browser_download_url: 'https://example/da.zip' },
  { name: 'Grok_Bot_0.36.0_darwin-x64.zip', browser_download_url: 'https://example/dx.zip' },
  { name: 'Grok_Bot_0.36.0_linux-arm64.AppImage', browser_download_url: 'https://example/la.AppImage' },
  { name: 'Grok_Bot_0.36.0_linux-x64.AppImage', browser_download_url: 'https://example/lx.AppImage' },
  { name: 'Grok_Bot_0.36.0_win-arm64.exe', browser_download_url: 'https://example/wa.exe' },
  { name: 'Grok_Bot_0.36.0_win-x64.exe', browser_download_url: 'https://example/wx.exe' },
];

test('hostKey maps platform/arch to feed keys', () => {
  assert.equal(hostKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(hostKey('darwin', 'x64'), 'darwin-x64');
  assert.equal(hostKey('linux', 'arm64'), 'linux-arm64');
  assert.equal(hostKey('linux', 'x64'), 'linux-x64');
  assert.equal(hostKey('win32', 'arm64'), 'win32-arm64');
  assert.equal(hostKey('win32', 'x64'), 'win32-x64');
});

test('machineArch does not follow Rosetta process.arch on Apple Silicon', async () => {
  const { machineArch } = await import('../lib/grokbotFetch.js');
  if (process.platform !== 'darwin') return;
  const a = machineArch('x64');
  // On this Mac hw.optional.arm64 is 1, so even a translated node reports arm64.
  // Intel Macs stay x64.
  assert.ok(a === 'arm64' || a === 'x64');
  if (process.arch === 'x64' && a === 'arm64') {
    assert.equal(hostKey(), 'darwin-arm64');
  }
});

test('resolveGrokBotAsset prefers github grokbot-v* over later grokui tags', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('api.github.com')) {
      return {
        ok: true,
        json: async () => [
          { tag_name: 'grokui-v1.6.21', assets: [] },
          { tag_name: 'grokbot-v0.36.0', assets: ASSETS },
        ],
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const a = await resolveGrokBotAsset('linux-x64', { fetchImpl });
  assert.equal(a.source, 'github');
  assert.equal(a.version, '0.36.0');
  assert.equal(a.name, 'Grok_Bot_0.36.0_linux-x64.AppImage');
});

test('every host key has a feed target and matches the grokbot-v0.36.0 asset names', () => {
  for (const key of Object.keys(FEED_TARGETS)) {
    const hit = matchGithubAsset(ASSETS, key);
    assert.ok(hit, `no asset for ${key}`);
    assert.match(hit.name, githubAssetRegex(key));
  }
});

test('installDest / installedBinary for each OS', () => {
  assert.equal(installDest('/u', 'darwin'), join('/u', 'Applications', 'Grok Bot.app'));
  assert.equal(installedBinary('/u', 'darwin'), join('/u', 'Applications', 'Grok Bot.app', 'Contents', 'MacOS', 'Grok Bot'));
  assert.equal(installDest('/u', 'linux'), join('/u', '.local', 'bin', 'Grok_Bot.AppImage'));
  assert.equal(installedBinary('/u', 'linux'), join('/u', '.local', 'bin', 'Grok_Bot.AppImage'));
  assert.equal(
    installDest('/u', 'win32'),
    join('/u', 'AppData', 'Local', 'Programs', 'Grok Bot', 'Grok Bot.exe'),
  );
});

test('findAppBundle locates a fake .app', () => {
  const root = mkdtempSync(join(tmpdir(), 'oz-app-'));
  try {
    const app = join(root, 'Grok Bot.app', 'Contents', 'MacOS');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'Grok Bot'), 'x');
    assert.equal(findAppBundle(root), join(root, 'Grok Bot.app'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runBot fetches when the binary is missing', () => {
  const cli = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib/grokcli.js'), 'utf8');
  assert.match(cli, /ensureGrokBot/);
  assert.match(cli, /grokbotFetch/);
  assert.match(cli, /tell application "Grok Bot" to quit/);
  assert.doesNotMatch(cli, /if \(process\.platform === 'darwin'\) \{\s*quitGrokBot\(\);/);
});

test('PATH shim bodies exec Electron-as-node', () => {
  const u = shimUnix({ execPath: '/Apps/OpenZoo Bot.app/Contents/MacOS/OpenZoo Bot', openzooJs: '/app/bin/openzoo.js' });
  assert.match(u, /^#!/);
  assert.match(u, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(u, /OpenZoo Bot/);
  const w = winShimBody({ execPath: 'C:\\OpenZoo Bot.exe', openzooJs: 'C:\\openzoo.js' });
  assert.match(w, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(w, /OpenZoo Bot\.exe/);
});

test('writeOpenzooShim creates an executable unix stub', () => {
  const root = mkdtempSync(join(tmpdir(), 'oz-shim-'));
  try {
    const js = join(root, 'openzoo.js');
    writeFileSync(js, '// fake\n');
    const dest = writeOpenzooShim({
      execPath: '/bin/echo',
      openzooJs: js,
      home: root,
      platform: 'darwin',
    });
    assert.equal(dest, shimPath(root, 'darwin'));
    assert.equal(shimDir(root, 'darwin'), join(root, '.local', 'bin'));
    const body = readFileSync(dest, 'utf8');
    assert.match(body, /ELECTRON_RUN_AS_NODE=1/);
    assert.match(body, /openzoo\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('overlay list includes grokbot fetch/shim (packed sidecar would otherwise be npm last week)', () => {
  const after = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'grokui-app/build/afterPack.js'), 'utf8');
  assert.match(after, /lib\/grokbotFetch\.js/);
  assert.match(after, /lib\/openzooPathShim\.js/);
  assert.match(after, /lib\/grokcli\.js/);
  assert.match(after, /exports\.copyNodeModules/);
  assert.match(after, /exports\.signAdHocIfNeeded/);
});
