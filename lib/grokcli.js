// `npx openzoo grokbot` — Grok Bot (xAI's agent app) on the zoo, Grok-only.
//
// WHAT GROK BOT IS: an Electron app, bundle id `com.anysphere.sand` (Anysphere,
// the Cursor company) shipped as "Grok Bot". It fronts the `grok` CLI, and the
// CLI is what reads ~/.grok/config.toml — which is why pointing the CLI's model
// table at the local proxy is enough, with no patching of the app bundle.
//
// WHY GROK-ONLY: the point of running it on the zoo is x402 per-call billing
// instead of first-party xAI billing, while keeping the product it is — a Grok
// agent. So every model written here is an x-ai/* id and nothing else is
// reachable from the picker.
//
// WHY THE LOCAL PROXY AND NOT x402-tokens.fly.dev: the gateway answers 402 on
// every call by design. The proxy is the thing that builds and signs the
// payment. Pointing base_url at the gateway makes every request fail
// "payment required".

import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  chmodSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { killListen } from './proxy.js';
import { fakeCursorTokens } from './cursorapi.js';
import {
  GROKBOT_CDP_PORT,
  grokBotChromiumArgs,
  injectSpendChipInBackground,
} from './ozSpendChip.js';

const GROK_HOME = process.env.GROK_HOME || join(homedir(), '.grok');
const CONFIG_PATH = join(GROK_HOME, 'config.toml');

/* LINUX/WIN DISCOVERY — the multiarch release ships Grok_Bot_<v>_<plat>-<arch>.AppImage
 * / .exe. GROKBOT_BIN env always wins. */
function linuxAppImage() {
  const home = homedir();
  const roots = [
    join(home, 'Applications'),
    join(home, '.local', 'bin'),
    join(home, 'Downloads'),
    '/opt',
    '/usr/local/bin',
    '/usr/bin',
  ];
  for (const dir of roots) {
    try {
      const hit = readdirSync(dir)
        .filter((f) => /^grok[ _-]?bot.*\.appimage$/i.test(f))
        .sort();
      if (hit.length) return join(dir, hit[hit.length - 1]);
    } catch { /* unreadable dir */ }
  }
  return join(home, '.local', 'bin', 'Grok_Bot.AppImage');
}

function windowsExe() {
  const home = homedir();
  const dirs = [
    join(home, 'AppData', 'Local', 'Programs', 'Grok Bot'),
    join(home, 'AppData', 'Local', 'Programs', 'grok-bot'),
    'C:\\Program Files\\Grok Bot',
  ];
  for (const dir of dirs) {
    for (const name of ['Grok Bot.exe', 'Grok_Bot.exe', 'grokbot.exe']) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return join(home, 'AppData', 'Local', 'Programs', 'Grok Bot', 'Grok Bot.exe');
}

function darwinAppDirs() {
  const apps = [];
  if (process.env.GROK_APP) apps.push(process.env.GROK_APP);
  apps.push('/Applications/Grok Bot.app');
  apps.push(join(homedir(), 'Applications', 'Grok Bot.app'));
  return apps;
}

function darwinBinary() {
  for (const app of darwinAppDirs()) {
    const bin = join(app, 'Contents', 'MacOS', 'Grok Bot');
    if (existsSync(bin)) return bin;
  }
  return join(darwinAppDirs()[0], 'Contents', 'MacOS', 'Grok Bot');
}

/** Cross-platform Grok Bot binary. GROKBOT_BIN env always wins. */
export function grokBotBinary() {
  if (process.env.GROKBOT_BIN) return process.env.GROKBOT_BIN;
  if (process.platform === 'darwin') return darwinBinary();
  if (process.platform === 'linux') return linuxAppImage();
  if (process.platform === 'win32') return windowsExe();
  return darwinBinary();
}

/** Cross-platform quit: osascript on mac, SIGTERM pids elsewhere. */
function quitGrokBot() {
  try {
    if (process.platform === 'darwin') {
      try {
        execSync('osascript -e \'tell application "Grok Bot" to quit\'', {
          timeout: 8000,
          stdio: 'ignore',
        });
      } catch { /* not running */ }
    }
    for (const pid of grokBotPids()) {
      try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ }
    }
  } catch { /* ok */ }
}

/** Grok ids as the zoo serves them. Verified against GET /v1/models at write
 *  time so a renamed/retired model never lands in the picker as a dead row. */
const FALLBACK_MODELS = [
  { key: 'openzoo-grok-46', id: 'x-ai/grok-4.6', name: 'Grok 4.6 (openzoo)' },
  { key: 'openzoo-grok-45', id: 'x-ai/grok-4.5', name: 'Grok 4.5 (openzoo)' },
];

/**
 * TOML table keys cannot contain a bare dot — `[model.openzoo-grok-4.6]` parses
 * as model -> "openzoo-grok-4" -> "6", silently producing a malformed entry
 * with no `model` field. Slugify to keep the key flat.
 */
function slug(id) {
  return 'openzoo-' + id.replace(/^x-ai\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/, '');
}

async function grokModels(base) {
  try {
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`models ${r.status}`);
    const j = await r.json();
    const rows = (j.data || [])
      // VENDOR-PREFIXED IDS ONLY. The local proxy augments /v1/models with
      // harness aliases ("grok-4", "openzoo-grok-4.6") so editors that validate
      // a configured id upfront do not refuse to start. Those are routing
      // conveniences, not catalog rows — writing them here would produce
      // duplicate picker entries that all resolve to the same model.
      .filter((m) => typeof m.id === 'string' && m.id.startsWith('x-ai/') && !m.kind)
      .map((m) => ({ key: slug(m.id), id: m.id, name: `${m.id.replace(/^x-ai\//, 'Grok ')} (openzoo)` }));
    return rows.length ? rows : FALLBACK_MODELS;
  } catch {
    // never write an empty picker because the catalog blipped
    return FALLBACK_MODELS;
  }
}

/** Strip the blocks we own so a re-run is idempotent, keeping everything else
 *  (mcp_servers, plugins, marketplace, privacy, ui) exactly as the user had it. */
function stripOurs(toml) {
  const lines = toml.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      const name = header[1];
      skipping = name === 'models' || name.startsWith('model.');
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function renderModels(models, base) {
  const def = models[0].key;
  const body = models.map((m) => `[model.${m.key}]
model = "${m.id}"
base_url = "${base}"
api_key = "openzoo"
name = "${m.name}"`).join('\n\n');
  return `
# --- openzoo: Grok-only, paid per call by x402 -------------------------------
# Written by \`npx openzoo grokbot\`. Re-running rewrites ONLY this block.
# base_url is the LOCAL proxy: the public gateway 402s every call by design,
# and the proxy is what signs the payment.
[models]
default = "${def}"

${body}
`;
}

/** pids whose command is the Grok Bot main binary (not grep itself). */
export function grokBotPids(run = execSync) {
  try {
    return run(`pgrep -f ${JSON.stringify(grokBotBinary())}`, { encoding: 'utf8', shell: true })
      .trim().split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function pidHasNeedle(pid, needle, run = execSync) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (process.platform === 'linux') {
    try {
      // /proc/<pid>/environ is NUL-separated; flatten and test.
      const env = readFileSync(`/proc/${n}/environ`, 'utf8');
      if (env.replace(/\0/g, '\n').includes(needle)) return true;
    } catch { /* gone */ }
  }
  if (process.platform === 'win32') return false;
  for (const cmd of [`ps -Eww -p ${n} -o command=`, `ps eww -p ${n}`]) {
    try {
      if (run(cmd, { encoding: 'utf8', timeout: 2000 }).includes(needle)) return true;
    } catch { /* SIP / dead pid */ }
  }
  return false;
}

function somethingTalksToPort(port, run = execSync) {
  try {
    if (process.platform === 'linux') {
      const out = run('ss -tnp', { encoding: 'utf8', timeout: 2000 });
      return out.includes(':' + Number(port)) && /grok|electron|bot/i.test(out);
    }
    if (process.platform === 'win32') {
      const out = run('netstat -ano', { encoding: 'utf8', timeout: 5000 });
      return new RegExp(':' + Number(port) + '[^0-9].*ESTABLISHED', 'i').test(out);
    }
    const out = run(`lsof -nP -iTCP:${Number(port)} -sTCP:ESTABLISHED`, {
      encoding: 'utf8', timeout: 2000,
    });
    return /Grok|Electron|Helper/i.test(out);
  } catch {
    return false;
  }
}

/** Is the running Grok Bot already pointed at our aiserver? */
export function inspectGrokBotHijack(url, port = 8443, run = execSync, cdpPort = GROKBOT_CDP_PORT) {
  const pids = grokBotPids(run);
  const needle = `CURSOR_API_BASE_URL=${url}`;
  const envHit = pids.some((pid) => pidHasNeedle(pid, needle, run));
  const tcpHit = somethingTalksToPort(port, run);
  const cdpNeedle = `--remote-debugging-port=${Number(cdpPort)}`;
  const chipDebug = pids.some((pid) => pidHasNeedle(pid, cdpNeedle, run));
  return { running: pids.length > 0, pids, hijacked: envHit || tcpHit, chipDebug };
}

/**
 * Decide whether to osascript-quit / spawn Grok Bot.
 * forceQuit = --quit / OZ_NO_QUIT=0
 * neverQuit = --no-quit / OZ_NO_QUIT=1
 */
export function grokBotQuitPlan({
  forceQuit = false,
  neverQuit = false,
  running = false,
  hijacked = false,
  chipDebug,
} = {}) {
  if (forceQuit) return { quit: true, spawn: true, reason: 'forced --quit' };
  if (neverQuit) {
    return {
      quit: false,
      spawn: !hijacked,
      reason: hijacked
        ? 'explicit --no-quit (already hijacked)'
        : 'explicit --no-quit (Grok Bot may be a login-item without hijack env)',
    };
  }
  if (!running) return { quit: false, spawn: true, reason: 'Grok Bot not running' };
  if (hijacked && chipDebug === false) {
    return {
      quit: true,
      spawn: true,
      reason: 'hijacked but no spend-chip debug port — bouncing so the ⓘ bubble can inject',
    };
  }
  if (hijacked) return { quit: false, spawn: false, reason: 'already hijacked — leaving the session' };
  return {
    quit: true,
    spawn: true,
    reason: 'running without hijack env (reboot/login item) — bouncing so CURSOR_API_BASE_URL sticks',
  };
}

export function botPidPath(home = homedir()) {
  return join(home, '.openzoo', 'bot.pid');
}

export function isBotDaemonChild(env = process.env) {
  return env.OPENZOO_BOT_DAEMON_CHILD === '1';
}

export function wantsBotDaemon(argv = [], env = process.env) {
  if (isBotDaemonChild(env)) return false;
  if (argv.includes('--once') || argv.includes('--web')) return false;
  return argv.includes('--daemon') || argv.includes('-d') || env.OPENZOO_BOT_DAEMON === '1';
}

/**
 * Env for the VENDOR Grok Bot Electron binary. Must NOT inherit
 * ELECTRON_RUN_AS_NODE — that is how OpenZoo Bot runs `openzoo.js`, and
 * passing it through makes Grok Bot start as Node with no window (measured
 * on the Linux AppImage: pay banner prints, then nothing). Nested AppImage
 * vars (APPIMAGE/APPDIR/LD_LIBRARY_PATH) make the child reuse our squashfs
 * and die silently.
 */
export function grokBotLaunchEnv(url, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const k of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ASAR',
    'APPIMAGE',
    'APPDIR',
    'ARGV0',
    'OWD',
    'APPIMAGE_EXTRACT_AND_RUN',
    'LD_LIBRARY_PATH',
    'LD_PRELOAD',
  ]) delete env[k];
  env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  env.CURSOR_API_BASE_URL = url;
  env.SAND_BACKEND_URL = url;
  env.SAND_HOST_GATEWAY_URL = url;
  env.SAND_HOST_GATEWAY_TOKEN = 'openzoo';
  env.SAND_HOST_GATEWAY_NETWORK_TOKEN = 'openzoo';
  // Login page is websiteUrl/loginDeepControl (cursor.com by default). Point
  // it at the hijack so "Log in with Cursor" never opens a real Cursor tab.
  env.SAND_CURSOR_WEBSITE_URL = url;
  env.CURSOR_WEBSITE_URL = url;
  // SAND_HOST_GATEWAY_URL turns on .env-descriptor-account-bindings.json:
  // the first Cursor account that used this machine claims it, and a fake
  // openzoo JWT then gets refused-credentials-retained (i18n DKMHuY).
  // asar createDesktopAccountAuthorizer honors this rebind flag.
  env.SAND_DEV_ALLOW_ACCOUNT_REBIND = '1';
  // asar waitForBrowserLogin always shell.openExternal(loginUrl) THEN polls.
  // Fake poll already returns tokens — swallow the tab so 127.0.0.1:8443/loginDeep
  // never pops. Linux Electron uses xdg-open from PATH (mac NSWorkspace ignores
  // this; the loginDeep HTML still window.close()s).
  const realPath = env.PATH || '/usr/bin:/bin:/usr/local/bin';
  env.OPENZOO_REAL_PATH = realPath;
  try {
    const shim = ensureGrokBotOpenShim({
      home: env.HOME || homedir(),
      platform: process.platform,
    });
    env.PATH = `${shim.dir}${delimiter}${realPath}`;
    env.BROWSER = shim.browser;
  } catch { /* read-only home */ }
  return env;
}

export function grokBotOpenShimDir(home = homedir()) {
  return join(home, '.openzoo', 'bin');
}

/** POSIX shim: exit 0 on loginDeepControl, else exec the real command. */
export const GROKBOT_OPEN_SHIM_SH = `#!/bin/sh
url=""
for a in "$@"; do
  case "$a" in
    http://*|https://*|cursor://*) url="$a" ;;
  esac
done
case "$url" in
  *loginDeepControl*|*/loginDeep*) exit 0 ;;
esac
cmd=\`basename "$0"\`
rest_path=\${OPENZOO_REAL_PATH:-/usr/bin:/bin:/usr/local/bin}
old_ifs=$IFS
IFS=:
for d in $rest_path; do
  if [ -n "$d" ] && [ -x "$d/$cmd" ]; then
    [ "$d/$cmd" = "$0" ] && continue
    IFS=$old_ifs
    exec "$d/$cmd" "$@"
  fi
done
IFS=$old_ifs
exit 0
`;

/**
 * PATH shims so Grok Bot's shell.openExternal does not pop a browser tab
 * for the fake login URL. Writes xdg-open + gio (Linux Electron) and open
 * (in case macOS shells out; NSWorkspace still bypasses PATH).
 */
export function ensureGrokBotOpenShim({
  home = homedir(),
  platform = process.platform,
} = {}) {
  const dir = grokBotOpenShimDir(home);
  mkdirSync(dir, { recursive: true });
  const names = platform === 'win32' ? [] : platform === 'darwin' ? ['open'] : ['xdg-open', 'gio'];
  for (const name of names) {
    const p = join(dir, name);
    writeFileSync(p, GROKBOT_OPEN_SHIM_SH, { encoding: 'utf8', mode: 0o755 });
    try { chmodSync(p, 0o755); } catch { /* windows */ }
  }
  return {
    dir,
    browser: join(dir, names[0] || 'xdg-open'),
    names,
  };
}

/** asar kkn: sha256(namespace || 0x00 || value) hex. */
export function sandBindingKey(namespace, value) {
  return createHash('sha256').update(String(namespace)).update('\0').update(String(value)).digest('hex');
}

/** asar descriptorKey — `new URL(url).toString()` adds the trailing slash. */
export function sandDescriptorKey(url) {
  return sandBindingKey('sand-env-descriptor', new URL(url).toString());
}

/** asar accountKey. JWT sub / cursorAccountSlot is `openzoo-user`. */
export function sandAccountKey(slot = 'openzoo-user') {
  return sandBindingKey('sand-account-slot', slot);
}

/**
 * Electron userData candidates for vendor Grok Bot (productName "Grok Bot",
 * package name "sand"). Bindings live at
 * `<userData>/.env-descriptor-account-bindings.json`.
 */
export function grokBotUserDataDirs(home = homedir(), env = process.env, platform = process.platform) {
  const names = ['Grok Bot', 'grok-bot', 'GrokBot', 'sand'];
  let root;
  if (platform === 'darwin') root = join(home, 'Library', 'Application Support');
  else if (platform === 'win32') root = env.APPDATA || join(home, 'AppData', 'Roaming');
  else root = env.XDG_CONFIG_HOME || join(home, '.config');
  return names.map((n) => join(root, n));
}

/**
 * Pre-seed the env-descriptor binding for our hijack URL.
 *
 * asar authorize (packaged AppImage) is:
 *   existing === thisAccount → ok
 *   existing != null && !REBIND → refuse
 *   existing == null && !firstStartupClaim && hasExistingDurableData() → refuse
 *   else write binding
 *
 * Packaged builds force hasExistingDurableData() true (dev-box control plane
 * is off). Mid-session "Log in with Cursor" is not firstStartupClaim. A new
 * hijack URL therefore has existing==null and REBIND never runs — 1.3.10.
 * Writing this file first makes existing==thisAccount (or existing!=null so
 * REBIND can rewrite if the slot is not openzoo-user).
 */
export function claimGrokBotMachine(url, {
  home = homedir(),
  env = process.env,
  platform = process.platform,
  accountSlot = 'openzoo-user',
} = {}) {
  const descriptorKey = sandDescriptorKey(url);
  const accountKey = sandAccountKey(accountSlot);
  const written = [];
  for (const dir of grokBotUserDataDirs(home, env, platform)) {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, '.env-descriptor-account-bindings.json');
    let bindings = {};
    try {
      const prev = JSON.parse(readFileSync(p, 'utf8'));
      if (prev && typeof prev.bindings === 'object' && prev.bindings) bindings = { ...prev.bindings };
    } catch { /* missing or junk */ }
    bindings[descriptorKey] = accountKey;
    writeFileSync(p, JSON.stringify({ version: 1, bindings }), { encoding: 'utf8', mode: 0o600 });
    written.push(p);
  }
  return { descriptorKey, accountKey, written };
}

function plaintextSecret(value) {
  return `plaintext:v1:${Buffer.from(String(value), 'utf8').toString('base64')}`;
}

/**
 * Write fake JWTs into Grok Bot's sand-secrets.json so asar getStatus is
 * already logged-in and waitForBrowserLogin never runs.
 * Windows shell.openExternal uses ShellExecute (not PATH), so the xdg-open
 * shim cannot swallow loginDeepControl — this is the Windows fix.
 */
export function seedGrokBotFakeLogin({
  home = homedir(),
  env = process.env,
  platform = process.platform,
} = {}) {
  const tok = fakeCursorTokens();
  const patch = {
    'cursor-access-token': plaintextSecret(tok.accessToken),
    'cursor-refresh-token': plaintextSecret(tok.refreshToken),
  };
  const written = [];
  for (const dir of grokBotUserDataDirs(home, env, platform)) {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'sand-secrets.json');
    let prev = {};
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (j && typeof j === 'object') prev = j;
    } catch { /* missing */ }
    writeFileSync(p, JSON.stringify({ ...prev, ...patch }, null, 2), { encoding: 'utf8', mode: 0o600 });
    written.push(p);
  }
  return { written, authId: tok.authId };
}

export function daemonizeBot(argv, {
  execPath = process.execPath,
  script = process.argv[1],
  env = process.env,
  logFile = join(homedir(), '.openzoo', 'bot.log'),
} = {}) {
  const rest = argv.filter((a) => a !== '--daemon' && a !== '-d');
  const entry = script || fileURLToPath(new URL('../bin/openzoo.js', import.meta.url));
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  const childEnv = { ...env, OPENZOO_BOT_DAEMON_CHILD: '1' };
  if (process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(execPath, [entry, 'bot', ...rest], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: childEnv,
    windowsHide: true,
  });
  child.unref();
  try { closeSync(fd); } catch { /* fd is inherited */ }
  const pidPath = botPidPath();
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, String(child.pid));
  return { pid: child.pid, logFile, pidPath };
}

export function stopBotDaemon({ log = (m) => console.error(m) } = {}) {
  const pidPath = botPidPath();
  let pid = 0;
  try { pid = Number(readFileSync(pidPath, 'utf8').trim()); } catch { /* none */ }
  if (!Number.isInteger(pid) || pid <= 0) {
    log('openzoo: no bot daemon pidfile');
    return false;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  try { unlinkSync(pidPath); } catch { /* ok */ }
  log(`openzoo: stopped daemon pid ${pid}`);
  return true;
}

/**
 * `openzoo bot` — Grok Bot.app on the zoo, no sudo, no /etc/hosts.
 *
 * CURSOR_API_BASE_URL (and SAND_BACKEND_URL) are what the Electron MAIN
 * process actually reads. Chromium --host-resolver-rules do not. Measured:
 * a bare `127.0.0.1:443` is HTTP and logs ERR_SSL_HTTP_REQUEST; the URL
 * must be https://127.0.0.1:8443. The TLS warning on launch is Node
 * complaining about NODE_TLS_REJECT_UNAUTHORIZED=0 — expected, the cert
 * is ours and self-signed.
 *
 * We bind 8443 ourselves (unprivileged). :443 is the old root takeover and
 * stubs oauth if it is the unpatched npx copy — do not point the app there.
 */
export async function runBot(argv = []) {
  if (argv.includes('--web')) {
    const { runGrokBotWeb } = await import('./grokbotweb.js');
    return runGrokBotWeb(argv);
  }
  if (argv.includes('--stop')) {
    stopBotDaemon();
    return;
  }
  if (wantsBotDaemon(argv)) {
    const d = daemonizeBot(argv);
    console.error(`openzoo: daemon pid ${d.pid} — log ${d.logFile}`);
    return;
  }
  const port = 8443;
  const url = `https://127.0.0.1:${port}`;
  let bin = grokBotBinary();
  if (!existsSync(bin) && !argv.includes('--no-fetch') && process.env.GROKBOT_NO_FETCH !== '1') {
    console.error('openzoo: Grok Bot not installed — fetching the multiarch build');
    try {
      const { ensureGrokBot } = await import('./grokbotFetch.js');
      bin = await ensureGrokBot({
        existing: bin,
        log: (m) => console.error(m),
      });
      if (bin) process.env.GROKBOT_BIN = bin;
    } catch (e) {
      console.error(`openzoo: fetch failed (${e.message})`);
    }
  }
  if (!existsSync(bin)) {
    console.error(`openzoo: Grok Bot binary not found — looked for ${bin}`);
    console.error('  set GROKBOT_BIN=/path/to/Grok_Bot_0.36.0_linux-x64.AppImage');
    console.error('  or drop the AppImage in ~/Applications, ~/.local/bin, /opt, ~/Downloads');
    console.error('  or run again on a network so openzoo can fetch grokbot-v* from GitHub');
    process.exit(1);
  }

  const proxyBase = `http://localhost:${config.port}/v1`;
  console.error('openzoo: starting proxy on', proxyBase);
  const { startProxy } = await import('./proxy.js');
  await startProxy({ silent: true, autoTunnel: process.env.OPENZOO_NO_TUNNEL === '1' ? false : true });

  process.env.OPENZOO_BYOK = '1';
  const sniff = argv.includes('--sniff') || argv.includes('--passthru');
  if (sniff) {
    // REAL pod, we only sit in the middle. EnsureSandBox is rewritten so
    // /api/sendPrompt and getAgentTranscriptTail land here, then we proxy
    // them to cursorvm and dump the live JSON. That is the comparison
    // surface — hijack guesses have been wrong twice.
    delete process.env.OZ_HIJACK_POD;
    process.env.OPENZOO_PASSTHRU = '1';
    process.env.OPENZOO_SNIFF = '1';
    process.env.OZ_SNIFF_SELF = url;
  } else {
    // Do NOT hand Grok Bot a real cursorvm pod — inference then never leaves
    // Anysphere (measured: EnsureSandBox -> REAL api2, then StreamUnifiedChat
    // never arrives). Point the sandbox URLs at THIS aiserver; StreamUnifiedChat
    // is answered from :8402 (x402).
    process.env.OZ_HIJACK_POD = JSON.stringify({
      region: 'local',
      accountId: 'openzoo',
      podId: 'openzoo-local',
      token: 'openzoo',
      agent: url,
      vnc: url,
      p1340: url,
      p6081: url,
    });
    process.env.OZ_SNIFF_SELF = url;
  }
  const { startCursorBackend } = await import('./cursorbackend.js');
  const models = [
    'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-3.5-turbo',
  ].map((n) => ({ name: n, label: n }));
  const { makeBotLogger, payBannerLines, walletAddresses } = await import('./botlog.js');
  const verbose = argv.includes('--verbose') || !!process.env.OPENZOO_DEBUG || !!process.env.OPENZOO_VERBOSE;
  const log = makeBotLogger({ verbose });
  const stale = killListen(port);
  if (stale.length) console.error(`openzoo: killed stale hijack on :${port} pids=${stale.join(',')}`);
  try {
    await startCursorBackend({ port, models, log });
  } catch (e) {
    console.error('openzoo: 8443 bind failed after kill (', e.message, ')');
    throw e;
  }
  await new Promise((r) => setTimeout(r, 400));
  let ver = '?';
  try {
    ver = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
  } catch { /* */ }
  process.on('uncaughtException', (e) => console.error('openzoo: uncaught', e?.message || e));
  process.on('unhandledRejection', (e) => console.error('openzoo: rejection', e?.message || e));
  console.error(`openzoo: grokbot hijack v${ver}`);
  console.error(`openzoo: aiserver on ${url}`);
  console.error('         oauth + /sand-box creds -> real api2');
  if (sniff) {
    console.error('         SNIFF: real EnsureSandBox, /api/* proxied, dump ~/.openzoo/grokbot-sniff.jsonl');
    console.error('         send a message in Grok Bot — it should paint for real');
  } else {
    console.error('         EnsureSandBox HIJACKED here; StreamUnifiedChat -> :8402 (x402)');
  }

  // Default: leave a Grok Bot that is ALREADY hijacked. After a reboot the
  // login item comes back WITHOUT CURSOR_API_BASE_URL; Electron's single-
  // instance lock then swallows our env'd spawn and the overlay stays
  // "Couldn't send your message". Bounce only that unhijacked case.
  // --quit / OZ_NO_QUIT=0 force a bounce. --no-quit / OZ_NO_QUIT=1 never.
  const state = inspectGrokBotHijack(url, port);
  const plan = grokBotQuitPlan({
    forceQuit: argv.includes('--quit') || process.env.OZ_NO_QUIT === '0',
    neverQuit: argv.includes('--no-quit') || process.env.OZ_NO_QUIT === '1',
    running: state.running,
    hijacked: state.hijacked,
    chipDebug: state.chipDebug,
  });
  console.error(`openzoo: grokbot ${plan.reason}`);
  if (plan.quit) {
    try { quitGrokBot(); } catch { /* ok */ }
    await new Promise((r) => setTimeout(r, 1500));
  }

  try {
    const claim = claimGrokBotMachine(url);
    console.error(`openzoo: machine-claim openzoo-user → ${claim.written.length} Grok Bot userData dir(s)`);
  } catch (e) {
    console.error(`openzoo: machine-claim failed (${e.message}) — login may still hit DKMHuY`);
  }
  try {
    const seed = seedGrokBotFakeLogin();
    console.error(`openzoo: fake login seeded → ${seed.written.length} sand-secrets.json`);
  } catch (e) {
    console.error(`openzoo: fake login seed failed (${e.message})`);
  }

  const launchGrokBot = () => {
    console.error('openzoo: launching Grok Bot');
    console.error(`         CURSOR_API_BASE_URL=${url}`);
    if (process.platform === 'linux' && /\.appimage$/i.test(bin)) {
      try { chmodSync(bin, 0o755); } catch { /* read-only */ }
    }
    const env = grokBotLaunchEnv(url);
    if (process.platform === 'linux' && /\.appimage$/i.test(bin)) {
      env.APPIMAGE_EXTRACT_AND_RUN = '1';
    }
    console.error(`         SAND_DEV_ALLOW_ACCOUNT_REBIND=${env.SAND_DEV_ALLOW_ACCOUNT_REBIND}`);
    if (env.BROWSER && process.platform !== 'win32') {
      console.error('         loginDeep tab swallowed (xdg-open/open shim)');
    }
    const child = spawn(bin, grokBotChromiumArgs(), {
      stdio: 'ignore',
      detached: true,
      env,
    });
    child.on('error', (e) => console.error(`openzoo: Grok Bot spawn failed: ${e.message}`));
    child.unref();
  };
  let needSpawn = plan.spawn;
  if (process.platform === 'win32' && state.running && !plan.quit) {
    // ShellExecute already opened Edge; restart so sand-secrets are read and
    // loginDeepControl is not opened again.
    try { quitGrokBot(); } catch { /* ok */ }
    await new Promise((r) => setTimeout(r, 1500));
    needSpawn = true;
  }
  if (needSpawn) launchGrokBot();
  else console.error('openzoo: Grok Bot already hijacked — not spawning another copy');

  injectSpendChipInBackground({
    port: GROKBOT_CDP_PORT,
    log: (m) => console.error(m),
    delayMs: plan.spawn ? 8000 : 2000,
  });

  console.error('openzoo: leave this running. ctrl-c stops the backend.');
  // HOW TO PAY, up front. A first run used to be sixty lines of wire noise and
  // the first 402 was the only thing that ever mentioned money.
  const payBanner = async () => {
    try {
      const { loadOrCreateWallet } = await import('./wallet.js');
      const addrs = walletAddresses(loadOrCreateWallet());
      const { quickBalances } = await import('./botlog.js');
      const balances = await quickBalances(addrs);
      let chromeMode = 'own-profile';
      try { const { chromeStatus } = await import('./mcpbridge.js'); chromeMode = chromeStatus().mode; } catch { /* */ }
      for (const l of payBannerLines({ ...addrs, balances, chromeMode })) console.error(l);
    } catch (e) {
      console.error(`openzoo: (pay banner unavailable: ${e.message}) — run: openzoo balance`);
    }
  };
  setTimeout(() => { payBanner().catch(() => {}); }, plan.spawn ? 7000 : 2500);
  if (argv.includes('--once')) return;
  await new Promise(() => {});
}

export async function setupGrokBot(argv = []) {
  const base = `http://localhost:${config.port}/v1`;
  const launch = !argv.includes('--no-launch');

  // 1. proxy up, or nothing can pay. Always startProxy: it kills a stale
  // listener on the port instead of reusing a PayClient that still thinks $0.
  console.error('openzoo: starting the proxy...');
  const { startProxy } = await import('./proxy.js');
  await startProxy({ silent: true, autoTunnel: true });
  let up = false;
  for (let i = 0; i < 25 && !up; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try { up = (await fetch(`${base}/models`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* wait */ }
  }
  if (!up) { console.error(`openzoo: proxy did not come up on ${base}`); process.exit(1); }

  const models = await grokModels(base);

  // 2. rewrite ONLY our block, after a timestamped backup
  if (!existsSync(GROK_HOME)) mkdirSync(GROK_HOME, { recursive: true });
  let existing = '';
  if (existsSync(CONFIG_PATH)) {
    const backup = `${CONFIG_PATH}.bak-${Date.now()}`;
    copyFileSync(CONFIG_PATH, backup);
    existing = readFileSync(CONFIG_PATH, 'utf8');
    console.error(`openzoo: backed up ${CONFIG_PATH} -> ${backup}`);
  }
  let next = stripOurs(existing);
  // the fork/secondary model must ride the zoo too, or forks quietly bill xAI
  // first-party while the main model is on openzoo
  if (/^\s*fork_secondary_model\s*=/m.test(next)) {
    next = next.replace(/^\s*fork_secondary_model\s*=.*$/m, `fork_secondary_model = "${models[0].key}"`);
  }
  writeFileSync(CONFIG_PATH, `${next}\n${renderModels(models, base)}`, 'utf8');

  console.error(`openzoo: wrote ${models.length} Grok model(s) to ${CONFIG_PATH}`);
  for (const m of models) console.error(`         ${m.key}  ->  ${m.id}`);
  console.error(`openzoo: default = ${models[0].key} · all calls paid by x402 from your burner wallet`);

  if (!launch) return;

  // 3. launch the app if it exists, else the CLI
  if (existsSync(APP)) {
    // BYOK IS THE DEFAULT. Without it this command only rewrites the CLI's
    // model table, and the APP — the thing you actually look at — keeps talking
    // to Cursor's cloud, which is the whole problem it was meant to solve.
    // --no-byok drops back to plain launch.
    // TAKEOVER IS THE DEFAULT. The --host-resolver-rules probe below is kept
    // only for reference: it was PROVED not to intercept this app (flags present,
    // backend listening, zero connections). Nothing routes without the hosts pin.
    if (!argv.includes('--no-takeover')) {
      // TAKEOVER — the Cursor recipe, because it is the only one that works.
      //
      // WHY NOT --host-resolver-rules: PROVED not to work here. The flag was
      // verified present in the running process args for all four cursor hosts,
      // the backend was listening, and ZERO connections arrived — the app kept
      // talking to the real api2.cursor.sh (cert CN confirmed on its live
      // sockets). That flag only steers CHROMIUM's stack; Grok Bot's Connect/gRPC
      // transport runs in the Electron MAIN process on Node's DNS + Node's TLS,
      // which ignore it. Same reason setup.js sets NODE_TLS_REJECT_UNAUTHORIZED
      // for Cursor takeover.
      //
      // So: /etc/hosts (Node reads the OS resolver) + Node-side TLS override,
      // and the app is spawned DIRECTLY rather than via `open`, because `open`
      // does not pass an environment to the app.
      const { blockBackend, unblockBackend, isBlocked } = await import('./hosts.js');
      const { startCursorBackend } = await import('./cursorbackend.js');
      const port = 443; // Node's DNS gives no port control — we must own :443

      // --sniff: intercept but PASS EVERYTHING THROUGH to the real backend, so
      // the app works normally and every method/size/status is logged. This is
      // the only way to see the chat path: stubbing breaks EnsureSandBox and the
      // app never reaches inference at all.
      if (argv.includes('--sniff')) { process.env.OPENZOO_PASSTHRU = '1'; process.env.OPENZOO_DUMP = '1'; }
      else process.env.OPENZOO_BYOK = '1';
      process.env.OPENZOO_FORCE_BLOCK = '1';   // our own guard refuses otherwise
      console.error(argv.includes('--sniff')
        ? 'openzoo: SNIFF — pinning api2.cursor.sh, proxying it to the REAL backend, logging everything.'
        : 'openzoo: TAKEOVER — pinning api2.cursor.sh and serving it locally.');
      if (argv.includes('--sniff')) console.error('         response bodies -> /tmp/openzoo-sniff/');
      console.error('         sudo will ask for your password (hosts file + :443).');
      if (!isBlocked()) blockBackend();

      await startCursorBackend({ port, log: (m) => console.error(`  backend: ${m}`) });

      const restore = () => {
        try { unblockBackend(); console.error('openzoo: /etc/hosts restored.'); } catch { /* best effort */ }
      };
      process.on('SIGINT', () => { restore(); process.exit(0); });
      process.on('exit', restore);

      console.error('openzoo: launching Grok Bot with Node TLS override...');
      spawn(`${APP}/Contents/MacOS/Grok Bot`, ['--ignore-certificate-errors'], {
        stdio: 'ignore',
        detached: true,
        env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      }).unref();

      console.error('openzoo: ctrl-c to stop and RESTORE /etc/hosts (do not just close the terminal).');
      await new Promise(() => {});
      return;
    }

    if (!argv.includes('--no-byok')) {
      // BYOK PROBE — NO /etc/hosts, NO sudo.
      //
      // Grok Bot asks aiserver.v1 whether BYOK is allowed (`byok_enabled`,
      // field 14). Answering that ourselves needs us to BE api2.cursor.sh, and
      // the obvious way — pinning it in /etc/hosts — is exactly what took the
      // app offline for an hour with "Reconnecting to your computer", because
      // the pin is machine-wide and outlives the app.
      //
      // Chromium's own --host-resolver-rules does the same redirect scoped to
      // THIS LAUNCH ONLY. Quit and reopen normally and it is gone; nothing
      // persists, nothing else on the machine is affected, no password needed.
      const { startCursorBackend } = await import('./cursorbackend.js');
      const port = 8443;
      killListen(port);
      process.env.OPENZOO_BYOK = '1';
      // LOUD BY DEFAULT. The previous run failed silently — "listening" and then
      // nothing — and silence looked identical to success. Every arriving method
      // is printed so "did it connect at all" is answerable at a glance.
      await startCursorBackend({ port, log: (m) => console.error(`  backend: ${m}`) });
      console.error('openzoo: BYOK probe — impersonating api2/api3/api4/repo42.cursor.sh on :' + port);
      console.error('         scoped to this launch only (no /etc/hosts, no sudo)');
      console.error('         WATCH: if StreamChat starts arriving at the proxy, inference moved.');
      console.error('         If only a BYOK settings pane appears, it is xAI-key-only and buys nothing.');
      // QUIT FIRST — `open -a X --args` is a NO-OP ON A RUNNING APP.
      // macOS just activates the existing instance and drops the args, so the
      // resolver rule never applies and the app keeps talking to the real
      // api2.cursor.sh. MEASURED: the backend logged "listening" and then zero
      // requests, while the app carried on answering normally.
      try {
        quitGrokBot();
      } catch { /* not running is fine */ }
      // give it a moment to actually exit before relaunching
      await new Promise((r) => setTimeout(r, 2500));
      // MAP EVERY CURSOR HOST, NOT JUST api2.
      // MEASURED: mapping api2 alone applied cleanly (verified in the running
      // process args) and still produced ZERO requests, because Grok Bot's own
      // surface is api3 — the bundle carries `https://api3.cursor.sh/tev1/v1`.
      // The self-signed cert already covers all four names, so map them all.
      const hosts = ['api2.cursor.sh', 'api3.cursor.sh', 'api4.cursor.sh', 'repo42.cursor.sh'];
      const rules = hosts.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(',');
      spawn('open', ['-n', '-a', APP, '--args',
        '--ignore-certificate-errors',
        `--host-resolver-rules=${rules}`,
      ], { stdio: 'ignore', detached: true }).unref();
      // keep this process alive so the backend keeps answering
      console.error('openzoo: leave this running while Grok Bot is open. ctrl-c stops the');
      console.error('         backend; the app then reconnects to xAI normally on next launch.');
      console.error('         (skip all of this with --no-byok)');
      await new Promise(() => {});
      return;
    }
    console.error('openzoo: launching Grok Bot...');
    spawn('open', ['-a', APP], { stdio: 'ignore', detached: true }).unref();
  } else {
    console.error('openzoo: Grok Bot.app not found — starting the `grok` CLI instead');
    const p = spawn('grok', argv.filter((a) => a !== '--no-launch'), { stdio: 'inherit' });
    p.on('exit', (c) => process.exit(c ?? 0));
  }
}
