// Fetch + install the official Grok Bot binary for this platform/arch.
//
// Source order:
//   1. GitHub release grokbot-v* on staccDOTsol/openzoo (our multiarch re-host)
//   2. Vendor feed api2.cursor.sh/updates/.../sand (same as scripts/release-grokbot.sh)
//
// A Finder-launched OpenZoo Bot.app has no npx and no Node on PATH. This is
// the grokui sidecar trick applied to the vendor Grok Bot: download the
// matching Grok_Bot_<ver>_<plat>-<arch> artifact, unpack it, then `openzoo bot`
// can spawn it. GROKBOT_NO_FETCH=1 skips the network (tests / airgap).

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const GROKBOT_GITHUB_REPO = 'staccDOTsol/openzoo';

export const FEED_TARGETS = {
  'darwin-arm64': { feed: 'darwin-arm64', plat: 'darwin-arm64', ext: 'zip' },
  'darwin-x64': { feed: 'darwin-x64', plat: 'darwin-x64', ext: 'zip' },
  'linux-arm64': { feed: 'linux-arm64', plat: 'linux-arm64', ext: 'AppImage' },
  'linux-x64': { feed: 'linux-x64', plat: 'linux-x64', ext: 'AppImage' },
  'win32-arm64': { feed: 'win32-arm64-user', plat: 'win-arm64', ext: 'exe' },
  'win32-x64': { feed: 'win32-x64-user', plat: 'win-x64', ext: 'exe' },
};

export function machineArch(arch = process.arch) {
  // nvm's default node on this Mac is x86_64 under Rosetta. Grok Bot is a
  // native app — fetching darwin-x64 because process.arch is x64 would ship
  // the Intel build onto Apple Silicon. hw.optional.arm64 is 1 on M-series
  // even when the current process is translated.
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('sysctl', ['-n', 'hw.optional.arm64'], {
        encoding: 'utf8',
        timeout: 2000,
      }).trim();
      if (out === '1') return 'arm64';
    } catch { /* Intel Mac, or sysctl blocked */ }
  }
  return arch === 'arm64' ? 'arm64' : 'x64';
}

export function hostKey(platform = process.platform, arch = machineArch()) {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'linux') return `linux-${a}`;
  if (platform === 'win32') return `win32-${a}`;
  return `darwin-${a}`;
}

export function githubAssetRegex(key) {
  const t = FEED_TARGETS[key];
  if (!t) return null;
  const plat = t.plat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^Grok_Bot_.+_${plat}\\.${t.ext}$`, 'i');
}

export function matchGithubAsset(assets, key) {
  const re = githubAssetRegex(key);
  if (!re || !Array.isArray(assets)) return null;
  return assets.find((a) => a && re.test(String(a.name || ''))) || null;
}

export function installDest(home = homedir(), platform = process.platform) {
  if (platform === 'linux') return join(home, '.local', 'bin', 'Grok_Bot.AppImage');
  if (platform === 'win32') {
    return join(home, 'AppData', 'Local', 'Programs', 'Grok Bot', 'Grok Bot.exe');
  }
  return join(home, 'Applications', 'Grok Bot.app');
}

export function installedBinary(home = homedir(), platform = process.platform) {
  const dest = installDest(home, platform);
  if (platform === 'darwin') return join(dest, 'Contents', 'MacOS', 'Grok Bot');
  return dest;
}

export function distDir(home = homedir()) {
  return join(home, '.openzoo', 'grokbot-dist');
}

export function findAppBundle(dir, depth = 0) {
  if (!dir || !existsSync(dir) || depth > 4) return null;
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  for (const name of entries) {
    const p = join(dir, name);
    if (/\.app$/i.test(name) && existsSync(join(p, 'Contents', 'MacOS'))) return p;
    try {
      if (statSync(p).isDirectory() && name !== 'Contents' && name !== 'node_modules') {
        const hit = findAppBundle(p, depth + 1);
        if (hit) return hit;
      }
    } catch { /* skip */ }
  }
  return null;
}

function uaHeaders() {
  return { 'User-Agent': 'openzoo-bot', Accept: 'application/vnd.github+json' };
}

export async function githubGrokbotRelease({ fetchImpl = fetch, repo = GROKBOT_GITHUB_REPO } = {}) {
  const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=40`, {
    headers: uaHeaders(),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`github releases ${r.status}`);
  const list = await r.json();
  if (!Array.isArray(list)) throw new Error('github releases: not a list');
  const hit = list.find((x) => x && typeof x.tag_name === 'string' && /^grokbot-v/.test(x.tag_name));
  if (!hit) throw new Error('no grokbot-v* GitHub release');
  return hit;
}

export async function vendorFeedAsset(key, { fetchImpl = fetch } = {}) {
  const t = FEED_TARGETS[key];
  if (!t) throw new Error(`unknown host key ${key}`);
  const machine = process.env.GROKBOT_MACHINE_ID || '11111111-2222-3333-4444-555555555555';
  const base = process.env.GROKBOT_BASE_VERSION || '0.30.0';
  const url = `https://api2.cursor.sh/updates/api/update/${t.feed}/sand/${base}/${machine}/stable`;
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`vendor feed ${r.status}`);
  const j = await r.json();
  const version = j.version || j.name || j.productVersion;
  let fileUrl = j.url;
  if (typeof fileUrl === 'string' && /\/linux\//.test(fileUrl) && version) {
    fileUrl = `${fileUrl.replace(/\/[^/]+$/, '')}/Grok_Bot_${version}.AppImage`;
  }
  if (!version || !fileUrl) throw new Error(`vendor feed missing url/version for ${key}`);
  return { version: String(version), url: fileUrl, name: `Grok_Bot_${version}_${t.plat}.${t.ext}`, source: 'vendor' };
}

export async function resolveGrokBotAsset(key, { fetchImpl = fetch, repo = GROKBOT_GITHUB_REPO } = {}) {
  if (!FEED_TARGETS[key]) throw new Error(`unknown host key ${key}`);
  try {
    const rel = await githubGrokbotRelease({ fetchImpl, repo });
    const asset = matchGithubAsset(rel.assets || [], key);
    if (asset && asset.browser_download_url) {
      const version = String(rel.tag_name || '').replace(/^grokbot-v/, '') || 'unknown';
      return {
        version,
        url: asset.browser_download_url,
        name: asset.name,
        source: 'github',
        tag: rel.tag_name,
      };
    }
  } catch { /* fall through to vendor */ }
  return vendorFeedAsset(key, { fetchImpl });
}

async function downloadTo(url, dest, { fetchImpl = fetch, log = () => {} } = {}) {
  mkdirSync(dirname(dest), { recursive: true });
  const r = await fetchImpl(url, {
    headers: uaHeaders(),
    redirect: 'follow',
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!r.ok) throw new Error(`download ${r.status} ${url}`);
  const total = Number(r.headers.get('content-length') || 0);
  log(`openzoo: downloading Grok Bot${total ? ` (${Math.round(total / 1024 / 1024)} MB)` : ''}…`);
  if (!r.body) throw new Error('download: empty body');
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
  const sz = statSync(dest).size;
  if (sz < 50 * 1024 * 1024) throw new Error(`download too small (${sz} bytes) — ${url}`);
  log(`openzoo: downloaded ${Math.round(sz / 1024 / 1024)} MB -> ${dest}`);
  return dest;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 120000, stdio: opts.stdio || 'pipe' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  return r;
}

export function installGrokBotArtifact({ archivePath, key, home = homedir(), log = () => {} }) {
  const platform = key.startsWith('linux') ? 'linux' : key.startsWith('win32') ? 'win32' : 'darwin';
  const dest = installDest(home, platform);
  mkdirSync(dirname(dest), { recursive: true });

  if (platform === 'darwin') {
    const tmp = join(distDir(home), 'extract');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    run('unzip', ['-o', archivePath, '-d', tmp]);
    const app = findAppBundle(tmp);
    if (!app) throw new Error(`zip has no Grok Bot.app: ${archivePath}`);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(app, dest, { recursive: true });
    const bin = join(dest, 'Contents', 'MacOS', 'Grok Bot');
    if (!existsSync(bin)) throw new Error(`installed app missing binary: ${bin}`);
    log(`openzoo: installed Grok Bot.app -> ${dest}`);
    return bin;
  }

  if (platform === 'linux') {
    copyFileSync(archivePath, dest);
    chmodSync(dest, 0o755);
    log(`openzoo: installed AppImage -> ${dest}`);
    return dest;
  }

  // NSIS user installer (vendor + our re-host). /S is silent; the default
  // dest is %LOCALAPPDATA%\Programs\Grok Bot\Grok Bot.exe.
  log('openzoo: running Grok Bot installer (silent)');
  run(archivePath, ['/S'], { timeout: 300000, stdio: 'ignore' });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (existsSync(dest)) return dest;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (!existsSync(dest)) {
    throw new Error(`installer finished but ${dest} is missing — run ${archivePath} yourself`);
  }
  return dest;
}

export async function ensureGrokBot({
  existing,
  platform = process.platform,
  arch = machineArch(),
  home = homedir(),
  fetchImpl = fetch,
  log = (m) => console.error(m),
} = {}) {
  if (existing && existsSync(existing)) return existing;
  if (process.env.GROKBOT_NO_FETCH === '1') {
    throw new Error('Grok Bot missing and GROKBOT_NO_FETCH=1');
  }
  const key = hostKey(platform, arch);
  const asset = await resolveGrokBotAsset(key, { fetchImpl });
  log(`openzoo: Grok Bot ${asset.version} from ${asset.source} (${asset.name})`);
  const destFile = join(distDir(home), asset.name);
  if (!existsSync(destFile) || statSync(destFile).size < 50 * 1024 * 1024) {
    await downloadTo(asset.url, destFile, { fetchImpl, log });
  } else {
    log(`openzoo: using cached ${destFile}`);
  }
  return installGrokBotArtifact({ archivePath: destFile, key, home, log });
}
