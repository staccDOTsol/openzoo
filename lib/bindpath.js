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
import { corpusHash, rememberContext, lookupContext } from './contexts.js';

/** Bodies over this go in their own part. Under the ~8MB transport ceiling
 *  with room for JSON escaping, which can inflate text substantially. */
export const MAX_PART_BYTES = Number(process.env.OPENZOO_BIND_PART_BYTES || 4_000_000);

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

async function postBind(payload) {
  const r = await fetch(`${config.apiBase}/v1/hrr/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  const text = files
    .map((f) => `===== ${path.relative(path.dirname(resolved), f) || path.basename(f)} =====\n${readAsText(f)}`)
    .join('\n\n');

  const bytes = Buffer.byteLength(text);
  const hash = corpusHash(text);
  if (!force) {
    const hit = lookupContext(config.apiBase, hash);
    if (hit) {
      onProgress?.({ stage: 'reused', contextId: hit.context_id, bytes, files: files.length });
      return { contextId: hit.context_id, files, parts: 0, bytes, reused: true };
    }
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
