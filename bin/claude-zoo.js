#!/usr/bin/env node
/**
 * `claude` — the openzoo-backed Claude Code command.
 *
 * Replaces the raw occ launcher. Same binary, but every request goes through
 * the local openzoo proxy on :8402 (x402 per-call payment, no Anthropic
 * subscription, no login):
 *
 *   - starts the proxy if it is not already THIS version on :8402 (steals stale)
 *   - applies claudeZooEnv(): ANTHROPIC_BASE_URL=localhost:PORT/v1,
 *     AUTH_TOKEN=sk-openzoo, ANTHROPIC_API_KEY deleted, compaction disabled
 *     (the proxy binds the prefix), 1M-token ceiling restored
 *   - execs occ (open-claude-code) with your original argv
 *
 * The old direct-to-Anthropic-capable launcher is preserved as
 * `claude-code-cli` (same directory, symlinked to occ).
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync as fsReaddir, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shimRoot = dirname(here);

// occ lives beside us (nvm bin/occ) or, if this wrapper is copied elsewhere,
// we fall back to searching the nvm tree we were installed from.
function findOcc() {
  const candidate = join(here, 'occ');
  if (existsSync(candidate)) return candidate;
  {
    const versions = join(homedir(), '.nvm', 'versions', 'node');
    try {
      for (const v of fsReaddir(versions).sort().reverse()) {
        const p = join(versions, v, 'bin', 'occ');
        if (existsSync(p)) return p;
      }
    } catch { /* fall through */ }
  }
  return null;
}

const occ = findOcc();
if (!occ) {
  console.error('claude: cannot find occ (open-claude-code) next to this wrapper.');
  process.exit(1);
}

const PROXY_PORT = Number(process.env.OPENZOO_PROXY_PORT || 8402);
const PROXY_URL = `http://localhost:${PROXY_PORT}/v1`;

function mineVersion() {
  try {
    return JSON.parse(readFileSync(join(shimRoot, 'package.json'), 'utf8')).version;
  } catch { return ''; }
}

function stealPort(port) {
  const n = Number(port);
  for (const cmd of [
    `lsof -t -iTCP:${n} -sTCP:LISTEN | xargs kill -9`,
    `fuser -k ${n}/tcp`,
  ]) {
    try { execSync(cmd, { stdio: 'ignore', timeout: 2000, shell: true }); } catch { /* missing */ }
  }
}

async function proxyUp() {
  try {
    const r = await fetch(`http://localhost:${PROXY_PORT}/v1/info`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    const mine = mineVersion();
    if (mine && String(j.version || '') !== mine) {
      console.error(`claude: stale proxy v${j.version || '?'} on :${PROXY_PORT} — stealing for v${mine}`);
      stealPort(PROXY_PORT);
      return false;
    }
    return true;
  } catch { return false; }
}

async function ensureProxy() {
  if (await proxyUp()) return PROXY_URL;
  console.error(`claude: starting openzoo proxy on :${PROXY_PORT} ...`);
  const entry = join(shimRoot, 'bin', 'openzoo.js');
  const child = spawn(process.execPath, [entry, 'proxy'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await proxyUp()) return PROXY_URL;
  }
  console.error(`claude: proxy did not come up on :${PROXY_PORT} — log: ~/.openzoo/proxy.log`);
  process.exit(1);
}

// Mirror of lib/launch.js claudeZooEnv, inlined so this wrapper has zero
// imports from the shim (it must run even if the shim tree moves).
function zooEnv(base) {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY; // would win over BASE_URL and bill Anthropic
  env.ANTHROPIC_BASE_URL = PROXY_URL;
  env.ANTHROPIC_AUTH_TOKEN = base.ANTHROPIC_AUTH_TOKEN || 'sk-openzoo';
  env.DISABLE_COMPACT = base.DISABLE_COMPACT || '1';
  env.DISABLE_AUTO_COMPACT = base.DISABLE_AUTO_COMPACT || '1';
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = base.CLAUDE_CODE_MAX_CONTEXT_TOKENS || '1000000';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = base.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || '1';
  return env;
}

const base = await ensureProxy();
// `claude auth status --json` / `claude auth login` — answered here, never
// forwarded. Tools that embed Claude Code as an AI provider (OKX's okx-a2a
// daemon probes exactly this before it will run) expect a JSON
// {"loggedIn":true} and a zero exit. occ has no `auth` command: it read the
// words as a prompt and sat waiting for input, so the probe timed out and the
// provider was reported "not logged in". Through the zoo the credential is
// the gateway token set above, so logged-in is simply true.
if (process.argv[2] === 'auth') {
  const sub = process.argv[3];
  if (sub === 'status') {
    process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'openzoo', apiProvider: 'openzoo', baseUrl: PROXY_URL }) + '\n');
    process.exit(0);
  }
  if (sub === 'login' || sub === 'logout') {
    process.stdout.write(`openzoo: nothing to ${sub} — every call pays x402 through ${PROXY_URL}\n`);
    process.exit(0);
  }
}

const child = spawn(occ, process.argv.slice(2), {
  stdio: 'inherit',
  env: zooEnv(process.env),
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
