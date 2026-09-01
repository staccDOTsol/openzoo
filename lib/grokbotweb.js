/**
 * Serve the Grok Bot renderer in a normal browser.
 *
 * The .app is Electron: main + preload + a Vite-built renderer in app.asar.
 * Chat never lived in Chromium — it goes through a coordinator MessagePort to
 * the same /api/sendPrompt hijack `npx openzoo bot` already runs. This process
 * extracts nothing into git: it reads the asar in place, injects a preload
 * shim, and speaks the coordinator protocol over WebSocket.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

import { config } from './config.js';
import { readHouseRoster } from './grokbotAccount.js';
import { ingestUpload, lookupUpload } from './grokbotUploads.js';
import { spendChipSource } from './ozSpendChip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = path.join(HERE, 'grokbotweb-shim.js');
const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = Number(process.env.OZ_GROKBOT_WEB_PORT || 4174);
/** LAN/tunnel visitors need all-interfaces. Hijack :8443 bind is unchanged. */
export const DEFAULT_WEB_BIND = process.env.OZ_GROKBOT_WEB_BIND || process.env.OPENZOO_BIND || '0.0.0.0';
const BIND = DEFAULT_WEB_BIND;
const HIJACK = process.env.OZ_SNIFF_SELF || 'https://127.0.0.1:8443';
const OZ_WHO_COOKIE = 'oz_who';
const OZ_WHO_MAX_AGE = 365 * 24 * 3600;

/** Word-list shortnames — never sequential "User-3". Paired 1:1 with colors. */
export const VISITOR_SHORTNAMES = [
  'maya', 'rex', 'jun', 'pio', 'nia', 'kai', 'zo', 'ash', 'ivy', 'lux',
  'neo', 'ora', 'sol', 'vem', 'kit', 'wynn', 'joss', 'lark', 'nico', 'rafi',
  'tess', 'uma', 'voss', 'wren', 'yara', 'zed', 'bea', 'cal', 'drew', 'eve',
  'finn', 'gia', 'hugo', 'ida', 'jem', 'liv', 'moe', 'nils', 'opal', 'quin',
];
export const VISITOR_COLORS = [
  '#e85d4c', '#3db8e8', '#e8c14c', '#7c5ce8', '#3dd68a',
  '#e84c9a', '#4c7ae8', '#e88b4c', '#4ce0d0', '#d44ce8',
  '#8ee84c', '#e85d7a', '#5c9ae8', '#e8a33b', '#6e4ce8',
  '#4ce89a', '#e86b4c', '#4caee8', '#c8e84c', '#e84cc8',
  '#4c58e8', '#e8d44c', '#a44ce8', '#4ce86e', '#e8486e',
  '#3ec4e8', '#e89a4c', '#745ce8', '#9ae84c', '#e84c7a',
  '#4c8ee8', '#e8bc4c', '#c44ce8', '#4ce8b6', '#e8704c',
  '#5cb0e8', '#d8e84c', '#8c4ce8', '#4ce878', '#e85c9c',
];
const usedShortnames = new Set();

export function visitorPaletteMap() {
  const o = {};
  for (let i = 0; i < VISITOR_SHORTNAMES.length; i += 1) {
    o[VISITOR_SHORTNAMES[i]] = VISITOR_COLORS[i % VISITOR_COLORS.length];
  }
  return o;
}

export function isVisitorShortname(name) {
  return VISITOR_SHORTNAMES.includes(String(name || '').toLowerCase());
}

export function colorForShortname(name) {
  const i = VISITOR_SHORTNAMES.indexOf(String(name || '').toLowerCase());
  if (i >= 0) return VISITOR_COLORS[i % VISITOR_COLORS.length];
  let h = 0;
  const s = String(name || '');
  for (let k = 0; k < s.length; k += 1) h = (h * 33 + s.charCodeAt(k)) >>> 0;
  return VISITOR_COLORS[h % VISITOR_COLORS.length];
}

export function normalizeVisitor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().toLowerCase();
  const shortname = String(raw.shortname || raw.name || '').trim().toLowerCase();
  let color = String(raw.color || '').trim().toLowerCase();
  if (!/^[a-f0-9-]{8,36}$/.test(id)) return null;
  if (!/^[a-z][a-z0-9]{1,15}$/.test(shortname)) return null;
  if (/^[0-9a-f]{6}$/.test(color)) color = `#${color}`;
  if (!/^#[0-9a-f]{6}$/.test(color)) color = colorForShortname(shortname);
  return { id, shortname, color };
}

export function mintVisitor(used = usedShortnames) {
  const taken = used instanceof Set ? used : usedShortnames;
  const pool = VISITOR_SHORTNAMES.filter((n) => !taken.has(n));
  const pickFrom = pool.length ? pool : VISITOR_SHORTNAMES;
  const shortname = pickFrom[crypto.randomInt(pickFrom.length)];
  taken.add(shortname);
  return {
    id: crypto.randomBytes(4).toString('hex'),
    shortname,
    color: colorForShortname(shortname),
  };
}

/** Compact cookie value: `<8-char-id>.<shortname>.<rrggbb>` (no #). */
export function serializeOzWho(visitor) {
  const v = normalizeVisitor(visitor);
  if (!v) return '';
  return `${v.id}.${v.shortname}.${v.color.replace(/^#/, '')}`;
}

export function parseOzWhoValue(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try { return normalizeVisitor(JSON.parse(s)); } catch { return null; }
  }
  const decoded = (() => {
    try { return decodeURIComponent(s); } catch { return s; }
  })();
  const m = decoded.match(/^([a-f0-9-]{8,36})\.([a-z][a-z0-9]{1,15})\.([0-9a-f]{6})$/i);
  if (!m) return null;
  return normalizeVisitor({ id: m[1], shortname: m[2], color: m[3] });
}

export function parseOzWhoCookie(header) {
  const raw = String(header || '');
  const parts = raw.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== OZ_WHO_COOKIE) continue;
    return parseOzWhoValue(part.slice(eq + 1).trim());
  }
  return null;
}

export function ozWhoSetCookie(visitor) {
  const value = serializeOzWho(visitor);
  return `${OZ_WHO_COOKIE}=${value}; Path=/; Max-Age=${OZ_WHO_MAX_AGE}; SameSite=Lax`;
}

export function ensureVisitorFromRequest(req) {
  const existing = parseOzWhoCookie(req?.headers?.cookie);
  if (existing) {
    usedShortnames.add(existing.shortname);
    return { visitor: existing, setCookie: null };
  }
  const visitor = mintVisitor(usedShortnames);
  return { visitor, setCookie: ozWhoSetCookie(visitor) };
}

export function stripVisitorPrompt(text) {
  const s = String(text || '');
  const m = s.match(/^([a-z][a-z0-9]{1,15}):\s+/);
  if (m && isVisitorShortname(m[1])) return s.slice(m[0].length);
  return s;
}

export function formatVisitorPrompt(shortname, prompt) {
  const p = String(prompt || '');
  const n = String(shortname || '').toLowerCase();
  if (!n) return p;
  const prefix = `${n}: `;
  if (p.startsWith(prefix)) return p;
  return prefix + p;
}

/** Grok Bot paints `richText`, not `content`. Unprefixed richText is why every
 *  visitor looked like the same grey "you" pill. */
export function prefixVisitorRichText(richText, shortname, labeledText) {
  const labeled = String(labeledText || '');
  const fallback = JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: labeled }] }],
  });
  const n = String(shortname || '').toLowerCase();
  if (!labeled) return typeof richText === 'string' ? richText : (richText ? JSON.stringify(richText) : fallback);
  if (!n) return fallback;
  const prefix = `${n}: `;
  let doc = richText;
  if (doc == null || doc === '') return fallback;
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch { return fallback; }
  }
  if (!doc || typeof doc !== 'object') return fallback;
  let clone;
  try { clone = JSON.parse(JSON.stringify(doc)); } catch { return fallback; }
  const blocks = Array.isArray(clone.content) ? clone.content : null;
  const para = blocks ? blocks.find((c) => c && c.type === 'paragraph') : null;
  if (!para) return fallback;
  if (!Array.isArray(para.content)) para.content = [];
  const first = para.content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
  if (first) {
    if (!first.text.startsWith(prefix)) first.text = prefix + String(first.text).replace(/^\s+/, '');
  } else {
    para.content.unshift({ type: 'text', text: prefix });
  }
  return JSON.stringify(clone);
}

const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  wasm: 'application/wasm',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
};

export const HOST_STATUS = {
  hostVersion: '0.30.0',
  latestHostVersion: '0.30.0',
  hostUpdateAvailable: false,
  isBusy: false,
  capabilities: [],
};

export const COORD_DEFAULTS = {
  listAgents: [],
  countAgents: 0,
  searchAgents: [],
  searchMedia: [],
  getTrays: [],
  getHostStatus: HOST_STATUS,
  sendPrompt: { accepted: true },
  promptAcceptanceStatus: { outcome: 'found', record: { status: 'accepted' } },
  getAgentTranscriptTail: { entries: [] },
  openAgentTail: { entries: [] },
  getForeverBoxStatus: { agentId: 'openzoo', state: 'ready' },
  ensureForeverBox: { agentId: 'openzoo', state: 'ready' },
  getBoxSecretsStatus: { keys: [], isApplied: false, lastAppliedAtMs: null },
  isGlobalSearchEnabled: false,
  isEgressTunnelAvailable: false,
  getSharingState: { isEnabled: false, selfAuthId: null, pendingJoinRequests: [], rooms: [], typingUsers: [] },
  getTeachRecordingStatus: { recording: false },
  getBotTemplateExportPolicy: { allowed: true },
  listBotTemplates: [],
  skillsCatalog: [],
  syncPluginSkills: [],
  getPluginSyncStatus: { ok: true },
  getMcpState: { servers: [] },
  getMcpCatalog: [],
  getEffectiveMcpPlugins: [],
  getSubagents: [],
  getAsyncTasks: [],
  getAgentWorkflows: [],
  getAgentAutomations: [],
  listAllAutomations: [],
  getListenerIntegrations: {},
  getAgentChannels: { manifests: [], connections: [] },
  getConversationOutline: [],
  readVoiceCallSentMessages: [],
  getVoiceCall: null,
  getHostSettings: { settings: {} },
};

const VOID_METHODS = new Set([
  'resolveAutoReviewApproval', 'resolveLocalToolPermission', 'submitSecret',
  'submitUserForm', 'dismissUserForm', 'reactToMessage', 'voteFeedback',
  'deleteBotTemplate', 'setAgentUnread', 'setAgentHiddenFromSidebar',
  'setAgentNotificationsEnabled', 'setAgentNotifyOnUpdates', 'runAgentWorkflowNow',
  'recordVoiceCall', 'handBackForeverBox', 'dismissTray', 'clearTrays',
  'setSharedRoomTyping',
]);

export function findGrokBotAsar() {
  if (process.env.GROK_BOT_ASAR && fs.existsSync(process.env.GROK_BOT_ASAR)) {
    return process.env.GROK_BOT_ASAR;
  }
  const names = [
    path.join(process.cwd(), 'Grok Bot.app', 'Contents', 'Resources', 'app.asar'),
    path.join(HERE, '..', 'Grok Bot.app', 'Contents', 'Resources', 'app.asar'),
    '/Applications/Grok Bot.app/Contents/Resources/app.asar',
    path.join(os.homedir(), 'Applications', 'Grok Bot.app', 'Contents', 'Resources', 'app.asar'),
  ];
  return names.find((p) => fs.existsSync(p)) || null;
}

export function loadAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const sizeBuf = Buffer.alloc(8);
  if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) {
    fs.closeSync(fd);
    throw new Error('asar: short size header');
  }
  const headerPickleSize = sizeBuf.readUInt32LE(4);
  const headerBuf = Buffer.alloc(headerPickleSize);
  if (fs.readSync(fd, headerBuf, 0, headerPickleSize, 8) !== headerPickleSize) {
    fs.closeSync(fd);
    throw new Error('asar: short header pickle');
  }
  const jsonLen = headerBuf.readUInt32LE(4);
  const json = JSON.parse(headerBuf.slice(8, 8 + jsonLen).toString('utf8'));
  return {
    fd,
    asarPath,
    json,
    payloadOffset: 8 + headerPickleSize,
    unpackedDir: asarPath + '.unpacked',
  };
}

function walkAsar(node, parts) {
  let cur = node;
  for (const part of parts) {
    const files = cur?.files || cur;
    cur = files?.[part];
    if (!cur) return null;
  }
  return cur;
}

export function readAsarFile(archive, rel) {
  const parts = String(rel || '').split('/').filter(Boolean);
  const node = walkAsar(archive.json, parts);
  if (!node || node.files) return null;
  if (node.unpacked) {
    const full = path.join(archive.unpackedDir, ...parts);
    try { return fs.readFileSync(full); } catch { return null; }
  }
  const size = Number(node.size) || 0;
  const offset = Number(node.offset) || 0;
  const buf = Buffer.alloc(size);
  const n = fs.readSync(archive.fd, buf, 0, size, archive.payloadOffset + offset);
  return n === size ? buf : buf.subarray(0, n);
}

export const MOBILE_CSS = `/* cafe phone: canvas first, chrome out of the way.
   min-width is always 0 so iOS does not zoom the layout past the 720px
   breakpoint (asar --sand-chat-min-width:424px + sidebar 280px did that). */
html, body, #root, .sand-shell {
  min-width: 0 !important;
  max-width: 100%;
}
:root {
  --sand-chat-min-width: 0px !important;
}
@media (max-width: 900px), (pointer: coarse) {
  html, body, #root, .sand-shell {
    width: 100%;
    max-width: 100vw;
    height: 100dvh;
    overflow-x: hidden;
    overflow-y: auto;
  }
  :root {
    --sand-titlebar-block: env(safe-area-inset-top, 0px) !important;
  }
  html.oz-narrow [data-agent-id] {
    min-width: 44px;
    min-height: 44px;
  }
  html.oz-narrow textarea,
  html.oz-narrow input:not([type="checkbox"]):not([type="radio"]) {
    font-size: 16px !important;
  }
  html.oz-narrow .sand-new-chat-bar,
  html.oz-narrow .sand-new-chat-menu,
  html.oz-narrow .sand-kit-message-input-frame {
    z-index: 40;
  }
}
#oz-new-chat {
  display: flex;
  position: fixed;
  top: max(10px, env(safe-area-inset-top, 0px));
  right: max(10px, env(safe-area-inset-right, 0px));
  z-index: 2147483000;
  width: 44px;
  height: 44px;
  margin: 0;
  padding: 0;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,.4);
  background: #2a2a2a;
  color: #f3f3f3;
  font: 600 28px/1 ui-sans-serif, system-ui, sans-serif;
  box-shadow: 0 2px 10px rgba(0,0,0,.45);
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
#oz-new-chat:active { background: #3a3a3a; }
#oz-new-chat[hidden] { display: none !important; }
[data-oz-spend-hide] { display: none !important; }
`;

export function injectIndexHtml(html) {
  let out = String(html);
  out = out.replace(
    /content="default-src 'self';[^"]*"/,
    'content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; script-src \'self\'; worker-src \'self\' blob:; font-src \'self\' data:; img-src \'self\' data: blob: https:; media-src \'self\' blob:; connect-src \'self\' ws: wss: blob:;"',
  );
  if (!out.includes('viewport-fit')) {
    out = out.replace(
      /<meta name="viewport" content="width=device-width, initial-scale=1\.0"\s*\/>/,
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    );
  }
  if (!out.includes('oz-shim.js')) {
    out = out.replace('<head>', '<head>\n    <script src="./oz-shim.js"></script>');
  }
  if (!out.includes('oz-mobile.css')) {
    out = out.replace('</head>', '    <link rel="stylesheet" href="./oz-mobile.css" />\n  </head>');
  }
  return out;
}

function unwrapPodJson(j) {
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object' && j.status === 'ok' && 'value' in j) return j.value;
  return j;
}

export async function podApi(method, args = {}, { hijack = HIJACK, fetchImpl = fetch } = {}) {
  const url = `${hijack.replace(/\/$/, '')}/api/${method}`;
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(args && typeof args === 'object' ? args : {}),
  });
  const text = await r.text();
  if (!text) return undefined;
  try { return unwrapPodJson(JSON.parse(text)); } catch { return text; }
}

export function defaultFor(method) {
  if (Object.prototype.hasOwnProperty.call(COORD_DEFAULTS, method)) return COORD_DEFAULTS[method];
  if (VOID_METHODS.has(method)) return null;
  if (/^is[A-Z]/.test(method)) return false;
  if (/^(list|search|get.*s)$/.test(method)) return [];
  return {};
}

export async function handleCoordinatorRequest(method, args, opts = {}) {
  const hijack = opts.hijack || HIJACK;
  const fetchImpl = opts.fetchImpl || fetch;
  if (method === 'sendPrompt' && opts.visitor) {
    const v = normalizeVisitor(opts.visitor);
    if (v) args = { ...(args && typeof args === 'object' ? args : {}), visitor: v };
  }
  if (method === 'getHostStatus') return HOST_STATUS;
  if (method === 'countAgents') {
    try {
      const list = await podApi('listAgents', {}, { hijack, fetchImpl });
      if (Array.isArray(list) && list.length) return list.length;
    } catch { /* fall through */ }
    return readHouseRoster(os.homedir()).length;
  }
  if (method === 'searchAgents') {
    try {
      let list = await podApi('listAgents', {}, { hijack, fetchImpl });
      if (!Array.isArray(list) || !list.length) list = readHouseRoster(os.homedir());
      const q = String(args?.query || args?.q || '').toLowerCase();
      if (!q) return list;
      return list.filter((a) => String(a?.name || a?.title || a?.id || '').toLowerCase().includes(q));
    } catch { return readHouseRoster(os.homedir()); }
  }
  if (method === 'promptAcceptanceStatus') {
    try {
      const got = await podApi(method, args, { hijack, fetchImpl });
      if (got && typeof got === 'object' && typeof got.outcome === 'string') return got;
    } catch { /* */ }
    const nonce = String(args?.clientNonce || '');
    return {
      outcome: 'found',
      record: {
        status: 'accepted',
        acceptedAtMs: Date.now(),
        echoEntryId: nonce,
        clientNonce: nonce,
        agentId: String(args?.agentId || ''),
        inputDigest: '',
      },
    };
  }

  const proxied = new Set([
    'listAgents', 'sendPrompt', 'getAgentTranscriptTail', 'openAgentTail',
    'createAgent', 'createAgentFromTemplate', 'duplicateAgent', 'updateAgent',
    'deleteAgents', 'getTrays', 'createGroup', 'setGroupMembers',
    'setAgentUnread', 'setAgentHiddenFromSidebar', 'setAgentNotificationsEnabled',
    'setAgentNotifyOnUpdates', 'getAgentAvatar', 'setAgentAvatarBytes',
    'interruptAgentRun', 'kickstartAgent',
    'uploadAttachment', 'readAttachmentImage', 'readAttachmentText', 'readAttachmentChunk',
  ]);
  if (proxied.has(method) || !Object.prototype.hasOwnProperty.call(COORD_DEFAULTS, method)) {
    try {
      const got = await podApi(method, args, { hijack, fetchImpl });
      if (got !== undefined) {
        if (method === 'getHostStatus') return HOST_STATUS;
        if (method === 'getAgentTranscriptTail' || method === 'openAgentTail') {
          if (got && Array.isArray(got.entries)) return got;
        }
        if (method === 'listAgents' && Array.isArray(got)) {
          return got.length ? got : readHouseRoster(os.homedir());
        }
        if (method === 'sendPrompt' && got && typeof got === 'object') {
          return got.accepted === true ? got : { ...got, accepted: true };
        }
        if (method === 'uploadAttachment' && got && typeof got === 'object' && got.path) {
          return got;
        }
        return got;
      }
    } catch { /* defaults below */ }
  }
  return defaultFor(method);
}

export function coordinatorReply(requestId, value) {
  return { kind: 'reply', requestId, outcome: { status: 'ok', value: value === undefined ? null : value } };
}

export function coordinatorFail(requestId, message) {
  return {
    kind: 'reply',
    requestId,
    outcome: { status: 'failed', failure: { code: 'gateway/unknown-method', message: String(message || 'failed') } },
  };
}

export function lifecycleReady() {
  return { kind: 'lifecycle', phase: 'ready', protocolVersion: PROTOCOL_VERSION };
}

export function transportConnected() {
  return { kind: 'event', family: 'coordinator-transport-state', payload: { state: 'connected' } };
}

export function transcriptSourceGateway() {
  return { kind: 'event', family: 'coordinator-transcript-source', payload: { source: 'gateway' } };
}

export async function handleCoordinatorFrame(frame, send, opts = {}) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.kind === 'lifecycle' && frame.phase === 'hello') {
    send(lifecycleReady());
    send(transportConnected());
    send(transcriptSourceGateway());
    return;
  }
  if (frame.kind === 'lifecycle' && frame.phase === 'shutdown') return;
  if (frame.kind === 'cancel') return;
  if (frame.kind !== 'request') return;
  const id = frame.requestId;
  try {
    const value = await handleCoordinatorRequest(frame.method, frame.args || {}, opts);
    send(coordinatorReply(id, value));
  } catch (err) {
    send(coordinatorFail(id, err?.message || err));
  }
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

function wsEncode(payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, data]);
}

function wsPong(payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
  const header = Buffer.alloc(2);
  header[0] = 0x8a;
  header[1] = data.length;
  return Buffer.concat([header, data]);
}

function attachWs(socket, onText) {
  let buf = Buffer.alloc(0);
  const send = (obj) => {
    if (socket.destroyed) return;
    try { socket.write(wsEncode(JSON.stringify(obj))); } catch { /* */ }
  };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return;
      let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        const decoded = Buffer.alloc(len);
        for (let i = 0; i < len; i += 1) decoded[i] = payload[i] ^ mask[i % 4];
        payload = decoded;
      }
      buf = buf.subarray(offset + maskLen + len);
      if (opcode === 0x8) { socket.end(); return; }
      if (opcode === 0x9) { socket.write(wsPong(payload)); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x1) {
        let frame;
        try { frame = JSON.parse(payload.toString('utf8')); } catch { continue; }
        onText(frame, send);
      }
    }
  });
  return send;
}

async function ensureProxy(log) {
  const base = `http://localhost:${config.port}/v1`;
  try {
    if ((await fetch(`${base}/models`, { signal: AbortSignal.timeout(1500) })).ok) return;
  } catch { /* start it */ }
  log(`openzoo-web: starting proxy on ${base}`);
  const { startProxy } = await import('./proxy.js');
  await startProxy({ silent: true, autoTunnel: process.env.OPENZOO_NO_TUNNEL === '1' ? false : true });
}

async function ensureHijack(log) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.env.OPENZOO_BYOK = '1';
  if (!process.env.OZ_HIJACK_POD) {
    const url = HIJACK;
    process.env.OZ_HIJACK_POD = JSON.stringify({
      region: 'local',
      accountId: 'openzoo',
      podId: 'openzoo-local',
      token: 'openzoo',
      agent: url,
      vnc: url,
      p1340: url,
      p6081: url,
    });
    process.env.OZ_SNIFF_SELF = url;
  }
  try {
    const r = await fetch(`${HIJACK}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      log(`openzoo-web: reusing hijack at ${HIJACK}`);
      return;
    }
  } catch { /* start */ }
  const { startCursorBackend } = await import('./cursorbackend.js');
  const models = ['gpt-4o', 'gpt-4o-mini'].map((n) => ({ name: n, label: n }));
  try {
    startCursorBackend({
      port: 8443,
      models,
      log: (m) => log(`  backend: ${m}`),
    });
    log(`openzoo-web: aiserver on ${HIJACK}`);
  } catch (e) {
    log(`openzoo-web: 8443 already bound — reusing (${e.message})`);
  }
}

function hijackSse(onEvent, log) {
  const ctrl = new AbortController();
  (async () => {
    while (!ctrl.signal.aborted) {
      try {
        const r = await fetch(`${HIJACK}/events`, {
          headers: { accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        if (!r.ok || !r.body) throw new Error(`events ${r.status}`);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let acc = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += dec.decode(value, { stream: true });
          const parts = acc.split('\n\n');
          acc = parts.pop() || '';
          for (const block of parts) {
            const line = block.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            try {
              const msg = JSON.parse(line.slice(5).trim());
              if (msg && msg.channel && msg.channel !== 'ping') {
                onEvent({ kind: 'event', family: msg.channel, payload: msg.payload ?? {} });
              }
            } catch { /* */ }
          }
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
        log(`openzoo-web: events reconnect (${e.message})`);
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  })();
  return () => ctrl.abort();
}

export async function startGrokBotWeb(opts = {}) {
  const log = opts.log || ((m) => console.error(m));
  const port = opts.port ?? DEFAULT_PORT;
  const bind = opts.bind || BIND;
  const asarPath = opts.asarPath || findGrokBotAsar();
  if (!asarPath) {
    throw new Error('Grok Bot.app not found (looked in ./Grok Bot.app and /Applications).');
  }
  const archive = loadAsar(asarPath);
  const shim = fs.readFileSync(SHIM_PATH, 'utf8') + '\n' + spendChipSource();

  if (!opts.skipBackend) {
    await ensureProxy(log);
    await ensureHijack(log);
  }

  const crashes = [];
  const sockets = new Set();
  const stopSse = opts.skipBackend ? () => {} : hijackSse((ev) => {
    for (const send of sockets) send(ev);
  }, log);

  function writeHead(res, status, headers = {}, reqForWho = null) {
    const out = { ...headers };
    if (reqForWho) {
      const { setCookie } = ensureVisitorFromRequest(reqForWho);
      if (setCookie) out['set-cookie'] = setCookie;
    }
    res.writeHead(status, out);
  }

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/oz-health') {
      writeHead(res, 200, { 'content-type': 'application/json' }, req);
      res.end(JSON.stringify({
        ok: true,
        asar: asarPath,
        hijack: HIJACK,
        crashes: crashes.length,
        agents: readHouseRoster(os.homedir()).length,
      }));
      return;
    }
    if (urlPath === '/oz-who') {
      const { visitor, setCookie } = ensureVisitorFromRequest(req);
      const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
      if (setCookie) headers['set-cookie'] = setCookie;
      res.writeHead(200, headers);
      res.end(JSON.stringify(visitor));
      return;
    }
    if (urlPath === '/oz-upload' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { parsed = {}; }
        const got = ingestUpload({
          filename: parsed.filename,
          bytesBase64: parsed.bytesBase64,
        });
        writeHead(res, got.ok ? 200 : 413, { 'content-type': 'application/json' }, req);
        res.end(JSON.stringify(got));
        if (got.ok) log(`openzoo-web: upload ${got.path} ${got.bytes}b`);
      });
      return;
    }
    if (urlPath.startsWith('/oz-upload/') && req.method === 'GET') {
      const rec = lookupUpload(decodeURIComponent(urlPath.slice('/oz-upload'.length)));
      if (!rec) {
        writeHead(res, 404, { 'content-type': 'text/plain' }, req);
        res.end('not found');
        return;
      }
      writeHead(res, 200, {
        'content-type': rec.mime || 'application/octet-stream',
        'cache-control': 'private, max-age=3600',
      }, req);
      res.end(rec.buf);
      return;
    }
    if (urlPath === '/oz-crash' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          crashes.push(body);
          if (crashes.length > 40) crashes.shift();
          log(`openzoo-web: crash ${body.type || ''} ${String(body.message || '').slice(0, 240)}`);
        } catch { /* */ }
        writeHead(res, 204, {}, req);
        res.end();
      });
      return;
    }
    if (urlPath === '/oz-crash' && req.method === 'GET') {
      writeHead(res, 200, { 'content-type': 'application/json' }, req);
      res.end(JSON.stringify(crashes, null, 2));
      return;
    }
    if (urlPath === '/oz-mobile.css') {
      writeHead(res, 200, { 'content-type': MIME.css, 'cache-control': 'no-store' }, req);
      res.end(MOBILE_CSS);
      return;
    }
    if (urlPath === '/oz-shim.js') {
      const { visitor, setCookie } = ensureVisitorFromRequest(req);
      const headers = { 'content-type': MIME.js, 'cache-control': 'no-store' };
      if (setCookie) headers['set-cookie'] = setCookie;
      const prelude = `window.__OZ_WHO_PALETTE__=${JSON.stringify(visitorPaletteMap())};\n`
        + `window.__OZ_WHO__=${JSON.stringify(visitor)};\n`;
      res.writeHead(200, headers);
      res.end(prelude + shim);
      return;
    }
    let rel = urlPath === '/' ? 'dist/renderer/index.html' : path.posix.normalize(urlPath).replace(/^\/+/, '');
    if (rel === 'index.html' || !rel.startsWith('dist/')) rel = `dist/renderer/${rel}`;
    const data = readAsarFile(archive, rel);
    if (!data) {
      writeHead(res, 404, { 'content-type': 'text/plain' }, req);
      res.end('not found');
      return;
    }
    const ext = rel.split('.').pop();
    let body = data;
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': rel.endsWith('index.html') ? 'no-store' : 'public, max-age=86400',
    };
    if (rel.endsWith('index.html')) {
      const { setCookie } = ensureVisitorFromRequest(req);
      if (setCookie) headers['set-cookie'] = setCookie;
      body = Buffer.from(injectIndexHtml(data.toString('utf8')), 'utf8');
    }
    res.writeHead(200, headers);
    res.end(body);
  });

  server.on('upgrade', (req, socket) => {
    if ((req.url || '').split('?')[0] !== '/oz-coord') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const { visitor, setCookie } = ensureVisitorFromRequest(req);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n`
      + (setCookie ? `Set-Cookie: ${setCookie}\r\n` : '')
      + '\r\n',
    );
    const send = attachWs(socket, (frame, s) => {
      if (frame?.kind === 'request') {
        const who = frame.method === 'sendPrompt' && visitor ? ` visitor=${visitor.shortname}` : '';
        log(`openzoo-web: coord ${frame.method}${who}`);
      }
      handleCoordinatorFrame(frame, s, { hijack: HIJACK, visitor }).catch((e) => {
        log(`openzoo-web: coord ${e.message}`);
      });
    });
    sockets.add(send);
    socket.on('close', () => sockets.delete(send));
    socket.on('error', () => sockets.delete(send));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => resolve());
  });
  const url = `http://${bind === '0.0.0.0' ? 'localhost' : bind}:${port}/`;
  log(`openzoo-web: Grok Bot renderer at ${url}`);
  log(`            asar ${asarPath}`);
  return {
    url,
    server,
    asarPath,
    close() {
      stopSse();
      try { fs.closeSync(archive.fd); } catch { /* */ }
      server.close();
    },
  };
}

export async function runGrokBotWeb(argv = []) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const log = (m) => console.error(m);
  const started = await startGrokBotWeb({ log });
  if (!argv.includes('--no-open') && process.platform === 'darwin') {
    exec(`open ${JSON.stringify(started.url)}`);
  }
  log('openzoo-web: leave this running. ctrl-c stops it.');
  if (argv.includes('--once')) return started;
  await new Promise(() => {});
  return started;
}
