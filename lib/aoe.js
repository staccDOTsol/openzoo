/**
 * `npx openzoo aoe [aoe args...]` — register openzoo as an agent in Agent of
 * Empires (https://github.com/agent-of-empires/agent-of-empires), make sure a
 * proxy is up for the sessions it will spawn, then hand off to `aoe`.
 *
 * AoE runs each coding agent in its own tmux session and picks the agent from
 * a registry it ships (`aoe agents`). openzoo is not in that registry, but AoE
 * has a first-class hook for exactly this shape: `[session.custom_agents]`
 * names a command, and `[session.agent_detect_as]` tells AoE which built-in
 * the command wraps so status hooks, resume flags and the structured-view
 * adapter are inherited. `openzoo claude` IS Claude Code (it spawns the real
 * CLI with ANTHROPIC_BASE_URL pointed at the local proxy and forwards every
 * flag untouched), so `openzoo = "openzoo claude"` + `openzoo = "claude"` is
 * the whole integration: `aoe add --tool openzoo` launches a Claude Code
 * session that pays per turn over x402 with no API key and no account.
 *
 * Everything written is a surgical edit of the user's config.toml: keys are
 * inserted into the tables they belong to (header form or inline form,
 * whichever the file already uses), never a second `[session.custom_agents]`
 * header, which TOML rejects as a duplicate table and would take the whole
 * config down with it. Re-running is idempotent.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

export const AGENT_NAME = 'openzoo';
export const TOOL_NAME = 'openzoo';

/**
 * Where AoE reads its global config.toml. Mirrors `get_app_dir_path` in
 * agent-of-empires/src/session/mod.rs: Linux is always XDG; macOS prefers an
 * existing XDG dir, then an existing legacy `~/.agent-of-empires`, then XDG
 * only when `XDG_CONFIG_HOME` is set explicitly; everything else is legacy.
 * OPENZOO_AOE_CONFIG overrides outright (tests, unusual layouts).
 */
export function aoeConfigPath({
  env = process.env, home = os.homedir(), platform = process.platform, exists = fs.existsSync,
} = {}) {
  if (env.OPENZOO_AOE_CONFIG) return env.OPENZOO_AOE_CONFIG;
  const xdg = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'agent-of-empires');
  const legacy = path.join(home, '.agent-of-empires');
  let dir;
  if (platform === 'linux') dir = xdg;
  else if (platform === 'darwin') {
    if (exists(xdg)) dir = xdg;
    else if (exists(legacy)) dir = legacy;
    else dir = env.XDG_CONFIG_HOME ? xdg : legacy;
  } else dir = legacy;
  return path.join(dir, 'config.toml');
}

/**
 * The command AoE will put in a tmux pane. `openzoo` on PATH when it is
 * (global install); otherwise the exact node + script that is running right
 * now, so `npx openzoo aoe` users get a session that launches instead of a
 * "command not found" pane. AoE verifies the first word is on PATH before it
 * creates a session, which is also why an absolute path beats `npx openzoo`.
 */
export function openzooLaunchCommand({ env = process.env, execPath = process.execPath, script = process.argv[1] } = {}) {
  const name = 'openzoo' + (process.platform === 'win32' ? '.cmd' : '');
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return 'openzoo'; } catch { /* next */ }
  }
  return `${shQuote(execPath)} ${shQuote(script)}`;
}

/** Quote one argv word for the shell AoE hands the command to. */
export function shQuote(s) {
  return /^[A-Za-z0-9_/.:@%+=-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** TOML basic string. JSON's escapes are a subset of TOML's for the characters
 *  a path or command can contain, so this is exact, not approximate. */
export function tomlString(s) {
  return JSON.stringify(String(s));
}

function keyMatches(rawKey, key) {
  const k = rawKey.trim();
  return k === key || k === `"${key}"` || k === `'${key}'`;
}

/** Split an inline-table body on commas that are not inside a string. */
function splitInline(body) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"') { cur += body[++i] ?? ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ',') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Set `key = value` inside TOML table `table` (dotted, e.g.
 * `session.custom_agents`), replacing any existing value for that key.
 * Pure: string in, string out.
 *
 * Handles the two spellings a hand-edited config uses:
 *   [session.custom_agents]          header form → key inserted under it
 *   [session]
 *   custom_agents = { a = "b" }      inline form → entry injected into the braces
 * and appends a fresh header only when neither exists. `value` must already be
 * a TOML literal (see tomlString).
 */
export function upsertTomlKey(toml, table, key, value) {
  const lines = String(toml || '').split('\n');
  const parent = table.includes('.') ? table.slice(0, table.lastIndexOf('.')) : '';
  const child = table.slice(table.lastIndexOf('.') + 1);
  const headerOf = (line) => {
    const m = line.match(/^\s*\[([^[\]]+)\]\s*(#.*)?$/);
    return m ? m[1].trim().replace(/\s+/g, '').replace(/"/g, '') : null;
  };
  let section = '';
  let headerIdx = -1;
  let inlineIdx = -1;
  const out = [];
  for (const line of lines) {
    const h = headerOf(line);
    if (h !== null) {
      section = h;
      if (h === table && headerIdx === -1) headerIdx = out.length;
      out.push(line);
      continue;
    }
    if (section === table) {
      const m = line.match(/^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/);
      if (m && keyMatches(m[1], key)) continue; // ours, rewritten below
    }
    if (section === parent && inlineIdx === -1) {
      const m = line.match(/^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*\{/);
      if (m && keyMatches(m[1], child)) inlineIdx = out.length;
    }
    out.push(line);
  }
  const entry = `${key} = ${value}`;
  if (headerIdx !== -1) {
    out.splice(headerIdx + 1, 0, entry);
  } else if (inlineIdx !== -1) {
    const line = out[inlineIdx];
    const open = line.indexOf('{');
    const close = line.lastIndexOf('}');
    if (close > open) {
      const body = splitInline(line.slice(open + 1, close))
        .filter((p) => !keyMatches(p.split('=')[0], key));
      out[inlineIdx] = `${line.slice(0, open + 1)} ${[entry, ...body].join(', ')} ${line.slice(close)}`;
    } else {
      // Multi-line inline table (TOML 1.1). Rare; a fresh header would clash
      // with it, so refuse loudly rather than corrupt the file.
      throw new Error(`cannot edit multi-line inline table \`${child}\` in [${parent}] — add ${entry} by hand`);
    }
  } else {
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    if (out.length) out.push('');
    out.push(`[${table}]`, entry);
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Drop a whole `[table]` block (header through the next header). */
export function stripTomlTable(toml, table) {
  const lines = String(toml || '').split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const m = line.match(/^\s*\[([^[\]]+)\]\s*(#.*)?$/);
    if (m) skipping = m[1].trim().replace(/\s+/g, '').replace(/"/g, '') === table;
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Merge openzoo into an AoE config. Pure.
 *
 *  - session.custom_agents.openzoo   = "<launch> claude"   the agent
 *  - session.agent_detect_as.openzoo = "claude"            inherit Claude's
 *    status hooks, resume/fork flags and structured-view adapter
 *  - tools.openzoo                   receipts tail on Alt+z (persistent tool
 *    session; the proxy's log is the spend ledger)
 *  - session.agent_command_override.claude (opt-in, `overrideClaude`): every
 *    built-in claude session in AoE launches through openzoo too
 */
export function mergeAoeConfig(toml, {
  launch = 'openzoo', logPath = '~/.openzoo/proxy.log', overrideClaude = false, receipts = true,
} = {}) {
  let out = String(toml || '');
  const changes = [];
  const claudeCmd = tomlString(`${launch} claude`);
  out = upsertTomlKey(out, 'session.custom_agents', AGENT_NAME, claudeCmd);
  changes.push(`session.custom_agents.${AGENT_NAME} = ${claudeCmd}`);
  out = upsertTomlKey(out, 'session.agent_detect_as', AGENT_NAME, '"claude"');
  changes.push(`session.agent_detect_as.${AGENT_NAME} = "claude"`);
  if (overrideClaude) {
    out = upsertTomlKey(out, 'session.agent_command_override', 'claude', claudeCmd);
    changes.push(`session.agent_command_override.claude = ${claudeCmd}`);
  }
  out = stripTomlTable(out, `tools.${TOOL_NAME}`);
  if (receipts) {
    const cmd = tomlString(`${launch} balance; tail -n 40 -f ${logPath}`);
    // Comment INSIDE the block: stripTomlTable drops header-to-next-header, so
    // a comment above the header would survive every re-run and pile up.
    out = `${out.trimEnd()}\n\n[tools.${TOOL_NAME}]\n# openzoo receipts: wallet balance, then the proxy's live payment log.\ncommand = ${cmd}\nhotkey = "Alt+z"\n`;
    changes.push(`tools.${TOOL_NAME} (Alt+z) = ${cmd}`);
  }
  return { toml: out, changes };
}

function aoeInstalled() {
  const r = spawnSync('aoe', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

async function proxyUp(base) {
  try { return (await fetch(`${base}/info`, { signal: AbortSignal.timeout(2500) })).ok; } catch { return false; }
}

/**
 * Start a proxy that outlives this command. AoE sessions are tmux sessions:
 * they keep running after the TUI closes, so a proxy tied to this process
 * would vanish under them. `openzoo claude` inside a pane heals a missing
 * proxy at launch, but a proxy that dies mid-conversation is a wall of API
 * errors in every other session, so the long-lived one is started here.
 * No public tunnel unless asked: a detached proxy nobody is watching must not
 * open a URL + key that spends the wallet with no session cap.
 */
function startDetachedProxy({ tunnel }) {
  const logPath = path.join(os.homedir(), '.openzoo', 'proxy.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  const env = { ...process.env };
  if (!tunnel && !env.OPENZOO_NO_TUNNEL) env.OPENZOO_NO_TUNNEL = '1';
  const child = spawn(process.execPath, [process.argv[1], 'proxy'], {
    detached: true, stdio: ['ignore', fd, fd], env,
  });
  child.unref();
  fs.closeSync(fd);
  return { pid: child.pid, logPath };
}

export async function setupAoe(argv = []) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const rest = argv.filter((a) => !['--no-launch', '--no-proxy', '--tunnel', '--override-claude', '--no-receipts'].includes(a));
  const cfgPath = aoeConfigPath();
  const launch = openzooLaunchCommand();

  let existing = '';
  try { existing = fs.readFileSync(cfgPath, 'utf8'); } catch { existing = ''; }
  const { toml, changes } = mergeAoeConfig(existing, {
    launch,
    logPath: path.join(os.homedir(), '.openzoo', 'proxy.log'),
    overrideClaude: flags.has('--override-claude'),
    receipts: !flags.has('--no-receipts'),
  });
  if (toml !== existing) {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, toml);
  }
  console.error(`openzoo: ${toml === existing ? 'already in' : 'written to'} ${cfgPath}`);
  for (const c of changes) console.error(`  ${c}`);
  console.error('  agent "openzoo" = Claude Code on the zoo: pays x402 per turn, no API key, no account.');
  console.error('  terminal view only — AoE\'s structured view runs claude-agent-acp itself, which bills Anthropic.');

  const version = aoeInstalled();
  if (!version) {
    console.error('');
    console.error('openzoo: `aoe` is not installed (Agent of Empires — tmux session manager for coding agents).');
    console.error('  brew install aoe');
    console.error('  curl -fsSL https://raw.githubusercontent.com/agent-of-empires/agent-of-empires/main/scripts/install.sh | bash');
    console.error('  then:  openzoo aoe        (TUI)     openzoo aoe add . -l   (one session, launched)');
    process.exit(flags.has('--no-launch') ? 0 : 1);
  }

  const base = `http://localhost:${config.port}/v1`;
  if (!flags.has('--no-proxy')) {
    const { oursOn, packageVersion, killListen } = await import('./proxy.js');
    if (await oursOn(config.port)) {
      console.error(`openzoo: proxy v${packageVersion()} already on ${base}`);
    } else {
      if (await proxyUp(base)) {
        console.error(`openzoo: stale proxy on ${base} — stealing :${config.port}`);
        killListen(config.port);
        await new Promise((r) => setTimeout(r, 400));
      }
      const { pid, logPath } = startDetachedProxy({ tunnel: flags.has('--tunnel') });
      let up = false;
      for (let i = 0; i < 40 && !up; i++) {
        await new Promise((r) => setTimeout(r, 300));
        up = await proxyUp(base);
      }
      if (up) console.error(`openzoo: proxy started in the background (pid ${pid}, receipts in ${logPath}; stop: kill ${pid})`);
      else console.error(`openzoo: proxy not answering yet on ${base} — sessions will start one themselves; see ${logPath}`);
    }
  }
  if (flags.has('--no-launch')) return;

  // `openzoo aoe add …` → `aoe add --tool openzoo …` unless the caller chose.
  const args = [...rest];
  if (args[0] === 'add' && !args.some((a) => a === '--tool' || a === '--cmd' || a === '-c')) {
    args.splice(1, 0, '--tool', AGENT_NAME);
  }
  console.error(`openzoo: aoe ${version} — running: aoe ${args.join(' ')}`.trimEnd());
  const child = spawn('aoe', args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => { console.error(`openzoo: could not launch aoe: ${e.message}`); process.exit(1); });
}
