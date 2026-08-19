/**
 * `npx openzoo claude [args...]` — launch Claude Code (or any Anthropic-shaped
 * harness) already pointed at the local zoo, so its inference is paid per turn
 * over x402 instead of hitting Anthropic directly.
 *
 * This is the supported front door: ANTHROPIC_BASE_URL is an official env var
 * Claude Code reads at startup. No DNS games, no TLS interception — the proxy
 * serves POST /v1/messages (see lib/anthropic.js) and this just spawns the
 * harness with the two env vars set. The proxy must already be running
 * (`npx openzoo` in another terminal); we check first and say so if not.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

/** Resolve the Claude DESKTOP app binary, platform-agnostically. Spawn the
 *  binary directly (not `open -a`) so the env — ANTHROPIC_BASE_URL — survives;
 *  macOS `open` hands off to launchd and drops it. */
function resolveClaudeDesktop() {
  const bundles = [
    '/Applications/Claude.app/Contents/MacOS/Claude',
    path.join(os.homedir(), 'Applications', 'Claude.app', 'Contents', 'MacOS', 'Claude'),
  ];
  for (const b of bundles) { try { fs.accessSync(b, fs.constants.X_OK); return b; } catch { /* next */ } }
  // Linux/Windows or PATH install.
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of ['claude-desktop', 'Claude']) {
      const f = path.join(dir, n + (process.platform === 'win32' ? '.exe' : ''));
      try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
    }
  }
  return null;
}

/** Resolve the Claude Code TERMINAL CLI. */
function resolveClaudeCli() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, 'claude' + (process.platform === 'win32' ? '.cmd' : ''));
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return null;
}

/**
 * `npx openzoo claude [dir] [--terminal]` — launch Claude on the zoo.
 * DEFAULT is the desktop app; `--terminal` (or `-t`) runs the Claude Code CLI.
 * Both get ANTHROPIC_BASE_URL so inference pays x402.
 */
export async function launchClaude(argv) {
  // let, not const: startProxy can heal onto a different port and every URL
  // below must follow the port we actually bound.
  let base = `http://localhost:${config.port}/v1`;
  // AUTO-START THE PROXY. One command should just work — if nothing is listening,
  // boot the proxy in THIS process (it stays alive because claude runs in the
  // foreground below), rather than making the user run `npx openzoo` first.
  let up = false;
  // /info, not /models — see the poll below. "Is a proxy already listening" must
  // not be answered by an endpoint that needs the gateway, or a user whose
  // upstream is flaky gets told to start a proxy that is already running.
  try { up = (await fetch(`${base}/info`, { signal: AbortSignal.timeout(3000) })).ok; } catch { up = false; }
  if (!up) {
    // NEVER GO SILENT DURING STARTUP. silent:true routes the proxy's own lines
    // to ~/.openzoo/proxy.log so payment receipts cannot corrupt Claude Code's
    // stdio — correct DURING the session, wrong BEFORE it, because it made a
    // slow step and a dead step look identical. Reported from the wild as
    // "always gets stuck at 'starting the proxy in the background...'": there
    // was nothing on screen for up to 46s and then, at worst, one terse line.
    // A ticking elapsed counter is the difference between "hung" and "working".
    process.stderr.write('openzoo: starting the proxy...');
    const t0 = Date.now();
    const tick = setInterval(() => {
      process.stderr.write(`\ropenzoo: starting the proxy... ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }, 1000);
    tick.unref?.();
    const done = (msg) => { clearInterval(tick); process.stderr.write(`\r\x1b[2Kopenzoo: ${msg}\n`); };
    try {
      const { startProxy } = await import('./proxy.js');
      await startProxy({ silent: true, autoTunnel: true });
    } catch (err) {
      // An exception here used to surface as an eternal spinner. Say what broke.
      done(`proxy failed to start: ${err?.message || err}`);
      console.error('  full log: ~/.openzoo/proxy.log');
      console.error('  try: OPENZOO_NO_TUNNEL=1 npx openzoo claude   (skips the cloudflared download)');
      process.exit(1);
    }
    // The proxy may have healed onto a different port (8402 busy). config.port
    // is the one it ACTUALLY bound, so re-derive every URL from it — the old
    // code kept polling the port it wished for and timed out on a live proxy.
    base = `http://localhost:${config.port}/v1`;
    // PROBE /v1/info, NOT /v1/models. `models` is PROXIED UPSTREAM, so on a
    // network with a bad path to the gateway the local proxy is listening and
    // healthy while this poll never passes — and the command exits after ~46s
    // looking like the proxy failed to start. That is precisely the reported
    // "two terminals works, one doesn't": running `npx openzoo` separately
    // leaves a live proxy, so the FIRST check short-circuits and the poll is
    // skipped. `/v1/info` is served from this process and touches nothing
    // remote, which is what readiness actually means here.
    for (let i = 0; i < 20 && !up; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try { up = (await fetch(`${base}/info`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* keep waiting */ }
    }
    if (!up) {
      // NAME THE REAL FAILURE. /v1/models is proxied upstream, so an unreachable
      // gateway looks identical to a broken local proxy — and the message sent
      // one user hunting their own machine for an hour while the actual fault
      // was a blackholed IPv6 route to fly.dev. Probe the gateway directly and
      // say which of the two is actually down.
      let upstream = null;
      try {
        const r = await fetch(`${config.apiBase}/v1/models`, { signal: AbortSignal.timeout(8000) });
        upstream = r.ok;
      } catch (e) { upstream = e?.message || false; }
      if (upstream !== true) {
        done(`cannot reach the gateway at ${config.apiBase}`);
        console.error(`  the local proxy started fine; ${config.apiBase} did not answer.`);
        console.error(`  reason: ${typeof upstream === 'string' ? upstream : 'no response'}`);
        console.error('  if that mentions two addresses (one starting 2a09:), your network');
        console.error('  advertises IPv6 but drops it — this build already prefers IPv4;');
        console.error('  force it explicitly with:  NODE_OPTIONS=--dns-result-order=ipv4first');
      } else {
        done(`proxy did not answer on ${base} (the gateway is up)`);
      }
      console.error('  full log: ~/.openzoo/proxy.log');
      console.error('  try: OPENZOO_NO_TUNNEL=1 npx openzoo claude   (skips the cloudflared download)');
      process.exit(1);
    }
    done(`proxy up on :${config.port} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  // TERMINAL (Claude Code CLI) IS THE DEFAULT — it is the guaranteed-x402 path
  // and honours ANTHROPIC_BASE_URL. --desktop explicitly opens the desktop app
  // (which is OAuth/subscription-bound and may ignore our endpoint).
  const wantDesktop = argv.includes('--desktop');
  const terminal = !wantDesktop;
  const rest = argv.filter((a) => !['--terminal', '-t', '--desktop'].includes(a));
  // GATEWAY AUTH, NOT API-KEY. Setting ANTHROPIC_API_KEY makes Claude Code bill
  // api.anthropic.com and it TAKES PRECEDENCE over ANTHROPIC_BASE_URL — observed:
  // "Both ... set · auth may not work" + "API Usage Billing", never hitting the
  // zoo. A custom gateway uses BASE_URL + AUTH_TOKEN only; API_KEY must be UNSET
  // (including any inherited one) or it wins.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_BASE_URL = base;
  env.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || 'sk-openzoo';

  if (terminal) {
    const cli = resolveClaudeCli();
    if (!cli) { console.error('openzoo: `claude` CLI not found on PATH — install Claude Code, or drop --terminal for the desktop app'); process.exit(1); }
    // ALWAYS-ON HUD via Claude Code's NATIVE status line (the title bar is owned
    // by Claude Code and gets overwritten, so OSC there is useless). We write a
    // tiny status script that reads the proxy's /v1/info, and merge a statusLine
    // into ~/.claude/settings.json — PRESERVING any existing one (restored on
    // exit). Shows live spend + call count at the bottom of every turn.
    let restoreStatus = null;
    try {
      const scriptPath = path.join(os.homedir(), '.openzoo', 'statusline.sh');
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      // node JSON.parse, not awk — /v1/info is pretty-printed (space after the
      // colon) and a fixed-offset awk regex silently read 0. This is robust.
      fs.writeFileSync(scriptPath,
        '#!/bin/sh\n'
        + `curl -s --max-time 1 ${base}/info 2>/dev/null | `
        + `${JSON.stringify(process.execPath)} -e `
        + '\'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{'
        + 'try{const j=JSON.parse(s);'
        + 'process.stdout.write("\\x1b[38;5;208m\\u25cf\\x1b[0m openzoo  $"+(Number(j.spendUsd)||0).toFixed(4)+"  "+(j.paidCalls||0)+" call"+((j.paidCalls||0)===1?"":"s")+"  \\u00b7 x402")}'
        + 'catch{process.stdout.write("\\x1b[38;5;208m\\u25cf\\x1b[0m openzoo  \\u00b7 x402")}})\'\n');
      fs.chmodSync(scriptPath, 0o755);
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      let settings = {};
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {}; } catch { settings = {}; }
      const prev = settings.statusLine;
      settings.statusLine = { type: 'command', command: `sh ${scriptPath}` };
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      restoreStatus = () => {
        try {
          const cur = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          if (prev === undefined) delete cur.statusLine; else cur.statusLine = prev;
          fs.writeFileSync(settingsPath, `${JSON.stringify(cur, null, 2)}\n`);
        } catch { /* leave as-is */ }
      };
    } catch { /* HUD is best-effort */ }

    // A CLEAR banner BEFORE Claude Code takes the screen, so it is obvious this
    // session routes through the zoo (the terminal title then shows live spend).
    let wallet = '';
    try { const { PayClient } = await import('./pay.js'); wallet = new PayClient().address; } catch { /* optional */ }
    console.error('');
    console.error('  \x1b[38;5;208m●\x1b[0m openzoo — this Claude Code session routes through the zoo');
    console.error(`     endpoint : ${base}`);
    console.error('     auth     : gateway token (ANTHROPIC_API_KEY unset — no api.anthropic.com billing)');
    if (wallet) console.error(`     wallet   : ${wallet}`);
    console.error('     spend    : live in the status line below (bottom of screen); receipts in ~/.openzoo/proxy.log');
    console.error('     every turn pays x402.');
    console.error('');
    const child = spawn(cli, rest, { stdio: 'inherit', env });
    child.on('exit', (c) => { try { restoreStatus?.(); } catch { /* ignore */ } process.exit(c ?? 0); });
    child.on('error', (e) => { console.error(`openzoo: could not launch claude: ${e.message}`); process.exit(1); });
    return;
  }

  // DESKTOP, ROUTED THROUGH THE ZOO.
  //
  // The force-quit was NOT Launch Services — it was the single-instance lock:
  // spawning the bundle binary while a Claude instance is already running makes
  // the new process detect the existing one and immediately exit ("force
  // quited"). `open -a` dodges that but hands off to launchd and DROPS our env,
  // so ANTHROPIC_BASE_URL never reaches the app and it cannot route.
  //
  // To get BOTH — no force-quit AND our env — quit any running instance first,
  // then spawn the bundle binary directly with the env set. Whether the desktop
  // app honours ANTHROPIC_BASE_URL is up to the app; this at least gives it the
  // variable, which `open` never could.
  const app = resolveClaudeDesktop();
  if (!app) { console.error('openzoo: Claude desktop app not found — install it, or use `npx openzoo claude --terminal`'); process.exit(1); }

  // ROUTE THE DESKTOP APP BY IMPERSONATING api.anthropic.com.
  //
  // The desktop app is OAuth/subscription-bound and ignores ANTHROPIC_BASE_URL,
  // so env cannot point it at us. Instead we ARE api.anthropic.com: block it in
  // /etc/hosts, bind our backend on 443 (it forwards /v1/messages to the local
  // proxy, which translates + pays x402), and launch the app with the Chromium
  // flags that (a) accept our self-signed cert and (b) override DNS past DoH.
  // Opt out with --no-intercept (then it just opens, on the subscription).
  if (process.platform !== 'win32' && !argv.includes('--no-intercept')) {
    try {
      const { blockBackend, bindBackend443, unblockBackend, CLAUDE_HOSTS } = await import('./hosts.js');
      const { ensureCert } = await import('./cursorbackend.js');
      ensureCert(console.error);
      const r = blockBackend(CLAUDE_HOSTS);
      console.error(r.already ? 'openzoo: api.anthropic.com already routed to us'
        : `openzoo: routing ${CLAUDE_HOSTS.join(', ')} -> 127.0.0.1 (sudo)`);
      const modelsFile = path.join(os.tmpdir(), 'openzoo-claude-models.json');
      fs.writeFileSync(modelsFile, '[]');
      const backendLog = path.join(os.homedir(), '.openzoo', 'cursor-backend.log');
      const b = bindBackend443(modelsFile, backendLog, console.error);
      // DO NOT CLAIM SUCCESS UNCONDITIONALLY. This line used to print even when
      // nothing was listening, so the app launched into a blackholed host with a
      // reassuring message — the exact reason the last failure was so hard to see.
      if (b.listening) {
        console.error('openzoo: backend bound on :443 — Claude desktop inference now forwards to the zoo.');
        console.error('         undo any time with: npx openzoo unblock');
      } else {
        console.error('openzoo: backend FAILED to bind :443 — api.anthropic.com is blackholed with');
        console.error('         nothing answering it, so Claude would not reach inference at all.');
        console.error('         restoring your hosts file so the app keeps working.');
        try { unblockBackend(); } catch { /* best effort */ }
      }
    } catch (e) { console.error(`openzoo: desktop interception setup failed (${e.message}) — opening app plain`); }
  }

  if (process.platform === 'darwin') {
    // Quit a running instance and WAIT until it is actually gone. A fixed 800ms
    // wait raced the single-instance lock — Claude was still releasing its file
    // locks (LOCK errors), so the fresh spawn saw a live instance and exited
    // immediately ("didn't launch at all"). Poll pgrep until clear, up to ~6s.
    try { spawnSync('osascript', ['-e', 'tell application "Claude" to quit'], { stdio: 'ignore', timeout: 4000 }); } catch { /* not running */ }
    for (let i = 0; i < 24; i++) {
      const r = spawnSync('pgrep', ['-x', 'Claude'], { encoding: 'utf8' });
      if (!r.stdout || !r.stdout.trim()) break;              // gone
      if (i === 8) { try { spawnSync('pkill', ['-9', '-x', 'Claude'], { stdio: 'ignore' }); } catch { /* */ } }
      await new Promise((res) => setTimeout(res, 250));
    }
    await new Promise((r) => setTimeout(r, 400));            // let the lock file release
  }
  // Chromium flags: accept the self-signed cert, and MAP the Anthropic hosts to
  // us at the resolver level (defeats DoH, which ignores /etc/hosts).
  // MAP to 127.0.0.1 for both hosts. The resolver rule replaces the lookup
  // wholesale (no AAAA is returned), so the v6 bypass that /etc/hosts alone left
  // open does not exist on this path — the backend listens on both regardless.
  const flags = argv.includes('--no-intercept') ? []
    : ['--ignore-certificate-errors', '--host-resolver-rules=MAP api.anthropic.com 127.0.0.1,MAP api-staging.anthropic.com 127.0.0.1'];
  console.error('openzoo: launching Claude desktop — inference routes through the zoo (pays x402).');
  const child = spawn(app, [...flags, ...rest], { stdio: 'ignore', env, detached: true });
  child.on('error', (e) => console.error(`openzoo: could not launch Claude desktop: ${e.message}`));
  child.unref();
}

export async function launchHarness(cmd, args) {
  const base = `http://localhost:${config.port}/v1`;
  // Fail early with a clear message rather than letting the harness spew
  // connection errors — the #1 support question would otherwise be "why won't
  // claude connect" when the answer is "the proxy isn't up".
  try {
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    console.error(`openzoo: no proxy reachable at ${base}`);
    console.error('start it first in another terminal:  npx openzoo');
    process.exit(1);
  }

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;   // conflicts with the gateway auth-token path
  env.ANTHROPIC_BASE_URL = base;
  env.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || 'sk-openzoo';
  console.error(`openzoo: launching \`${cmd}\` on the zoo (ANTHROPIC_BASE_URL=${base}) — every turn pays x402`);
  const child = spawn(cmd, args, { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => {
    console.error(`openzoo: could not launch \`${cmd}\`: ${e.message}`);
    process.exit(1);
  });
}
