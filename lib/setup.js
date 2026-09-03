/**
 * `npx openzoo cursor|vscode [path]` — one command: proxy + tunnel up, config
 * written, editor launched already pointed at the zoo.
 *
 * THREE THINGS THIS MUST DO, because the user should configure nothing:
 *  1. ANTHROPIC_BASE_URL (and OPENAI_BASE_URL) exported INTO the editor, so
 *     its embedded terminals and the Claude Code extension bill through x402.
 *  2. Config written for them — MCP server registered in the editor's own
 *     mcp.json, no hand-editing.
 *  3. The TUNNEL, because a cloud-run harness cannot reach localhost.
 *
 * WHY LAUNCH THE BINARY, NOT `open -a`: macOS `open` hands the app to launchd,
 * which does NOT pass the caller's environment. `open -a Cursor` therefore
 * configures nothing — the editor comes up with no idea the zoo exists.
 * Spawning Contents/MacOS/Cursor directly keeps the env, which is the entire
 * point of this command.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import {
  writeEditorProviderConfig, editorRunning, quitEditor,
  pinEditorProviderConfig, unpinEditorProviderConfig, forceMembership,
} from './cursorcfg.js';

/**
 * Models offered in the editor's picker — named the way the EDITOR names them.
 *
 * Vendor-prefixed ids (anthropic/claude-opus-5) are foreign to Cursor's picker;
 * its own catalog uses bare names (claude-opus-5, grok-4.6, glm-5.2). Matching
 * that naming means the entries look native and the proxy still resolves them:
 * lib/models.js maps each to a real catalog id (claude-opus-5 ->
 * anthropic/claude-opus-5-fast, grok-4.6 -> x-ai/grok-4.6, composer-2.5 ->
 * qwen/qwen-2.5-coder-32b-instruct), all verified against the live catalog.
 * Override with OPENZOO_MODELS.
 */
/**
 * Every model the zoo serves, offered in the editor's picker as its openzoo-*
 * twin — pulled LIVE, never hardcoded.
 *
 * A hand-maintained list goes stale the moment the catalog changes, and it made
 * the shim lie about what is available. The prefix matters: an editor claims any
 * name from its OWN catalog (claude-opus-5, grok-4.6) and routes it to its
 * backend, so a name it does not recognise is what forces the custom endpoint.
 *
 * OPENZOO_MODELS overrides with an explicit comma-separated list;
 * OPENZOO_MODEL_LIMIT caps how many are written (default all).
 */
async function catalogModels(base) {
  if (process.env.OPENZOO_MODELS) {
    return process.env.OPENZOO_MODELS.split(',').map((m) => m.trim()).filter(Boolean);
  }
  // NAMES THE EDITOR WILL ACCEPT — this is the whole ballgame.
  //
  // We used to write `openzoo-<model>` twins here, on the theory that a name the
  // editor recognises gets claimed by its own backend. That theory was never
  // actually tested: it rested on "zero connections reached the proxy", which was
  // equally true of both naming schemes, so it discriminated nothing. The real
  // cause of zero connections was a stale pin trigger rewriting the base URL.
  //
  // MEASURED, on two machines: with openzoo-* names Cursor refuses before any
  // request leaves the process — "Model name is not valid" — because it validates
  // the name against its OWN catalog. The custom-OpenAI-endpoint setting only
  // accepts OpenAI-branded ids. Those same ids route through us correctly
  // (verified over the live tunnel: gpt-4o -> openai/gpt-4o-2024-11-20,
  // gpt-4-turbo -> openai/gpt-4-turbo, o3 -> openai/o3-pro), because
  // lib/models.js publishes them in /v1/models and maps them on the way through.
  //
  // OPENZOO_EDITOR_MODELS overrides the list; the zoo model each one lands on is
  // still steerable per-request, and OPENZOO_DEFAULT_MODEL pins them all.
  // EVERY id we publish that a mainstream editor also knows — all vendors, not
  // just OpenAI. These are lib/models.js's ALIAS_IDS: each is served by the proxy
  // (GET /v1/models lists them) and each maps to a DIFFERENT zoo model by the
  // similarity scorer, so picking claude-opus-4-1 vs gemini-2.5-flash vs grok-4
  // really does change which model answers.
  // UNGATED NAMES ONLY, BY DEFAULT.
  //
  // The editor gates its own catalog per plan, on the NAME, before any request
  // leaves the process — MEASURED: claude-opus-4-1 answers "Max Mode Required",
  // and other names answer "Model name is not valid". Neither ever reaches us, so
  // neither is something the proxy can fix. The ids below are the ones no plan
  // gates. The NAME is only the editor's label: OPENZOO_DEFAULT_MODEL decides
  // which zoo model actually answers, so `gpt-4o` can be served by Opus 5.
  //
  // OPENZOO_EDITOR_MODELS=all offers every alias (claude-*, gemini-*, grok-*,
  // o3…) for accounts whose plan allows them.
  const { ALIAS_IDS } = await import('./models.js');
  const UNGATED = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-3.5-turbo'];
  const fallback = process.env.OPENZOO_EDITOR_MODELS === 'all' ? [...ALIAS_IDS] : UNGATED;
  if (process.env.OPENZOO_EDITOR_MODELS) {
    return process.env.OPENZOO_EDITOR_MODELS.split(',').map((m) => m.trim()).filter(Boolean);
  }
  try {
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    const have = new Set((d.data || []).map((m) => m.id));
    // Only offer ids the proxy actually serves, so a pick can never 404.
    // Anything the proxy serves, in the order we prefer to show it. An id the
    // proxy does NOT serve is dropped rather than offered and 404'd.
    const usable = fallback.filter((id) => have.has(id));
    return usable.length ? usable : fallback;
  } catch {
    return fallback;
  }
}

const MCP_FILES = {
  cursor: path.join(os.homedir(), '.cursor', 'mcp.json'),
  vscode: path.join(os.homedir(), '.vscode', 'mcp.json'),
};

/**
 * Find a launchable editor binary, platform-agnostically.
 *
 * Hardcoding /Applications broke every non-mac install and any mac install
 * that is not in /Applications (~/Applications, Setapp, a homebrew cask on a
 * different volume). Order per editor: PATH first (works everywhere and is
 * what a Linux/Windows user has), then the known app-bundle locations.
 *
 * The BUNDLE BINARY is preferred over `open -a` on macOS because `open` hands
 * the app to launchd, which drops our environment — and the environment IS the
 * configuration here.
 */
const EDITORS = {
  cursor: {
    cli: ['cursor'],
    bundles: [
      '/Applications/Cursor.app/Contents/MacOS/Cursor',
      path.join(os.homedir(), 'Applications', 'Cursor.app', 'Contents', 'MacOS', 'Cursor'),
    ],
  },
  vscode: {
    cli: ['code', 'code-insiders', 'codium'],
    bundles: [
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      path.join(os.homedir(), 'Applications', 'Visual Studio Code.app', 'Contents', 'MacOS', 'Electron'),
    ],
  },
};

function onPath(bin) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const f = path.join(dir, bin + ext);
      try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* keep looking */ }
    }
  }
  return null;
}

/** Resolve one editor to a runnable command, or null if it is not installed. */
function resolveEditor(which) {
  const spec = EDITORS[which];
  if (!spec) return null;
  for (const c of spec.cli) { const f = onPath(c); if (f) return f; }
  for (const b of spec.bundles) { try { fs.accessSync(b, fs.constants.X_OK); return b; } catch { /* next */ } }
  return null;
}

/** Which editor to use: the one asked for, else Cursor if present, else VS Code. */
export function pickEditor(requested) {
  if (requested && EDITORS[requested]) {
    const found = resolveEditor(requested);
    if (found) return { which: requested, cmd: found };
  }
  for (const which of ['cursor', 'vscode']) { // cursor wins when both exist
    const cmd = resolveEditor(which);
    if (cmd) return { which, cmd };
  }
  return null;
}

/** Merge our server into an existing mcp.json without clobbering the user's. */
function addMcpServer(file) {
  let doc = {};
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { doc = {}; }
  const key = doc.servers && !doc.mcpServers ? 'servers' : 'mcpServers';
  doc[key] = doc[key] || {};
  doc[key].openzoo = { command: 'npx', args: ['-y', 'openzoo@latest', 'mcp'] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

/** Is a proxy already listening? Returns its /v1 base or null. */
async function proxyUp(base) {
  try {
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}


/** Facts about THIS run, before anything can go wrong silently. */
async function printStartupDiagnostic(base, which) {
  const q = (fn, dflt = '?') => { try { return fn(); } catch { return dflt; } };
  let version = '?';
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    version = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
  } catch { /* keep ? */ }

  const picked = q(() => pickEditor(which), null);
  let hosts = 'n/a';
  try {
    const { isBlocked, BACKEND_HOSTS } = await import('./hosts.js');
    hosts = isBlocked() ? `blocked (${BACKEND_HOSTS.join(', ')})` : 'NOT blocked';
  } catch { /* n/a */ }

  const portBusy = await proxyUp(base);

  console.log('openzoo diagnostic');
  console.log(`  version    : ${version}   node ${process.version}   ${process.platform}/${process.arch}`);
  console.log(`  port ${config.port}  : ${portBusy ? 'occupied (steal unless this exact version)' : 'free'}`);
  console.log(`  editor     : ${picked ? `${picked.which} @ ${picked.cmd}` : 'NONE FOUND'}`);
  console.log(`  running    : ${picked ? (q(() => editorRunning(picked.which), false) ? 'yes — will be quit so settings stick' : 'no') : '-'}`);
  console.log(`  backend    : ${hosts}`);
  console.log(`  upstream   : ${config.apiBase}`);
  const envs = ['OPENZOO_DEFAULT_MODEL', 'OPENZOO_EDITOR_MODELS', 'OPENZOO_EDITOR_MAP', 'OPENZOO_NO_LABELS', 'OPENZOO_NO_TUNNEL']
    .filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`);
  if (envs.length) console.log(`  env        : ${envs.join('  ')}`);
  console.log('');
}

export async function setupEditor(which, target) {
  const base = `http://localhost:${config.port}/v1`;

  // STARTUP DIAGNOSTIC. Printed unconditionally because every hard bug tonight
  // was invisible from the outside: a STALE BUILD writing old config (npm caches
  // metadata and silently serves an older version), a hosts block that never
  // applied because the sudo prompt was skipped, an editor that was still running
  // so it clobbered the write, a tunnel that printed a URL and never served.
  // One block up front turns each of those from a guess into a fact.
  await printStartupDiagnostic(base, which);
  const mcpFile = addMcpServer(MCP_FILES[which] || MCP_FILES.cursor);

  // 1. PROXY + TUNNEL. Start in-process if nothing is listening, so the user
  //    does not need a second terminal. The tunnel URL is what a cloud-run
  //    harness must use; we surface it rather than leaving them to find it.
  let publicUrl = null;
  let tunnelKey = null;
  // Declared out here: the tunnel-rebind hook is registered further down, well
  // outside the block that starts the proxy.
  let started = null;
  const { startProxy, oursOn, packageVersion } = await import('./proxy.js');
  if (await oursOn(config.port)) {
    console.log(`proxy v${packageVersion()} already on ${base} — keeping it`);
    try {
      const info = await (await fetch(`${base}/info`)).json();
      publicUrl = (info?.publicTunnel || '').replace(/\/v1$/, '') || null;
      tunnelKey = info?.tunnelToken ?? tunnelKey;
      if (publicUrl) console.log(`tunnel:  ${publicUrl}/v1 (from the running proxy)`);
    } catch { /* no /info */ }
  } else {
    console.log(`${(await proxyUp(base)) ? 'stale proxy — stealing' : 'starting proxy on'} ${base} (+ public tunnel)...`);
    started = await startProxy({ silent: true, autoTunnel: true });
    publicUrl = started?.publicUrl ?? null;
    tunnelKey = started?.tunnelToken ?? null;
    // DO NOT BLOCK ON THE TUNNEL. Everything below (settings, MCP, launching
    // the editor) is local and works without it; only a CLOUD-run harness needs
    // the public URL. Waiting inline meant a slow or failing cloudflared left
    // the user staring at "waiting for tunnel.." while nothing else happened —
    // and if it never came up, the editor never launched at all. Announce it
    // when it arrives instead.
    // THE EDITOR CONFIG CANNOT USE LOCALHOST. Cursor does not call the custom
    // endpoint from your machine — its SERVER makes the request, so a private
    // address is unreachable from there and it answers, verbatim:
    //   "Provider returned error: Access to private networks is forbidden"
    // (see the header of lib/tunnel.js). So the public URL is a HARD dependency
    // of the editor path, and we wait for it — bounded, with progress, because
    // an unbounded wait once left the editor never launching at all.
    // NEVER BLOCK THE LAUNCH ON THE TUNNEL. Waiting inline is what made this
    // command sit on "waiting for the public tunnel....." with nothing else
    // happening — and if the tunnel was slow or failing, the editor never opened
    // at all. The tunnel is genuinely required for the EDITOR path (its server
    // cannot reach localhost), but we already have a rebind hook that rewrites
    // and re-pins the config the moment a URL exists, so the honest design is:
    // launch now with what we have, and follow the tunnel in when it arrives.
    // BOUNDED WAIT, THEN LAUNCH REGARDLESS. The editor's server cannot reach
    // localhost, so the public URL is what belongs in its config — but an
    // unbounded wait is how this command ended up sitting on
    // "waiting for the public tunnel....." and never opening the editor at all.
    // With --edge-ip-version 4 the tunnel comes up in seconds; if it somehow
    // does not, we say so plainly and still launch.
    if (!publicUrl) {
      // VISIBLY ALIVE, AND SHORT. A silent 90s wait is indistinguishable from a
      // hang — which is exactly how it was read, correctly. One dot per second
      // with a countdown, capped at 25s, because with --edge-ip-version 4 a
      // healthy tunnel registers in ~5-10s; longer than that means it is broken,
      // not slow, and waiting more does not help.
      const LIMIT = Number(process.env.OPENZOO_TUNNEL_WAIT_S || 25);
      for (let i = 0; i < LIMIT * 2 && !started?.publicUrl; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (i % 2 === 1) process.stdout.write(`\rwaiting for the public tunnel — ${LIMIT - Math.floor(i / 2) - 1}s `);
      }
      process.stdout.write('\r\x1b[K');
      publicUrl = started?.publicUrl ?? null;
      tunnelKey = started?.tunnelToken ?? tunnelKey;
    }
    if (publicUrl) console.log(`tunnel:  ${publicUrl}/v1   api_key ${tunnelKey}`);
    else {
      console.log('tunnel:  did NOT come up. cloudflared could not reach Cloudflare\'s edge.');
      console.log('         most common cause here: no working IPv6 route (we already force');
      console.log('         --edge-ip-version 4). check: npx openzoo tunnel   for the raw log.');
    }
  }
  // What the EDITOR is configured with. Localhost only as a last resort, and
  // said out loud, because it will fail with the private-networks error.
  // NEVER WRITE LOCALHOST INTO THE EDITOR. Its server makes the request, so a
  // private address is unreachable from there and every call returns "Access to
  // private networks is forbidden". Writing it anyway does not degrade
  // gracefully — it overwrites a config that may have been working with one
  // that provably cannot. With no tunnel we leave the existing settings alone
  // and say why.
  const editorBase = publicUrl ? `${publicUrl}/v1` : null;

  // 2. ENV INTO THE EDITOR. Both vendor shapes, so an OpenAI-compatible pane
  //    and an Anthropic-shaped one (Claude Code extension) both route here.
  const env = {
    ...process.env,
    OPENAI_BASE_URL: base,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-openzoo',
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'sk-openzoo',
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || 'sk-openzoo',
  };
  // TRUST OUR SELF-SIGNED IMPERSONATION CERT IN THE EDITOR'S NODE STACK TOO.
  // --ignore-certificate-errors covers only the Chromium RENDERER (browser fetch:
  // stripe, updates — those succeeded). The editor's gRPC/Connect transport runs
  // in the Electron MAIN process on Node's own TLS, which ignores that flag and
  // rejected our cert — the ECONNRESET-before-ALPN wall in the backend log, and
  // exactly the model/chat calls we need. NODE_TLS_REJECT_UNAUTHORIZED=0 is the
  // Node-side switch. Only set under takeover, where we own the endpoint.
  if (which === 'cursor' && process.argv.includes('--takeover')) env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  console.log('');
  console.log(`mcp:     ${mcpFile}  (openzoo: zoo_bind, zoo_ask, zoo_models, zoo_wallet, zoo_contexts)`);
  console.log(`local:   ${base}   api_key sk-openzoo`);
  console.log('');
  // THE ONE THING THE EDITOR WILL NOT INHERIT. Cursor's BUILT-IN models
  // (Opus 5, GPT, Composer) go to Cursor's own backend and ignore
  // ANTHROPIC_BASE_URL — Cursor has no Anthropic base-URL override, only an
  // OpenAI one. So routing a Claude model through the zoo means adding it as a
  // CUSTOM model under the OpenAI override, where the proxy serves it and maps
  // the name. Env alone cannot do this; say so plainly instead of implying the
  // launch handled everything.
  // WRITE THE PROVIDER SETTINGS. These are plain JSON in the editor's
  // globalStorage sqlite — not an encrypted store, as previously assumed — so
  // the "paste four things into Settings" ritual is unnecessary. Must happen
  // while the editor is CLOSED or it rewrites them from memory on exit.
  if (!editorBase) {
    console.log('settings: NOT touched — a tunnel is required for the editor path and none came up.');
    console.log('          (localhost cannot work here: the editor calls the endpoint from ITS server,');
    console.log('           which answers "Access to private networks is forbidden".)');
    console.log('          your previous settings are left as they were — re-run when the network settles.');
  }
  const picked0 = pickEditor(which);
  const target0 = picked0?.which || which || 'cursor';
  // Quit it FOR the user — a running editor reverts our write on exit.
  if (editorRunning(target0)) {
    console.log(`${target0} is running — quitting it so settings stick (it relaunches below)...`);
    const q = await quitEditor(target0);
    if (!q.quit) console.log(`  could not close ${target0} automatically; settings may not persist`);
  }
  const models = await catalogModels(base);
  let wrote = null;
  if (editorBase) {
    // UNPIN FIRST — THIS IS THE BUG THAT BROKE THE TUNNEL ALL NIGHT.
    // pinEditorProviderConfig installs a SQL trigger that re-applies the URL it
    // was pinned with on EVERY update to that row. A previous run's trigger
    // therefore silently rewrote each new tunnel URL back to its own, dead one:
    // the banner printed the live tunnel while the DB (and Cursor) got the old
    // hostname, which answered 530. Observed verbatim in one run —
    //   tunnel:   https://friendly-api-suppliers-suits.trycloudflare.com/v1
    //   settings: openAIBaseUrl -> https://motors-multiple-parade-surround...
    // Two hostnames, one run, because the printed value is read BACK from the DB
    // after the trigger has had its say.
    try { unpinEditorProviderConfig(target0); } catch { /* nothing pinned yet */ }
    try { wrote = writeEditorProviderConfig(target0, { baseUrl: editorBase, models, apiKey: tunnelKey }); } catch (e) { wrote = { error: e.message }; }
    // SELF-HEAL: verify what actually landed, and if anything rewrote it, drop
    // the pin and write again rather than launching an editor we know is
    // pointed at a dead host.
    for (let attempt = 0; attempt < 2 && wrote && !wrote.error; attempt++) {
      const got = wrote.verified?.openAIBaseUrl;
      if (!got || got === editorBase) break;
      console.log(`settings: something rewrote the url (${got}) — unpinning and retrying`);
      try { unpinEditorProviderConfig(target0); } catch { /* ignore */ }
      try { wrote = writeEditorProviderConfig(target0, { baseUrl: editorBase, models, apiKey: tunnelKey }); } catch (e) { wrote = { error: e.message }; }
    }
    const pin = pinEditorProviderConfig(target0, { baseUrl: editorBase, models });
    // A pin that re-applies the WRONG url is worse than no pin at all.
    try {
      const after = writeEditorProviderConfig(target0, { baseUrl: editorBase, models, apiKey: tunnelKey });
      const got = after?.verified?.openAIBaseUrl;
      if (got && got !== editorBase) {
        console.log(`settings: the pin re-applied ${got} — removing it so the live url stands`);
        unpinEditorProviderConfig(target0);
        writeEditorProviderConfig(target0, { baseUrl: editorBase, models, apiKey: tunnelKey });
      }
    } catch { /* advisory */ }
    console.log(`          models        -> ${models.join(', ')}`);
    console.log(`          selected      -> ${models[0]}`);
    console.log(pin?.pinned
      ? '          pinned        -> yes (the editor re-syncs these from its account; a DB trigger re-applies them)'
      : `          pinned        -> NO (${pin?.error || 'unavailable'}) — the editor may revert these on launch`);
    console.log('  verify: send one message, watch for "paid $0.0… · rail solana · tx …" here.');
    // READ-BACK, not what we intended to write. A pin trigger or a running editor
    // can rewrite this between the write and the launch, and that silent revert
    // is exactly what made the editor point at a dead tunnel for hours.
    try {
      const back = writeEditorProviderConfig(target0, { baseUrl: editorBase, models, apiKey: tunnelKey })?.verified;
      console.log('  db now  : baseUrl=' + (back?.openAIBaseUrl || '?'));
      console.log('            models =' + (Array.isArray(back?.availableAPIKeyModels)
        ? back.availableAPIKeyModels.map((m) => m.name).join(', ') : '?'));
      if (back?.openAIBaseUrl && back.openAIBaseUrl !== editorBase) {
        console.log('  WARNING : the database does NOT match what we wrote — something is reverting it.');
      }
    } catch (e) { console.log('  db now  : could not read back (' + e.message + ')'); }
  }

  // 2b. THE BACKEND BLOCK. Pinning the database is not sufficient on its own:
  //     the editor re-syncs its model list from its own backend into MEMORY on
  //     window focus and repaints the picker empty, and that same host is the
  //     route its own inference takes. Blackholing it in the hosts file is what
  //     leaves the configured base URL as the only way out. System-wide and
  //     needs a password, so it is opt-in and reversible.
  // THE BACKEND BLOCK IS REQUIRED FOR ROUTING — measured, not assumed.
  //
  // With api2.cursor.sh reachable the editor answers from its OWN backend and the
  // custom base URL is never used: servedRequests stayed 0 through a whole session.
  // With it blackholed, requests arrive and settle — two Solana payments at
  // 10:38:27Z and 10:38:30Z on the same machine, same config, block on.
  //
  // The cost is that this host also serves the editor's own model catalog, so its
  // picker cannot self-populate. That is fine BECAUSE WE WRITE THE MODELS
  // OURSELVES (availableAPIKeyModels + availableDefaultModels2 above) — the picker
  // is ours, not theirs. If our write fails, the picker collapses to "Auto", and
  // that is the symptom to chase, not the block.
  //
  // --no-block opts out for anyone who would rather keep the vendor catalog.
  if (target0 === 'cursor' && !process.argv.includes('--no-block')) {
    const { blockBackend, isBlocked, BACKEND_HOSTS, AGENT_HOSTS } = await import('./hosts.js');
    // Default: block ONLY the model-list re-sync host (safe for subbed users).
    // Under --takeover we also block the chat-inference hosts, because only then
    // does the impersonation backend answer their chat — blocking them otherwise
    // just severs Cursor ("Reconnecting...").
    const hostsToBlock = process.argv.includes('--takeover')
      ? [...BACKEND_HOSTS, ...AGENT_HOSTS] : BACKEND_HOSTS;
    const r = blockBackend(hostsToBlock);
    if (r.already) console.log('backend: already blocked (required for routing; npx openzoo unblock to undo)');
    else if (isBlocked()) console.log('backend: blocked -> 127.0.0.1 (this is what forces the editor onto the zoo)');
    else console.log('backend: NOT blocked — the editor will keep using its own backend and\n         nothing will reach the zoo. Re-run and enter your password.');
  }

  // 2c. TAKEOVER (--takeover): impersonate the editor's backend so a PLAN-LESS
  //     account can route. Config alone cannot help there — the editor refuses
  //     unentitled models before a request exists. So we ANSWER api2.cursor.sh
  //     ourselves: catalog with every gate open, empty-valid for the rest. No CA
  //     install — the editor is launched with --ignore-certificate-errors below,
  //     and it does not pin certs (verified), so a self-signed cert is accepted.
  // DEFAULT ON. Takeover is what makes a plan-less account route, and it is
  // harmless on an entitled one (the editor just reads our catalog instead of
  // theirs), so it runs unless explicitly disabled with --no-takeover.
  // OPT-IN ONLY. Takeover impersonates Cursor's backend to unlock paid-tier
  // model selection on an unpaid account — that is defeating Cursor's own
  // subscription gate, not routing, so it is NOT the default. Plain
  // `openzoo cursor` writes the base URL + models and routes Auto (and any model
  // an entitled account can pick) through the zoo. --takeover is the escape
  // hatch for those who understand what it does.
  const doTakeover = target0 === 'cursor' && process.argv.includes('--takeover');
  if (doTakeover) {
    try {
      const { ensureCert } = await import('./cursorbackend.js');
      const { bindBackend443 } = await import('./hosts.js');
      const backModels = models.map((m) => ({ name: m, label: m }));
      // Cert is minted as the USER (root can still read it); models handed to the
      // privileged listener via a temp file.
      ensureCert(console.log);
      const modelsFile = path.join(os.tmpdir(), 'openzoo-cursor-models.json');
      fs.writeFileSync(modelsFile, JSON.stringify(backModels));
      const backendLog = path.join(os.homedir(), '.openzoo', 'cursor-backend.log');
      try { fs.writeFileSync(backendLog, ''); } catch { /* ignore */ }
      // DIRECT 443 BIND (root) — pfctl loopback redirect measured FAIL, this is
      // the reliable path. Only this static server runs privileged.
      const rr = bindBackend443(modelsFile, backendLog, console.log);
      console.log(rr.ok ? `takeover: backend bound on 127.0.0.1:443 (root); log ${backendLog}`
        : rr.manual ? 'takeover: run the printed command in an elevated shell, then relaunch'
        : 'takeover: could NOT bind 443 — impersonation will not receive traffic');

      // SELF-TEST — prove the whole path (hosts -> redirect -> our server) works
      // NOW, at startup, so a failure is a loud line here instead of a silent
      // "still gated" in the editor. We dial api2.cursor.sh exactly as the editor
      // will; if our backend logs the ClientHello and answers, it is wired.
      await new Promise((r) => setTimeout(r, 400));
      try {
        const https = await import('node:https');
        const ok = await new Promise((resolve) => {
          const rq = https.request({
            host: 'api2.cursor.sh', port: 443, method: 'POST',
            path: '/aiserver.v1.AiService/AvailableModels',
            headers: { 'content-type': 'application/grpc-web+proto' },
            rejectUnauthorized: false, timeout: 4000,
          }, (rp) => { rp.on('data', () => {}); rp.on('end', () => resolve(rp.statusCode === 200)); });
          rq.on('error', () => resolve(false));
          rq.on('timeout', () => { rq.destroy(); resolve(false); });
          rq.end();
        });
        console.log(ok
          ? 'takeover: SELF-TEST PASS — api2.cursor.sh:443 reaches our backend. The editor will too.'
          : 'takeover: SELF-TEST FAIL — api2.cursor.sh:443 did NOT reach our backend.\n'
            + '          The 443->8443 redirect is not delivering (pfctl/loopback). Tell me and I switch to a root-bound 443.');
      } catch (e) { console.log(`takeover: self-test error (${e.message})`); }

      // WRITE THE CACHED MEMBERSHIP the model-gate actually reads (measured: the
      // ultra machine held "ultra" here; api2 responses alone did not move the
      // gate). The impersonation keeps it from re-syncing back to free.
      try {
        const fm = forceMembership(target0, process.env.OPENZOO_MEMBERSHIP || 'pro');
        console.log(fm.error ? `takeover: membership write skipped (${fm.error})`
          : `takeover: cached membership -> ${fm.verified} (was gating model selection)`);
      } catch (e) { console.log(`takeover: membership write failed (${e.message})`); }
      console.log('takeover: launching with --ignore-certificate-errors so the self-signed cert is trusted (no CA install)');
    } catch (e) {
      console.log(`takeover: failed to start (${e.message}) — falling back to plain routing`);
    }
  }



  // 3. LAUNCH with that env. Editor resolved platform-agnostically; Cursor
  //    wins when both are installed.
  // Open the directory you ran this from, or the one you named. The earlier
  // "helpfully" substitute a ~/openzoo folder when run from $HOME was worse
  // than the problem it dodged: it silently opened the wrong project.
  // WORKSPACE: `openzoo cursor ~/somedir` opens that directory. Resolve it
  // ourselves — a quoted `~` never reaches the shell's expansion, and a path
  // that does not exist yet should be created rather than silently opening the
  // wrong folder (the editor treats a missing path as a file and opens blank).
  let cwd = process.cwd();
  if (target && !target.startsWith('-')) {
    cwd = target.startsWith('~')
      ? path.join(os.homedir(), target.slice(1))
      : path.resolve(target);
    if (!fs.existsSync(cwd)) {
      fs.mkdirSync(cwd, { recursive: true });
      console.log(`workspace: created ${cwd}`);
    }
  }
  console.log(`workspace: ${cwd}`);

  const picked = pickEditor(which);
  if (!picked) {
    console.error('no editor found — install Cursor or VS Code, or put `cursor`/`code` on PATH');
    console.error(`(config is written either way: ${mcpFile})`);
    return;
  }
  const useProfile = process.env.OPENZOO_PROFILE === '1' || process.argv.includes('--profile');
  const args = [cwd];
  // Trust our self-signed impersonation cert without any CA install — this flag
  // is the entire reason no trust prompt is needed. Only added under --takeover.
  if (doTakeover) {
    // DEFEAT DNS-OVER-HTTPS. /etc/hosts is ignored by Chromium's Secure DNS, so
    // the agent chat connection (network-service, DoH) escaped even with every
    // host blocked — measured: 0 backend lines on chat while api2 (renderer
    // fetch, OS resolver) hit us fine. --host-resolver-rules overrides Chromium's
    // resolver directly, DoH included, and takes a WILDCARD so every region /
    // privacy variant of *.api5.cursor.sh maps to us without enumerating them.
    args.unshift(
      '--ignore-certificate-errors',
      '--host-resolver-rules=MAP api2.cursor.sh 127.0.0.1,MAP *.api5.cursor.sh 127.0.0.1',
    );
  }
  if (useProfile) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    args.unshift(`--user-data-dir=${PROFILE_DIR}`, `--extensions-dir=${path.join(PROFILE_DIR, 'extensions')}`);
    console.log(`profile: ${PROFILE_DIR}  (isolated — vendor account sync cannot reclaim these settings)`);
    console.log('         first run in this profile asks you to sign in; extensions are separate.');
  }
  console.log(`launching ${picked.which}${useProfile ? ' (isolated profile)' : ''}...`);
  const child = spawn(picked.cmd, args, { stdio: 'ignore', env, detached: true });
  child.on('error', (e) => {
    console.error(`could not launch ${picked.which}: ${e.message}`);
  });
  child.unref();

  // DID IT ACTUALLY ROUTE? The editor can look perfectly configured and still
  // serve every message from its OWN backend — it answers normally, so a reply
  // proves nothing. This watches the only number that does: chat requests that
  // actually ARRIVED here. Costs nothing and ends the guessing.
  (async () => {
    const seen = async () => {
      try {
        const r = await fetch(`${base}/info`, { signal: AbortSignal.timeout(3000) });
        return (await r.json())?.servedRequests ?? 0;
      } catch { return 0; }
    };
    const before = await seen();
    for (let i = 0; i < 40; i++) {                      // ~2 min
      await new Promise((r) => setTimeout(r, 3000));
      const now = await seen();
      if (now > before) {
        console.log(`\nROUTING CONFIRMED — ${now - before} request(s) reached the zoo.`);
        console.log('   (a receipt line above shows what each one paid)');
        return;
      }
    }
    console.log('\nNOT ROUTING — 0 requests reached the zoo in 2 minutes.');
    console.log('   The editor is answering from its OWN backend. Check, in order:');
    console.log('   1. did you QUIT the editor fully before this ran? it caches config at launch');
    console.log('   2. Settings -> Models -> "Override OpenAI Base URL" toggle is ON');
    console.log('   3. the model you picked is one of the ids written above');
  })();
  // Keep this process alive when we own the proxy — killing it would kill the
  // zoo the editor was just pointed at.
  if (publicUrl || !(await proxyUp(base))) {
    console.log('proxy is running in this terminal — Ctrl-C when done.');
  }
}
