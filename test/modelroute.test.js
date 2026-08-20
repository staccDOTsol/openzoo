import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_MODEL_ID,
  atomPositions,
  TextEncoder,
  TaskClassifier,
  Catalog,
  Outcomes,
  route,
  routeChatBody,
  fallbackChain,
  isRetryableStatus,
  outcomeFromResponse,
  isAutoModel,
  BIND_ABOVE_TOKENS,
  BIND_SLICE_TOKENS,
  resetModelrouteSingletons,
  artifactDir,
  shippedOutcomesPath,
  getOutcomes,
} from '../lib/modelroute.js';
import { resolveModel, rewriteChatModel, publishModelList } from '../lib/models.js';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fixtures = JSON.parse(readFileSync(path.join(root, 'test', 'fixtures', 'modelroute.json'), 'utf8'));
const catalogPath = path.join(root, 'vendor', 'modelroute', 'catalog.json');
const routerPath = path.join(root, 'vendor', 'modelroute', 'router.json');

const CFG = { dim: 4096, k: 8, seed: 17, char_n: 4, use_bigrams: true };

test('isAutoModel accepts the virtual id and aliases', () => {
  assert.equal(isAutoModel('openzoo/auto'), true);
  assert.equal(isAutoModel('openzoo-auto'), true);
  assert.equal(isAutoModel('auto'), true);
  assert.equal(isAutoModel('openzoo/auto '), true);
  assert.equal(isAutoModel('x-ai/grok-4.6'), false);
  assert.equal(AUTO_MODEL_ID, 'openzoo/auto');
});

test('encoder hashes are sha256 — atom positions match Python', () => {
  const { idx, sgn } = atomPositions('python', 4096, 8, 17);
  assert.deepEqual(idx, fixtures.atom_python.idx);
  assert.deepEqual(sgn, fixtures.atom_python.sgn);
});

test('encoder matches Python on fixture strings (channels, IDF, vector)', () => {
  const clf = TaskClassifier.load(routerPath);
  assert.equal(clf.enc.idfBucket('python'), fixtures.idf_sample.bucket_python);
  assert.ok(Math.abs(clf.enc.weight('python') - fixtures.idf_sample.python) < 1e-9);
  assert.ok(Math.abs(clf.enc.weight('the') - fixtures.idf_sample.the) < 1e-9);
  // Fixtures were dumped from a vocabulary-free encoder (no IDF table). Same
  // sha256 atoms; IDF is checked above and via route() against the real head.
  const enc = new TextEncoder(CFG);

  for (const row of fixtures.encoder) {
    const [words, bigrams, charsHead] = enc.channels(row.text);
    assert.deepEqual(words, row.channels[0]);
    assert.deepEqual(bigrams, row.channels[1]);
    assert.deepEqual(charsHead.slice(0, row.channels[2].length), row.channels[2]);
    const v = enc.encode(row.text);
    assert.equal(v.length, 4096);
    for (let i = 0; i < row.encode.head.length; i++) {
      assert.ok(Math.abs(v[i] - row.encode.head[i]) < 1e-9, `${row.text} dim ${i}: ${v[i]} vs ${row.encode.head[i]}`);
    }
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n);
    assert.ok(Math.abs(n - row.encode.norm) < 1e-8 || row.encode.norm < 1e-12);
  }
  // Same sparse support as Python; 1-ulp drift after unit-normalise is ok —
  // route() fixtures (below) are the decision contract.
  const v = enc.encode('write a python function');
  const nz = [];
  for (let i = 0; i < v.length; i++) if (Math.abs(v[i]) > 1e-12) nz.push(i);
  assert.deepEqual(nz.slice(0, 6), [32, 33, 60, 76, 81, 83]);
  assert.equal(nz.length, 207);
  assert.ok(Math.abs(Math.abs(v[32]) - 0.028249581756603644) < 1e-14);
});

test('classifier labels match Python on fixture prompts', () => {
  const clf = TaskClassifier.load(routerPath);
  for (const [text, [label]] of Object.entries(fixtures.predict)) {
    const [got] = clf.predict(text);
    assert.equal(got, label, text);
  }
});

test('route() matches Python fixtures (HANDOFF keys + chosen model)', () => {
  const catalog = new Catalog(catalogPath);
  const classifier = TaskClassifier.load(routerPath);
  const outcomes = new Outcomes(null);
  assert.equal(catalog.stamp.startsWith('2026-08-20'), true);
  assert.equal(catalog.length, 414);

  for (const { in: inp, out } of fixtures.routes) {
    const r = route(inp.text, {
      catalog, classifier, outcomes,
      allow_free: inp.allow_free ?? false,
      bindable: inp.bindable ?? true,
      context: inp.context,
      has_image: inp.has_image,
    });
    for (const key of ['model', 'p_success', 'usd_per_task', 'bind_first', 'cleared_bar', 'shortlist', 'task_class']) {
      assert.ok(key in r, `missing ${key}`);
    }
    assert.equal(r.model, out.model, inp.text);
    assert.equal(r.task_class, out.task_class, inp.text);
    assert.equal(r.cleared_bar, out.cleared_bar, inp.text);
    assert.equal(r.bind_first, out.bind_first, inp.text);
    assert.equal(r.p_success, out.p_success, `${inp.text} p_success`);
    assert.equal(r.usd_per_task, out.usd_per_task, `${inp.text} usd`);
    assert.equal(r.shortlist[0].model, out.shortlist[0].model);
    assert.equal(r.catalog_stamp, out.catalog_stamp);
  }
});

test('HANDOFF contract: cheapest that clears the bar; uncleared is flagged', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-mr-'));
  const catalog = {
    stamp: 'selftest',
    ids: ['cheap/good', 'pricey/good', 'cheap/blind', 'cheap/weak'],
    ctx: [200000, 200000, 200000, 200000],
    categories: ['programming'],
    price_in: [0.5, 10.0, 0.4, 0.3],
    price_out: [1.0, 30.0, 0.8, 0.6],
    modality: [1 | 2, 1 | 2, 1, 1],
    tools: [true, true, true, false],
    jsonmode: [true, true, true, true],
    reasoning: [true, true, true, true],
    ranks: [[2], [1], [3], [0]],
    bind_ctx: [128000000, 128000000, 128000000, 128000000],
  };
  const cat = new Catalog(null, catalog);
  const enc = new TextEncoder({ dim: 256, k: 8, seed: 3, char_n: 4 });
  // Tiny synthetic head: one prototype per class, no router.json.
  const P = [
    enc.encode('write a python function'),
    enc.encode('translate this into french'),
  ];
  const clf = new TaskClassifier(['code', 'translate'], enc, P);
  const out = new Outcomes(null);

  const r = route('write a python function', { catalog: cat, classifier: clf, outcomes: out, allow_free: true });
  assert.equal(r.cleared_bar, true);
  const clearing = r.shortlist.filter((s) => s.p_success >= r.bar);
  assert.equal(r.model, clearing.reduce((a, b) => (a.usd_per_task <= b.usd_per_task ? a : b)).model);
  assert.notEqual(r.model, 'pricey/good');

  const rv = route('what is in this screenshot', {
    catalog: cat, classifier: clf, outcomes: out, allow_free: true, has_image: true,
  });
  assert.equal(rv.feasible_models, 2);
  assert.ok(rv.shortlist.every((s) => s.model === 'cheap/good' || s.model === 'pricey/good'));

  const rhard = route('prove this rigorously', {
    catalog: cat, classifier: clf, outcomes: out, allow_free: true, bar_shift: 0.5,
  });
  assert.equal(rhard.cleared_bar, false);
  assert.match(rhard.reason, /NO feasible model/);
  assert.equal(rhard.model, 'pricey/good');

  const out2 = new Outcomes(null);
  for (let i = 0; i < 12; i++) out2.record('code', 'cheap/good', false);
  const r2 = route('write a python function', { catalog: cat, classifier: clf, outcomes: out2, allow_free: true });
  assert.notEqual(r2.model, 'cheap/good');
  assert.ok(!r2.shortlist.some((s) => s.model === 'cheap/good'));
  rmSync(dir, { recursive: true, force: true });
});

test('NaN / negative prices are uncostable, never cheaper than free', () => {
  const catalog = {
    stamp: 'neg',
    ids: ['paid/ok', 'neg/price', 'nan/price'],
    ctx: [200000, 200000, 200000],
    categories: ['programming'],
    price_in: [0.5, -3, null],
    price_out: [1.0, -3, null],
    modality: [1, 1, 1],
    tools: [true, true, true],
    jsonmode: [true, true, true],
    reasoning: [true, true, true],
    ranks: [[1], [1], [1]],
  };
  const cat = new Catalog(null, catalog);
  const feas = cat.feasible({ needs_image: false, needs_tools: false, needs_json: false, min_context: 100 }, false);
  assert.deepEqual(feas, [true, false, false]);
});

test('bind_ctx is not a routing window; bind_first uses the leCore slice', () => {
  const catalog = {
    stamp: 'bind',
    ids: ['small/window'],
    ctx: [16384],
    bind_ctx: [128000000],
    categories: ['programming'],
    price_in: [0.5],
    price_out: [1.0],
    modality: [1],
    tools: [true],
    jsonmode: [true],
    reasoning: [true],
    ranks: [[2]],
  };
  const cat = new Catalog(null, catalog);
  const enc = new TextEncoder({ dim: 64, seed: 1 });
  const clf = new TaskClassifier(['bulk'], enc, [enc.encode('hello')]);
  const r = route('summarise this document', {
    catalog: cat, classifier: clf, outcomes: new Outcomes(null),
    allow_free: false, bindable: true, input_tokens: BIND_ABOVE_TOKENS + 1,
  });
  assert.equal(r.bind_first, true);
  assert.equal(r.constraints.est_in, BIND_SLICE_TOKENS);
  assert.ok(r.constraints.min_context < 20000);
  assert.equal(r.model, 'small/window');
  assert.equal(r.feasible_models, 1);

  const nobind = route('summarise this document', {
    catalog: cat, classifier: clf, outcomes: new Outcomes(null),
    allow_free: false, bindable: false, input_tokens: BIND_ABOVE_TOKENS + 1,
  });
  assert.equal(nobind.bind_first, false);
  assert.equal(nobind.model, null);
  assert.equal(nobind.feasible_models, 0);
});

test('runtime loads lib/modelroute catalog, router, and shipped outcomes', () => {
  resetModelrouteSingletons();
  const prevOut = process.env.OPENZOO_MODELROUTE_OUTCOMES;
  const prevDir = process.env.OPENZOO_MODELROUTE_DIR;
  const tmp = mkdtempSync(path.join(tmpdir(), 'oz-ship-'));
  delete process.env.OPENZOO_MODELROUTE_DIR;
  process.env.OPENZOO_MODELROUTE_OUTCOMES = path.join(tmp, 'live.json');
  try {
    const dir = artifactDir();
    assert.equal(path.basename(dir), 'modelroute');
    assert.ok(dir.replace(/\\/g, '/').endsWith('lib/modelroute'));
    assert.equal(shippedOutcomesPath(), path.join(dir, 'outcomes.json'));
    assert.ok(existsSync(path.join(dir, 'catalog.json')));
    assert.ok(existsSync(path.join(dir, 'router.json')));
    const shipped = JSON.parse(readFileSync(shippedOutcomesPath(), 'utf8'));
    const n = Object.values(shipped).reduce((a, p) => a + (p[1] || 0), 0);
    assert.equal(Object.keys(shipped).length, 341);
    assert.equal(n, 3832);
    const out = getOutcomes();
    assert.equal(Object.keys(out.shipped).length, 341);
    const [p, obs] = out.posterior('agentic', 'anthropic/claude-sonnet-5', 0.45);
    assert.equal(obs, 9);
    assert.ok(p > 0.45, `measured posterior should beat the prior, got ${p}`);
    out.record('code', 'test/live-only', true);
    const disk = JSON.parse(readFileSync(process.env.OPENZOO_MODELROUTE_OUTCOMES, 'utf8'));
    assert.deepEqual(disk, { 'code|test/live-only': [1, 1] });
    assert.equal(Object.keys(disk).length, 1);
  } finally {
    resetModelrouteSingletons();
    if (prevOut === undefined) delete process.env.OPENZOO_MODELROUTE_OUTCOMES;
    else process.env.OPENZOO_MODELROUTE_OUTCOMES = prevOut;
    if (prevDir === undefined) delete process.env.OPENZOO_MODELROUTE_DIR;
    else process.env.OPENZOO_MODELROUTE_DIR = prevDir;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('outcomes file is mergeable {class|model: [successes, attempts]}', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-out-'));
  const file = path.join(dir, 'modelroute-outcomes.json');
  const a = new Outcomes(file);
  a.record('code', 'cheap/good', true);
  a.record('code', 'cheap/good', false);
  const tab = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(tab['code|cheap/good'], [1, 2]);
  const b = new Outcomes(file);
  b.record('code', 'cheap/good', true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8'))['code|cheap/good'], [2, 3]);
  rmSync(dir, { recursive: true, force: true });
});

test('fallbackChain is cheapest-first among those that cleared, finite', () => {
  const r = {
    model: 'mid/ok',
    cleared_bar: true,
    bar: 0.6,
    shortlist: [
      { model: 'mid/ok', p_success: 0.7, usd_per_task: 0.002 },
      { model: 'cheap/ok', p_success: 0.65, usd_per_task: 0.001 },
      { model: 'pricey/ok', p_success: 0.8, usd_per_task: 0.01 },
      { model: 'weak', p_success: 0.4, usd_per_task: 0.0001 },
    ],
  };
  assert.deepEqual(fallbackChain(r), ['cheap/ok', 'pricey/ok']);
  assert.deepEqual(fallbackChain({ ...r, cleared_bar: false }), []);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(402), false);
  assert.equal(isRetryableStatus(200), false);
  assert.equal(outcomeFromResponse(200, { choices: [{ message: { content: 'hi' } }] }), true);
  assert.equal(outcomeFromResponse(200, { choices: [{ message: { content: '' } }] }), false);
  assert.equal(outcomeFromResponse(400, {}), false);
  assert.equal(outcomeFromResponse(402, {}), null);
});

test('resolveModel / rewriteChatModel leave openzoo/auto alone', () => {
  const ids = ['x-ai/grok-4.6', 'deepseek/deepseek-v4-pro-0813'];
  assert.equal(resolveModel('openzoo/auto', ids), null);
  process.env.OPENZOO_DEFAULT_MODEL = 'x-ai/grok-4.6';
  try {
    assert.equal(resolveModel('openzoo/auto', ids), null);
    const fat = {
      model: 'openzoo/auto',
      max_tokens: 2000,
      messages: Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `turn ${i} ${'please review this function '.repeat(20)}`,
      })),
    };
    const out = rewriteChatModel(fat, ids);
    assert.equal(out.auto, true);
    assert.equal(out.tiny, false);
    assert.equal(out.parsed.model, 'openzoo/auto');
  } finally {
    delete process.env.OPENZOO_DEFAULT_MODEL;
  }
});

test('published catalog includes openzoo/auto as Auto', () => {
  const published = publishModelList({ object: 'list', data: [{ id: 'x-ai/grok-4.6', object: 'model' }] });
  const auto = published.data.find((m) => m.id === 'openzoo/auto');
  assert.ok(auto);
  assert.equal(auto.display_name, 'Auto');
  assert.equal(auto.owned_by, 'openzoo');
});

test('routeChatBody uses the last user turn and prior context', () => {
  resetModelrouteSingletons();
  const r = routeChatBody({
    model: 'openzoo/auto',
    messages: [
      { role: 'user', content: 'the unit test for parse_json is failing on nested objects' },
      { role: 'assistant', content: 'can you paste the error?' },
      { role: 'user', content: 'fix it' },
    ],
  });
  assert.ok(r.model);
  assert.ok(r.task_class);
  assert.equal(typeof r.cleared_bar, 'boolean');
  assert.ok(Array.isArray(r.shortlist) && r.shortlist.length >= 1);
  for (const key of ['p_success', 'usd_per_task', 'bind_first', 'evidence']) {
    assert.ok(key in r || r.shortlist[0][key] != null);
  }
});

test('npm pack includes vendor/modelroute artifacts', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('vendor/modelroute'));
  assert.equal(pkg.files.includes('lib'), true);
});

test('sidecar wires /route, openzoo/auto rewrite, fallback, and outcomes', () => {
  const src = readFileSync(path.join(root, 'lib', 'proxy.js'), 'utf8');
  assert.match(src, /routePath === '\/route'/);
  assert.match(src, /openzoo\/auto ->/);
  assert.match(src, /fallbackChain/);
  assert.match(src, /recordRouteOutcome/);
  assert.match(src, /allow_free: false/);
  assert.match(src, /bindable: true/);
  const libPkg = JSON.parse(readFileSync(path.join(root, 'lib', 'package.json'), 'utf8'));
  assert.equal(libPkg.type, 'module');
});
