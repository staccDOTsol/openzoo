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
import { writeEditorProviderConfig, editorRunning } from './cursorcfg.js';

const DEFAULT_MODELS = ['anthropic/claude-opus-5', 'deepseek/deepseek-v4-pro-0813'];

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
  if (editorRunning(target0)) {
    console.log(`NOTE: ${target0} is already running — quit it and re-run so settings stick.`);
  }
  const models = [DEFAULT_MODELS[0], ...DEFAULT_MODELS.slice(1)];
  let wrote = null;
  try { wrote = writeEditorProviderConfig(target0, { baseUrl: base, models }); } catch (e) { wrote = { error: e.message }; }
  if (wrote?.error) {
    console.log(`settings: could not write automatically (${wrote.error}) — set them in Settings → Models`);
  } else if (wrote) {
    console.log(`settings: openAIBaseUrl -> ${base}  (was ${wrote.before.openAIBaseUrl || 'unset'})`);
    console.log(`          useOpenAIKey  -> true`);
    console.log(`          models added  -> ${wrote.added.length ? wrote.added.join(', ') : '(already present)'}`);
    console.log('          pick one of those in the model dropdown; built-ins bypass the zoo.');
  }

  // 3. LAUNCH with that env. Editor resolved platform-agnostically; Cursor
  //    wins when both are installed.
  const cwd = target && !target.startsWith('-') ? target : '.';
  const picked = pickEditor(which);
  if (!picked) {
    console.error('no editor found — install Cursor or VS Code, or put `cursor`/`code` on PATH');
    console.error(`(config is written either way: ${mcpFile})`);
    return;
  }
  console.log(`launching ${picked.which}...`);
  const child = spawn(picked.cmd, [cwd], { stdio: 'ignore', env, detached: true });
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
