import { config } from './config.js';
import { fetchHeaders } from './fetch.js';
// AUTO routing lives on the backend now; these helpers survive only so the
// published catalog can EXCLUDE ids the gateway cannot serve (auto aliases,
// :batch twins, $0 rows). The shim never routes.
export const AUTO_MODEL_ID = 'openzoo/auto';
export const AUTO_MODEL_ALIASES = new Set(['openzoo/auto', 'openzoo-auto', 'auto']);

export function isAutoModel(id) {
  return AUTO_MODEL_ALIASES.has(String(id || '').trim().toLowerCase());
}

/** Ids the gateway cannot quote for a chat turn (:batch twins, ~latest
 *  pointers, openzoo-* aliases). The published catalog must never list them. */
export function isUnservableRouteId(id) {
  const s = String(id || '').trim();
  if (!s) return true;
  if (isAutoModel(s)) return false;
  return s.includes(':batch') || s.startsWith('~') || s.startsWith('openzoo-');
}

/** Both sides must be a finite positive token price. $0 / NaN / missing 500. */
export function isPricedTokenPair(priceIn, priceOut) {
  const pin = Number(priceIn);
  const pout = Number(priceOut);
  return Number.isFinite(pin) && Number.isFinite(pout) && pin > 0 && pout > 0;
}

/** Same threshold as BIND_MIN_CHARS in hrr.js — kept local so this
 *  module stays importable without the wallet/rpc stack. */
const BIND_MIN_CHARS = Number(process.env.OPENZOO_CONTEXT_MIN_CHARS || 16384);

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
let cache = { at: 0, ids: null, base: null };

export function resetZooModelIdsCache() {
  cache = { at: 0, ids: null, base: null };
}

export async function zooModelIds() {
  if (cache.ids && cache.base === config.apiBase && Date.now() - cache.at < CATALOG_TTL_MS) return cache.ids;
  const r = await fetchHeaders(`${config.apiBase}/v1/models`);
  if (!r.ok) throw new Error(`model catalog fetch failed: HTTP ${r.status}`);
  const d = await r.json();
  const ids = quoteableRows(d.data).map((m) => m.id).filter((id) => id && !isAutoModel(id));
  if (ids.length) cache = { at: Date.now(), ids, base: config.apiBase };
  return ids;
}

/** OpenRouter / gateway token price pair. Image/video rows have no prompt. */
export function tokenPricePair(pricing) {
  if (!pricing || typeof pricing !== 'object') return [NaN, NaN];
  return [Number(pricing.prompt ?? pricing.input), Number(pricing.completion ?? pricing.output)];
}

/**
 * A row the gateway can actually quote for chat. Drops :batch, ~latest
 * pointers, openzoo-* twins, $0 / missing / non-token OpenRouter prices.
 */
export function isQuoteableModel(m) {
  const id = m?.id;
  if (isAutoModel(id)) return true;
  if (isUnservableRouteId(id)) return false;
  return isPricedTokenPair(...tokenPricePair(m?.pricing));
}

export function quoteableRows(data) {
  return (Array.isArray(data) ? data : []).filter(isQuoteableModel);
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
  // Virtual router id — never family-match, never steal via OPENZOO_DEFAULT_MODEL.
  if (isAutoModel(requested)) return null;
  // Bare Anthropic / Claude Code ids are never live on Fly/OpenRouter
  // (`claude-opus-5` → 500 unknown model). Rewrite even on a catalog miss
  // or if a gateway row lists the bare name — the request must not leave
  // the sidecar as that id.
  const native = anthropicNativeAlias(requested);
  if (native) return native;
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
 * Bare Anthropic / Claude Code ids. MEASURED 2026-08-20 against Fly
 * x402-tokens: POST /v1/chat/completions model=claude-opus-5 → 500
 * `unknown model claude-opus-5`. The vendor-prefixed twin
 * (`anthropic/claude-opus-5`) 402s and is priced. Claude Code's Auto
 * permission classifier calls these ids on ANTHROPIC_BASE_URL; if the
 * sidecar forwards the bare name, Bash hangs with
 * "claude-opus-5 is temporarily unavailable, so auto mode cannot
 * determine the safety of Bash". Always rewrite. Never send the bare
 * id to OpenRouter / Fly. Do not push x402-tokens — alias here.
 */
export const ANTHROPIC_NATIVE_ALIASES = {
  'claude-opus-5': 'anthropic/claude-opus-5',
  'claude-opus-5-fast': 'anthropic/claude-opus-5-fast',
  'claude-3-5-opus': 'anthropic/claude-opus-5',
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'claude-sonnet-5-fast': 'anthropic/claude-sonnet-5',
  'claude-opus-4-8': 'anthropic/claude-opus-4.8',
  'claude-opus-4.8': 'anthropic/claude-opus-4.8',
  'claude-fable-5': 'anthropic/claude-fable-5',
  'claude-haiku-4.5': 'anthropic/claude-haiku-4.5',
};

/** Claude Code sometimes suffixes a window marker (`claude-opus-5[1m]`). */
function stripAnthropicWindowSuffix(id) {
  return String(id || '').trim().replace(/\[[\d]+m\]$/i, '');
}

/**
 * Priced zoo twin for a bare Anthropic / Claude Code id, or null.
 * Vendor-prefixed ids and openzoo-* twins are left to the rest of resolveModel.
 */
export function anthropicNativeAlias(requested) {
  if (!requested || typeof requested !== 'string') return null;
  const stripped = stripAnthropicWindowSuffix(requested);
  if (!stripped || stripped.includes('/')) return null;
  if (/^openzoo[-/]/i.test(stripped)) return null;
  return ANTHROPIC_NATIVE_ALIASES[stripped] || ANTHROPIC_NATIVE_ALIASES[stripped.toLowerCase()] || null;
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
  'claude-opus-5', 'claude-opus-5-fast', 'claude-3-5-opus', 'claude-sonnet-5',
  'claude-opus-4-8', 'claude-fable-5',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'grok-4', 'grok-3',
  'deepseek-chat', 'deepseek-reasoner', 'qwen-max', 'llama-3.3-70b',
];

export function isHarnessAliasId(id) {
  const stripped = stripAnthropicWindowSuffix(id);
  return ALIAS_IDS.includes(stripped) || Boolean(anthropicNativeAlias(stripped));
}

/**
 * Merge alias rows into a /v1/models payload without duplicating real ids.
 * Each alias inherits context_length and pricing from the model it RESOLVES
 * to — a harness sizing its corpus off "gpt-4o" gets the real ceiling of the
 * model that will actually serve it, not a blank.
 *
 * Does not mint openzoo-* twins. Those duplicated every real id (and every
 * :batch id) in Claude Code's /model picker.
 */
export function augmentModelList(payload, { aliases: withAliases = true } = {}) {
  const data = quoteableRows(payload?.data);
  const have = new Set(data.map((m) => m.id));
  const ids = data.map((m) => m.id);
  const aliases = withAliases
    ? ALIAS_IDS.filter((id) => !have.has(id)).map((id) => {
      const target = data.find((m) => m.id === resolveModel(id, ids));
      return {
        id,
        object: 'model',
        owned_by: 'openzoo-alias',
        ...(target?.context_length ? { context_length: target.context_length, context_window: target.context_window ?? target.context_length } : {}),
        ...(target?.pricing ? { pricing: target.pricing } : {}),
        ...(target ? { served_by: target.id } : {}),
      };
    })
    : [];

  // BARE-NAME TWINS, DERIVED FROM THE LIVE CATALOG.
  //
  // ALIAS_IDS is thirty hand-written strings against a ~435-model catalog, so
  // it drifts: `/model deepseek-v4-pro` answered "Model not found" purely
  // because nobody had typed that string into the list, while
  // `deepseek/deepseek-v4-pro-0813` worked. Claude Code validates /model
  // CLIENT-SIDE against this payload, so the shim's similarity rewriter never
  // gets a chance — the id has to be in the list or the picker refuses it.
  //
  // For every `vendor/name` row, publish `name` too. That is the form people
  // actually type, and it needs no maintenance as the catalog moves.
  //
  // FIRST WRITER WINS on a collision: two vendors can ship the same bare name
  // and silently resolving to whichever sorted last would answer from the
  // wrong model. A bare name that is already a real id is never shadowed.
  const bare = [];
  if (withAliases) {
    const taken = new Set([...have, ...aliases.map((a) => a.id)]);
    for (const m of data) {
      const short = String(m.id).includes('/') ? String(m.id).split('/').pop() : null;
      if (!short || taken.has(short)) continue;
      taken.add(short);
      bare.push({
        id: short,
        object: 'model',
        owned_by: 'openzoo-alias',
        ...(m.context_length ? { context_length: m.context_length, context_window: m.context_window ?? m.context_length } : {}),
        ...(m.pricing ? { pricing: m.pricing } : {}),
        served_by: m.id,
      });
    }
  }

  // FAMILY SHORTCUTS — `/model grok`, `/model deepseek`, `/model gemini`.
  //
  // PROVEN NECESSARY on a live VM: the proxy's fuzzy /v1/models/<id> probe
  // answered `grok -> x-ai/grok-4.6` with a 200, and Claude Code v2.1.246
  // REFUSED THE ID ANYWAY — this client validates /model purely against the
  // list it fetched at startup and never probes per-id. So the only fuzzy a
  // list-validating harness can have is fuzzy that is already IN the list.
  //
  // One row per vendor family, resolved through the same scorer as the POST
  // path, so `grok` lands on the family flagship rather than a hardcoded pick.
  const FAMILY_TOKENS = ['gpt', 'claude', 'gemini', 'grok', 'deepseek', 'qwen',
    'mistral', 'llama', 'glm', 'kimi', 'minimax', 'command', 'nova', 'sonar'];
  const family = [];
  if (withAliases) {
    const ids = data.map((m) => m.id);
    const taken2 = new Set([...have, ...aliases.map((a) => a.id), ...bare.map((b) => b.id)]);
    for (const tok of FAMILY_TOKENS) {
      if (taken2.has(tok)) continue;
      const target = data.find((m) => m.id === resolveModel(tok, ids));
      if (!target) continue;
      taken2.add(tok);
      family.push({
        id: tok,
        object: 'model',
        owned_by: 'openzoo-alias',
        ...(target.context_length ? { context_length: target.context_length, context_window: target.context_window ?? target.context_length } : {}),
        ...(target.pricing ? { pricing: target.pricing } : {}),
        served_by: target.id,
      });
    }
  }

  // Auto is no longer published: routing lives on the backend, and a shim
  // that advertises openzoo/auto would have to route it.
  return { ...payload, object: payload?.object || 'list', data: [...data, ...aliases, ...bare, ...family] };
}

/**
 * Label a catalog id for a picker without minting a new id.
 * `x-ai/grok-4.6` stays `x-ai/grok-4.6` on the wire; the label is just
 * "grok-4.6 (x-ai)". Never invents a `claude-*` name for a non-Anthropic animal.
 */
export function displayNameFor(id) {
  const raw = String(id || '').trim();
  if (!raw) return raw;
  if (raw.includes('/')) {
    const slash = raw.indexOf('/');
    return `${raw.slice(slash + 1)} (${raw.slice(0, slash)})`;
  }
  return raw;
}

function decorateModelEntry(m) {
  if (!m || typeof m !== 'object') return m;
  return {
    ...m,
    object: m.object || 'model',
    type: m.type || 'model',
    display_name: m.display_name || displayNameFor(m.id),
  };
}

/**
 * OpenAI-compatible /v1/models body. Quoteable chat models only — no :batch,
 * no unpriced / image-video rows, no openzoo-* twins. Extra Anthropic fields
 * (`type`, `display_name`) sit alongside OpenAI ones.
 */
export function publishModelList(payload, opts) {
  const merged = augmentModelList(payload, opts);
  const data = (merged.data || []).map(decorateModelEntry);
  return {
    ...merged,
    object: merged.object || 'list',
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

function modelVersionKey(id) {
  const m = String(id || '').match(/(\d+(?:\.\d+)*)/g);
  if (!m) return [0];
  return m[0].split('.').map((n) => Number(n) || 0);
}

function cmpModelVersion(a, b) {
  const ka = modelVersionKey(a);
  const kb = modelVersionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (kb[i] || 0) - (ka[i] || 0);
    if (d) return d;
  }
  return String(a).localeCompare(String(b));
}

function newestMatching(ids, pred) {
  const hits = ids.filter((id) => pred(id) && !String(id).includes(':') && !/-fast(?:$|:)/i.test(id));
  hits.sort(cmpModelVersion);
  return hits[0] || null;
}

/** Preferred gateway flagships for the Claude Code picker, if quoteable. */
export const CLAUDE_PICKER_GATEWAY = [
  { prefer: 'x-ai/grok-4.6', re: /^x-ai\/grok-/ },
  { prefer: 'google/gemini-3.7-flash', re: /^google\/gemini-/ },
  { prefer: 'deepseek/deepseek-v4-pro-0813', re: /^deepseek\// },
  { prefer: 'qwen/qwen3.8-2.4t-a95b', re: /^qwen\// },
];

/**
 * Short honest Claude Code /model list: current Opus/Sonnet/Haiku/Fable
 * plus a few real gateway models plus Auto. Only ids already in `rows`.
 */
export function pickClaudePickerRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byId = new Map(list.map((m) => [m.id, m]));
  const ids = list.map((m) => m.id);
  const picked = [];
  const add = (id) => {
    if (id && byId.has(id) && !picked.includes(id)) picked.push(id);
  };
  add(newestMatching(ids, (id) => /^anthropic\/claude-opus/.test(id)));
  add(newestMatching(ids, (id) => /^anthropic\/claude-sonnet/.test(id)));
  add(newestMatching(ids, (id) => /claude-(?:3-)?haiku/.test(id)));
  add(newestMatching(ids, (id) => /^anthropic\/claude-fable/.test(id)));
  for (const { prefer, re } of CLAUDE_PICKER_GATEWAY) {
    add(ids.includes(prefer) ? prefer : newestMatching(ids, (id) => re.test(id)));
  }
  return picked.map((id) => byId.get(id)).filter(Boolean);
}

function anthropicRows(rows) {
  return rows.map((m) => ({
    type: 'model',
    id: m.id,
    display_name: m.display_name || displayNameFor(m.id),
    ...(m.created_at ? { created_at: m.created_at } : {}),
    ...(m.served_by ? { served_by: m.served_by } : {}),
  }));
}

/**
 * Anthropic GET /v1/models shape (id + display_name + type).
 * Claude Code gateway discovery reads `data[].id` and optional `display_name`.
 * Short picker — not the 300+ OpenRouter dump and not openzoo-* clones.
 */
export function anthropicModelList(payload) {
  const published = publishModelList(payload, { aliases: false });
  const data = anthropicRows(pickClaudePickerRows(published.data || []));
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

/** Claude Code / Anthropic SDKs send anthropic-version or an x-app / UA hint. */
export function wantsAnthropicModelList(headers = {}) {
  const h = headers && typeof headers === 'object' ? headers : {};
  const get = (k) => h[k] ?? h[k.toLowerCase()] ?? '';
  return Boolean(get('anthropic-version'))
    || /claude|anthropic/i.test(String(get('x-app')))
    || /claude|anthropic/i.test(String(get('user-agent')));
}

/**
 * Body for GET /v1/models. Quoteable catalog only (never opus-5-only, never
 * the raw OpenRouter dump). Anthropic-shaped clients get the short picker;
 * OpenAI clients keep object:list of every quoteable id + harness aliases.
 */
export function modelsListForRequest(payload, headers) {
  return wantsAnthropicModelList(headers) ? anthropicModelList(payload) : publishModelList(payload);
}
