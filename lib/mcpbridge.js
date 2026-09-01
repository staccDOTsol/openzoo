/**
 * Load the operator's local MCP servers (Grok / Claude / Cursor) and expose
 * them as OpenAI function tools for Grok Bot zoo turns.
 *
 * chrome-devtools is always attached if missing — that is Claude-in-Chrome
 * for this hijack: navigate / snapshot / fill the live page, not osascript.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const SKIP = /^(openzoo|openzoo-mcp)$/i;
const NAME_RE = /[^a-zA-Z0-9_-]/g;

const registry = new Map();
let openaiTools = [];
let started = null;
let serversUp = [];
let chromeCfg = null;
let lastReattachCheck = 0;
let lastBraveCheck = 0;

export function hostMcpTools() {
  return openaiTools;
}

export function hostMcpHas(name) {
  return registry.has(String(name || ''));
}

export function hostMcpServers() {
  return [...serversUp];
}

export function toolOpenaiName(server, toolName) {
  return `${String(server || 'mcp').replace(NAME_RE, '_') }__${String(toolName || 'tool').replace(NAME_RE, '_')}`.slice(0, 64);
}

export function flattenMcpResult(r) {
  const parts = [];
  const content = Array.isArray(r?.content) ? r.content : [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && c.text) parts.push(String(c.text));
    else if (c.type === 'image') parts.push(`[image ${c.mimeType || 'png'} ${(c.data || '').length}b]`);
    else parts.push(JSON.stringify(c));
  }
  const body = parts.join('\n').trim() || JSON.stringify(r ?? {});
  const out = r?.isError ? `ERROR ${body}` : body;
  return out.slice(0, 20_000);
}

function stripJsonComments(s) {
  return String(s || '').replace(/^\s*\/\/.*$/gm, '');
}

function readJsonFile(p) {
  try { return JSON.parse(stripJsonComments(fs.readFileSync(p, 'utf8'))); } catch { return null; }
}

/** Enough TOML for ~/.grok/config.toml [mcp_servers.*] tables. */
export function parseTomlMcpServers(text) {
  const servers = {};
  let cur = null;
  let nested = null;
  let arrayKey = null;
  let arrayBuf = [];
  const ensure = (name) => {
    if (!servers[name]) servers[name] = { name };
    return servers[name];
  };
  const flushArray = () => {
    if (!cur || !arrayKey) return;
    const vals = arrayBuf.map((x) => unquote(x)).filter((x) => x !== '');
    cur[arrayKey] = vals;
    arrayKey = null;
    arrayBuf = [];
  };
  const unquote = (raw) => {
    let s = String(raw || '').trim().replace(/,$/, '').trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
    }
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  };
  for (const rawLine of String(text || '').split(/\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (arrayKey) {
      if (line.startsWith(']')) {
        flushArray();
        continue;
      }
      arrayBuf.push(line.replace(/,$/, ''));
      continue;
    }
    const nestedSec = line.match(/^\[mcp_servers\.([^\]]+?)\.([a-zA-Z0-9_-]+)\]$/);
    if (nestedSec) {
      cur = ensure(nestedSec[1]);
      nested = nestedSec[2];
      if (!cur[nested] || typeof cur[nested] !== 'object' || Array.isArray(cur[nested])) cur[nested] = {};
      continue;
    }
    const sec = line.match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (sec) {
      cur = ensure(sec[1]);
      nested = null;
      continue;
    }
    if (line.startsWith('[')) {
      cur = null;
      nested = null;
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const rest = kv[2].trim();
    if (rest === '[' || rest.startsWith('[')) {
      arrayKey = key;
      arrayBuf = [];
      const inner = rest.replace(/^\[/, '').replace(/\]\s*$/, '').trim();
      if (rest.includes(']') && rest !== '[') {
        if (inner) arrayBuf = inner.split(',').map((x) => x.trim());
        flushArray();
      }
      continue;
    }
    const val = unquote(rest);
    if (nested) cur[nested][key] = val;
    else cur[key] = val;
  }
  flushArray();
  return Object.values(servers);
}

export function fromJsonMcpServers(obj, fallbackName) {
  if (!obj || typeof obj !== 'object') return [];
  const src = obj.mcpServers && typeof obj.mcpServers === 'object' ? obj.mcpServers : obj;
  const out = [];
  for (const [name, raw] of Object.entries(src)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    out.push({
      name: String(name || fallbackName || 'mcp'),
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args.map(String) : (Array.isArray(raw.command) ? raw.command.slice(1) : undefined),
      url: raw.url,
      type: raw.type,
      env: raw.env && typeof raw.env === 'object' ? raw.env : undefined,
      headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : undefined,
      enabled: raw.enabled !== false,
    });
  }
  return out;
}

function shapeServer(raw) {
  const name = String(raw?.name || '').trim();
  if (!name || SKIP.test(name) || raw?.enabled === false) return null;
  const command = Array.isArray(raw.command) ? raw.command[0] : raw.command;
  const args = Array.isArray(raw.args)
    ? raw.args.map(String)
    : (Array.isArray(raw.command) ? raw.command.slice(1).map(String) : []);
  const url = raw.url ? String(raw.url) : '';
  if (!url && !command) return null;
  return {
    name,
    command: command ? String(command) : '',
    args,
    url,
    env: raw.env && typeof raw.env === 'object' ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)])) : undefined,
    headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : undefined,
  };
}

export function loadHostMcpConfigs(home = os.homedir()) {
  const piles = [];
  const grokToml = path.join(home, '.grok', 'config.toml');
  try { piles.push(...parseTomlMcpServers(fs.readFileSync(grokToml, 'utf8'))); } catch { /* */ }
  for (const p of [
    path.join(home, '.claude', 'mcp.json'),
    path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    path.join(home, '.cursor', 'mcp.json'),
  ]) {
    const j = readJsonFile(p);
    if (j) piles.push(...fromJsonMcpServers(j));
  }
  const seen = new Set();
  const out = [];
  for (const raw of piles) {
    const s = shapeServer(raw);
    if (!s || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  if (![...seen].some((n) => /chrome|devtools|browser/i.test(n))) {
    out.push({
      name: 'chrome-devtools',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest'],
      url: '',
    });
  }
  // BRAVE AS A SECOND BROWSER. When Brave has flipped brave://inspect
  // remote debugging it writes DevToolsActivePort like Chrome does; a second
  // chrome-devtools-mcp attaches to it by --browserUrl and its tools land as
  // brave-devtools__*. Half the X bots drive Brave, half drive Chrome.
  const brave = readActive(path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'));
  if (brave.port && !seen.has('brave-devtools')) {
    out.push({
      name: 'brave-devtools',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest', ...braveAttachArgs(brave)],
      url: '',
    });
  }
  return out;
}

export function mcpToOpenAiTool(server, tool) {
  const schema = tool?.inputSchema && typeof tool.inputSchema === 'object'
    ? { ...tool.inputSchema }
    : { type: 'object', properties: {} };
  if (!schema.type) schema.type = 'object';
  if (!schema.properties) schema.properties = {};
  delete schema.$schema;
  return {
    type: 'function',
    function: {
      name: toolOpenaiName(server, tool.name),
      description: `[MCP ${server}] ${String(tool.description || tool.name || '').slice(0, 900)}`,
      parameters: schema,
    },
  };
}

function portOpen(port, host = '127.0.0.1', ms = 150) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => {
      try { sock.destroy(); } catch { /* */ }
      resolve(ok);
    };
    sock.setTimeout(ms);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

/**
 * "Chrome with Claude" for the hijack. Preference order:
 *   1. the user's REAL Chrome (their logins): Chrome 144+ writes
 *      DevToolsActivePort under its user-data-dir once the human flips
 *      chrome://inspect/#remote-debugging -> "Allow remote debugging for this
 *      browser". chrome-devtools-mcp attaches with --autoConnect.
 *   2. the user's real Brave the same way (Brave exposes a port, not the
 *      channel autoConnect expects) -> --browserUrl to that port.
 *   3. any browser already listening on 9222/9333 -> --browserUrl.
 *   4. chrome-devtools-mcp's own persistent profile (log in there once).
 * Chrome 136+ refuses --remote-debugging-port on the default profile, so
 * relaunching the user's browser with a flag is not an option — the toggle is.
 */
export const CHROME_TOGGLE_HINT = 'To let bots drive your real Chrome (your logins): open chrome://inspect/#remote-debugging in Chrome, turn on "Allow remote debugging for this browser", then restart `openzoo bot`. Until then the bot drives its own Chrome profile — log into sites there once and it persists.';

let chromeMode = { mode: 'own-profile', detail: '' };
export function chromeStatus() {
  return { ...chromeMode, hint: chromeMode.mode === 'own-profile' ? CHROME_TOGGLE_HINT : '' };
}

function readActivePort(dir) {
  return readActive(dir).port;
}
/** DevToolsActivePort = "<port>\n<ws path>". Chrome 144+ "Allow remote debugging"
 *  serves ONLY that websocket path (no /json/version), so a second browser must
 *  be attached by --wsEndpoint, not --browserUrl. */
export function readActive(dir) {
  try {
    const [first, second = ''] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n').map((l) => l.trim());
    const port = Number(first);
    if (!Number.isFinite(port) || port <= 0) return { port: 0, ws: '' };
    return { port, ws: second.startsWith('/') ? `ws://127.0.0.1:${port}${second}` : '' };
  } catch {
    return { port: 0, ws: '' };
  }
}
export function braveAttachArgs({ port, ws }) {
  return ws ? ['--wsEndpoint', ws] : ['--browserUrl', `http://127.0.0.1:${port}`];
}

/** Pure: decide the chrome-devtools-mcp argv from what is observable. */
export function chromeArgsFor(baseArgs, { chromePort = 0, bravePort = 0, braveWs = '', openPorts = [], hasOwnBraveServer = false } = {}) {
  const args = [...(baseArgs || ['-y', 'chrome-devtools-mcp@latest'])];
  const has = (flag) => args.some((a) => String(a) === flag || String(a).startsWith(`${flag}=`));
  if (has('--browserUrl') || has('--autoConnect') || has('--wsEndpoint')) return { args, mode: 'explicit', detail: '' };
  if (chromePort) { args.push('--autoConnect'); return { args, mode: 'real-chrome', detail: `Chrome DevToolsActivePort ${chromePort}` }; }
  if (bravePort && !hasOwnBraveServer) { args.push(...braveAttachArgs({ port: bravePort, ws: braveWs })); return { args, mode: 'real-brave', detail: `Brave DevToolsActivePort ${bravePort}` }; }
  const port = openPorts.find((n) => n === 9222 || n === 9333);
  if (port) { args.push('--browserUrl', `http://127.0.0.1:${port}`); return { args, mode: `attached:${port}`, detail: `browser listening on ${port}` }; }
  return { args, mode: 'own-profile', detail: '~/.cache/chrome-devtools-mcp/chrome-profile' };
}

async function chromeArgs(baseArgs, home = os.homedir()) {
  const chromeDir = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  const braveDir = path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser');
  let chromePort = readActivePort(chromeDir);
  if (chromePort && !(await portOpen(chromePort))) chromePort = 0;
  let bravePort = readActivePort(braveDir);
  if (bravePort && !(await portOpen(bravePort))) bravePort = 0;
  const openPorts = [];
  for (const port of [9222, 9333]) if (await portOpen(port)) openPorts.push(port);
  const got = chromeArgsFor(baseArgs, { chromePort, bravePort, openPorts, hasOwnBraveServer: true });
  chromeMode = { mode: got.mode, detail: got.detail };
  return got.args;
}

async function connectOne(cfg, log) {
  const client = new Client({ name: 'openzoo-grokbot', version: '0.50.55' });
  let transport;
  if (cfg.url) {
    const headers = {};
    for (const [k, v] of Object.entries(cfg.headers || {})) headers[k] = String(v);
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers },
    });
  } else {
    let args = cfg.args || [];
    if (cfg.name === 'chrome-devtools') {
      args = await chromeArgs(args);
      log?.(`cursor-backend:      mcp chrome-devtools mode=${chromeMode.mode} ${chromeMode.detail}`);
      if (chromeMode.mode === 'own-profile') log?.(`cursor-backend:      mcp chrome-devtools ${CHROME_TOGGLE_HINT}`);
    }
    const env = { ...getDefaultEnvironment(), PATH: process.env.PATH || '', ...(cfg.env || {}) };
    if (process.env.NVM_DIR) env.NVM_DIR = process.env.NVM_DIR;
    transport = new StdioClientTransport({
      command: cfg.command,
      args,
      env,
      stderr: 'pipe',
    });
    try {
      transport.stderr?.on?.('data', (buf) => {
        const line = String(buf).trim().split('\n')[0];
        if (line && !/No handler registered for issue code/.test(line)) log?.(`cursor-backend:      mcp ${cfg.name} ${line.slice(0, 160)}`);
      });
    } catch { /* */ }
  }
  const ms = cfg.name === 'chrome-devtools' ? 90_000 : 45_000;
  await Promise.race([
    client.connect(transport),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms)),
  ]);
  const listed = await client.listTools();
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  return { client, tools };
}

/**
 * The human flipped chrome://inspect/#remote-debugging AFTER boot: Chrome
 * writes DevToolsActivePort immediately. Swap the blank-profile
 * chrome-devtools for one attached to their real browser, no restart.
 * Cheap (two stats) — called at the top of every zoo turn, throttled 5s.
 */
async function ensureBraveServer(log, home) {
  if (!started || serversUp.includes('brave-devtools')) return false;
  const brave = readActive(path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'));
  const bravePort = brave.port;
  if (!bravePort || !(await portOpen(bravePort))) return false;
  const cfg = { name: 'brave-devtools', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', ...braveAttachArgs(brave)], url: '' };
  log(`cursor-backend:      mcp brave-devtools Brave appeared on ${bravePort} — attaching (${brave.ws ? 'wsEndpoint' : 'browserUrl'})`);
  try {
    const got = await connectOne(cfg, log);
    serversUp.push(cfg.name);
    for (const tool of got.tools) {
      registry.set(toolOpenaiName(cfg.name, tool.name), {
        client: got.client, server: cfg.name, tool: tool.name, description: tool.description || tool.name, schema: tool.inputSchema,
      });
    }
    rebuildOpenai();
    log(`cursor-backend:      mcp brave-devtools attached tools=${got.tools.length}`);
    return true;
  } catch (e) {
    log(`cursor-backend:      mcp brave-devtools attach FAIL ${e.message}`);
    return false;
  }
}

export async function reattachChrome({ log = () => {}, home = os.homedir() } = {}) {
  if (!chromeCfg || !started) return false;
  const now0 = Date.now();
  if (now0 - lastBraveCheck > 5000) { lastBraveCheck = now0; await ensureBraveServer(log, home); }
  if (/^(real-chrome|real-brave|explicit)$/.test(chromeMode.mode)) return false;
  const now = Date.now();
  if (now - lastReattachCheck < 5000) return false;
  lastReattachCheck = now;
  const chromeDir = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  const braveDir = path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser');
  const chromePort = readActivePort(chromeDir);
  const bravePort = readActivePort(braveDir);
  const port = chromePort || bravePort;
  if (!port || !(await portOpen(port))) return false;
  log(`cursor-backend:      mcp chrome-devtools real browser appeared on ${port} — re-attaching`);
  const oldClients = new Set();
  for (const [name, rec] of [...registry]) {
    if (rec.server === chromeCfg.name) { oldClients.add(rec.client); registry.delete(name); }
  }
  for (const c of oldClients) { try { await c.close?.(); } catch { /* */ } }
  serversUp = serversUp.filter((n) => n !== chromeCfg.name);
  try {
    const got = await connectOne(chromeCfg, log);
    serversUp.push(chromeCfg.name);
    for (const tool of got.tools) {
      registry.set(toolOpenaiName(chromeCfg.name, tool.name), {
        client: got.client, server: chromeCfg.name, tool: tool.name, description: tool.description || tool.name, schema: tool.inputSchema,
      });
    }
    rebuildOpenai();
    log(`cursor-backend:      mcp chrome-devtools re-attached mode=${chromeMode.mode} tools=${got.tools.length}`);
    return true;
  } catch (e) {
    log(`cursor-backend:      mcp chrome-devtools re-attach FAIL ${e.message}`);
    return false;
  }
}

function rebuildOpenai() {
  openaiTools = [];
  for (const [name, rec] of registry) {
    openaiTools.push(mcpToOpenAiTool(rec.server, { name: rec.tool, description: rec.description, inputSchema: rec.schema }));
    void name;
  }
}

/**
 * One MCP call, with a hard ceiling. Measured 2026-09-01: take_snapshot on
 * x.com never returned and the whole zoo turn froze behind it. A tool that
 * hangs must come back as an error string the model can route around.
 */
export const MCP_CALL_TIMEOUT_MS = Math.max(10_000, Number(process.env.OZ_MCP_CALL_TIMEOUT_MS || 75_000));
/** One browser, many bots: chrome-devtools calls run one at a time so two
 *  turns cannot interleave select_page / click on the same Chrome. */
const browserChains = new Map(); // server name -> promise chain (one per browser)
export async function callHostMcp(name, args, { timeoutMs = MCP_CALL_TIMEOUT_MS } = {}) {
  const rec = registry.get(String(name || ''));
  if (!rec) throw new Error(`no mcp tool ${name}`);
  if (/chrome|devtools|browser/i.test(rec.server)) {
    const run = () => callHostMcpNow(name, rec, args, timeoutMs);
    const prev = browserChains.get(rec.server) || Promise.resolve();
    const p = prev.then(run, run);
    browserChains.set(rec.server, p.catch(() => {}));
    return p;
  }
  return callHostMcpNow(name, rec, args, timeoutMs);
}
async function callHostMcpNow(name, rec, args, timeoutMs) {
  let timer;
  const ceiling = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`MCP tool ${name} timed out after ${Math.round(timeoutMs / 1000)}s. The page may be too heavy for that action. Use a narrower one: evaluate_script to pull the text you need, take_screenshot, or navigate_page to a lighter URL. Do not retry the same call.`)), timeoutMs);
    timer.unref?.();
  });
  try {
    const r = await Promise.race([
      rec.client.callTool({ name: rec.tool, arguments: args && typeof args === 'object' ? args : {} }),
      ceiling,
    ]);
    return flattenMcpResult(r);
  } finally {
    clearTimeout(timer);
  }
}

export function registerHostMcpForTests(name, rec) {
  registry.set(name, rec);
}

export function resetHostMcpForTests() {
  registry.clear();
  openaiTools = [];
  serversUp = [];
  started = null;
}

export async function startHostMcps({ log = () => {}, home = os.homedir() } = {}) {
  if (started) return started;
  if (process.env.OZ_GROKBOT_MCP === '0') {
    started = { tools: [], servers: [] };
    return started;
  }
  started = (async () => {
    const configs = loadHostMcpConfigs(home);
    chromeCfg = configs.find((c) => c.name === 'chrome-devtools') || configs.find((c) => /chrome|devtools|browser/i.test(c.name)) || null;
    log(`cursor-backend:      mcp loading n=${configs.length} ${configs.map((c) => c.name).join(',')}`);
    const results = await Promise.allSettled(configs.map((cfg) => connectOne(cfg, log)));
    for (let i = 0; i < results.length; i++) {
      const cfg = configs[i];
      const r = results[i];
      if (r.status !== 'fulfilled') {
        log(`cursor-backend:      mcp ${cfg.name} FAIL ${r.reason?.message || r.reason}`);
        continue;
      }
      serversUp.push(cfg.name);
      for (const tool of r.value.tools) {
        const openaiName = toolOpenaiName(cfg.name, tool.name);
        if (registry.has(openaiName)) continue;
        registry.set(openaiName, {
          client: r.value.client,
          server: cfg.name,
          tool: tool.name,
          description: tool.description || tool.name,
          schema: tool.inputSchema,
        });
      }
      log(`cursor-backend:      mcp ${cfg.name} tools=${r.value.tools.length}`);
    }
    rebuildOpenai();
    log(`cursor-backend:      mcp ready servers=${serversUp.join(',') || 'none'} tools=${openaiTools.length}`);
    return { tools: openaiTools, servers: serversUp };
  })();
  return started;
}
