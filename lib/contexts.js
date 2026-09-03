/**
 * Context manifest — "the body never ships twice."
 *
 * ~/.openzoo/contexts.json (chmod 600) maps sha256(normalized corpus) →
 * { context_id, boundAt } per API base. A hit means the corpus is already
 * bound on the zoo's holographic sidecar, so an ask ships only the question
 * plus an X-HRR-Context header instead of re-uploading megabytes.
 *
 * Scoped per API base: the same corpus bound on a different zoo is a
 * different context id, and pointing OPENZOO_API_BASE elsewhere must never
 * replay ids the new gateway has never seen.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(os.homedir(), '.openzoo', 'contexts.json');

/** sha256 of the normalized corpus text. Normalization (CRLF→LF + trim) keeps
 *  the hash stable across OSes and trailing-whitespace edits — the corpus the
 *  sidecar chunks is semantically identical either way. */
export function corpusHash(text) {
  return createHash('sha256').update(String(text).replace(/\r\n/g, '\n').trim()).digest('hex');
}

function load() {
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function save(map) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  // write-then-rename so a crash mid-write never truncates the manifest
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(map, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, FILE);
}

/** manifest entry for (apiBase, hash) or null. */
export function lookupContext(apiBase, hash) {
  const map = load();
  return map[apiBase]?.[hash] ?? null;
}

export function rememberContext(apiBase, hash, contextId) {
  const map = load();
  map[apiBase] = map[apiBase] || {};
  map[apiBase][hash] = { context_id: contextId, boundAt: new Date().toISOString() };
  save(map);
}

export function forgetContext(apiBase, hash) {
  const map = load();
  if (map[apiBase]?.[hash]) {
    delete map[apiBase][hash];
    if (!Object.keys(map[apiBase]).length) delete map[apiBase];
    save(map);
    return 1;
  }
  return 0;
}

/** Flat list of every entry: { apiBase, hash, context_id, boundAt }. */
export function listContexts() {
  const map = load();
  const out = [];
  for (const [apiBase, entries] of Object.entries(map)) {
    for (const [hash, e] of Object.entries(entries)) {
      out.push({ apiBase, hash, context_id: e.context_id, boundAt: e.boundAt });
    }
  }
  out.sort((a, b) => String(b.boundAt).localeCompare(String(a.boundAt)));
  return out;
}

/** Forget by hash prefix (any api base) or 'all'. Returns removed count. */
export function forgetContexts(selector) {
  const map = load();
  let removed = 0;
  if (selector === 'all') {
    for (const entries of Object.values(map)) removed += Object.keys(entries).length;
    save({});
    return removed;
  }
  for (const [apiBase, entries] of Object.entries(map)) {
    for (const hash of Object.keys(entries)) {
      if (hash.startsWith(selector)) {
        delete entries[hash];
        removed += 1;
      }
    }
    if (!Object.keys(entries).length) delete map[apiBase];
  }
  if (removed) save(map);
  return removed;
}
