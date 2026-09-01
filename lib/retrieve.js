/**
 * leCore silly retrieval cascade, in the OpenZoo sidecar.
 *
 * Production bind/spill used to treat BM25 as a full-corpus parallel front
 * door: bind the body, send the ask + x-hrr-top-k, and let the remote HRR
 * sidecar score every chunk. Moose `silly` (landed on staccDOTsol/leCore
 * main) replaced that with a staged dispatcher:
 *
 *   exact unique phrase → dense margin gate → BM25 refine on the shortlist
 *   only → honest abstain
 *
 * plus a PerfectRecallIndex / guard_candidates safety net under the ranked
 * list (a certificate of lexical completeness, not a replacement for ranking).
 *
 * This module is the JS equivalent so zoo_ask / spilled completions go
 * through the same cascade without importing Python. The live sidecar also
 * sends `x-hrr-gate: dispatch` so a remote leCore/HRR that already has
 * UnifiedMind.retrieval_dispatch uses it. bm25Rank is an internal arm.
 */
export const HRR_DISPATCH_GATE = 'dispatch';

const STOP = new Set((
  'a an the of to in on at for and or is are be by with from as it this that these those '
  + 'into over under out up down off no not do does did can could would should will '
  + 'your my our their its his her you we they i he she them us me'
).split(' '));

function normalizeTok(tok) {
  for (const suf of ['ing', 'ed', 'es', 's']) {
    if (tok.endsWith(suf) && tok.length - suf.length >= 3) return tok.slice(0, -suf.length);
  }
  return tok;
}

/** Same contract as leCore holographic_bm25.tokenize: alnum, stop, light stem. */
export function tokenize(text) {
  const raw = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return raw.map(normalizeTok).filter((t) => t.length > 1 && !STOP.has(t));
}

export function tokenOverlapScores(query, docs) {
  const q = new Set(tokenize(query));
  const out = docs.map(() => 0);
  if (!q.size) return out;
  const denom = q.size;
  for (let i = 0; i < docs.length; i++) {
    let hit = 0;
    for (const t of new Set(tokenize(docs[i]))) if (q.has(t)) hit += 1;
    out[i] = hit / denom;
  }
  return out;
}

function orderByScoreDesc(scores) {
  const n = scores.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => (scores[b] - scores[a]) || (a - b));
  return idx;
}

/**
 * Okapi BM25 over a fixed shortlist. Internal arm — never the retrieve
 * front door. Fit cost is O(docs tokens), so callers must pass the dense
 * window, not the whole corpus.
 */
export class BM25 {
  constructor(docs, { k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.N = docs.length;
    this.tf = [];
    this.docLen = [];
    const df = new Map();
    for (const d of docs) {
      const toks = tokenize(d);
      this.docLen.push(toks.length);
      const counts = new Map();
      for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
      this.tf.push(counts);
      for (const t of counts.keys()) df.set(t, (df.get(t) || 0) + 1);
    }
    const sum = this.docLen.reduce((a, n) => a + n, 0);
    this.avgdl = this.N ? sum / this.N : 0;
    this.idf = new Map();
    for (const [t, n] of df) {
      this.idf.set(t, Math.log(1 + (this.N - n + 0.5) / (n + 0.5)));
    }
  }

  scores(query) {
    const out = new Array(this.N).fill(0);
    const qtf = new Map();
    for (const t of tokenize(query)) qtf.set(t, (qtf.get(t) || 0) + 1);
    for (const [t, c] of qtf) {
      const idf = this.idf.get(t);
      if (idf == null) continue;
      for (let i = 0; i < this.N; i++) {
        const f = this.tf[i].get(t) || 0;
        if (!f) continue;
        const denom = f + this.k1 * (1 - this.b + this.b * this.docLen[i] / (this.avgdl + 1e-12));
        out[i] += c * (idf * (f * (this.k1 + 1)) / (denom + 1e-12));
      }
    }
    return out;
  }

  /** [(doc_index, score)] high to low; ties by ascending index. */
  rank(query) {
    const s = this.scores(query);
    return orderByScoreDesc(s).map((i) => [i, s[i]]);
  }
}

/** Reciprocal rank fusion. lists are best-first ids; weights default equal. */
export function reciprocalRankFusion(rankedLists, { k = 60, weights } = {}) {
  const w = weights || rankedLists.map(() => 1);
  const fused = new Map();
  rankedLists.forEach((lst, li) => {
    const ww = Number(w[li]) || 0;
    lst.forEach((item, rank0) => {
      fused.set(item, (fused.get(item) || 0) + ww / (k + rank0 + 1));
    });
  });
  return [...fused.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));
}

/**
 * Adaptive retrieval: exact → dense (margin-gated) → BM25-on-shortlist → abstain.
 *
 * Returns { ranked, stage, margin, shortlistSize, bm25Docs }.
 * `bm25Docs` is 0 unless the refine arm ran — tests fail the old
 * "always full-corpus BM25" path on that field.
 */
export function dispatchRetrieval(query, docs, {
  denseScores = null,
  k = 5,
  tau = 0.25,
  shortlist = 32,
  weights = [1.0, 0.3],
  rrfK = 60,
} = {}) {
  const n = docs.length;
  if (!n) return { ranked: [], stage: 'abstain', margin: 0, shortlistSize: 0, bm25Docs: 0 };

  const qPhrase = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  if (qPhrase) {
    const hits = [];
    for (let i = 0; i < n; i++) {
      const d = String(docs[i] || '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
      if (d.includes(qPhrase)) hits.push(i);
    }
    if (hits.length === 1) {
      return { ranked: [[hits[0], 1]], stage: 'exact', margin: 1, shortlistSize: 0, bm25Docs: 0 };
    }
  }

  const s = denseScores != null
    ? Array.from(denseScores, Number)
    : tokenOverlapScores(query, docs);
  const order = orderByScoreDesc(s);
  const s1 = s[order[0]] || 0;
  const s2 = n > 1 ? (s[order[1]] || 0) : 0;
  const margin = s1 > 0 ? (s1 - s2) / Math.max(s1, 1e-12) : 0;
  const denseRanked = order.slice(0, k).map((i) => [i, s[i]]);
  if (s1 > 0 && margin >= tau) {
    return { ranked: denseRanked, stage: 'dense', margin, shortlistSize: 0, bm25Docs: 0 };
  }

  const sl = order.slice(0, Math.min(shortlist, n));
  const bm = new BM25(sl.map((i) => String(docs[i])));
  const bmRanked = bm.rank(query);
  const bmTop1 = bmRanked.length ? bmRanked[0][1] : 0;
  if (s1 <= 0 && bmTop1 <= 0) {
    return { ranked: [], stage: 'abstain', margin, shortlistSize: sl.length, bm25Docs: sl.length };
  }
  const denseOrderLocal = sl.map((_, i) => i);
  const bmOrderLocal = bmRanked.filter(([, sc]) => sc > 0).map(([i]) => i);
  const fused = reciprocalRankFusion([denseOrderLocal, bmOrderLocal], { k: rrfK, weights });
  const ranked = fused.slice(0, k).map(([li, sc]) => [sl[li], sc]);
  return { ranked, stage: 'refine', margin, shortlistSize: sl.length, bm25Docs: sl.length };
}

/**
 * Exact-containment index. Posting lists, not Bloom tiles — same AND
 * semantics the guard certificate depends on (zero false neg/pos for
 * "docs containing ALL of these terms").
 */
export class PerfectRecallIndex {
  constructor() {
    this.n = 0;
    this.channels = new Map();
  }

  add(termsByChannel) {
    const di = this.n++;
    for (const [ch, terms] of Object.entries(termsByChannel || {})) {
      if (!this.channels.has(ch)) this.channels.set(ch, new Map());
      const post = this.channels.get(ch);
      for (const t of new Set(terms || [])) {
        if (!post.has(t)) post.set(t, []);
        post.get(t).push(di);
      }
    }
    return di;
  }

  query(terms, { channel = 'token' } = {}) {
    const post = this.channels.get(channel);
    if (!post) return [];
    const uniq = [...new Set(terms || [])];
    if (!uniq.length) return Array.from({ length: this.n }, (_, i) => i);
    let acc = null;
    for (const t of uniq) {
      const ids = post.get(t) || [];
      acc = acc == null ? new Set(ids) : new Set(ids.filter((i) => acc.has(i)));
      if (!acc.size) return [];
    }
    return [...acc].sort((a, b) => a - b);
  }
}

export function combinations(items, k) {
  const src = [...items];
  const out = [];
  const rec = (start, cur) => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < src.length; i++) {
      cur.push(src[i]);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);
  return out;
}

/**
 * Union `ranked` with exact-containment tiers until `budget` fills.
 * Certificate: every doc sharing >= completeDownTo query terms is present.
 */
export function guardCandidates(ranked, queryTerms, index, { budget = 500, channel = 'token' } = {}) {
  const terms = [...new Set(queryTerms)].sort();
  const m = terms.length;
  const rankPos = new Map(ranked.map((d, i) => [d, i]));
  const out = ranked.slice(0, budget);
  const seen = new Set(out);
  const cert = { completeDownTo: m + 1, complete_down_to: m + 1, tierSizes: {}, tier_sizes: {}, added: 0 };
  if (!m || !index) return [out.slice(0, budget), cert];
  for (let level = m; level >= 1; level--) {
    const subsets = combinations(terms, level);
    if (subsets.length > 256) break;
    const tier = new Set();
    for (const sub of subsets) {
      for (const di of index.query(sub, { channel })) tier.add(di);
    }
    cert.tierSizes[level] = tier.size;
    cert.tier_sizes[level] = tier.size;
    const missing = [...tier].filter((d) => !seen.has(d))
      .sort((a, b) => ((rankPos.get(a) ?? 1e15) - (rankPos.get(b) ?? 1e15)) || (a - b));
    if (out.length + missing.length > budget) break;
    out.push(...missing);
    for (const d of missing) seen.add(d);
    cert.added += missing.length;
    cert.completeDownTo = level;
    cert.complete_down_to = level;
  }
  return [out.slice(0, budget), cert];
}

export const RETRIEVE_CHUNK_CHARS = Number(process.env.OPENZOO_RETRIEVE_CHUNK_CHARS || 1200);
export const RETRIEVE_CHUNK_OVERLAP = Number(process.env.OPENZOO_RETRIEVE_CHUNK_OVERLAP || 200);

/** Paragraph-first chunker. A fact split mid-sentence is retrievable from neither. */
export function chunkCorpus(corpus, {
  maxChars = RETRIEVE_CHUNK_CHARS,
  overlap = RETRIEVE_CHUNK_OVERLAP,
} = {}) {
  const text = String(corpus || '');
  if (!text) return [];
  const paras = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const pieces = paras.length ? paras : [text];
  const chunks = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    if (buf.length <= maxChars * 1.5) {
      chunks.push(buf);
    } else {
      const step = Math.max(1, maxChars - overlap);
      for (let i = 0; i < buf.length; i += step) chunks.push(buf.slice(i, i + maxChars));
    }
    buf = overlap && buf.length > overlap ? buf.slice(-overlap) : '';
  };
  for (const p of pieces) {
    if (buf && buf.length + p.length + 2 > maxChars) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return chunks.length ? chunks : [text];
}

/**
 * Front door for a bound corpus: dispatch, then guard under the ranking.
 * `docs` may be pre-chunked; a raw string is chunked here.
 */
export function retrieveBoundCorpus(query, corpusOrDocs, opts = {}) {
  const docs = Array.isArray(corpusOrDocs) ? corpusOrDocs : chunkCorpus(corpusOrDocs, opts);
  const dispatched = dispatchRetrieval(query, docs, opts);
  const rankedIdx = dispatched.ranked.map(([i]) => i);
  const index = new PerfectRecallIndex();
  for (const d of docs) index.add({ token: tokenize(d) });
  const qTerms = tokenize(query);
  const budget = opts.guardBudget ?? Math.max(opts.k ?? 5, rankedIdx.length, 8);
  const [candidates, certificate] = guardCandidates(rankedIdx, qTerms, index, { budget });
  return {
    ...dispatched,
    docs,
    candidates,
    certificate,
    gate: HRR_DISPATCH_GATE,
    texts: candidates.map((i) => docs[i]).filter((t) => t != null),
  };
}

/** Headers the live sidecar must send so remote HRR uses the new cascade. */
export function hrrAskHeaders({ contextId, topK, corpusChars } = {}) {
  const h = { 'x-hrr-gate': HRR_DISPATCH_GATE };
  if (contextId) h['x-hrr-context'] = String(contextId);
  if (topK != null && topK !== '') h['x-hrr-top-k'] = String(topK);
  if (corpusChars) h['x-hrr-corpus-chars'] = String(corpusChars);
  return h;
}

function lastUserAsk(msgs) {
  if (!Array.isArray(msgs)) return '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role !== 'user') continue;
    const c = msgs[i].content;
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

/**
 * Retrieve plan attached to a spill/oneshot decision. Does not rewrite the
 * forwarded body (HUD multiples / x402 stay on the existing bind+header path).
 */
export function spillRetrieve(decision, opts = {}) {
  if (!decision || !decision.setHrrContext) return null;
  const corpus = typeof decision.prefix === 'string' ? decision.prefix : '';
  const query = (typeof decision.ask === 'string' && decision.ask.trim())
    ? decision.ask.trim()
    : lastUserAsk(decision.tail) || lastUserAsk(decision.forwarded);
  if (!corpus || !query) return null;
  return retrieveBoundCorpus(query, corpus, opts);
}
