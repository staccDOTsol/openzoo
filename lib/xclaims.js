/**
 * Shared tweet-id locks for the X reply bots.
 *
 * Thirteen bots search thirteen lanes, and lanes overlap. Before a bot spends
 * a turn drafting a reply it CLAIMS the tweet id here; the claim is atomic
 * on the host (one process, synchronous file write), leased for CLAIM_TTL_MS
 * so a bot that dies mid-reply frees the tweet, and `done` makes it permanent.
 *
 * File: ~/.openzoo/xclaims.json  { [tweetId]: { by, name, at, until, done, url } }
 * `done` entries are also appended to the human's ledger
 * (~/openzoo-shim/openzoobot-posted.json) so the old "never reply twice" file
 * keeps working for anything that reads it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLAIM_TTL_MS = Number(process.env.OZ_XCLAIM_TTL_MS || 20 * 60_000);

export function claimsPath(home = os.homedir()) {
  return path.join(home, '.openzoo', 'xclaims.json');
}

export function tweetIdFrom(input) {
  const s = String(input || '').trim();
  const m = s.match(/status(?:es)?\/(\d{8,25})/) || s.match(/^(\d{8,25})$/);
  return m ? m[1] : '';
}

export function loadClaims(home = os.homedir()) {
  try {
    const j = JSON.parse(fs.readFileSync(claimsPath(home), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

export function saveClaims(home, claims) {
  const p = claimsPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(claims, null, 2));
  fs.renameSync(tmp, p);
  return claims;
}

/** Atomic on the host: returns {ok:true} once per live lease, else who holds it. */
export function claimTweet({ tweet, by, name = '', home = os.homedir(), now = Date.now(), ttlMs = CLAIM_TTL_MS } = {}) {
  const id = tweetIdFrom(tweet);
  if (!id) return { ok: false, error: 'no tweet id (pass the status URL or numeric id)' };
  const claims = loadClaims(home);
  const cur = claims[id];
  if (cur?.done) return { ok: false, id, reason: 'already replied', by: cur.name || cur.by, url: cur.url || '' };
  if (cur && cur.by !== by && Number(cur.until) > now) {
    return { ok: false, id, reason: 'claimed by another bot', by: cur.name || cur.by, until: cur.until };
  }
  claims[id] = { by: String(by || ''), name: String(name || ''), at: now, until: now + ttlMs, done: false, url: '' };
  saveClaims(home, claims);
  return { ok: true, id, until: claims[id].until, renewed: !!cur };
}

export function releaseTweet({ tweet, by, home = os.homedir() } = {}) {
  const id = tweetIdFrom(tweet);
  const claims = loadClaims(home);
  const cur = claims[id];
  if (!cur) return { ok: true, id, released: false };
  if (cur.done) return { ok: false, id, reason: 'already replied' };
  if (cur.by !== by) return { ok: false, id, reason: 'not your claim', by: cur.name || cur.by };
  delete claims[id];
  saveClaims(home, claims);
  return { ok: true, id, released: true };
}

/** Permanent. Also appends to the human's ledger so old readers still see it. */
export function markDone({ tweet, by, name = '', url = '', lane = '', home = os.homedir(), ledgerPath, now = Date.now() } = {}) {
  const id = tweetIdFrom(tweet);
  if (!id) return { ok: false, error: 'no tweet id' };
  const claims = loadClaims(home);
  const cur = claims[id];
  if (cur?.done && cur.by !== by) return { ok: false, id, reason: 'already replied by another bot', by: cur.name || cur.by };
  claims[id] = { by: String(by || ''), name: String(name || cur?.name || ''), at: cur?.at || now, until: 0, done: true, url: String(url || ''), doneAt: now };
  saveClaims(home, claims);
  const ledger = ledgerPath || path.join(home, 'openzoo-shim', 'openzoobot-posted.json');
  try {
    let j = { posted: [] };
    try { j = JSON.parse(fs.readFileSync(ledger, 'utf8')); } catch { /* fresh */ }
    if (!Array.isArray(j.posted)) j.posted = [];
    j.posted.push({ tweet: `https://x.com/i/status/${id}`, ours: String(url || ''), lane: String(lane || ''), by: String(name || by || ''), at: new Date(now).toISOString() });
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, JSON.stringify(j, null, 2));
  } catch { /* the lock file is the source of truth; the ledger is a courtesy */ }
  return { ok: true, id, url: String(url || '') };
}

/** Everything a bot needs to skip fast: done ids + live claims by others. */
export function listClaims({ home = os.homedir(), now = Date.now() } = {}) {
  const claims = loadClaims(home);
  const done = [];
  const live = [];
  for (const [id, c] of Object.entries(claims)) {
    if (c.done) done.push(id);
    else if (Number(c.until) > now) live.push({ id, by: c.name || c.by, until: c.until });
  }
  return { done, live, total: Object.keys(claims).length };
}
