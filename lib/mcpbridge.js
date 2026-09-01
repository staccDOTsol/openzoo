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

async function chromeArgs(baseArgs) {
  const args = [...(baseArgs || ['-y', 'chrome-devtools-mcp@latest'])];
  if (args.some((a) => String(a).includes('browserUrl') || String(a) === '--browserUrl')) return args;
  for (const port of [9222, 9333]) {
    if (await portOpen(port)) {
      args.push('--browserUrl', `http://127.0.0.1:${port}`);
      break;
    }
  }
  return args;
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
    if (cfg.name === 'chrome-devtools') args = await chromeArgs(args);
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
        if (line) log?.(`cursor-backend:      mcp ${cfg.name} ${line.slice(0, 160)}`);
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

function rebuildOpenai() {
  openaiTools = [];
  for (const [name, rec] of registry) {
    openaiTools.push(mcpToOpenAiTool(rec.server, { name: rec.tool, description: rec.description, inputSchema: rec.schema }));
    void name;
  }
}

export async function callHostMcp(name, args) {
  const rec = registry.get(String(name || ''));
  if (!rec) throw new Error(`no mcp tool ${name}`);
  const r = await rec.client.callTool({ name: rec.tool, arguments: args && typeof args === 'object' ? args : {} });
  return flattenMcpResult(r);
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
