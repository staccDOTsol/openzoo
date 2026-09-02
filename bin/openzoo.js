#!/usr/bin/env node
// NODE >=18 OR NOTHING — AND HEAL IT IF WE CAN.
//
// package.json says engines >=18 but npm only WARNS, so an old node walked
// straight in and died somewhere useless: there is no global `fetch` before 18,
// so the very first probe threw, a bare `catch` swallowed it, and the user was
// left staring at "starting the proxy in the background..." forever with no
// error to report. Reported from the wild on macOS.
//
// Detect-and-exit is not enough when the machine usually HAS a good node sitting
// in nvm/homebrew and merely isn't using it. Find one and re-exec through it;
// only give up (with the exact fix) when there is genuinely nothing to run on.
// NOTE: plain 'fs'/'path' specifiers, not 'node:fs'. The node: prefix only
// resolves from 14.13.1, and this block's whole job is to run on the old
// runtime we are rejecting — an import error here would defeat the message.
import { existsSync, readdirSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const MIN_NODE = 18;
if (Number(process.versions.node.split('.')[0]) < MIN_NODE && !process.env.OPENZOO_NODE_REEXEC) {
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].filter(existsSync);
  // nvm keeps every install under ~/.nvm/versions/node/vNN.../bin/node —
  // newest first, so we land on the best available rather than the oldest.
  try {
    const nvm = join(process.env.NVM_DIR || join(homedir(), '.nvm'), 'versions', 'node');
    for (const v of readdirSync(nvm)
      .filter((d) => /^v\d+/.test(d))
      .sort((a, b) => parseInt(b.slice(1), 10) - parseInt(a.slice(1), 10))) {
      const p = join(nvm, v, 'bin', 'node');
      if (existsSync(p)) candidates.push(p);
    }
  } catch { /* no nvm, fine */ }

  for (const node of candidates) {
    let v = 0;
    try { v = Number(execFileSync(node, ['-v'], { encoding: 'utf8' }).trim().slice(1).split('.')[0]); } catch { continue; }
    if (v < MIN_NODE) continue;
    console.error(`openzoo: node ${process.versions.node} is too old (need >=${MIN_NODE}) — re-running under ${node} (v${v})`);
    const r = spawnSync(node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, OPENZOO_NODE_REEXEC: '1' },
    });
    process.exit(r.status === null ? 1 : r.status);
  }

  console.error(`openzoo: needs Node >=${MIN_NODE}, you are on ${process.versions.node}.`);
  console.error('  no newer node found on this machine. install one, then re-run:');
  console.error('    brew install node            # macOS');
  console.error('    nvm install 20 && nvm use 20 # if you use nvm');
  process.exit(1);
}

// A DEAD IPv6 ROUTE MUST NOT EAT THE CONNECT BUDGET.
//
// x402-tokens.fly.dev publishes both AAAA (2a09:8280:1::16a:5795) and A
// (66.241.124.74). Node resolves `verbatim` by default, so on a network whose
// IPv6 is advertised but blackholed it opens the v6 socket first and waits —
// and the aggregate error names BOTH addresses, which reads as "the whole host
// is down" when v4 was never given a fair chance:
//
//   Connect Timeout Error (attempted addresses: 2a09:8280:1::16a:5795:443,
//                          66.241.124.74:443, timeout: 10000ms)
//
// Reported from the wild on macOS: the proxy binds, every upstream call times
// out, the health poll never passes, and it exits after ~1 minute looking like
// a startup bug. Same shape as the cloudflared IPv6+QUIC note in the wiki.
//
// Happy Eyeballs (RFC 8305) races the families instead of guessing, with a
// short per-attempt timeout so a dead route costs 500ms rather than ten
// seconds. Both calls are version-gated and best-effort — an older Node just
// keeps its default behaviour, and the ipv4first fallback covers it.
try {
  const net = await import('node:net');
  net.setDefaultAutoSelectFamily?.(true);
  net.setDefaultAutoSelectFamilyAttemptTimeout?.(500);
} catch { /* older node: fall through to the DNS order below */ }
try {
  const dns = await import('node:dns');
  if (!process.env.OPENZOO_DNS_VERBATIM) dns.setDefaultResultOrder?.('ipv4first');
} catch { /* nothing to do */ }

const cmd = process.argv[2] || 'proxy';

const HELP = `openzoo — local x402-paying proxy + MCP server for openzoo.fun

usage:
  npx openzoo            start the proxy: http://localhost:8402/v1 (keyless) PLUS a
                         public HTTPS url for cloud IDEs (key required, printed at start)
  npx openzoo bot             Grok Bot.app on the zoo. Starts :8402 + aiserver on
                              :8443, then launches the app with
                              CURSOR_API_BASE_URL=https://127.0.0.1:8443
                              (no sudo, no /etc/hosts). Leave it running.
                              After a reboot the login item comes back without
                              that env — bot bounces it so send works. Already-
                              hijacked sessions are left alone.
                              --quit force bounce · --no-quit never bounce
                              --verbose  print every request the app makes
                                         (default is quiet: milestones + problems)
                              --web serve the renderer in a browser instead of
                              launching the .app (http://127.0.0.1:4174)
  npx openzoo web             Grok Bot renderer in the browser. Same hijack as
                              bot (proxy :8402 + aiserver :8443) but no Electron.
                              --no-open skip launching a tab
  npx openzoo cursor [dir]    start proxy+tunnel, write MCP config + every model
                              into the picker, and LAUNCH Cursor on [dir]
                              (defaults to the current directory; ~ works;
                               a missing dir is created)
                              --profile  use an isolated editor profile the
                                         vendor account cannot re-sync over
                              --block-backend  OPT-IN: point cursor's own backend
                                         at 127.0.0.1 so it cannot re-sync over your
                                         model list. WARNING: that host also serves
                                         cursor's own catalog, so the picker may show
                                         only "Auto". Undo: npx openzoo unblock
  npx openzoo vscode [path]   same, for VS Code
  npx openzoo editor [path]   whichever is installed (Cursor wins if both)
  npx openzoo claude [dir]        Claude Code CLI on the zoo (x402 per turn); --desktop for the app
                                          by default, --terminal for the Claude Code CLI
  npx openzoo launch <cmd> [args]   launch a TERMINAL Messages API client
                                    (claude, aider...) already pointed at the zoo
  npx openzoo grok-cli        point the grok CLI at the zoo — GROK MODELS ONLY,
                              paid per call by x402 instead of xAI first-party billing,
                              then TAKE OVER the app's backend: pins api2.cursor.sh in
                              /etc/hosts, serves it locally on :443 with byok_enabled,
                              and launches Grok Bot with Node TLS override (sudo required;
                              ctrl-c restores /etc/hosts).
                              --no-takeover plain launch · --no-launch config only
  npx openzoo voice      write like YOU — your own exports, paid per call
                         voice ingest --telegram <telegram_messages.txt> --twitter <archive dir>
                               parse your history into turns and bind the tier cascade
                               (cream / all telegram / all twitter) to the gateway + leCore
                         voice card --telegram <file>   distil the style card (one paid call)
                         voice say "draft"              rewrite a draft in your voice
                         voice login / voice watch      PREHOOK your own outgoing Telegram
                               messages: type raw, the watcher revises in place (userbot;
                               "." prefix sends raw). X has no edit API — no equivalent.
  npx openzoo openclaw   write the zoo into ~/.openclaw/openclaw.json as a model
                         provider WITH REAL PRICES (OpenClaw's own custom-provider
                         path hard-codes $0.00 and ignores /v1/models pricing)
                         --all (whole catalog) --models a,b (exact ids)
                         --default <id> (set the agents' primary model)
  npx openzoo aoe [aoe args]  Agent of Empires (tmux session manager for coding
                         agents): registers "openzoo" as an agent in aoe's
                         config.toml (= Claude Code on the zoo, detected as
                         claude so status/resume work), starts a background
                         proxy if none is up, then runs aoe.
                         aoe add . -l   one session in this dir, launched
                         --no-launch (config only) --no-proxy --tunnel
                         --override-claude (aoe's built-in claude pays via
                         the zoo too) --no-receipts (skip the Alt+z tool)
  npx openzoo mcp        stdio MCP server (tools: zoo_ask, zoo_bind, zoo_models, zoo_wallet, zoo_contexts)
  npx openzoo unblock    restore the editor's own backend in the hosts file
  npx openzoo tunnel     public-url-only mode (everything key-gated, no keyless localhost)
  npx openzoo demo       ~1M-token needle demo: direct refuses, the zoo answers
                         (run it twice — the second run reuses the bound corpus and is near-free)
  npx openzoo contexts   list corpora bound to the zoo (never re-uploaded)
  npx openzoo contexts --forget <hash|all>   drop manifest entries
  npx openzoo balance    wallet balance on every rail — Solana (USDC/TOKEN/SOL),
                         Base (USDC/ETH), Robinhood Chain (USDG/memecoins/ETH)
  npx openzoo address    print both funding addresses (Solana + EVM)
  npx openzoo help       this text

point any OpenAI-compatible harness at:
  base_url = http://localhost:8402/v1
  api_key  = sk-openzoo   (any value; the zoo takes payment, not keys)

rails (all three settle real payments; Solana is the default):
  OPENZOO_RAIL=solana|base|robinhood forces one rail — errors clearly if the
  live 402 does not offer it. Unset = Solana first.

env:
  OPENZOO_PORT (8402)  OPENZOO_API_BASE (https://x402-tokens.fly.dev)
  OPENZOO_RPC (mainnet-beta)  OPENZOO_TOKEN (402 rail preference)  OPENZOO_WALLET (~/.openzoo/wallet.json)
  OPENZOO_RAIL (unset — force a rail: solana | base | robinhood)
  OPENZOO_BASE_RPC (https://mainnet.base.org)  OPENZOO_RH_RPC (rpc.mainnet.chain.robinhood.com)
  OPENZOO_MAX_USD_PER_CALL (unset — NO per-call ceiling; set to add one)  OPENZOO_DEMO_MAX_USD (0.01)
  OPENZOO_ENABLE_RH (unset — every offered rail is a fallback, Robinhood tried LAST;
                     set 0 to drop Robinhood rows from default selection)
  OPENZOO_TUNNEL_MAX_USD (unset — NO public-url session ceiling; set to add one)  OPENZOO_TUNNEL_TOKEN (pin the api key)
  OPENZOO_NO_TUNNEL (0 — set 1 for localhost-only, no public url)`;

async function main() {
  switch (cmd) {
    case 'proxy':
    case 'start':
      await (await import('../lib/proxy.js')).startProxy({ autoTunnel: true });
      break;
    case 'bot':
      await (await import('../lib/grokcli.js')).runBot(process.argv.slice(3));
      break;
    case 'web':
      await (await import('../lib/grokbotweb.js')).runGrokBotWeb(process.argv.slice(3));
      break;
    case 'editor':
    case 'cursor':
    case 'vscode':
      // GUI editors read config files, not env vars — see lib/setup.js.
      await (await import('../lib/setup.js')).setupEditor(cmd === 'editor' ? undefined : cmd, process.argv[3]);
      break;
    case 'grok-cli':
    case 'grok':
      // Grok Bot (com.anysphere.sand) fronts the `grok` CLI, and the CLI reads
      // ~/.grok/config.toml — so pointing that model table at the local proxy
      // is enough; no patching of the app bundle.
      await (await import('../lib/grokcli.js')).setupGrokBot(process.argv.slice(3));
      break;
    case 'openclaw':
      await (await import('../lib/openclaw.js')).setupOpenClaw(process.argv.slice(3));
      break;
    case 'aoe':
      await (await import('../lib/aoe.js')).setupAoe(process.argv.slice(3));
      break;
    case 'voice':
      await (await import('../lib/voice.js')).runVoice(process.argv.slice(3));
      break;
    case 'sonar':
      await (await import('../lib/sonar.js')).runSonar(process.argv.slice(3));
      break;
    // @openzoobot. runXBot was only ever reachable as a library export, so the
    // obvious `openzoo xbot` printed usage and did nothing.
    case 'xbot': {
      const a = process.argv.slice(3);
      // --interval accepts seconds (15) or ms (15000); anything under 1000 is
      // read as seconds, because "--interval 15" meaning 15ms is never intended.
      const iv = Number(a[a.indexOf('--interval') + 1]);
      const intervalMs = a.includes('--interval') && Number.isFinite(iv) && iv > 0
        ? (iv < 1000 ? iv * 1000 : iv) : undefined;
      await (await import('../lib/xbot.js')).runXBot({
        once: a.includes('--once'),
        dryRun: a.includes('--dry-run') || a.includes('--dry'),
        seed: a.includes('--seed'),
        ...(intervalMs ? { intervalMs } : {}),
      });
      break;
    }
    case 'mcp':
      await (await import('../lib/mcp.js')).startMcp();
      break;
    case 'claude':
      await (await import('../lib/launch.js')).launchClaude(process.argv.slice(3));
      break;
    case 'launch': {
      const rest = process.argv.slice(3);
      const [harness, hargs] = [rest[0], rest.slice(1)];
      if (!harness) throw new Error('usage: openzoo launch <command> [args...]');
      await (await import('../lib/launch.js')).launchHarness(harness, hargs);
      break;
    }
    case 'unblock': {
      const { unblockBackend, unredirect443, isBlocked } = await import('../lib/hosts.js');
      try { unredirect443(); } catch { /* no redirect */ }
      try { (await import('../lib/hosts.js')).unbindBackend443(); } catch { /* no backend */ }
      const r = unblockBackend();
      console.log(r.already ? 'not blocked — nothing to undo' : (isBlocked() ? 'still blocked (sudo declined?)' : 'restored: the editor can reach its own backend again'));
      break;
    }
    case 'tunnel':
      await (await import('../lib/tunnel.js')).runTunnel();
      break;
    case 'demo':
      await (await import('../lib/demo.js')).runDemo();
      break;
    case 'contexts': {
      const { listContexts, forgetContexts } = await import('../lib/contexts.js');
      const fi = process.argv.indexOf('--forget');
      if (fi !== -1) {
        const sel = process.argv[fi + 1];
        if (!sel) throw new Error('usage: openzoo contexts --forget <hash-prefix|all>');
        console.log(`forgot ${forgetContexts(sel)} context(s)`);
        break;
      }
      const all = listContexts();
      if (!all.length) {
        console.log('no bound corpora yet — run `npx openzoo demo` or ask with a big body.');
        break;
      }
      const age = (iso) => {
        const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
        return s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`;
      };
      for (const c of all) {
        console.log(`${c.hash.slice(0, 12)}  ${c.context_id}  bound ${age(c.boundAt)} ago  ${c.apiBase}`);
      }
      console.log('\nthese corpora never ship again — asks against them send only the question + X-HRR-Context.');
      break;
    }
    case 'bind': {
      const target = process.argv[3];
      if (!target) throw new Error('usage: openzoo bind <file-or-directory> [--ext .txt,.md] [--force]');
      const { bindPath } = await import('../lib/bindpath.js');
      const ei = process.argv.indexOf('--ext');
      const exts = ei !== -1 && process.argv[ei + 1]
        ? process.argv[ei + 1].split(',').map((e) => (e.startsWith('.') ? e : `.${e}`))
        : undefined;
      const mb = (n) => (n / 1048576).toFixed(1);
      // Delta uploads are routinely a few KB against a multi-MB corpus; "0.0MB
      // of 3.2MB" reads as a bug. Pick the unit per number.
      const hb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${(n / 1024).toFixed(0)}KB` : `${n}B`);
      const out = await bindPath(target, {
        exts,
        force: process.argv.includes('--force'),
        onProgress: (p) => {
          if (p.stage === 'reused') console.log(`already bound — ${mb(p.bytes)}MB across ${p.files} file(s) reused, nothing uploaded`);
          if (p.stage === 'start') console.log(`binding ${mb(p.bytes)}MB from ${p.files} file(s) in ${p.parts} part(s)...`);
          if (p.stage === 'part') console.log(`  part ${p.index}/${p.of} bound (${mb(p.bytes)}MB)`);
          // DELTA: the server already holds most of a re-bound repo, so say
          // how much is actually crossing the wire — that number is the reason
          // re-binding after an edit is cheap, and hiding it makes the feature
          // look like a no-op.
          if (p.stage === 'delta') {
            console.log(p.missing === 0
              ? `delta: server already holds all ${p.chunks} chunk(s) of ${hb(p.bytes)} — nothing to upload`
              : `delta: ${p.missing} of ${p.chunks} chunk(s) missing on the server, uploading only those...`);
          }
          if (p.stage === 'delta-fill') console.log(`  shipped ${hb(p.shipped)} of ${hb(p.of)}${p.remaining ? ` (${p.remaining} still missing)` : ''}`);
        },
      });
      console.log('');
      if (out.delta) {
        const pct = out.bytes ? ((100 * out.shipped) / out.bytes).toFixed(1) : '0.0';
        console.log(`bound via delta — uploaded ${hb(out.shipped)} of ${hb(out.bytes)} (${pct}%)`);
      }
      console.log(`context: ${out.contextId}`);
      console.log(`ask it:  npx openzoo ask "your question" --context ${out.contextId}`);
      console.log('or send X-HRR-Context: <id> with a small body to /v1/chat/completions');
      break;
    }
    case 'ask': {
      const question = process.argv[3];
      if (!question) throw new Error('usage: openzoo ask "<question>" [--context <id>] [--model <id>] [--system <text>]');
      const ci = process.argv.indexOf('--context');
      const mi = process.argv.indexOf('--model');
      // A BARE QUESTION IS A DIFFERENT PRODUCT FROM A BRIEFED ONE.
      //
      // This path drives PayClient straight at the gateway, so it never passes
      // through the local proxy that injects lib/brief.js — the model gets the
      // user's words and nothing else. OBSERVED from the Omarchy bar widget:
      // "do you even love omarchy thru this uiux?!?" came back "I think you
      // mean *anarchy*?" from deepseek, while the same question in the terminal
      // (Claude Code: full system prompt + the omarchy skill) answered about
      // DHH, Hyprland and theming. Same gateway, same product, one had context.
      // A caller that knows where it is running can now say so.
      const si = process.argv.indexOf('--system');
      const system = si !== -1 ? process.argv[si + 1] : '';
      const { PayClient } = await import('../lib/pay.js');
      const { config } = await import('../lib/config.js');
      const client = new PayClient();
      const headers = { 'content-type': 'application/json' };
      if (ci !== -1 && process.argv[ci + 1]) headers['x-hrr-context'] = process.argv[ci + 1];
      const { response, receipt } = await client.fetch(`${config.apiBase}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: (mi !== -1 && process.argv[mi + 1]) || process.env.OPENZOO_DEFAULT_MODEL || 'anthropic/claude-opus-5',
          messages: system
            ? [{ role: 'system', content: system }, { role: 'user', content: question }]
            : [{ role: 'user', content: question }],
          max_tokens: Number(process.env.OPENZOO_ASK_MAX_TOKENS || 1024),
        }),
      });
      if (!response.ok) throw new Error(`zoo returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const data = await response.json();
      console.log(data.choices?.[0]?.message?.content ?? '(no content)');
      if (receipt) console.error(`\n${receipt.line}`);
      break;
    }
    case 'balance':
      await (await import('../lib/info.js')).printBalance();
      break;
    case 'topup':
    case 'prepay':
      await (await import('../lib/info.js')).topUp(process.argv[3]);
      break;
    case 'credit':
    case 'credits': {
      const bal = await (await import('../lib/info.js')).creditBalance();
      console.log(`prepaid credit: $${bal.toFixed(6)}`);
      if (bal <= 0) console.log('buy some with:  npx openzoo topup 10');
      break;
    }
    case 'address':
      (await import('../lib/info.js')).printAddress();
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    case 'version':
    case '--version':
    case '-v':
    case '-V': {
      // Every installer, mise shim and shell script that probes a CLI asks
      // this first; answering "unknown command" to it failed real installs.
      const { readFileSync } = await import('fs');
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      console.log(pkg.version);
      break;
    }
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`openzoo: ${err.message}`);
  process.exit(1);
});
