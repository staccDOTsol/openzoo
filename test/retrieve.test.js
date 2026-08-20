import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  dispatchRetrieval,
  retrieveBoundCorpus,
  guardCandidates,
  PerfectRecallIndex,
  tokenize,
  BM25,
  hrrAskHeaders,
  HRR_DISPATCH_GATE,
  spillRetrieve,
} from '../lib/retrieve.js';
import { decideChatSpill } from '../lib/spill.js';

const DOCS = [
  'smooth a bumpy surface mesh by laplacian averaging',
  'fluid solver with pressure projection',
  'render an image with adaptive path tracing',
  'denoise a noisy render with joint bilateral filtering',
];

test('exact unique phrase short-circuits — no scoring, no BM25', () => {
  const r = dispatchRetrieval('adaptive path tracing', DOCS);
  assert.equal(r.stage, 'exact');
  assert.deepEqual(r.ranked, [[2, 1]]);
  assert.equal(r.shortlistSize, 0);
  assert.equal(r.bm25Docs, 0, 'exact must not run the lexical arm at all');
});

test('ambiguous exact hit is not proof — falls through', () => {
  const r = dispatchRetrieval('adaptive path tracing', [...DOCS, 'adaptive path tracing, again']);
  assert.notEqual(r.stage, 'exact');
});

test('wide dense margin skips BM25', () => {
  const r = dispatchRetrieval('clean up render noise', DOCS, {
    denseScores: [0.1, 0.1, 0.1, 0.9],
    tau: 0.25,
  });
  assert.equal(r.stage, 'dense');
  assert.equal(r.ranked[0][0], 3);
  assert.equal(r.bm25Docs, 0, 'proven dense pixel must not open a full lexical pass');
  assert.equal(r.shortlistSize, 0);
});

test('narrow margin refines only the shortlist, not the full corpus', () => {
  const r = dispatchRetrieval('surface is bumpy, smooth it', DOCS, {
    denseScores: [0.50, 0.49, 0.48, 0.10],
    tau: 0.25,
    shortlist: 32,
  });
  assert.equal(r.stage, 'refine');
  assert.equal(r.ranked[0][0], 0);
  assert.ok(r.bm25Docs <= 32);
  assert.ok(r.bm25Docs <= DOCS.length);
  assert.equal(r.shortlistSize, r.bm25Docs);
});

test('refine cannot reach gold outside the dense shortlist', () => {
  const big = Array.from({ length: 64 }, (_, i) => `filler document ${i} about nothing`);
  big.push('smooth a bumpy surface mesh');
  const dense = Array(big.length).fill(0.5);
  dense[64] = 0;
  const r = dispatchRetrieval('surface is bumpy, smooth it', big, {
    denseScores: dense,
    tau: 1,
    shortlist: 32,
    k: 8,
  });
  assert.ok(r.bm25Docs <= 32, `BM25 saw ${r.bm25Docs} docs — old path scored the whole corpus`);
  assert.ok(r.ranked.every(([i]) => i !== 64));
});

test('flat signal abstains instead of argmax on noise', () => {
  const r = dispatchRetrieval('purple monkey dishwasher', DOCS, {
    denseScores: [0, 0, 0, 0],
  });
  assert.equal(r.stage, 'abstain');
  assert.deepEqual(r.ranked, []);
});

test('retrieveBoundCorpus attaches a guard certificate under the ranking', () => {
  const r = retrieveBoundCorpus('adaptive path tracing', DOCS);
  assert.equal(r.gate, HRR_DISPATCH_GATE);
  assert.equal(r.stage, 'exact');
  assert.ok(r.certificate);
  assert.equal(typeof r.certificate.complete_down_to, 'number');
  assert.ok(r.candidates.includes(2));
  assert.equal(r.candidates[0], 2, 'ranked head is never repainted');
});

test('guard certificate is a theorem: every high-coord doc is present', () => {
  const idx = new PerfectRecallIndex();
  const docs = [];
  for (let i = 0; i < 80; i++) {
    const terms = [`w${i % 10}`, `w${(i + 3) % 10}`, 'keep'];
    if (i % 17 === 0) terms.push('q1', 'q2');
    docs.push(terms);
    idx.add({ token: terms });
  }
  const q = ['q1', 'q2'];
  const ranked = [5, 3, 1];
  const [cand, cert] = guardCandidates(ranked, q, idx, { budget: 40 });
  assert.deepEqual(cand.slice(0, 3), ranked);
  const c = cert.complete_down_to;
  const set = new Set(cand);
  docs.forEach((d, i) => {
    if (q.filter((t) => d.includes(t)).length >= c) assert.ok(set.has(i), `missing doc ${i} at cert ${c}`);
  });
});

test('spill oneshot retrieve carries dispatch gate + guard certificate', () => {
  const gold = 'render an image with adaptive path tracing';
  const filler = `${'padding paragraph about unrelated widgets.\n\n'.repeat(400)}`;
  const corpus = `${filler}${gold}\n\n${filler}`;
  const msgs = [{ role: 'user', content: `${corpus}\n\nadaptive path tracing` }];
  // One chunk so the unique phrase cannot land in two overlap windows
  // (that is ambiguity, not proof — the cascade's kept negative).
  const got = decideChatSpill({ messages: msgs }, { retrieveOpts: { maxChars: 1e7, overlap: 0 } });
  assert.equal(got.mode, 'oneshot');
  assert.equal(got.setHrrContext, true);
  assert.ok(got.retrieve, 'spilled retrieve must run dispatch+guard');
  assert.equal(got.retrieve.gate, 'dispatch');
  assert.equal(got.retrieve.stage, 'exact');
  assert.equal(got.retrieve.bm25Docs, 0, 'exact phrase must not full-corpus BM25');
  assert.ok(got.retrieve.certificate);
  assert.equal(typeof got.retrieve.certificate.complete_down_to, 'number');
});

test('spillRetrieve is the front door — not BM25.rank on the whole corpus', () => {
  const docs = DOCS.join('\n\n');
  const r = spillRetrieve({
    setHrrContext: true,
    prefix: docs,
    ask: 'fluid solver with pressure projection',
  });
  assert.equal(r.stage, 'exact');
  assert.equal(r.bm25Docs, 0);
  assert.ok(r.certificate);
  const full = new BM25(DOCS).rank('fluid solver with pressure projection');
  assert.ok(full.length === DOCS.length, 'fixture: raw BM25 still ranks the whole corpus');
  assert.notEqual(r.gate, 'bm25');
});

test('hrrAskHeaders opts the live sidecar into dispatch', () => {
  const h = hrrAskHeaders({ contextId: 'ctx-1', topK: 8, corpusChars: 40000 });
  assert.equal(h['x-hrr-gate'], 'dispatch');
  assert.equal(h['x-hrr-context'], 'ctx-1');
  assert.equal(h['x-hrr-top-k'], '8');
  assert.equal(h['x-hrr-corpus-chars'], '40000');
});

test('production ask/spill paths send x-hrr-gate: dispatch and do not treat BM25 as the front door', () => {
  const proxy = fs.readFileSync(new URL('../lib/proxy.js', import.meta.url), 'utf8');
  const hrr = fs.readFileSync(new URL('../lib/hrr.js', import.meta.url), 'utf8');
  const mcp = fs.readFileSync(new URL('../lib/mcp.js', import.meta.url), 'utf8');
  const retrieve = fs.readFileSync(new URL('../lib/retrieve.js', import.meta.url), 'utf8');
  const spill = fs.readFileSync(new URL('../lib/spill.js', import.meta.url), 'utf8');

  assert.match(proxy, /hrrAskHeaders/, 'spilled completions must stamp dispatch headers');
  assert.match(hrr, /hrrAskHeaders/, 'askWithContext must stamp dispatch headers');
  assert.match(mcp, /hrrAskHeaders/, 'zoo_ask must stamp dispatch headers');
  assert.match(spill, /spillRetrieve/, 'decideChatSpill must run dispatch+guard');
  assert.match(retrieve, /dispatchRetrieval/, 'retrieve front door is the cascade');
  assert.match(retrieve, /guardCandidates/, 'recall guard sits under ranked results');
  assert.doesNotMatch(
    retrieve,
    /export function bm25Rank/,
    'bm25_rank must not be a public front door',
  );
  assert.ok(tokenize('smoothing a bumpy surface').includes('smooth'));
});
