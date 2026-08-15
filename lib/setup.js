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
import { writeEditorProviderConfig, editorRunning, quitEditor, pinEditorProviderConfig } from './cursorcfg.js';

/**
 * Models offered in the editor's picker. All verified present in the live
 * catalog; the first is the default selection. A spread across vendors and
 * price tiers on purpose — the picker is where someone chooses cost, and one
 * flagship plus one cheap model is not a choice.
 * Override with OPENZOO_MODELS (comma-separated).
 */
const DEFAULT_MODELS = (process.env.OPENZOO_MODELS
  ? process.env.OPENZOO_MODELS.split(',').map((m) => m.trim()).filter(Boolean)
  : [
    'anthropic/claude-opus-5',            // default — strongest reasoning
    'anthropic/claude-sonnet-4',
    'openai/gpt-5.6-sol-pro',             // flagship, ~$90/M out
    'openai/gpt-5.6-luna',
    'x-ai/grok-4.6',
    'z-ai/glm-5.2',
    'google/gemini-3.1-pro-preview-customtools',
    'deepseek/deepseek-v4-pro-0813',      // ~34x cheaper output than the flagship
    'qwen/qwen3.8-2.4t-a95b',
    'moonshotai/kimi-k2-0905',
    'meta-llama/llama-4-maverick',
    'bytedance-seed/seed-2.0-code',       // code specialist
  ]);

/**
 * An ISOLATED editor profile we own.
 *
 * The editor's normal profile syncs provider settings from the vendor account
 * and overwrites local state on launch — measured repeatedly. `--user-data-dir`
 * gives it a profile directory we control, so our settings are the only ones
 * there and nothing upstream reclaims them. Opt in with OPENZOO_PROFILE=1 (or
 * --profile) because a fresh profile means signing in again and re-adding
 * extensions; that is a real cost, not a detail to spring on someone.
 */
const PROFILE_DIR = process.env.OPENZOO_PROFILE_DIR
  || path.join(os.homedir(), '.openzoo', 'editor-profile');

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

export async function setupEditor(which, target) {
  const base = `http://localhost:${config.port}/v1`;
  const mcpFile = addMcpServer(MCP_FILES[which] || MCP_FILES.cursor);

  // 1. PROXY + TUNNEL. Start in-process if nothing is listening, so the user
  //    does not need a second terminal. The tunnel URL is what a cloud-run
  //    harness must use; we surface it rather than leaving them to find it.
  let publicUrl = null;
  let tunnelKey = null;
  if (!(await proxyUp(base))) {
    console.log(`starting proxy on ${base} (+ public tunnel)...`);
    const { startProxy } = await import('./proxy.js');
    const started = await startProxy({ silent: true, autoTunnel: true });
    publicUrl = started?.publicUrl ?? null;
    tunnelKey = started?.tunnelToken ?? null;
    // Wait for cloudflared to publish the URL. It downloads on first run and
    // routinely takes 30-45s; a 10s wait meant the tunnel line simply never
    // printed and the user never learned the public URL existed.
    process.stdout.write('waiting for tunnel');
    for (let i = 0; i < 120 && !publicUrl; i++) {
      await new Promise((r) => setTimeout(r, 500));
      publicUrl = started?.publicUrl ?? null;
      tunnelKey = started?.tunnelToken ?? null;
      if (i % 4 === 3) process.stdout.write('.');
    }
    process.stdout.write(publicUrl ? ' ok\n' : ' (not up yet — it will print in this terminal when ready)\n');
  } else {
    console.log(`proxy already running on ${base}`);
  }

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
  const picked0 = pickEditor(which);
  const target0 = picked0?.which || which || 'cursor';
  // Quit it FOR the user — a running editor reverts our write on exit.
  if (editorRunning(target0)) {
    console.log(`${target0} is running — quitting it so settings stick (it relaunches below)...`);
    const q = await quitEditor(target0);
    if (!q.quit) console.log(`  could not close ${target0} automatically; settings may not persist`);
  }
  const models = [DEFAULT_MODELS[0], ...DEFAULT_MODELS.slice(1)];
  let wrote = null;
  try { wrote = writeEditorProviderConfig(target0, { baseUrl: base, models }); } catch (e) { wrote = { error: e.message }; }
  if (wrote?.error) {
    console.log(`settings: could not write automatically (${wrote.error}) — set them in Settings → Models`);
  } else if (wrote) {
    console.log(`settings: openAIBaseUrl -> ${wrote.verified?.openAIBaseUrl || base}`);
    console.log('          useOpenAIKey  -> true');
    // PIN so the editor's account-sync cannot revert it on launch.
    const pin = pinEditorProviderConfig(target0, { baseUrl: base, models });
    console.log(`          models        -> ${models.join(', ')}`);
    console.log(`          selected      -> ${models[0]}`);
    console.log(pin?.pinned
      ? '          pinned        -> yes (the editor re-syncs these from its account; a DB trigger re-applies them)'
      : `          pinned        -> NO (${pin?.error || 'unavailable'}) — the editor may revert these on launch`);
    console.log('  verify: send one message, watch for "paid $0.0… · rail solana · tx …" here.');
  }

  // 3. LAUNCH with that env. Editor resolved platform-agnostically; Cursor
  //    wins when both are installed.
  // WORKSPACE, NOT WHEREVER YOU RAN THIS. Launching with '.' opens the current
  // directory as the workspace — and running from $HOME makes the editor treat
  // ~/.cursor as WORKSPACE config, where a stray rules/mcp file fights the
  // global settings we just wrote. A dedicated folder has no local config to
  // collide with. Pass a path explicitly to override.
  let cwd = target && !target.startsWith('-') ? target : null;
  if (!cwd) {
    const home = os.homedir();
    const here = process.cwd();
    if (here === home) {
      cwd = path.join(home, 'openzoo');
      fs.mkdirSync(cwd, { recursive: true });
      const readme = path.join(cwd, 'README.md');
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme, [
          '# openzoo workspace',
          '',
          'Opened by `npx openzoo cursor` because launching from your home directory',
          'makes the editor read `~/.cursor` as WORKSPACE config, which collides with',
          'the global provider settings openzoo writes.',
          '',
          'Every model call from this window is paid per-request over x402 from the',
          'local burner wallet. Pick a model with a vendor prefix (e.g.',
          '`anthropic/claude-opus-5`) — built-in models bypass the proxy.',
          '',
          'Run `npx openzoo cursor /path/to/your/project` to use a different folder.',
        ].join('\n'));
      }
      console.log(`workspace: ${cwd}  (home dir would collide with ~/.cursor)`);
    } else {
      cwd = here;
    }
  }
  const picked = pickEditor(which);
  if (!picked) {
    console.error('no editor found — install Cursor or VS Code, or put `cursor`/`code` on PATH');
    console.error(`(config is written either way: ${mcpFile})`);
    return;
  }
  const useProfile = process.env.OPENZOO_PROFILE === '1' || process.argv.includes('--profile');
  const args = [cwd];
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
  // Keep this process alive when we own the proxy — killing it would kill the
  // zoo the editor was just pointed at.
  if (publicUrl || !(await proxyUp(base))) {
    console.log('proxy is running in this terminal — Ctrl-C when done.');
  }
}
