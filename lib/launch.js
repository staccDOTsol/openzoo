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

/**
 * Claude Code ≥2.1.129 only reads GET /v1/models when gateway discovery is
 * opted in. Without this flag the picker stays the built-in opus-5 / tiny
 * claude-* set instead of the zoo catalog the proxy publishes.
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC (even "0") blocks that GET.
 *
 * Do NOT invent ANTHROPIC_MODEL=openzoo-claude-sonnet-5. That pin hid the
 * live OpenRouter catalog behind one Anthropic-native row. Only alias a
 * model the caller already chose (OPENZOO_CLAUDE_ALIAS or ANTHROPIC_MODEL).
 */
export function applyClaudeCodeCatalogEnv(env) {
  if (env.OPENZOO_NO_GATEWAY_DISCOVERY !== '1') {
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY || '1';
    delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  }
  if (env.OPENZOO_NO_ALIAS === '1') return env;
  const want = env.OPENZOO_CLAUDE_ALIAS || env.ANTHROPIC_MODEL;
  if (!want) return env;
  const bare = String(want).replace(/^openzoo-/, '').replace(/^[^/]+\//, '');
  const SAFE = /^claude-(opus|sonnet|fable)-/;
  if (SAFE.test(bare)) env.ANTHROPIC_MODEL = `openzoo-${bare}`;
  return env;
}

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

/** Dirs Claude's install.sh uses, plus Homebrew. Finder-launched grokui
 *  has no ~/.zshrc PATH, so PATH-only lookup misses `~/.local/bin/claude`. */
export function claudeCodeBinDirs(home = os.homedir()) {
  return [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

/** Resolve the Claude Code TERMINAL CLI. */
export function resolveClaudeCli(env = process.env) {
  const name = 'claude' + (process.platform === 'win32' ? '.cmd' : '');
  const extras = env.OPENZOO_CLAUDE_PATH_ONLY === '1' ? [] : claudeCodeBinDirs();
  const pathDirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of [...new Set([...extras, ...pathDirs])]) {
    if (!dir) continue;
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return null;
}

/**
 * The same env `openzoo claude` writes: gateway auth at the local proxy,
 * Anthropic API key UNSET (it would bill api.anthropic.com), catalog
 * discovery on, compact off because the proxy already spills.
 *
 * grokui Auto and the CLI share this. Do not invent a second key/url pair.
 */
export function claudeZooEnv(baseEnv = process.env, { base, port } = {}) {
  const url = base || `http://localhost:${port ?? config.port}/v1`;
  const env = { ...baseEnv };
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_BASE_URL = url;
  env.ANTHROPIC_AUTH_TOKEN = baseEnv.ANTHROPIC_AUTH_TOKEN || 'sk-openzoo';
  const extras = claudeCodeBinDirs().filter((d) => {
    try { return fs.existsSync(d); } catch { return false; }
  });
  const pathDirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  env.PATH = [...new Set([...extras, ...pathDirs])].join(path.delimiter);
  applyClaudeCodeCatalogEnv(env);
  // ANTHROPIC_MODEL is only aliased (never invented) in applyClaudeCodeCatalogEnv.
  // A default pin to openzoo-claude-sonnet-5 hid the live zoo catalog.
  // THE ACTUAL SWITCHES. Three earlier attempts missed these entirely:
  // autoCompactEnabled in settings (global, trapped a session), a raised
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS (clamped to 200k by the model table), and an
  // unrecognised model alias (resolves fine, still compacted). DISABLE_COMPACT
  // and DISABLE_AUTO_COMPACT are in the binary and are the direct controls.
  //
  // Correct here for the same reason as everything else in this block: the
  // proxy binds the prefix and forwards a bounded tail, so the request that
  // leaves this machine stays small no matter how long the conversation runs.
  if (baseEnv.OPENZOO_KEEP_COMPACT !== '1') {
    env.DISABLE_COMPACT = baseEnv.DISABLE_COMPACT || '1';
    env.DISABLE_AUTO_COMPACT = baseEnv.DISABLE_AUTO_COMPACT || '1';
  }
  // RAISE THE CEILING, because the proxy already removed it.
  //
  // Claude Code counts the WHOLE local transcript against the model's window and
  // hard-stops with "Context limit reached - /compact or /clear to continue". It
  // cannot know the proxy binds the old prefix into leCore and forwards only the
  // system block plus a bounded tail - MEASURED live, 8 of 166 turns actually
  // sent. Disabling auto-compact WITHOUT raising this made it worse: it used to
  // compact and carry on, and instead it just stopped.
  //
  // Safe only because spillTranscript is real: OPENZOO_TAIL_MAX_CHARS bounds what
  // leaves this machine however long the conversation gets.
  if (baseEnv.OPENZOO_KEEP_COMPACT !== '1' && !baseEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = baseEnv.OPENZOO_CLAUDE_CONTEXT_TOKENS || '1000000';
  }
  return env;
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
  // (including any inherited one) or it wins. claudeZooEnv is the one writer.
  const env = claudeZooEnv(process.env, { base });

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
        // Spend alone is the COST with none of the benefit. The spill figure is
        // the context that did NOT ride upstream — the thing being paid for.
        + 'const sp=j.spilled||{};'
        + 'const tk=Number(sp.tokensApprox)||0;'
        + 'const ht=tk>=1e6?(tk/1e6).toFixed(1)+"M":tk>=1e3?Math.round(tk/1e3)+"k":String(tk);'
        + 'const paid=Number(j.paidCalls)||0;'
        + 'const sc=Number(sp.calls)||0;'
        + 'const fb=Number(sp.fileBinds)||0;'
        + 'const rb=Number(sp.reusedBinds)||0;'
        + 'const ls=sp.lastSend||{};'
        + 'const bits=[];'
        + 'bits.push("spilled "+sc+"/"+paid+" calls");'
        + 'if(rb)bits.push(rb+" reused");'
        + 'bits.push(fb+" filebind");'
        + 'if(ls.sent!=null&&ls.msgs!=null)bits.push("sending "+ls.sent+"/"+ls.msgs);'
        + 'if(tk)bits.push(ht+" tok offloaded");'
        + 'const spill=bits.length?("  \\u00b7 "+bits.join("  \\u00b7 ")):"";'
        // "how can I easily see what credit i'm left" — asked by a user who
        // could not tell whether x402 had charged them at all.
        + 'const cr=(j.creditUsd==null)?"":("  \\u00b7 $"+Number(j.creditUsd).toFixed(2)+" credit");'
        // The headline: what the same calls would have cost on OpenRouter.
        // ALWAYS shown, 4dp, even at 1.0000. Hiding it when there is no saving
        // reads as "no data"; printing 1.0000x says "measured, and it is level"
        // — which is the difference between an omission and a fact.
        + 'const sx=Number(j.savingX);const sv=Number((j.spilled||{}).savedUsd ?? j.savedUsd)||0;'
        + 'const col=(sx>1)?"\\x1b[32m":"\\x1b[90m";'
        // Prefer the SPILLED-call ratio: the session-wide one averages in every
        // small turn that had nothing to offload, so it slides toward 1.0 as a
        // conversation grows and reads as the mechanism failing when it is not.
        + 'const sx2=Number(sp.savingX);'
        + 'const on=(isFinite(sx2)&&sx2>0)?sx2:sx;'
        + 'const lbl=(isFinite(sx2)&&sx2>0)?"x on spilled":"x vs direct";'
        + 'const col2=(on>1)?"\\x1b[32m":"\\x1b[90m";'
        + 'const save=(on==null||!isFinite(on))?"":("  \\u00b7 "+col2+on.toFixed(4)+lbl+(sv>0?(" ($"+sv.toFixed(4)+" saved)"):"")+"\\x1b[0m");'
        // REAL upstream cost, metered by OpenRouter (`usage.cost`), not our
        // catalog estimate. Everything else on this line is derived from
        // `max_tokens`, which callers set as a ceiling — measured 2026-08-19, a
        // $0.9858 quote covered $0.007962 of actual inference. Showing the two
        // side by side is the only way the markup is visible while it is happening.
        + 'const ac=j.actual||{};'
        + 'const real=(ac.calls>0)?("  \\u00b7 $"+Number(ac.upstreamUsd||0).toFixed(4)+" real"+(ac.markupX?(" ("+ac.markupX+"x)"):"")):"";'
        + 'process.stdout.write("\\x1b[38;5;208m\\u25cf\\x1b[0m openzoo  $"+(Number(j.spendUsd)||0).toFixed(4)+"  "+(j.paidCalls||0)+" call"+((j.paidCalls||0)===1?"":"s")+save+real+spill+cr+"  \\u00b7 x402")}'
        + 'catch{process.stdout.write("\\x1b[38;5;208m\\u25cf\\x1b[0m openzoo  \\u00b7 x402")}})\'\n');
      fs.chmodSync(scriptPath, 0o755);
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      let settings = {};
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {}; } catch { settings = {}; }
      const prev = settings.statusLine;
      settings.statusLine = { type: 'command', command: `sh ${scriptPath}` };
      // AUTO-COMPACT OFF — and only correct BECAUSE the proxy spills.
      //
      // Claude Code counts the WHOLE local transcript and compacts on its own
      // ceiling; it cannot know the proxy binds the old prefix into leCore and
      // forwards only the system block plus the recent tail. So it was
      // destroying history to stay under a limit the upstream request never
      // approached — on a product whose pitch is that it does not have to.
      //
      // This would have been RECKLESS before spillTranscript existed: with the
      // full body going upstream, disabling compaction just moves the failure
      // from a lossy summary to a hard context error. It is safe now precisely
      // because OPENZOO_KEEP_TAIL_MSGS bounds what is actually sent.
      // OPENZOO_KEEP_COMPACT=1 restores stock behaviour.
      const prevCompact = settings.autoCompactEnabled;
      // DO NOT touch autoCompactEnabled. Disabling it here mutated the user's
      // GLOBAL ~/.claude/settings.json and applied to every session, openzoo or
      // not — and because Claude Code's HARD ceiling is separate from its
      // AUTOMATIC compaction, it removed the escape hatch without removing the
      // wall. A live session ended up unable to compact AND unable to continue:
      // every keystroke returned "Context limit reached". Strictly worse than
      // stock. The correct lever is CLAUDE_CODE_MAX_CONTEXT_TOKENS on the
      // spawned process (set below), which is scoped to this launch and leaves
      // compaction available as a fallback.
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      restoreStatus = () => {
        try {
          const cur = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          if (prev === undefined) delete cur.statusLine; else cur.statusLine = prev;
          // Never leave a global setting mutated after we exit.
          // Clean up the flag older builds left behind in global settings.
          if (prevCompact === undefined) delete cur.autoCompactEnabled;
          else cur.autoCompactEnabled = prevCompact;
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
    console.error('     models   : GET /v1/models (quoteable ids only — Claude /model is a short picker + Auto)');
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

  const env = claudeZooEnv(process.env, { base });
  console.error(`openzoo: launching \`${cmd}\` on the zoo (ANTHROPIC_BASE_URL=${base}) — every turn pays x402`);
  const child = spawn(cmd, args, { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => {
    console.error(`openzoo: could not launch \`${cmd}\`: ${e.message}`);
    process.exit(1);
  });
}
