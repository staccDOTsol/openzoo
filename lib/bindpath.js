/**
 * Chunk-and-bind a FILE or DIRECTORY from local disk.
 *
 * WHY THIS EXISTS: harnesses cap what they can inline. Cursor truncates every
 * file read at 100,000 characters, so an agent asked to "consume this 8.7MB
 * export" physically cannot put it in a request body no matter how large the
 * zoo's context is — it never gets the bytes in the first place. The CLI and
 * the local MCP server both run ON the machine that holds the file, so they
 * can read it directly and hand the zoo the whole thing.
 *
 * A single request also cannot carry an arbitrary corpus: the network hop in
 * front of the gateway drops bodies past ~8MB (an opaque 413 or a dead
 * connection). So the corpus is split into parts under that ceiling and bound
 * SEQUENTIALLY — part 1 creates the context, every later part is appended to
 * the same context_id. The result is one context holding everything.
 *
 * Splitting happens on PARAGRAPH boundaries where possible. leCore's own
 * chunker documents why ("a fact split across two chunks is retrievable from
 * neither"), and the same reasoning applies one level up: cutting mid-sentence
 * at an arbitrary byte offset can strand a fact across two bind calls.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createHash } from 'node:crypto';
import { corpusHash, rememberContext, lookupContext } from './contexts.js';
import { withNamespace } from './namespace.js';

/**
 * Bodies over this go in their own part.
 *
 * Sized by TIME, not just by the transport ceiling. Each append re-indexes a
 * larger context, so parts get progressively slower — MEASURED binding a 23MB
 * Rust tree, 4MB parts ran 25s → 30s → 65s. A minutes-long bind is also a
 * minutes-long window in which any gateway restart destroys all the work done
 * so far (a deploy mid-bind cost exactly that, five good parts thrown away).
 * Smaller parts cost more round trips, finish sooner, and lose less when
 * something upstream cycles.
 */
export const MAX_PART_BYTES = Number(process.env.OPENZOO_BIND_PART_BYTES || 2_000_000);

/** Text-ish files worth binding. Anything else is skipped rather than
 *  silently binding a binary as mojibake. */
const DEFAULT_EXTS = [
  '.txt', '.md', '.json', '.jsonl', '.csv', '.tsv', '.log', '.html', '.htm', '.xml',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.rs', '.go', '.java', '.c',
  '.h', '.cpp', '.hpp', '.rb', '.php', '.sh', '.sql', '.yaml', '.yml', '.toml', '.ini',
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.next', '__pycache__', '.venv']);

/** Refuse rather than grind. A directory of exports can be hundreds of MB;
 *  binding that takes many minutes and mostly buys markup. Raise deliberately. */
export const MAX_TOTAL_BYTES = Number(process.env.OPENZOO_BIND_MAX_BYTES || 32 * 1024 * 1024);

/**
 * HTML → readable text. Chat/forum exports are ~90% markup: binding the raw
 * pages wastes the corpus on tags and makes retrieval rank div soup against
 * the question. Deliberately crude (no parser dependency) but it keeps the
 * text nodes in document order, which is all retrieval needs.
 */
export function stripHtml(html) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

const readAsText = (file) => {
  const raw = fs.readFileSync(file, 'utf8');
  return /\.html?$/i.test(file) ? stripHtml(raw) : raw;
};

/** Every bindable file under `root` (or just `root` if it is a file). */
export function collectFiles(root, { exts = DEFAULT_EXTS, maxFiles = 5000 } = {}) {
  const st = fs.statSync(root);
  if (st.isFile()) return [root];
  const out = [];
  const walk = (dir) => {
    if (out.length >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(p);
      } else if (exts.includes(path.extname(entry.name).toLowerCase())) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Split text into parts at or under `maxBytes`, preferring paragraph breaks
 * and falling back to line breaks, then to a hard cut. Byte-aware, because a
 * character count lies for non-ASCII — and chat exports are full of it.
 */
export function splitIntoParts(text, maxBytes = MAX_PART_BYTES) {
  const parts = [];
  let rest = text;
  while (Buffer.byteLength(rest) > maxBytes) {
    // Walk back from the byte ceiling to a boundary. Slice generously by
    // chars first (bytes >= chars), then trim to fit.
    let cut = rest.length;
    while (Buffer.byteLength(rest.slice(0, cut)) > maxBytes) cut = Math.floor(cut * 0.9);
    const window = rest.slice(0, cut);
    const at = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    const end = at > cut * 0.5 ? at : cut; // only honour a boundary that is not absurdly early
    parts.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\n+/, '');
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}


/**
 * DELTA BIND — ship only the chunks the server does not already hold.
 *
 * The whole-bind path below hashes the CONCATENATED corpus and re-uploads
 * every part on a miss, so editing one file in a repo re-ships the tree.
 * MEASURED here: a 23MB Rust tree in 4MB parts ran 25s -> 30s -> 65s, and a
 * deploy mid-bind threw five good parts away.
 *
 * Here the unit is one file (split further only when a file alone exceeds a
 * part). Probe with sha256 per chunk, get back {missing, known}, ship the
 * missing in batches under MAX_PART_BYTES, and when every hash resolves the
 * corpus binds under an ordinary context_id — through the same chunked path
 * as a whole bind, so recall cannot tell the difference. MEASURED on the
 * sidecar: 6 files / 124,350 chars, editing one file re-ships 22,525 (18%).
 *
 * Any non-200 anywhere returns null and the caller falls back to the whole
 * bind. Delta is an optimisation; it must never be the reason a bind fails.
 */
const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

const ddbg = (...a) => { if (process.env.OPENZOO_BIND_DEBUG) console.error('[delta]', ...a); };

async function postDelta(payload) {
  const r = await fetch(`${config.apiBase}/v1/hrr/delta`, {
    method: 'POST',
    headers: withNamespace({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (r.status !== 200) { ddbg('HTTP', r.status, (await r.text().catch(() => '')).slice(0, 200)); return null; }
  const j = await r.json().catch(() => null);
  if (!(j && Array.isArray(j.missing))) ddbg('bad shape', JSON.stringify(j).slice(0, 200));
  return j && Array.isArray(j.missing) ? j : null;
}

async function bindDelta(fileTexts, shardKey, onProgress) {
  const chunks = [];
  for (const t of fileTexts) for (const part of splitIntoParts(t)) chunks.push(part);
  const hashes = chunks.map(sha256);
  const byHash = new Map(hashes.map((h, i) => [h, chunks[i]]));

  const probe = await postDelta({ chunk_hashes: hashes, shard_key: shardKey });
  if (!probe) return null;
  let missing = probe.missing;
  const total = chunks.reduce((n, c) => n + Buffer.byteLength(c), 0);
  onProgress?.({ stage: 'delta', chunks: chunks.length, missing: missing.length, bytes: total });

  let last = probe;
  let shipped = 0;
  while (missing.length) {
    // one fill per batch under the part ceiling; the last fill assembles
    const batch = {};
    let size = 0;
    for (const h of missing) {
      const t = byHash.get(h);
      if (t === undefined) { ddbg('missing hash not in byHash', h); return null; }
      if (size && size + Buffer.byteLength(t) > MAX_PART_BYTES) break;
      batch[h] = t; size += Buffer.byteLength(t);
    }
    if (!Object.keys(batch).length) { ddbg('empty batch'); return null; }
    last = await postDelta({ chunk_hashes: hashes, chunks: batch, shard_key: shardKey });
    if (!last) return null;
    shipped += size;
    onProgress?.({ stage: 'delta-fill', shipped, of: total, remaining: last.missing.length });
    if (last.missing.length >= missing.length) { ddbg('no progress', last.missing.length, missing.length, JSON.stringify(last.refused)); return null; }   // no progress: refused chunks
    missing = last.missing;
  }
  if (!last.complete || !last.context_id) { ddbg('incomplete', JSON.stringify(last).slice(0, 200)); return null; }
  return { contextId: last.context_id, chunks: chunks.length, shipped, bytes: total };
}

async function postBind(payload) {
  const r = await fetch(`${config.apiBase}/v1/hrr/bind`, {
    method: 'POST',
    headers: withNamespace({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (r.status !== 200) throw new Error(`bind failed: HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  if (!j?.context_id) throw new Error('bind returned no context_id');
  return j;
}

/**
 * Read `target` (file or directory), split it, and bind every part into ONE
 * context. Returns { contextId, files, parts, bytes, reused }.
 *
 * Binding is free, but it is not instant on a large corpus, so `onProgress`
 * reports each part as it lands rather than going quiet for minutes.
 */
export async function bindPath(target, { exts, onProgress, force = false } = {}) {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) throw new Error(`no such file or directory: ${resolved}`);

  const files = collectFiles(resolved, exts ? { exts } : {});
  if (!files.length) throw new Error(`nothing bindable under ${resolved} (looked for text-like files)`);

  // Size the job BEFORE reading anything. A 2GB export folder is 100MB of
  // text-like files, and silently grinding through it for minutes reads as a
  // hang — an actionable refusal is better than a spinner.
  const onDisk = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  if (onDisk > MAX_TOTAL_BYTES) {
    const biggest = files
      .map((f) => ({ f, size: fs.statSync(f).size }))
      .sort((a, b) => b.size - a.size).slice(0, 3)
      .map(({ f, size }) => `${path.basename(f)} (${(size / 1048576).toFixed(1)}MB)`);
    throw new Error(
      `${(onDisk / 1048576).toFixed(0)}MB across ${files.length} files exceeds the ${(MAX_TOTAL_BYTES / 1048576).toFixed(0)}MB bind limit. `
      + `Largest: ${biggest.join(', ')}. Point at one file, narrow with --ext/ext, `
      + `or raise OPENZOO_BIND_MAX_BYTES if you really want all of it.`,
    );
  }

  // Each file is prefixed with its path so retrieval can cite where a passage
  // came from — a corpus of concatenated files with no provenance is much
  // less useful to answer from. HTML is reduced to its text (see readAsText).
  const fileTexts = files
    .map((f) => `===== ${path.relative(path.dirname(resolved), f) || path.basename(f)} =====\n${readAsText(f)}`);
  const text = fileTexts.join('\n\n');

  const bytes = Buffer.byteLength(text);
  const hash = corpusHash(text);
  if (!force) {
    const hit = lookupContext(config.apiBase, hash);
    if (hit) {
      onProgress?.({ stage: 'reused', contextId: hit.context_id, bytes, files: files.length });
      return { contextId: hit.context_id, files, parts: 0, bytes, reused: true };
    }
  }

  // Delta first: on a re-bind after an edit this ships one file, not the tree.
  // OPENZOO_BIND_DELTA=0 forces the whole-bind path.
  if (process.env.OPENZOO_BIND_DELTA !== '0') {
    try {
      const d = await bindDelta(fileTexts, resolved, onProgress);
      if (d) {
        rememberContext(config.apiBase, hash, d.contextId);
        return { contextId: d.contextId, files, parts: d.chunks, bytes, reused: false, delta: true, shipped: d.shipped };
      }
    } catch (e) { ddbg('threw', e?.message); /* fall through to the whole bind */ }
  }

  const parts = splitIntoParts(text);
  onProgress?.({ stage: 'start', files: files.length, parts: parts.length, bytes });

  let contextId = null;
  for (let i = 0; i < parts.length; i++) {
    // Part 1 creates the context; every later part APPENDS by passing the id
    // back. This is what lets a corpus exceed the per-request ceiling.
    const j = await postBind(contextId ? { corpus: parts[i], context_id: contextId } : { corpus: parts[i] });
    contextId = j.context_id;
    onProgress?.({ stage: 'part', index: i + 1, of: parts.length, bytes: Buffer.byteLength(parts[i]), contextId });
  }

  rememberContext(config.apiBase, hash, contextId);
  return { contextId, files, parts: parts.length, bytes, reused: false };
}
