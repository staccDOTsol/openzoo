/**
 * Task router: cheapest model that will probably finish the job.
 *
 *   argmin  cost(m, task)  subject to  P_success(m | task) >= bar(task)
 *           m in feasible(task)
 *
 * If nothing clears the bar, return the strongest option and flag
 * cleared_bar=false. Price is used in cost() only — never as a capability
 * proxy. Pure JS; sha256 encoder; no numpy/python/torch; no network.
 *
 * Artifacts (prefer packed lib/modelroute/, then vendor/modelroute/):
 * catalog.json, router.json, outcomes.json (partial hard-suite fold).
 * holographic_modelroute.py is a reference, not a runtime dep.
 *
 * Shipped outcomes.json is the measured prior. Live records go to
 * ~/.openzoo/modelroute-outcomes.json and are summed on top so a later
 * reship of the suite table is picked up without double-counting.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUTO_MODEL_ID = 'openzoo/auto';
export const AUTO_MODEL_ALIASES = new Set(['openzoo/auto', 'openzoo-auto', 'auto']);

export function isAutoModel(id) {
  return AUTO_MODEL_ALIASES.has(String(id || '').trim().toLowerCase());
}

/**
 * Ids the gateway cannot quote for a chat turn. Live GET /v1/models includes
 * :batch twins (positive prices, OpenRouter batch endpoint — 500s), ~latest
 * pointers that duplicate a real id, and openzoo-* aliases of those same ids.
 * Auto must never emit these; the published catalog must never list them.
 */
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

const MOD_IMAGE = 2;
export const BIND_ABOVE_TOKENS = 60_000;
export const BIND_SLICE_TOKENS = 8_000;
const BLEND_TEMP = 0.05;
const COST_FLOOR = 1e-6;
const IDF_BUCKETS = 8192;
const CHANNEL_W = [1.0, 0.6, 0.45];

const _WORD = /[a-z0-9]+/g;
const _IMG_CUE = /\b(image|images|screenshot|screenshots|photo|photos|pic|picture|pictures|scan|scanned|attached|attachment|diagram|chart|graph|x[- ]?ray|mockup|handwrit\w*|snap|frame|logo|infographic)\b/;
const _TOOL_CUE = /\b(tool call\w*|tool_choice|function call\w*|call the (tool|api|endpoint|function)|use the \w+ tool|invoke the|agent(ic)? loop|orchestrat\w*|tools? (and|then|as needed)|agent that)\b/;
const _JSON_CUE = /\b(json (only|schema|output|mode)|(valid|strict|only) json|structured output\w*|json ?schema|response_format|pydantic|machine[ -]readable|no prose|conform\w* to this schema)\b/;
const _HARD_CUE = /\b(prove|proof|derive|rigorous|production|carefully|step by step|complex|subtle|edge case\w*|optimis\w*|optimiz\w*|architect\w*|security|correctness|exactly|strictly|must)\b/;

const _OUT_TOKENS = {
  code: 900, reasoning: 1200, longctx: 1000, vision: 350, bulk: 60,
  creative: 900, translate: 500, agentic: 250, chat: 250, advice: 700,
};

const _CLASS_CATEGORIES = {
  code: { programming: 1.0, technology: 0.5 },
  reasoning: { science: 1.0, academia: 0.7, trivia: 0.2 },
  longctx: { academia: 0.8, legal: 0.5, technology: 0.4 },
  vision: { technology: 0.6, trivia: 0.2 },
  bulk: {},
  creative: { roleplay: 1.0, marketing: 0.7, 'marketing/seo': 0.4 },
  translate: { translation: 1.0 },
  agentic: { programming: 0.8, technology: 0.8 },
  chat: { trivia: 1.0, technology: 0.3 },
  advice: { legal: 0.8, health: 0.8, finance: 0.8 },
};

const _BAR = {
  code: [0.58, 0.72], reasoning: [0.65, 0.82], longctx: [0.60, 0.74],
  vision: [0.55, 0.70], bulk: [0.40, 0.52], creative: [0.50, 0.66],
  translate: [0.52, 0.68], agentic: [0.60, 0.76], chat: [0.40, 0.52],
  advice: [0.68, 0.80],
};

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest();
}

export function artifactDir() {
  const env = process.env.OPENZOO_MODELROUTE_DIR;
  if (env) return env;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Packed npm tree: lib/modelroute/{catalog,router,outcomes}.json
  const bundled = path.join(here, 'modelroute');
  if (existsSync(path.join(bundled, 'catalog.json'))) return bundled;
  // Repo / overlay: vendor/modelroute (same files, plus the Python reference)
  const vendor = path.resolve(here, '..', 'vendor', 'modelroute');
  if (existsSync(path.join(vendor, 'catalog.json'))) return vendor;
  return bundled;
}

export function shippedOutcomesPath() {
  return path.join(artifactDir(), 'outcomes.json');
}

export function defaultOutcomesPath() {
  return process.env.OPENZOO_MODELROUTE_OUTCOMES
    || path.join(os.homedir(), '.openzoo', 'modelroute-outcomes.json');
}

function readOutcomeTab(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  try {
    const tab = JSON.parse(readFileSync(filePath, 'utf8'));
    return tab && typeof tab === 'object' && !Array.isArray(tab) ? tab : {};
  } catch {
    return {};
  }
}

function mergeOutcomeTabs(base, extra) {
  const tab = { ...base };
  for (const [k, pair] of Object.entries(extra || {})) {
    const s = Number(pair?.[0]) || 0;
    const n = Number(pair?.[1]) || 0;
    const [s0, n0] = tab[k] || [0, 0];
    tab[k] = [s0 + s, n0 + n];
  }
  return tab;
}

function writeOutcomeTab(filePath, tab) {
  if (!filePath) return;
  mkdirSync(path.dirname(filePath) || '.', { recursive: true });
  const keys = Object.keys(tab).sort();
  const ordered = {};
  for (const key of keys) ordered[key] = tab[key];
  writeFileSync(filePath, JSON.stringify(ordered, null, 0));
}

export function parseLooseJson(text) {
  return JSON.parse(String(text).replace(/\bNaN\b/g, 'null').replace(/-?Infinity\b/g, 'null'));
}

export function atomPositions(token, dim, k, seed) {
  let buf = sha256(`${seed}|${token}`);
  const idx = [];
  const sgn = [];
  let salt = 0;
  while (idx.length < k) {
    for (let off = 0; off < 32 && idx.length < k; off += 8) {
      const chunk = buf.readBigUInt64BE(off);
      idx.push(Number(chunk % BigInt(dim)));
      sgn.push((chunk >> 63n) & 1n ? 1 : -1);
    }
    salt += 1;
    buf = sha256(`${seed}|${token}|${salt}`);
  }
  return { idx, sgn };
}

function argmaxTiebreak(s) {
  let i = 0;
  for (let j = 1; j < s.length; j++) if (s[j] > s[i]) i = j;
  return i;
}

function unitRow(row) {
  let n = 0;
  for (const x of row) n += x * x;
  n = Math.sqrt(n) + 1e-12;
  return row.map((x) => x / n);
}

function l2normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n < 1e-12) return v;
  return v.map((x) => x / n);
}

export class TextEncoder {
  constructor({
    dim = 4096, k = 8, seed = 17, char_n = 4, use_bigrams = true, cache = true, idf = null,
  } = {}) {
    this.dim = dim | 0;
    this.k = k | 0;
    this.seed = seed | 0;
    this.char_n = char_n | 0;
    this.use_bigrams = Boolean(use_bigrams);
    this._cache = cache ? new Map() : null;
    this.idf = idf ? Float64Array.from(idf) : null;
  }

  idfBucket(tok) {
    return Number(sha256(`idf|${this.seed}|${tok}`).readBigUInt64BE(0) % BigInt(IDF_BUCKETS));
  }

  weight(tok) {
    return this.idf == null ? 1 : this.idf[this.idfBucket(tok)];
  }

  channels(text) {
    const words = String(text || '').toLowerCase().match(_WORD) || [];
    const bigrams = this.use_bigrams
      ? words.slice(1).map((b, i) => `${words[i]}_${b}`)
      : [];
    const flat = words.join(' ');
    const n = this.char_n;
    const chars = [];
    const limit = Math.max(0, flat.length - n + 1);
    for (let i = 0; i < limit; i++) chars.push(`#${flat.slice(i, i + n)}`);
    return [words, bigrams, chars];
  }

  atom(tok) {
    if (!this._cache) return atomPositions(tok, this.dim, this.k, this.seed);
    let got = this._cache.get(tok);
    if (!got) {
      got = atomPositions(tok, this.dim, this.k, this.seed);
      this._cache.set(tok, got);
    }
    return got;
  }

  bundle(toks) {
    const v = new Float64Array(this.dim);
    for (const tok of toks) {
      const { idx, sgn } = this.atom(tok);
      const w = this.weight(tok);
      for (let i = 0; i < idx.length; i++) v[idx[i]] += sgn[i] * w;
    }
    return l2normalize(Array.from(v));
  }

  encode(text) {
    let v = new Array(this.dim).fill(0);
    const chans = this.channels(text);
    for (let c = 0; c < CHANNEL_W.length; c++) {
      if (!chans[c].length) continue;
      const b = this.bundle(chans[c]);
      const w = CHANNEL_W[c];
      for (let i = 0; i < v.length; i++) v[i] += w * b[i];
    }
    return l2normalize(v);
  }
}

export class TaskClassifier {
  constructor(classes, encoder, P) {
    this.classes = [...classes];
    this.enc = encoder;
    this.P = P;
  }

  static load(routerPath) {
    const raw = JSON.parse(readFileSync(routerPath, 'utf8'));
    const cfg = typeof raw.config === 'string' ? JSON.parse(raw.config) : raw.config;
    const enc = new TextEncoder({ ...cfg, idf: raw.idf });
    const [rows, cols] = raw.q_shape;
    const buf = Buffer.from(raw.q_b64, 'base64');
    const q = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return TaskClassifier._fromQuant(raw.classes, enc, q, raw.scale, rows, cols);
  }

  static _fromQuant(classes, enc, q, scale, rows, cols) {
    const P = [];
    for (let r = 0; r < rows; r++) {
      const row = new Array(cols);
      const s = Number(scale[r]);
      for (let c = 0; c < cols; c++) row[c] = (q[r * cols + c] * s) / 127;
      P.push(unitRow(row));
    }
    return new TaskClassifier(classes, enc, P);
  }

  scores(text) {
    const v = this.enc.encode(text);
    return this.P.map((row) => {
      let s = 0;
      for (let i = 0; i < row.length; i++) s += row[i] * v[i];
      return s;
    });
  }

  predict(text) {
    const s = this.scores(text);
    const i = argmaxTiebreak(s);
    const sorted = [...s].sort((a, b) => b - a);
    const margin = sorted.length > 1 ? sorted[0] - sorted[1] : sorted[0];
    return [this.classes[i], s[i], margin];
  }
}

export function extractConstraints(text, {
  has_image = false, needs_tools = null, needs_json = null,
  input_tokens = null, output_tokens = null, task_class = null,
} = {}) {
  const low = String(text || '').toLowerCase();
  const est_in = input_tokens != null ? (input_tokens | 0) : Math.max(16, (String(text || '').length / 4) | 0);
  const est_out = output_tokens != null ? (output_tokens | 0) : (_OUT_TOKENS[task_class] ?? 400);
  return {
    needs_image: Boolean(has_image || _IMG_CUE.test(low)),
    needs_tools: needs_tools == null ? Boolean(_TOOL_CUE.test(low)) : Boolean(needs_tools),
    needs_json: needs_json == null ? Boolean(_JSON_CUE.test(low)) : Boolean(needs_json),
    est_in,
    est_out,
    min_context: ((((est_in + est_out) * 1.25) | 0) + 512),
    estimated: [input_tokens == null, output_tokens == null],
  };
}

export function difficulty(text, margin = 1.0, est_in = 0) {
  const hits = Number(_HARD_CUE.test(String(text || '').toLowerCase()))
    + Number(est_in > 2000)
    + Number(margin < 0.05);
  return hits >= 1 ? 'hard' : 'easy';
}

export class Outcomes {
  static PRIOR_STRENGTH = 6.0;

  /**
   * @param {string|null} filePath  live write path; null = memory only
   * @param {{ shipped?: string|false }} [opts]
   *   shipped path to preload (suite table). false skips. omitted + filePath
   *   set means "that file only" (tests). runtime() always preloads shipped.
   */
  constructor(filePath = defaultOutcomesPath(), opts = {}) {
    this.path = filePath;
    this.shipped = {};
    this.live = {};
    this.tab = {};
    if (opts.shipped) this.shipped = readOutcomeTab(opts.shipped);
    if (filePath) this.live = readOutcomeTab(filePath);
    this.tab = mergeOutcomeTabs(this.shipped, this.live);
  }

  /** Shipped hard-suite table + this machine's live file (summed). */
  static runtime() {
    const ship = shippedOutcomesPath();
    const live = defaultOutcomesPath();
    const same = live && ship && path.resolve(live) === path.resolve(ship);
    // Never write the live delta onto the packed suite file.
    return new Outcomes(same ? null : live, { shipped: ship });
  }

  static key(taskClass, modelId) {
    return `${taskClass}|${modelId}`;
  }

  record(taskClass, modelId, ok) {
    const k = Outcomes.key(taskClass, modelId);
    const [ls, ln] = this.live[k] || [0, 0];
    this.live[k] = [ls + (ok ? 1 : 0), ln + 1];
    this.tab = mergeOutcomeTabs(this.shipped, this.live);
    if (this.path) writeOutcomeTab(this.path, this.live);
    return this.tab[k];
  }

  posterior(taskClass, modelId, prior) {
    const [s, n] = this.tab[Outcomes.key(taskClass, modelId)] || [0, 0];
    const a0 = Outcomes.PRIOR_STRENGTH;
    return [(a0 * prior + s) / (a0 + n), n];
  }
}

export class Catalog {
  static P_TOP = 0.88;
  static P_BOT = 0.62;
  static P_UNKNOWN = 0.45;
  static P_UNKNOWN_TOOLS = 0.05;
  static P_UNKNOWN_REASON = 0.06;

  constructor(catalogPath, raw = null) {
    const data = raw || parseLooseJson(readFileSync(catalogPath, 'utf8'));
    this.ids = data.ids.map(String);
    this.categories = data.categories.map(String);
    this.ctx = data.ctx.map((n) => Number(n) || 0);
    this.price_in = data.price_in.map((n) => (n == null ? NaN : Number(n)));
    this.price_out = data.price_out.map((n) => (n == null ? NaN : Number(n)));
    this.modality = data.modality.map((n) => Number(n) || 0);
    this.tools = data.tools.map(Boolean);
    this.jsonmode = data.jsonmode.map(Boolean);
    this.reasoning = data.reasoning.map(Boolean);
    this.ranks = data.ranks;
    this.stamp = String(data.stamp || '?');
    this._cat_ix = Object.fromEntries(this.categories.map((c, i) => [c, i]));
  }

  get length() { return this.ids.length; }

  feasible(cons, allowFree = false, allowIds = null) {
    const allow = allowIds == null ? null : new Set(allowIds);
    const ok = new Array(this.ids.length).fill(true);
    for (let i = 0; i < this.ids.length; i++) {
      if (isUnservableRouteId(this.ids[i])) ok[i] = false;
      if (allow && !allow.has(this.ids[i])) ok[i] = false;
      if (cons.needs_image && !((this.modality[i] & MOD_IMAGE) > 0)) ok[i] = false;
      if (cons.needs_tools && (!this.tools[i] || isNoToolDumpId(this.ids[i]))) ok[i] = false;
      if (cons.needs_json && !this.jsonmode[i]) ok[i] = false;
      if (this.ctx[i] < cons.min_context) ok[i] = false;
      const pin = this.price_in[i];
      const pout = this.price_out[i];
      if (!Number.isFinite(pin) || !Number.isFinite(pout) || pin < 0 || pout < 0) ok[i] = false;
      // Paid routing requires both sides > 0. OR used to let prompt=0 through.
      if (!allowFree && !isPricedTokenPair(pin, pout)) ok[i] = false;
    }
    return ok;
  }

  cost(cons) {
    return this.ids.map((_, i) => this.price_in[i] * cons.est_in / 1e6 + this.price_out[i] * cons.est_out / 1e6);
  }

  prior(taskClass, cons) {
    const weights = _CLASS_CATEGORIES[taskClass] || {};
    const p = new Array(this.ids.length).fill(Catalog.P_UNKNOWN);
    const keys = Object.keys(weights);
    if (keys.length) {
      const num = new Array(this.ids.length).fill(0);
      const den = new Array(this.ids.length).fill(0);
      const span = Catalog.P_TOP - Catalog.P_BOT;
      for (const cat of keys) {
        const j = this._cat_ix[cat];
        if (j == null) continue;
        const w = weights[cat];
        for (let i = 0; i < this.ids.length; i++) {
          const r = Number(this.ranks[i][j]) || 0;
          if (r > 0) {
            num[i] += w * (Catalog.P_TOP - (r - 1) / 19 * span);
            den[i] += w;
          }
        }
      }
      for (let i = 0; i < this.ids.length; i++) if (den[i] > 0) p[i] = num[i] / den[i];
    }
    for (let i = 0; i < this.ids.length; i++) {
      if (p[i] !== Catalog.P_UNKNOWN) continue;
      if (cons.needs_tools || cons.needs_json) {
        if (this.tools[i]) p[i] += Catalog.P_UNKNOWN_TOOLS;
      }
      if (taskClass === 'reasoning' || taskClass === 'code') {
        if (this.reasoning[i]) p[i] += Catalog.P_UNKNOWN_REASON;
      }
      p[i] = Math.min(1, Math.max(0, p[i]));
    }
    return p;
  }

  bar(taskClass, diff) {
    const [lo, hi] = _BAR[taskClass] || [0.55, 0.70];
    return diff === 'hard' ? hi : lo;
  }
}

function emptyRoute(cls, c2, cons, diff, bar, stamp, reason) {
  return {
    model: null, task_class: cls, runner_up: c2, bind_first: Boolean(cons?.bind_first),
    difficulty: diff, bar, constraints: cons, shortlist: [],
    reason, cleared_bar: false, feasible_models: 0, catalog_stamp: stamp,
  };
}

export function route(text, {
  catalog, classifier, outcomes, k = 5, bar_shift = 0,
  allow_free = false, blend = true, context = null, bindable = true,
  has_image, needs_tools, needs_json, input_tokens, output_tokens,
  allow_ids = null,
} = {}) {
  const cat = catalog ?? getCatalog();
  const clf = classifier ?? getClassifier();
  const out = outcomes ?? getOutcomes();

  const classifyOn = context ? `${context}\n${text}` : text;
  const s = clf.scores(classifyOn);
  let i0 = argmaxTiebreak(s);
  let i1 = 0;
  let best2 = -Infinity;
  for (let i = 0; i < s.length; i++) {
    if (i === i0) continue;
    if (s[i] > best2) { best2 = s[i]; i1 = i; }
  }
  if (s.length < 2) i1 = i0;
  const cls = clf.classes[i0];
  const c2 = clf.classes[i1];
  const conf = s[i0];
  const margin = s[i0] - s[i1];
  let cons = extractConstraints(text, {
    has_image, needs_tools, needs_json, input_tokens, output_tokens, task_class: cls,
  });

  const raw_in = cons.est_in;
  const bind_first = Boolean(bindable && raw_in > BIND_ABOVE_TOKENS);
  if (bind_first) {
    cons = {
      ...cons,
      est_in: BIND_SLICE_TOKENS,
      min_context: ((((BIND_SLICE_TOKENS + cons.est_out) * 1.25) | 0) + 512),
    };
  }
  cons.bind_first = bind_first;
  cons.raw_in = raw_in;

  const diff = difficulty(classifyOn, margin, raw_in);
  const gap = s[i0] - s[i1];
  const w2 = Math.exp(-Math.max(0, gap) / BLEND_TEMP);
  let w = [1 / (1 + w2), w2 / (1 + w2)];
  if (!blend) w = [1, 0];

  const feas = cat.feasible(cons, allow_free, allow_ids);
  const cost = cat.cost(cons);
  const prior1 = cat.prior(cls, cons);
  const prior2 = cat.prior(c2, cons);
  const prior = prior1.map((p, i) => w[0] * p + w[1] * prior2[i]);
  const bar = Math.min(1, Math.max(0, w[0] * cat.bar(cls, diff) + w[1] * cat.bar(c2, diff) + bar_shift));
  const post = [];
  const nobs = [];
  for (let i = 0; i < cat.ids.length; i++) {
    const [p, n] = out.posterior(cls, cat.ids[i], prior[i]);
    post.push(p);
    nobs.push(n);
  }

  const idx = [];
  for (let i = 0; i < feas.length; i++) if (feas[i]) idx.push(i);
  if (!idx.length) {
    return emptyRoute(cls, c2, cons, diff, bar, cat.stamp,
      'no model in the catalogue satisfies the hard constraints');
  }

  const clears = idx.filter((i) => post[i] >= bar);
  const cleared = clears.length > 0;
  const pool = cleared ? clears : idx;
  const order = cleared
    ? [...pool].sort((a, b) => {
      const ca = Math.round(cost[a] * 1e12) / 1e12;
      const cb = Math.round(cost[b] * 1e12) / 1e12;
      if (ca !== cb) return ca - cb;
      if (post[b] !== post[a]) return post[b] - post[a];
      return cat.ids[a] < cat.ids[b] ? -1 : cat.ids[a] > cat.ids[b] ? 1 : 0;
    })
    : [...pool].sort((a, b) => {
      if (post[b] !== post[a]) return post[b] - post[a];
      const ca = Math.round(cost[a] * 1e12) / 1e12;
      const cb = Math.round(cost[b] * 1e12) / 1e12;
      if (ca !== cb) return ca - cb;
      return cat.ids[a] < cat.ids[b] ? -1 : cat.ids[a] > cat.ids[b] ? 1 : 0;
    });

  const cheapestFeasible = Math.max(Math.min(...idx.map((i) => cost[i])), COST_FLOOR);
  const short = [];
  for (const i of order.slice(0, k)) {
    short.push({
      model: cat.ids[i],
      p_success: Math.round(post[i] * 1000) / 1000,
      evidence: nobs[i] ? `measured(n=${nobs[i]})` : 'prior',
      usd_per_task: Math.round(cost[i] * 1e6) / 1e6,
      relative_cost: cheapestFeasible ? Math.round((cost[i] / cheapestFeasible) * 100) / 100 : null,
      context: cat.ctx[i] | 0,
    });
  }
  const top = order[0];
  const nClear = idx.filter((i) => post[i] >= bar).length;
  const reason = cleared
    ? `${bind_first ? `bind ${cons.raw_in} tokens to leCore first, then ` : ''}`
      + `cheapest of ${nClear} feasible models clearing P>=${bar.toFixed(2)} for a ${diff} ${cls} task`
    : `NO feasible model clears P>=${bar.toFixed(2)} for a ${diff} ${cls} task; returning highest-P instead`;

  return {
    model: cat.ids[top],
    task_class: cls,
    runner_up: c2,
    bind_first: cons.bind_first,
    blend: [Math.round(w[0] * 1000) / 1000, Math.round(w[1] * 1000) / 1000],
    class_confidence: Math.round(conf * 1000) / 1000,
    class_margin: Math.round(margin * 1000) / 1000,
    difficulty: diff,
    bar: Math.round(bar * 1000) / 1000,
    p_success: Math.round(post[top] * 1000) / 1000,
    usd_per_task: Math.round(cost[top] * 1e6) / 1e6,
    cleared_bar: cleared,
    feasible_models: idx.length,
    shortlist: short,
    constraints: cons,
    catalog_stamp: cat.stamp,
    reason,
  };
}

let _catalog;
let _classifier;
let _outcomes;

export function getCatalog() {
  if (!_catalog) _catalog = new Catalog(path.join(artifactDir(), 'catalog.json'));
  return _catalog;
}

export function getClassifier() {
  if (!_classifier) _classifier = TaskClassifier.load(path.join(artifactDir(), 'router.json'));
  return _classifier;
}

export function getOutcomes() {
  if (!_outcomes) _outcomes = Outcomes.runtime();
  return _outcomes;
}

export function resetModelrouteSingletons() {
  _catalog = undefined;
  _classifier = undefined;
  _outcomes = undefined;
}

function rawMessageText(m) {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (typeof b === 'string') return b;
      if (b?.type === 'text' && typeof b.text === 'string') return b.text;
      if (b?.type === 'input_text' && typeof b.text === 'string') return b.text;
      if (typeof b?.text === 'string' && !b.type) return b.text;
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function contentHasToolParts(c) {
  if (!Array.isArray(c)) return false;
  return c.some((b) => b && (b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'function' || b.type === 'tool_calls'));
}

function messageHasToolParts(m) {
  if (!m) return false;
  if (m.role === 'tool') return true;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
  if (m.function_call) return true;
  return contentHasToolParts(m.content);
}

/** Models that 400 on tool-only continues even when the catalog marks tools. */
export function isNoToolDumpId(id) {
  return /^nex-agi\//i.test(String(id || ''));
}

function messageHasImage(m) {
  const c = m?.content;
  if (!Array.isArray(c)) return false;
  return c.some((b) => b && (b.type === 'image_url' || b.type === 'image' || b.image_url || b.type === 'input_image'));
}

/** Pull route() kwargs out of a chat/completions body. */
export function routeInputFromChat(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let lastUser = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue;
    if (rawMessageText(messages[i])) { lastUser = messages[i]; break; }
  }
  const text = rawMessageText(lastUser) || (typeof body?.prompt === 'string' ? body.prompt : '');
  const contextParts = [];
  for (let i = 0; i < messages.length; i++) {
    if (lastUser && messages[i] === lastUser) continue;
    const t = rawMessageText(messages[i]);
    if (t) contextParts.push(t);
  }
  const hasImage = messages.some(messageHasImage) || Boolean(body?.has_image);
  const toolsListed = Array.isArray(body?.tools) && body.tools.length > 0;
  const toolChoice = body?.tool_choice && body.tool_choice !== 'none';
  const historyTools = messages.some(messageHasToolParts);
  const needsTools = (toolsListed || toolChoice || historyTools) ? true : undefined;
  const rf = body?.response_format;
  const needsJson = rf && (rf.type === 'json_object' || rf.type === 'json_schema') ? true : undefined;
  return {
    text,
    context: contextParts.length ? contextParts.join('\n') : undefined,
    has_image: hasImage,
    needs_tools: needsTools,
    needs_json: needsJson,
  };
}

export function routeChatBody(body, extra = {}) {
  const input = routeInputFromChat(body);
  const { needs_tools: extraTools, ...rest } = extra;
  return route(input.text, {
    allow_free: extra.allow_free ?? false,
    bindable: extra.bindable ?? true,
    ...input,
    ...rest,
    needs_tools: extraTools == null ? input.needs_tools : extraTools,
  });
}

/** Cheapest-first among shortlist entries that cleared the bar. Do not loop forever. */
export function fallbackChain(result, { max = 5 } = {}) {
  if (!result?.cleared_bar || !Array.isArray(result.shortlist)) return [];
  const chosen = result.model;
  return result.shortlist
    .filter((s) => s.model && s.model !== chosen && (s.p_success == null || s.p_success >= result.bar))
    .sort((a, b) => (a.usd_per_task - b.usd_per_task) || String(a.model).localeCompare(String(b.model)))
    .slice(0, max)
    .map((s) => s.model);
}

export function isRetryableStatus(status) {
  const n = Number(status);
  return n === 429 || (n >= 500 && n <= 599);
}

function completionContent(data) {
  const c = data?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('');
  return '';
}

/**
 * ok=true on 2xx with content; false on empty / error / 4xx except 402.
 * Returns null when the call should not be recorded (402).
 */
export function outcomeFromResponse(status, data) {
  const n = Number(status);
  if (n === 402) return null;
  if (n >= 200 && n < 300) return Boolean(String(completionContent(data) || '').trim());
  if (n >= 400) return false;
  return false;
}

export function recordRouteOutcome(result, ok) {
  if (!result?.task_class || !result?.model || ok == null) return null;
  return getOutcomes().record(result.task_class, result.model, Boolean(ok));
}

export function autoModelListEntry() {
  return {
    id: AUTO_MODEL_ID,
    object: 'model',
    owned_by: 'openzoo',
    display_name: 'Auto',
    served_by: AUTO_MODEL_ID,
    description: 'Virtual model: cheapest zoo id that clears the task bar',
  };
}

/** True when Auto's feasible set is non-empty after the priced-id filter. */
export function autoHasPricedModels(catalog, allowIds = null) {
  const cat = catalog ?? getCatalog();
  const cons = { needs_image: false, needs_tools: false, needs_json: false, min_context: 16 };
  return cat.feasible(cons, false, allowIds).some(Boolean);
}
