import { config } from './config.js';
import { fetchHeaders } from './fetch.js';
import {
  AUTO_MODEL_ID, autoHasPricedModels, autoModelListEntry, isAutoModel,
  isPricedTokenPair, isUnservableRouteId,
} from './modelroute.js';

export { AUTO_MODEL_ID, isAutoModel, isPricedTokenPair, isUnservableRouteId };

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
  const virtual = [];
  // Auto is listed only when its own shortlist is priced models — never an
  // unquoted OpenRouter id that 500s `bad openrouter price`.
  if (!have.has(AUTO_MODEL_ID) && autoHasPricedModels(undefined, ids.length ? ids : null)) {
    virtual.push(autoModelListEntry());
    have.add(AUTO_MODEL_ID);
  }
  return { ...payload, object: payload?.object || 'list', data: [...virtual, ...data, ...aliases] };
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

function anthropicRows(rows) {
  return rows.map((m) => ({
    type: 'model',
    id: m.id,
    display_name: m.display_name || displayNameFor(m.id),
    ...(m.created_at ? { created_at: m.created_at } : {}),
    ...(m.served_by ? { served_by: m.served_by } : {}),
  }));
}

/** openzoo/auto first so Claude Code's picker default is the router, not opus. */
function withAutoFirst(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const i = list.findIndex((m) => isAutoModel(m?.id));
  if (i > 0) {
    const [auto] = list.splice(i, 1);
    list.unshift(auto);
  }
  return list;
}

/**
 * Anthropic GET /v1/models shape (id + display_name + type).
 * Claude Code gateway discovery reads `data[].id` and optional `display_name`.
 * Full quoteable catalog — every priced published id, including OpenRouter
 * grok/gemini/gpt rows. Not a 4-id Anthropic cap, not openzoo-* clones.
 * Picker ≠ classifier: rewriteChatModel still pins 16-token classify off opus-5.
 */
export function anthropicModelList(payload) {
  const published = publishModelList(payload, { aliases: false });
  const data = anthropicRows(withAutoFirst(published.data || []));
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
 * unpriced / :batch / openzoo-* clones). Anthropic-shaped clients get the
 * same quoteable ids in Anthropic shape (type / id / display_name) so Claude
 * Code can select grok, gemini, gpt, etc. OpenAI clients keep object:list
 * of every quoteable id + harness aliases.
 */
export function modelsListForRequest(payload, headers) {
  return wantsAnthropicModelList(headers) ? anthropicModelList(payload) : publishModelList(payload);
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
 * Families that spend max_tokens on hidden thinking first. A 16/40/160
 * budget on these returns an empty visible completion — measured on Grok
 * and DeepSeek. The raise in raiseReasoningMaxTokens exists for that.
 * It must NEVER fire on Claude Code's 16-token auto-mode classifier.
 */
export const REASONING_MODEL_RE = /(deepseek|grok|o[134](-|$)|reasoner|thinking|-pro\b|sol-pro|qwq)/i;

/** Claude Code auto-mode classify is max_tokens=16. 0.48.75 used 64 and
 *  missed grok nubs at 128 / 2000 on a 1–2 message body (dead-steady ~3¢
 *  from the reasoning floor). Anything in (0, 256] on a short transcript
 *  is a nub; a fat grok chat still uses the 4000 floor. */
export const CLASSIFY_MAX_TOKENS = 256;
export const CLASSIFY_MAX_MSGS = 3;
export const CLASSIFY_MAX_BODY = 65_536;

const CLASSIFIER_PREFS = ['google/gemini-3.7-flash', 'anthropic/claude-haiku-4.5'];

function messageHasToolCalls(m) {
  return Boolean(
    (Array.isArray(m?.tool_calls) && m.tool_calls.length)
    || m?.function_call
    || m?.role === 'tool',
  );
}

/**
 * Tiny classify / grok nub: pin to flash, never apply the reasoning floor.
 *
 * 0.48.75 required max_tokens ≤ 64 AND body < BIND_MIN (16k). Live 3¢
 * asks missed that (max_tokens 128 or 2000, and/or body ≥ 16k from a
 * tools schema) and then ate the 4000 grok floor. Widen:
 *   - max_tokens ≤ 256 on a short transcript (≤ 6 msgs, no tool_calls)
 *   - OR few messages, no tool_calls, body under a few tens of KB
 *     (even when the caller asked for 2000 tokens)
 * A real grok chat (max_tokens 2000+ AND a long / tool-using transcript)
 * still returns false so the floor can fire.
 *
 * `body` may be the raw Buffer/string or a parsed object. An optional
 * `bodyLen` overrides stringify length when the caller still has the wire
 * bytes (the proxy does).
 */
export function isTinyClassify(body, bodyLen) {
  let parsed = body;
  let len = bodyLen;
  if (body == null) return false;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    len = buf.length;
    try { parsed = JSON.parse(buf.toString('utf8')); } catch { return false; }
  } else if (len == null) {
    try { len = Buffer.byteLength(JSON.stringify(body)); } catch { return false; }
  }
  const mt = Number(parsed?.max_tokens);
  if (!Number.isFinite(mt) || mt <= 0) return false;
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  if (messages.some(messageHasToolCalls)) return false;
  if (mt <= CLASSIFY_MAX_TOKENS && messages.length <= 6) return true;
  return messages.length <= CLASSIFY_MAX_MSGS && len < CLASSIFY_MAX_BODY;
}

/**
 * Ids that must never serve Claude Code / grokui AUTO's tiny yes/no classify.
 * REASONING_MODEL_RE is the thinking floor; HEAVY_RE is the flagship set
 * (opus/pro/max/…). opus-5 is openzoo's default session model and does NOT
 * match the reasoning regex, so a catalog that lists opus before flash — or
 * lists only opus + grok — used to pick opus as "first non-reasoner". That
 * classify is a 402 handshake on a big model; AUTO's timeout then hard-blocks
 * Bash instead of prompting.
 */
function isSlowClassifier(id) {
  const s = String(id || '');
  return REASONING_MODEL_RE.test(s) || HEAVY_RE.test(s);
}

/**
 * Fast non-reasoning id that is actually on the zoo. Prefer an explicit
 * OPENZOO_CLASSIFIER_MODEL, then flash, then haiku, then the first catalog
 * id that is neither a reasoner nor a heavy/flagship (opus/pro/max/…).
 */
export function pickClassifierModel(ids, preferred = process.env.OPENZOO_CLASSIFIER_MODEL) {
  if (!Array.isArray(ids) || !ids.length) return null;
  if (preferred && ids.includes(preferred)) return preferred;
  for (const id of CLASSIFIER_PREFS) {
    if (ids.includes(id)) return id;
  }
  return ids.find((id) => !isSlowClassifier(id)) || null;
}

/**
 * Raise max_tokens for a reasoning model. Returns { parsed, raised, from, to }.
 * Does not itself decide whether a request is a classify — callers skip this
 * when isTinyClassify is true. Real Grok/DeepSeek chats still need the floor:
 * 4× a caller's 40 is 160, and those still come back blank.
 */
export function raiseReasoningMaxTokens(parsed, env = process.env) {
  const mult = Number(env.OPENZOO_REASONING_MAX_TOKENS_X || 4);
  const cap = Number(env.OPENZOO_REASONING_MAX_TOKENS_CAP || 32000);
  const floor = Number(env.OPENZOO_REASONING_MIN_TOKENS || 4000);
  const mdl = String(parsed?.model || '');
  const mt = Number(parsed?.max_tokens);
  if (mult > 1 && REASONING_MODEL_RE.test(mdl) && Number.isFinite(mt) && mt > 0 && mt < cap) {
    const raised = Math.min(cap, Math.max(floor, Math.round(mt * mult)));
    if (raised > mt) {
      return { parsed: { ...parsed, max_tokens: raised }, raised: true, from: mt, to: raised };
    }
  }
  return { parsed, raised: false, from: mt, to: mt };
}

/**
 * Model + max_tokens policy for one chat body.
 *
 * Tiny classify: pin to a fast non-reasoning catalog id, leave max_tokens
 * alone, ignore OPENZOO_DEFAULT_MODEL. Never fall back to `from` when that
 * id is a reasoner or a heavy/flagship (the zoo default is opus-5). A
 * catalog miss or an opus-only list used to keep the classify on opus-5
 * and AUTO hard-blocked Bash. Everything else: resolveModel (which honours
 * the default) then the reasoning floor.
 */
export function rewriteChatModel(parsed, ids, { bodyLen } = {}) {
  const from = parsed?.model;
  const len = bodyLen ?? (parsed == null ? 0 : Buffer.byteLength(JSON.stringify(parsed)));
  if (isAutoModel(from) && !isTinyClassify(parsed, len)) {
    return { parsed, tiny: false, auto: true, from, to: AUTO_MODEL_ID, raised: false };
  }
  if (isTinyClassify(parsed, len)) {
    const picked = pickClassifierModel(ids);
    // pickClassifierModel returns null on an empty catalog or a zoo that
    // only lists reasoners/heavies. `(picked) || from` left those on
    // anthropic/claude-opus-5 (openzoo's default). Pin to flash instead —
    // never ship a classify body AUTO would time out and hard-block on.
    const to = picked || (typeof from === 'string' && !isSlowClassifier(from) ? from : CLASSIFIER_PREFS[0]);
    return {
      parsed: (to && to !== from) ? { ...parsed, model: to } : parsed,
      tiny: true,
      from,
      to,
      raised: false,
    };
  }
  if (typeof from !== 'string') {
    return { parsed, tiny: false, from, to: from, raised: false };
  }
  const resolved = resolveModel(from, ids) || anthropicNativeAlias(from);
  const next = resolved ? { ...parsed, model: resolved } : parsed;
  const bump = raiseReasoningMaxTokens(next);
  return {
    parsed: bump.parsed,
    tiny: false,
    from,
    to: next.model,
    raised: bump.raised,
    raisedFrom: bump.from,
    raisedTo: bump.to,
  };
}

/**
 * Rewrite the model field of any request body that has one.
 * Returns null (send as-is) or { body, from, to, tiny?, raised? }. Any
 * failure — bad JSON, unreachable catalog — returns null: this layer must
 * never break a call that would have worked without it.
 *
 * Tiny classify is pinned here too, so OPENZOO_DEFAULT_MODEL cannot capture
 * a 16-token yes/no even if a caller only goes through this helper.
 */
export async function maybeRewriteModel(bodyBuf) {
  let body;
  try { body = JSON.parse(bodyBuf.toString('utf8')); } catch { return null; }
  if (typeof body?.model !== 'string') return null;
  let ids;
  try { ids = await zooModelIds(); } catch { return null; }
  const policy = rewriteChatModel(body, ids, { bodyLen: bodyBuf.length });
  if (!policy.tiny && !policy.raised && policy.to === body.model) return null;
  return {
    body: Buffer.from(JSON.stringify(policy.parsed)),
    from: body.model,
    to: policy.parsed.model,
    tiny: policy.tiny,
    raised: policy.raised,
    raisedFrom: policy.raisedFrom,
    raisedTo: policy.raisedTo,
  };
}
