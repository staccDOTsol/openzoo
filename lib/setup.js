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
    // give the tunnel a moment to publish its URL
    for (let i = 0; i < 20 && !publicUrl; i++) {
      await new Promise((r) => setTimeout(r, 500));
      publicUrl = started?.publicUrl ?? null;
      tunnelKey = started?.tunnelToken ?? null;
    }
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
  if (publicUrl) {
    console.log(`tunnel:  ${publicUrl}/v1   api_key ${tunnelKey}`);
    console.log('         (use the tunnel for any cloud-run harness — it cannot reach localhost)');
  }
  console.log('');

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
