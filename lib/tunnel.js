/**
 * `npx openzoo tunnel` — make the local paying proxy reachable from a CLOUD-run
 * harness.
 *
 * WHY THIS EXISTS: IDEs that execute model calls from their own servers cannot
 * dial your laptop. Pointing one at http://localhost:8402 returns, verbatim:
 *   "Provider returned error: Access to private networks is forbidden"
 * The payment path is fine — the harness just can't reach it. A tunnel gives
 * that harness a public HTTPS URL while your keys stay on this machine.
 *
 * SELF-PROVISIONING: we do not ask you to install anything. If `cloudflared`
 * isn't on PATH we fetch the single static binary for this platform into
 * ~/.openzoo/bin and cache it. Quick tunnels need no Cloudflare account.
 *
 * SECURITY IS THE DESIGN. A public URL in front of a wallet is a public URL in
 * front of your money, so tunnel mode is the ONE mode where the api key is real:
 *   - a random bearer token is minted per session and REQUIRED (401 otherwise),
 *     checked before anything is forwarded, quoted, or paid;
 *   - caps are OPT-IN (user directive: no maximums by default) — set
 *     OPENZOO_MAX_USD_PER_CALL and/or OPENZOO_TUNNEL_MAX_USD to add them;
 *   - every tunnel-served request is logged with its running spend.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const BIN_DIR = path.join(os.homedir(), '.openzoo', 'bin');

/** cloudflared publishes one static binary per platform; pick ours. */
function cloudflaredAsset() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin') return { name: 'cloudflared-darwin-amd64.tgz', tgz: true };
  if (p === 'linux') {
    const arch = a === 'arm64' ? 'arm64' : a === 'arm' ? 'arm' : 'amd64';
    return { name: `cloudflared-linux-${arch}`, tgz: false };
  }
  if (p === 'win32') return { name: 'cloudflared-windows-amd64.exe', tgz: false };
  return null;
}

function onPath(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const f = path.join(d, bin);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Return a usable cloudflared path, downloading it if needed. Order: PATH, our
 * cache, then the official GitHub release. macOS ships a .tgz; the others are
 * bare binaries.
 */
export async function ensureCloudflared(log = console.log) {
  const found = onPath(process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (found) return found;

  const cached = path.join(BIN_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  try { fs.accessSync(cached, fs.constants.X_OK); return cached; } catch { /* fetch it */ }

  const asset = cloudflaredAsset();
  if (!asset) throw new Error(`no cloudflared build for ${process.platform}/${process.arch} — install it manually and re-run`);

  fs.mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.name}`;
  log(`fetching cloudflared for ${process.platform}/${process.arch} (one-time, ~35MB)...`);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`cloudflared download failed: HTTP ${r.status}`);

  if (asset.tgz) {
    const tgz = path.join(BIN_DIR, 'cloudflared.tgz');
    await pipeline(Readable.fromWeb(r.body), createWriteStream(tgz));
    await new Promise((resolve, reject) => {
      const t = spawn('tar', ['xzf', tgz, '-C', BIN_DIR], { stdio: 'ignore' });
      t.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exited ${c}`))));
      t.on('error', reject);
    });
    fs.rmSync(tgz, { force: true });
  } else {
    await pipeline(Readable.fromWeb(r.body), createWriteStream(cached));
  }
  fs.chmodSync(cached, 0o755);
  log(`cloudflared cached at ${cached}`);
  return cached;
}

/**
 * Kill cloudflared processes left over from previous runs against OUR port.
 *
 * WHY: the proxy exits with its terminal but cloudflared does not always go with
 * it, so repeated `openzoo cursor` runs stack tunnels. Observed: two orphaned
 * cloudflared processes, the editor configured with a third hostname, and every
 * request answering 530/1033 — the editor was pointed at a tunnel whose origin
 * had died while other live tunnels sat there serving nothing.
 */
function killStaleTunnels(port, log) {
  try {
    const out = execFileSync('pgrep', ['-f', `cloudflared tunnel --url http://localhost:${port}`], { encoding: 'utf8' });
    const pids = out.split('\n').map((x) => x.trim()).filter(Boolean).filter((x) => Number(x) !== process.pid);
    for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ } }
    if (pids.length) log(`tunnel: cleared ${pids.length} stale cloudflared process(es) from an earlier run`);
  } catch { /* pgrep exits non-zero when nothing matches — that is the good case */ }
}

/** Start a quick tunnel to localhost:<port>; resolve with its public URL. */
export function startCloudflared(bin, port, log) {
  killStaleTunnels(port, log);
  return new Promise((resolve, reject) => {
    // --edge-ip-version 4: cloudflared prefers IPv6+QUIC to reach the edge
    // whenever the interface merely HAS an IPv6 address — it never checks the
    // route works. MEASURED here (address present, no route):
    //   failed to dial to edge with quic: write udp6 [::]->[2606:4700:a8::1]:7844:
    //   sendmsg: no route to host
    // ...every retry, so the tunnel registered then died and the edge served
    // 502/530 — which reads exactly like a dead origin or a rate limit, and is
    // neither. Forcing v4 registered first try on the same machine.
    const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate', '--edge-ip-version', '4'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const scan = (buf) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(buf.toString());
      if (m && !settled) { settled = true; resolve({ url: m[0], proc }); }
    };
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan); // cloudflared prints the URL on stderr
    proc.on('error', reject);
    proc.on('exit', (c) => { if (!settled) reject(new Error(`cloudflared exited ${c} before printing a URL`)); });
    setTimeout(() => { if (!settled) reject(new Error('cloudflared did not produce a URL in 60s')); }, 60000);
  });
}

export function mintToken() {
  return process.env.OPENZOO_TUNNEL_TOKEN || `oz_${crypto.randomBytes(24).toString('base64url')}`;
}

export async function runTunnel() {
  const { startProxy } = await import('./proxy.js');
  const { config } = await import('./config.js');

  const token = mintToken();
  // Uncapped unless the user sets a ceiling — the required token is the gate.
  const sessionCap = process.env.OPENZOO_TUNNEL_MAX_USD ? Number(process.env.OPENZOO_TUNNEL_MAX_USD) : null;

  // The proxy enforces the gate itself: nothing is forwarded, quoted or paid
  // without the bearer token, and the session ceiling stops spend cold.
  const { spent } = await startProxy({
    silent: true,
    requireToken: token,
    sessionMaxUsd: sessionCap,
  });

  const bin = await ensureCloudflared();
  const { url, proc } = await startCloudflared(bin, config.port, console.log);

  console.log('');
  console.log('  ┌─────────────────────────────────────────────────────────────');
  console.log('  │  THIS URL SPENDS REAL MONEY FROM YOUR WALLET.');
  console.log('  │  The token below is the only thing protecting it.');
  console.log(sessionCap != null
    ? `  │  Session ceiling: $${sessionCap.toFixed(2)} — then it stops paying.`
    : '  │  NO session ceiling — OPENZOO_TUNNEL_MAX_USD adds one.');
  console.log('  │  Ctrl-C when you are done; the URL dies with this process.');
  console.log('  └─────────────────────────────────────────────────────────────');
  console.log('');
  console.log('point your cloud IDE at:');
  console.log(`  base_url = ${url}/v1`);
  console.log(`  api_key  = ${token}`);
  console.log('');

  const shutdown = () => {
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    const total = typeof spent === 'function' ? spent() : 0;
    console.log(`\ntunnel closed — session spend $${total.toFixed(6)}`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
