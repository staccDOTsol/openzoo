/**
 * Grok Bot tray/roster.
 *
 * Electron hijack: a second Cursor login on the same Mac must not inherit the
 * previous account's 1340 / tray (rosterForAccount still isolates that).
 *
 * Cafe/web: every visitor is a cookie identity on ONE house. They share the
 * operator tray at ~/.openzoo/grokbot-agents.json plus any account agents.json
 * under ~/.openzoo/grokbot/<id>/ -- not per-browser localStorage, not empty
 * just because no Cursor account has logged in.
 */
import fs from 'node:fs';
import path from 'node:path';

export function accountSlug(accountId) {
  const s = String(accountId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return s || null;
}

export function accountDir(home, accountId) {
  const slug = accountSlug(accountId);
  if (!slug) return null;
  return path.join(home, '.openzoo', 'grokbot', slug);
}

export function accountPodPath(home, accountId) {
  const dir = accountDir(home, accountId);
  return dir ? path.join(dir, 'pod.json') : null;
}

export function accountAgentsPath(home, accountId) {
  const dir = accountDir(home, accountId);
  return dir ? path.join(dir, 'agents.json') : null;
}

export function houseAgentsPath(home) {
  return path.join(home, '.openzoo', 'grokbot-agents.json');
}

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** First-seen id wins. A later pile can only *upgrade* a UUID name/stub brief. */
export function mergeAgentRecords(piles) {
  const seen = new Map();
  const out = [];
  for (const pile of piles) {
    if (!Array.isArray(pile)) continue;
    for (const a of pile) {
      if (!a?.id) continue;
      const idx = seen.get(a.id);
      if (idx == null) {
        seen.set(a.id, out.length);
        out.push(a);
        continue;
      }
      out[idx] = preferNamedAgent(out[idx], a);
    }
  }
  return out;
}

/**
 * Shared house tray from disk. Cafe visitors have no Cursor account — they
 * still get this list. A live account's file is preferred, never required.
 */
export function readHouseRoster(home, liveAccountId) {
  const piles = [];
  const livePath = liveAccountId ? accountAgentsPath(home, liveAccountId) : null;
  if (livePath) {
    const scoped = readJsonFile(livePath);
    if (Array.isArray(scoped)) piles.push(scoped);
  }
  const global = readJsonFile(houseAgentsPath(home));
  if (Array.isArray(global)) piles.push(global);
  try {
    const dir = path.join(home, '.openzoo', 'grokbot');
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name, 'agents.json');
      if (livePath && p === livePath) continue;
      const a = readJsonFile(p);
      if (Array.isArray(a) && a.length) piles.push(a);
    }
  } catch { /* no grokbot dir yet */ }
  return mergeAgentRecords(piles);
}

/**
 * Isolate two Cursor logins. Cafe (no live account) gets the house fallback.
 * `fallback` is the merged disk roster; never return [] just because oauth
 * hasn't run — that emptied the public site's sidebar.
 */
export function rosterForAccount({ liveAccountId, cachedAccountId, cached, fallback }) {
  if (liveAccountId && cachedAccountId && liveAccountId !== cachedAccountId) return [];
  if (liveAccountId && cachedAccountId && liveAccountId === cachedAccountId) {
    return Array.isArray(cached) ? cached : [];
  }
  if (Array.isArray(fallback) && fallback.length) return fallback;
  return Array.isArray(cached) ? cached : [];
}

function activityRec(agent, activity) {
  if (!activity || !agent?.id) return null;
  if (typeof activity.get === 'function') return activity.get(agent.id) || null;
  return activity[agent.id] || null;
}

function activityTs(agent, activity) {
  const rec = activityRec(agent, activity);
  return (rec && rec.updatedAt) || agent.updatedAt || agent.createdAt || 0;
}

/**
 * Grok Bot client persistence (Xkn) DROPS any row missing these booleans /
 * nulls, then clears the whole persisted tray. That is how a group vanished
 * after the first send: bumpAgent wrote a partial row, restore returned null.
 */
const AGENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** bumpAgent used `{id, name:id}` and 1340 listAgents often echoes that — sidebar then paints UUIDs. */
export function looksLikeAgentId(s, id) {
  const n = String(s || '').trim();
  if (!n) return true;
  if (id && n === String(id)) return true;
  return AGENT_UUID_RE.test(n);
}

export function isStubBrief(brief, id) {
  const b = String(brief || '').trim();
  if (!b) return true;
  if (id && b.startsWith(`You are ${id}. Your job is ${id}`)) return true;
  return /^You are [0-9a-f-]{36}\. Your job is [0-9a-f-]{36}/i.test(b);
}

/** Pull a human name out of a standing brief: "You are 6 · Content Studio…" / "Job: Product Simplification". */
export function nameFromBrief(brief, id) {
  const b = String(brief || '').replace(/^\[brief\]\s*/i, '').trim();
  if (!b) return '';
  const job = b.match(/\bJob:\s*([^\n.]+)/i);
  if (job) {
    const n = job[1].trim();
    if (n && !looksLikeAgentId(n, id)) return n.slice(0, 80);
  }
  const numbered = b.match(/^You are\s+(\d+\s*[·.•.\-—–]+\s*[^\n.]+)/i);
  if (numbered) {
    const n = numbered[1].replace(/\s+for\s+.*$/i, '').trim();
    if (n && !looksLikeAgentId(n, id)) return n.slice(0, 80);
  }
  const you = b.match(/^You are\s+(.+?)(?:\.\s|$)/i);
  if (you) {
    const n = you[1].replace(/\s+for\s+Stacc(?:'s)?(?:\s+LLC)?$/i, '').trim();
    if (n && !looksLikeAgentId(n, id)) return n.slice(0, 80);
  }
  return '';
}

export function nameQuality(a) {
  const n = String(a?.name || a?.title || '').trim();
  if (!n || looksLikeAgentId(n, a?.id)) return 0;
  if (/^(chat|group)$/i.test(n)) return 1;
  if (/^new bot$/i.test(n)) return 2;
  return 3;
}

/** Keep the record that still has a human name / real brief. */
export function preferNamedAgent(keep, incoming) {
  if (!keep) return incoming;
  if (!incoming) return keep;
  const kq = nameQuality(keep);
  const iq = nameQuality(incoming);
  const keepBrief = String(keep.brief || keep.instructions || '').trim();
  const inBrief = String(incoming.brief || incoming.instructions || '').trim();
  const keepStub = isStubBrief(keepBrief, keep.id);
  const inStub = isStubBrief(inBrief, incoming.id);
  if (iq <= kq && !(keepStub && !inStub)) return keep;
  const nameSrc = iq > kq ? incoming : keep;
  const briefSrc = (!inStub && keepStub) ? incoming : keep;
  return {
    ...keep,
    ...incoming,
    name: nameSrc.name || nameSrc.title,
    title: nameSrc.title || nameSrc.name,
    brief: briefSrc.brief || briefSrc.instructions || keepBrief || inBrief,
  };
}

export function displayName(raw = {}) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const id = String(a.id || '');
  const isGroup = a.isGroup === true
    || (Array.isArray(a.memberIds) && a.memberIds.length > 0)
    || (Array.isArray(a.memberAgentIds) && a.memberAgentIds.length > 0);
  for (const cand of [a.name, a.title]) {
    const n = String(cand || '').trim();
    if (n && !looksLikeAgentId(n, id)) return n.slice(0, 80);
  }
  const fromBrief = nameFromBrief(a.brief || a.instructions || a.description, id);
  if (fromBrief) return fromBrief;
  return isGroup ? 'group' : 'chat';
}

/** Standing job from a sidebar name like "6 · Content Studio" or "Bot 1 — Marketing (X)". */
export function briefFromName(name) {
  const n = String(name || '').trim();
  if (!n || /^(new bot|chat|group)$/i.test(n) || looksLikeAgentId(n)) return '';
  // grokroom threads (# main) and bubble-members are not jobs — a brief would
  // kick a zoo turn on a gossip canvas.
  if (/^#\s/.test(n)) return '';
  const role = n.replace(/^\d+\s*[·.•.\-—–]+\s*/, '').trim() || n;
  if (role.length < 2) return '';
  return `You are ${n}. Your job is ${role}. Do that job. Do not ask the human to re-brief you. Coordinate with list_agents and message_agent.`;
}

/** Overlay sidebar id for a grokroom gossip room. */
export function grokroomAgentId(roomId) {
  const id = String(roomId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return id ? `room-${id}` : '';
}

/** Public page on openzoo.fun for a grokroom account (paymaster + browser signer). */
export function grokroomShareUrl(addr, { origin = 'https://openzoo.fun' } = {}) {
  const a = String(addr || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return '';
  return `${String(origin || 'https://openzoo.fun').replace(/\/$/, '')}/r/${a}`;
}

/** Hidden bubble-member id for a grokroom sender. One row, many rooms. */
export function grokroomMemberId(name) {
  const slug = String(name || 'anon').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'anon';
  return `roombot-${slug}`;
}

export function isGrokRoomAgent(a) {
  if (!a || typeof a !== 'object') return false;
  if (a.room && a.room.id) return true;
  return /^room-/.test(String(a.id || ''));
}

export function isGrokRoomMember(a) {
  if (!a || typeof a !== 'object') return false;
  return a.hidden === true || a.hiddenFromSidebar === true || /^roombot-/.test(String(a.id || ''));
}

/** Standing job text. shapeAgent used to drop this, so every restart was amnesia. */
export function agentBrief(raw = {}) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const id = String(a.id || '');
  for (const k of ['brief', 'instructions', 'customInstructions', 'systemPrompt']) {
    const v = a[k];
    if (typeof v === 'string' && v.trim() && !isStubBrief(v, id)) {
      const name = displayName(a);
      const text = v.trim();
      if (id && name && !looksLikeAgentId(name, id) && text.startsWith(`You are ${id}`)) {
        return (`You are ${name}` + text.slice(`You are ${id}`.length)).slice(0, 8000);
      }
      return text.slice(0, 8000);
    }
  }
  const d = String(a.description || '').trim();
  if (d && !isStubBrief(d, id)) return d.slice(0, 8000);
  return briefFromName(displayName(a)).slice(0, 8000);
}

export function shapeAgent(raw = {}) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const id = String(a.id || '');
  const memberIds = Array.isArray(a.memberIds)
    ? a.memberIds.map((x) => String(x)).filter(Boolean)
    : (Array.isArray(a.memberAgentIds) ? a.memberAgentIds.map((x) => String(x)).filter(Boolean) : []);
  const isGroup = a.isGroup === true || memberIds.length > 0;
  const name = displayName({ ...a, isGroup, memberIds });
  const hidden = a.hidden === true || a.hiddenFromSidebar === true;
  let room = null;
  if (a.room && typeof a.room === 'object' && a.room.id) {
    room = { id: String(a.room.id), addr: String(a.room.addr || a.room.address || '') };
  } else if (/^room-/.test(id)) {
    room = { id: id.slice(5), addr: '' };
  }
  const skipJob = hidden || !!room || /^#\s/.test(name);
  const brief = skipJob ? String(a.brief || '').slice(0, 8000) : agentBrief({ ...a, name, title: a.title || name });
  return {
    id,
    name,
    brief,
    description: String((a.description && !looksLikeAgentId(a.description, id) && a.description) || brief || ''),
    title: String((!looksLikeAgentId(a.title, id) && a.title) || name),
    origin: String(a.origin || 'user'),
    path: String(a.path || (id ? `/local/${id}` : '/local')),
    createdAt: Number(a.createdAt) || Date.now(),
    updatedAt: Number(a.updatedAt) || Date.now(),
    hasUnread: !!a.hasUnread,
    unreadCount: Number(a.unreadCount) || 0,
    hidden, // GROKROOM-HIDDEN-BOTS
    hiddenFromSidebar: hidden,
    notificationsEnabled: a.notificationsEnabled !== false,
    notifyOnUpdatesEnabled: a.notifyOnUpdatesEnabled !== false,
    isGroup,
    memberIds: isGroup ? memberIds : [],
    lastMessageId: a.lastMessageId == null ? null : String(a.lastMessageId),
    lastEntry: a.lastEntry && typeof a.lastEntry === 'object' ? a.lastEntry : null,
    awaitingUserResponse: a.awaitingUserResponse && typeof a.awaitingUserResponse === 'object'
      ? a.awaitingUserResponse : null,
    avatarShape: a.avatarShape ?? null,
    avatarColor: a.avatarColor ?? null,
    ...(room ? { room } : {}),
  };
}

/**
 * Full sidebar roster for SSE `agents` / listAgents. Sorts by activity and
 * stamps unread -- does not slice. The old 80-cap hid agents past the tray.
 */
export function rosterForEvent(list, activity, opts) {
  // GROKROOM-HIDDEN-BOTS: client-facing rosters never include hidden bots; persistence passes { includeHidden: true }
  const arr = (Array.isArray(list) ? [...list] : []).filter((a) => (opts && opts.includeHidden) || !a?.hidden);
  arr.sort((x, y) => activityTs(y, activity) - activityTs(x, activity));
  return arr.map((agent) => {
    const rec = activityRec(agent, activity) || {};
    return shapeAgent({
      ...agent,
      updatedAt: rec.updatedAt || agent.updatedAt || agent.createdAt || 0,
      hasUnread: !!rec.hasUnread,
      unreadCount: rec.unreadCount || 0,
    });
  });
}

export const WAKEUP_MIN_SEC = 60;
export const WAKEUP_MAX_SEC = 6 * 3600;
export const WAKEUP_DEFAULT_SEC = 5 * 60;
export const DEFAULT_WAKEUP_PROMPT = 'Wakeup. Continue your brief. Do the next real action (write a file, click, or message a worker). Do not only re-read sitrep. Do not spawn more bots. Do not exec sysctl/uptime.';

export function wakeupsPath(home) {
  return path.join(home, '.openzoo', 'grokbot-wakeups.json');
}

/** "5m" / "1h" / "90" / "30s". Floor 60s so a never-stop cron cannot storm. */
export function parseWakeupEvery(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return WAKEUP_DEFAULT_SEC;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?$/);
  if (!m) return WAKEUP_DEFAULT_SEC;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return WAKEUP_DEFAULT_SEC;
  const u = m[2] || 's';
  let sec = n;
  if (/^m/.test(u)) sec = n * 60;
  else if (/^h/.test(u)) sec = n * 3600;
  return Math.min(WAKEUP_MAX_SEC, Math.max(WAKEUP_MIN_SEC, Math.round(sec)));
}

export function wantsWakeupCron(prompt) {
  const s = String(prompt || '');
  if (/\bcron\b.{0,48}\bwakeups?\b/i.test(s)) return true;
  if (/\bwakeups?\b.{0,48}\bcron\b/i.test(s)) return true;
  if (/\bnever stop\b/i.test(s)) return true;
  if (/\bschedule\b.{0,24}\bwakeups?\b/i.test(s)) return true;
  return false;
}

export function shapeWakeup(agentId, rec = {}, now = Date.now()) {
  const everySec = parseWakeupEvery(rec.everySec ?? rec.every ?? rec.interval);
  const prompt = String(rec.prompt || DEFAULT_WAKEUP_PROMPT).trim().slice(0, 2000)
    || DEFAULT_WAKEUP_PROMPT;
  const lastAt = Number(rec.lastAt) || 0;
  let nextAt = Number(rec.nextAt) || 0;
  if (!Number.isFinite(nextAt) || nextAt <= 0) nextAt = now + everySec * 1000;
  return {
    agentId: String(agentId || rec.agentId || ''),
    everySec,
    prompt,
    lastAt,
    nextAt,
  };
}

export function readWakeups(home) {
  const raw = readJsonFile(wakeupsPath(home));
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [id, rec] of Object.entries(src)) {
    const w = shapeWakeup(id, rec);
    if (w.agentId) out[w.agentId] = w;
  }
  return out;
}

export function deletedAgentsPath(home) {
  return path.join(home, '.openzoo', 'grokbot-deleted.json');
}

export function readDeletedIds(home) {
  const raw = readJsonFile(deletedAgentsPath(home));
  const ids = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.ids) ? raw.ids : []);
  return new Set(ids.map(String).filter(Boolean));
}

export function addDeletedIds(home, ids) {
  const s = readDeletedIds(home);
  for (const id of ids) if (id) s.add(String(id));
  const dir = path.dirname(deletedAgentsPath(home));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(deletedAgentsPath(home), JSON.stringify([...s], null, 2));
  return s;
}

export function filterDeleted(agents, home) {
  const del = readDeletedIds(home);
  if (!del.size || !Array.isArray(agents)) return agents || [];
  return agents.filter((a) => {
    if (!a) return false;
    const id = String(a.id || '');
    // grokroom threads + bubble-members are gossip identities, not user bots.
    // The old sidebar roombots were tombstoned; native rooms must still load.
    if (/^(room-|roombot-)/.test(id)) return true;
    return !del.has(id);
  });
}

export function writeWakeups(home, map) {
  const dir = path.dirname(wakeupsPath(home));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(wakeupsPath(home), JSON.stringify(map || {}, null, 2));
}

export function callerKeyFromAuth(authorization) {
  const a = String(authorization || '').trim();
  if (!a) return '';
  // Not a secret store — a session-scoped equality key so a second oauth
  // does not inherit the previous account's 1340 / tray cache.
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}