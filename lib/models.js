import { config } from './config.js';

/**
 * Model-id rewriting — "any harness, zero model setup".
 *
 * Cursor and friends send THEIR model ids ("gpt-5.6-sol", "gpt-4o",
 * "claude-…") to whatever base URL is configured, and the zoo answers
 * "model not available". Users will not hand-add custom models per harness,
 * so the proxy maps unknown ids onto the zoo's live catalog instead:
 *
 *   1. an id the zoo serves passes through UNTOUCHED — this layer can never
 *      hijack an explicit, valid choice;
 *   2. a family hint in the requested id (grok→x-ai/, gemini→google/, …)
 *      picks the plain (non-:free/:batch) model of that family;
 *   3. anything else — gpt-*, claude-*, composer, o3 — falls through to
 *      OPENZOO_DEFAULT_MODEL, or a preference-ordered pick from the catalog.
 *
 * Every rewrite is logged with both ids. The catalog is fetched live and
 * cached briefly, so new zoo models resolve without shipping this package.
 */

/**
 * The editor-slot map: bland id the editor accepts -> the zoo model that should
 * actually answer it. Mirrors DEFAULT_SLOTS in cursorcfg.js; OPENZOO_EDITOR_MAP
 * overrides both ("gpt-4o=x-ai/grok-4.6:Grok 4.6,...").
 */
const DEFAULT_SLOT_MODELS = {
  'gpt-4o': 'anthropic/claude-opus-5',
  'gpt-4.1': 'anthropic/claude-sonnet-5',
  'gpt-4-turbo': 'x-ai/grok-4.6',
  'gpt-4o-mini': 'google/gemini-3.7-flash',
  'gpt-4.1-mini': 'deepseek/deepseek-v4-pro-0813',
  'gpt-3.5-turbo': 'qwen/qwen3.8-2.4t-a95b',
};

export function editorSlot(id) {
  const env = process.env.OPENZOO_EDITOR_MAP;
  if (env) {
    for (const part of env.split(',')) {
      const [lhs, rhs] = part.split('=');
      if ((lhs || '').trim() === id && rhs) return rhs.split(':')[0].trim();
    }
  }
  return DEFAULT_SLOT_MODELS[id] || null;
}

const CATALOG_TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, ids: null };

export async function zooModelIds() {
  if (cache.ids && Date.now() - cache.at < CATALOG_TTL_MS) return cache.ids;
  const r = await fetch(`${config.apiBase}/v1/models`);
  if (!r.ok) throw new Error(`model catalog fetch failed: HTTP ${r.status}`);
  const d = await r.json();
  const ids = (d.data || []).map((m) => m.id).filter(Boolean);
  if (ids.length) cache = { at: Date.now(), ids };
  return ids;
}

/** Vendor fingerprints in harness model ids → zoo catalog prefixes. Order
 *  matters only for overlapping hints; first match wins. */
const FAMILIES = [
  [/^gpt|^chatgpt|^o[134]\b|^o[134]-|openai/i, 'openai/'],
  [/claude|anthropic/i, 'anthropic/'],
  [/gemini|google/i, 'google/'],
  [/grok|x-?ai/i, 'x-ai/'],
  [/deepseek/i, 'deepseek/'],
  [/qwen/i, 'qwen/'],
  [/mistral|mixtral|codestral/i, 'mistralai/'],
  [/llama|meta\b/i, 'meta-llama/'],
  [/glm|z-ai|zhipu/i, 'z-ai/'],
  [/kimi|moonshot/i, 'moonshotai/'],
  [/minimax/i, 'minimax/'],
  [/command|cohere/i, 'cohere/'],
  [/nova|amazon/i, 'amazon/'],
  [/sonar|perplexity/i, 'perplexity/'],
  [/nemotron|nvidia/i, 'nvidia/'],
  [/seed|doubao|bytedance/i, 'bytedance-seed/'],
  [/solar|upstage/i, 'upstage/'],
  [/liquid|lfm/i, 'liquid/'],
  [/sakana/i, 'sakana/'],
];

/**
 * Capability-tier fingerprints. The rewrite must land on a LIKE model — a
 * harness asking for a flagship gets the zoo's flagship, "mini"/"flash" gets
 * a light model, a reasoning id gets the heaviest thing available — never a
 * one-size-fits-all default.
 */
const LIGHT_RE = /mini|nano|flash|lite|small|tiny|haiku|lightning|turbo/i;
const HEAVY_RE = /pro\b|pro-|max\b|opus|ultra|large|\bsol\b/i;
const REASON_RE = /^o[134]\b|^o[134]-|reason|think|r1\b|deepthink/i;
const CODE_RE = /code|coder|codex|composer|copilot/i;

/** "2.6b" → light, "70b"/"2.4t" → heavy; a param count in the id outranks words. */
function paramTier(id) {
  const m = /(\d+(?:\.\d+)?)([bt])\b/i.exec(id);
  if (!m) return null;
  const n = Number(m[1]) * (m[2].toLowerCase() === 't' ? 1000 : 1);
  return n >= 60 ? 'heavy' : n < 15 ? 'light' : 'mid';
}

function tierOf(id) {
  if (REASON_RE.test(id)) return 'reason';
  return paramTier(id) || (LIGHT_RE.test(id) ? 'light' : HEAVY_RE.test(id) ? 'heavy' : 'mid');
}

const GENERIC_TOKENS = new Set(['chat', 'model', 'latest', 'preview', 'instruct', 'v1', 'v2', 'v3', 'v4']);
const tokensOf = (id) => id.toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t && !GENERIC_TOKENS.has(t));

/**
 * Map a requested model id onto the catalog by similarity. Returns null when
 * the id is already servable (no rewrite), otherwise the closest zoo id.
 * OPENZOO_DEFAULT_MODEL is an explicit user override, not a fallback tier.
 */
export function resolveModel(requested, ids) {
  if (!requested || !ids?.length || ids.includes(requested)) return null;
  // `openzoo-` prefixed names exist so an editor cannot mistake them for its
  // OWN models: Cursor claims any name in its catalog (claude-opus-5, grok-4.6)
  // and routes it to its backend, ignoring the custom endpoint entirely —
  // measured, zero connections ever reached the proxy. A name it does not know
  // is forced down the custom path. Strip the marker before matching so
  // openzoo-opus-5 still resolves to anthropic/claude-opus-5.
  const bare = String(requested).replace(/^openzoo[-/]/i, '');
  if (bare !== requested) {
    if (ids.includes(bare)) return bare;
    // EXACT INVERSE OF MINTING. augmentModelList creates each twin as
    // `openzoo-<suffix>` where suffix = id.split('/')[1], so the way back is a
    // suffix match — not the similarity scorer below. Without this, a twin fell
    // through to scoring and could land on a NEIGHBOUR of its own source:
    // openzoo-claude-opus-5 resolved to anthropic/claude-opus-5-FAST, and with
    // OPENZOO_DEFAULT_MODEL set in the environment every twin resolved to that
    // one model instead — the user picked a model in the editor and silently got
    // a different one. A twin is an EXPLICIT choice, so it is honoured before
    // both the env override and the scorer.
    const suffixed = ids.filter((id) => id.slice(id.indexOf('/') + 1) === bare);
    // Full-strength before :free/:batch, mirroring the ordering everywhere else.
    const exact = suffixed.find((id) => !id.includes(':')) || suffixed[0];
    if (exact) return exact;
    requested = bare;
  }
  // An explicit OPENZOO_DEFAULT_MODEL is a deliberate act and outranks
  // everything below it, including the editor slots.
  const env = process.env.OPENZOO_DEFAULT_MODEL;
  if (env && ids.includes(env)) return env;

  // SLOT MAP. The editor only accepts a handful of bland ids it already knows,
  // so the shim writes those as slots and shows a real label for each (slotFor
  // in cursorcfg.js). That label would be a LIE if the id then fell through to
  // the similarity scorer, so the same mapping is honoured here: gpt-4o really
  // is served by claude-opus-5. One source of truth, OPENZOO_EDITOR_MAP.
  const slot = editorSlot(requested);
  if (slot && ids.includes(slot)) return slot;

  const reqTier = tierOf(requested);
  const reqCode = CODE_RE.test(requested);
  const reqToks = new Set(tokensOf(requested));

  let best = null;
  let bestScore = -Infinity;
  for (const id of ids) {
    let score = 0;
    // Same vendor family is the strongest signal there is.
    for (const [re, prefix] of FAMILIES) {
      if (re.test(requested) && id.startsWith(prefix)) { score += 100; break; }
    }
    // Tier: exact match strong; reasoning degrades to heavy (a reasoner's
    // nearest neighbour is a flagship, never a mini); mid borders both.
    const t = tierOf(id);
    if (t === reqTier) score += 40;
    else if (reqTier === 'reason' && t === 'heavy') score += 30;
    else if ((reqTier === 'mid') !== (t === 'mid') && t !== 'light' && reqTier !== 'light') score += 15;
    else if ((reqTier === 'light' && t === 'mid') || (reqTier === 'mid' && t === 'light')) score += 15;
    // Specialisation: code asks want code models; nothing else does.
    if (CODE_RE.test(id)) score += reqCode ? 25 : -8;
    // Shared name tokens ("grok", "4.6", "sonnet") pull toward the namesake.
    for (const tok of tokensOf(id)) if (reqToks.has(tok)) score += 10;
    // Full-strength beats :free/:batch variants at equal similarity.
    if (!id.includes(':')) score += 5;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}

/**
 * Ids harnesses ship as DEFAULTS (Cursor, Continue, Aider, Codex CLI, Cline,
 * OpenClaw, LangChain templates…). Merged into GET /v1/models so a harness
 * that validates its configured model against the list passes validation —
 * the POST is then rewritten by resolveModel. Every one of these resolves.
 */
export const ALIAS_IDS = [
  'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4-turbo', 'gpt-3.5-turbo',
  'gpt-5', 'gpt-5-mini', 'chatgpt-4o-latest', 'o1', 'o3', 'o3-mini', 'o4-mini',
  'claude-3-5-sonnet-latest', 'claude-sonnet-4-0', 'claude-opus-4-1',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'grok-4', 'grok-3',
  'deepseek-chat', 'deepseek-reasoner', 'qwen-max', 'llama-3.3-70b',
];

/**
 * Merge alias rows into a /v1/models payload without duplicating real ids.
 * Each alias inherits context_length and pricing from the model it RESOLVES
 * to — a harness sizing its corpus off "gpt-4o" gets the real ceiling of the
 * model that will actually serve it, not a blank.
 */
export function augmentModelList(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const have = new Set(data.map((m) => m.id));
  const ids = data.map((m) => m.id);
  // openzoo-* twins of the popular models. An editor that validates a custom
  // model against THIS list (Cursor's "Add model" box reports "No models
  // available" for anything missing here) can only offer what we publish — and
  // the openzoo- prefix is what stops it claiming the name as one of its own
  // built-ins and routing to its backend instead of to us.
  const branded = [];
  for (const src0 of data) {
    const id = src0.id;
    // Brand only REAL upstream models. Anything we synthesised (a twin or a
    // harness alias) must be skipped, or augmenting an already-augmented
    // payload mints openzoo-openzoo-* and the catalog grows every pass.
    if (!id || id.startsWith('openzoo-') || String(src0.owned_by || '').startsWith('openzoo')) continue;
    const short = id.includes('/') ? id.split('/')[1] : id;
    const name = `openzoo-${short}`;
    if (have.has(name)) continue;
    const src = data.find((m) => m.id === id);
    branded.push({
      id: name,
      object: 'model',
      owned_by: 'openzoo',
      served_by: id,
      ...(src?.context_length ? { context_length: src.context_length, context_window: src.context_window ?? src.context_length } : {}),
      ...(src?.pricing ? { pricing: src.pricing } : {}),
    });
    have.add(name);
  }
  const aliases = ALIAS_IDS.filter((id) => !have.has(id)).map((id) => {
    const target = data.find((m) => m.id === resolveModel(id, ids));
    return {
      id,
      object: 'model',
      owned_by: 'openzoo-alias',
      ...(target?.context_length ? { context_length: target.context_length, context_window: target.context_window ?? target.context_length } : {}),
      ...(target?.pricing ? { pricing: target.pricing } : {}),
      ...(target ? { served_by: target.id } : {}),
    };
  });
  return { ...payload, object: payload?.object || 'list', data: [...data, ...branded, ...aliases] };
}

/**
 * Which request paths carry a rewritable model field. POST-only; embeddings /
 * audio / image / moderation models are DIFFERENT model families — rewriting
 * a chat model into those would corrupt the call, so they pass untouched.
 */
export function rewritablePath(method, url) {
  if (method !== 'POST') return false;
  const p = (url || '').split('?')[0];
  return !/embed|audio|image|moderation/.test(p);
}

/**
 * Rewrite the model field of any request body that has one.
 * Returns null (send as-is) or { body, from, to }. Any failure — bad JSON,
 * unreachable catalog — returns null: this layer must never break a call
 * that would have worked without it.
 */
export async function maybeRewriteModel(bodyBuf) {
  let body;
  try { body = JSON.parse(bodyBuf.toString('utf8')); } catch { return null; }
  if (typeof body?.model !== 'string') return null;
  let ids;
  try { ids = await zooModelIds(); } catch { return null; }
  const to = resolveModel(body.model, ids);
  if (!to) return null;
  return { body: Buffer.from(JSON.stringify({ ...body, model: to })), from: body.model, to };
}
