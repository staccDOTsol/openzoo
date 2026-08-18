/**
 * Well-known context NAMES for the one shared stacc tenant.
 *
 * THE PROBLEM. Every stacc app now resolves to the same tenant
 * (sha256(chain:signer:"stacc") — see namespace.js), so a corpus bound by
 * `npx openzoo` is finally REACHABLE from openzoo brain or open-webui. But
 * reachable is not findable: recall takes ONE context_id
 * ({tenant_id, context_id, query, top_k}), and the gateway mints that id
 * itself — `{"context_id":"stacc:notes"}` is rejected outright with
 * "invalid context_id format". So the apps could reach each other's memory
 * and still had no way to NAME it.
 *
 * THE FIX. A name -> id registry that lives where every app and every device
 * can already see it: the tenant's own leCore memory. `/v1/memory/write` and
 * `/v1/memory/search` are tenant-scoped via the same tenantFor() the rest of
 * the gateway uses, and they are FREE (logged status "free"), so the registry
 * costs nothing to read and needs no new endpoint, table, or sync.
 *
 * WHY NAMED CONTEXTS RATHER THAN ONE BIG POOL. The obvious alternative is
 * tenant-wide recall: search every context and merge. That is worse, and
 * measurably so. `top_k` is FIXED (32 by default), so pooling makes your
 * actual question compete for retrieval slots against every unrelated corpus
 * you have ever bound — retrieval breadth is already the ceiling here, and
 * widening the haystack lowers the hit rate rather than raising it. A handful
 * of purposeful contexts you can name beats one undifferentiated blob.
 *
 * USAGE
 *   import { setAlias, resolveAlias, listAliases } from './ctxalias.js';
 *   await setAlias('notes', ctxId);        // after a bind
 *   const id = await resolveAlias('notes'); // from any app, any device
 */

import { withNamespace } from './namespace.js';

const GATEWAY = process.env.OPENZOO_API_BASE || 'https://x402-tokens.fly.dev';

// A tag, not a prefix match on free text: memory/search takes tags, and a tag
// keeps registry rows from ever colliding with a user's real notes.
const TAG = 'stacc-ctx-alias';

// Deliberately strict. These names are meant to be typed by a human in
// another app a week later, so ambiguity (case, spaces, unicode) is the enemy.
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

function assertName(name) {
  if (!NAME_RE.test(String(name || ''))) {
    throw new Error(
      `invalid alias name "${name}" — use lowercase a-z 0-9 . _ - (max 63)`);
  }
}

function line(name, contextId) {
  return `${TAG} ${name} = ${contextId}`;
}

async function call(path, body) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method: 'POST',
    headers: withNamespace({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) {
    // The gateway refuses an expired namespace signature on money paths now;
    // say so plainly rather than surfacing a bare 401 from a "free" route.
    throw new Error('namespace signature rejected — is the wallet present?');
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/** Point a name at a context id. Last write wins. */
export async function setAlias(name, contextId) {
  assertName(name);
  if (!contextId) throw new Error('setAlias needs a context id');
  await call('/v1/memory/write', { text: line(name, contextId), tags: [TAG, name] });
  return { name, contextId };
}

/**
 * Resolve a name to a context id, or null.
 *
 * Reads the NEWEST matching row rather than the first: setAlias appends, so a
 * re-pointed name leaves the old row behind and a naive "first hit" would
 * silently keep resolving to the stale context.
 */
export async function resolveAlias(name) {
  assertName(name);
  const rows = hitsOf(await call('/v1/memory/search',
    { query: `${TAG} ${name}`, tags: [TAG, name], top: 200 }));
  let best = null;
  for (const r of rows) {
    const m = String(r?.text ?? '').match(new RegExp(`^${TAG}\\s+${name}\\s*=\\s*(\\S+)$`));
    if (m) best = m[1];        // rows arrive oldest-first, so the last wins
  }
  return best;
}

/** Every name currently registered in this tenant. */
export async function listAliases() {
  const rows = hitsOf(await call('/v1/memory/search', { query: TAG, tags: [TAG], top: 500 }));
  const map = new Map();
  for (const r of rows) {
    const m = String(r?.text ?? '').match(new RegExp(`^${TAG}\\s+(\\S+)\\s*=\\s*(\\S+)$`));
    if (m) map.set(m[1], m[2]);   // later row replaces earlier — re-pointing works
  }
  return Object.fromEntries(map);
}

/**
 * Rows out of a memory_search response, oldest first.
 *
 * The payload key is `hits` (object "ouroboros.memory_search"), NOT items or
 * results — reading the wrong key returns [] and every lookup silently
 * resolves to null, which looks exactly like "the alias was never set".
 *
 * Sorting by id matters as much. Ids are sequential (`note-0000`,
 * `note-0001`, ...) but search returns them by SCORE, and two rows for the
 * same name score identically — so without an explicit order, re-pointing an
 * alias would resolve to whichever row the ranker happened to emit last.
 */
function hitsOf(out) {
  const rows = out?.hits ?? [];
  return rows.slice().sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? '')));
}

export { TAG as ALIAS_TAG };
