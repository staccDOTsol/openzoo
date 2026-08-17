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
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { config } from './config.js';

const GROK_HOME = process.env.GROK_HOME || join(homedir(), '.grok');
const CONFIG_PATH = join(GROK_HOME, 'config.toml');
const APP = '/Applications/Grok Bot.app';

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

export async function setupGrokBot(argv = []) {
  const base = `http://localhost:${config.port}/v1`;
  const launch = !argv.includes('--no-launch');

  // 1. proxy up, or nothing can pay
  let up = false;
  try { up = (await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) })).ok; } catch { up = false; }
  if (!up) {
    console.error('openzoo: starting the proxy...');
    const { startProxy } = await import('./proxy.js');
    await startProxy({ silent: true, autoTunnel: true });
    for (let i = 0; i < 25 && !up; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try { up = (await fetch(`${base}/models`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* wait */ }
    }
    if (!up) { console.error(`openzoo: proxy did not come up on ${base}`); process.exit(1); }
  }

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

      startCursorBackend({ port, log: (m) => console.error(`  backend: ${m}`) });

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
      process.env.OPENZOO_BYOK = '1';
      // LOUD BY DEFAULT. The previous run failed silently — "listening" and then
      // nothing — and silence looked identical to success. Every arriving method
      // is printed so "did it connect at all" is answerable at a glance.
      startCursorBackend({ port, log: (m) => console.error(`  backend: ${m}`) });
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
        execSync('osascript -e \'tell application "Grok Bot" to quit\'', { stdio: 'ignore' });
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
