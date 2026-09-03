import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  splitSpendText,
  spendOnlyText,
  spendChipSource,
  stripSpendFromText,
  grokBotChromiumArgs,
  injectSpendChip,
  sessionSpendLabel,
  sessionSpendState,
  writeSpendHud,
} from '../lib/ozSpendChip.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('splitSpendText reads the ::oz-spend:: tag', () => {
  const footer = '\n\n::oz-spend::$10.68 · saved $0.69 · 6%/1.06×\nthis call $0.001150 · OpenRouter $0.002874\nspent $10.6810 · OpenRouter would $11.3706 · saved $0.6896 (6%)\ntx https://solscan.io/tx/SIG';
  const s = splitSpendText('hello' + footer);
  assert.equal(s.head, 'hello\n\n');
  assert.equal(s.summary, '$10.68 · saved $0.69 · 6%/1.06×');
  assert.match(s.body, /this call \$0\.001150/);
  assert.match(s.body, /solscan/);
});

test('splitSpendText still pills when React concatenates text nodes without newlines', () => {
  const vis = 'Sitrep rebuilds the board.::oz-spend::$25.26 · saved $21.00 · 45%/1.83×this call $0.001111 · OpenRouter $0.002954spent $25.2630 · OpenRouter would $46.2639 · saved $21.0009 (45%)tx https://basescan.org/tx/0xabc';
  const s = splitSpendText(vis);
  assert.ok(s, 'must not skip the pill when vis has no newlines');
  assert.match(s.head, /Sitrep rebuilds/);
  assert.equal(s.summary, '$25.26 · saved $21.00 · 45%/1.83×');
  assert.match(s.body, /this call \$0\.001111/);
  assert.doesNotMatch(s.body, /Sitrep rebuilds/);
});

test('splitSpendText falls back to this call $ when untagged', () => {
  const s = splitSpendText('reply\n\nthis call $0.004000 · OpenRouter $0.01\nspent $0.0040');
  assert.equal(s.head, 'reply\n\n');
  assert.equal(s.summary, '$0.0040');
  assert.match(s.body, /this call \$0\.004000/);
});

test('stripSpendFromText does not wipe list items', () => {
  assert.equal(stripSpendFromText('5. ship the PR::oz-spend::$29.09 · saved $21.14'), '5. ship the PR');
  assert.equal(stripSpendFromText('this call $0.001111 · OpenRouter $0.002954'), '');
  assert.equal(stripSpendFromText('1. first item'), '1. first item');
});

test('spendOnlyText is true for a footer with no reply', () => {
  assert.equal(spendOnlyText('::oz-spend::$0.01\nthis call $0.010000 · OpenRouter $0.02\nspent $0.0100 · OpenRouter would $0.0200 · saved $0.0100 (50%)'), true);
  assert.equal(spendOnlyText('the model said hi\n\nthis call $0.01 · OpenRouter $0.02'), false);
});

test('spendChipSource is the cafe ⓘ details IIFE', () => {
  const src = spendChipSource();
  assert.doesNotThrow(() => new Function(src));
  assert.match(src, /oz-spend/);
  assert.match(src, /ozCollapseSpend/);
  assert.match(src, /ⓘ /);
  assert.match(src, /sand-message-card/);
  assert.match(src, /data-oz-spend-hide/);
  assert.match(src, /__OZ_SPEND_CHIP__/);
  assert.match(src, /__OZ_SPEND_CHIP__ === 17/);
  assert.match(src, /isContentEditable/);
  assert.match(src, /oz-spend-float-pos/);
  assert.match(src, /pointerdown/);
  assert.match(src, /ozPlaceFloat/);
  assert.match(src, /oz-spend-hud/);
  assert.match(src, /ozFloatLabel/);
  assert.match(src, /__OZ_SPEND_LAST__/);
  assert.match(src, /Start voice input/);
  assert.match(src, /MutationObserver/);
  assert.match(src, /subtree: true/);
  assert.match(src, /setInterval\(\(\) => \{ run\(\); ozPollSpend\(\); ozPollShare\(\); \}, 2000\)/);
  assert.match(src, /ozPollSpend/);
  assert.match(src, /\/api\/ozSpend/);
  assert.match(src, /oz-share-hud/);
  assert.match(src, /\/api\/ozShare/);
  assert.match(src, /Share group/);
  assert.match(src, /__OZ_SPEND_BODY__/);
  assert.match(src, /el\.open = true/);
  assert.doesNotMatch(src, /msgPills/);
});

test('grokBotChromiumArgs open a localhost CDP port without asar edits', () => {
  const args = grokBotChromiumArgs(9444);
  assert.ok(args.includes('--ignore-certificate-errors'));
  assert.ok(args.includes('--remote-debugging-port=9444'));
  assert.ok(args.includes('--remote-allow-origins=*'));
  const cli = fs.readFileSync(path.join(root, 'lib/grokcli.js'), 'utf8');
  assert.match(cli, /grokBotChromiumArgs\(\)/);
  assert.match(cli, /injectSpendChipInBackground/);
  assert.match(cli, /chipDebug: state\.chipDebug/);
});

test('sessionSpendLabel reads ~/.openzoo/session.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-sess-'));
  try {
    fs.mkdirSync(path.join(tmp, '.openzoo'));
    fs.writeFileSync(path.join(tmp, '.openzoo', 'session.json'), JSON.stringify({
      spentUsd: 10.94, directUsd: 20.32, savedUsd: 9.38,
    }));
    const lab = sessionSpendLabel(tmp);
    assert.match(lab, /\$10\.94/);
    assert.match(lab, /saved \$9\.38/);
    const st = sessionSpendState(tmp);
    assert.equal(st.spent, 10.94);
    assert.equal(st.label, lab);
    assert.match(st.body, /spent \$10\.9400/);
    writeSpendHud({
      spent: 10.94, would: 20.32, saved: 9.38, pct: 46,
      label: lab,
      body: 'this call $0.15 · OpenRouter $0.76\ntx https://solscan.io/tx/SIG',
    }, tmp);
    const hud = sessionSpendState(tmp);
    assert.match(hud.body, /this call \$0\.15/);
    assert.match(hud.body, /solscan/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('spend chip inject is one-shot so CDP does not freeze the composer', () => {
  const src = fs.readFileSync(path.join(root, 'lib/ozSpendChip.js'), 'utf8');
  assert.doesNotMatch(src, /setInterval\(tick/);
  assert.match(src, /One CDP attach, then drop the debugger/);
  assert.match(src, /waitForUi/);
  assert.match(src, /class\*=\"sand-\"/);
});

test('floating HUD stays up even when a message chip exists', () => {
  const src = spendChipSource();
  assert.match(src, /function ozEnsureFloatSpend/);
  assert.doesNotMatch(src, /if \(!label \|\| msgPills\)/);
  assert.match(src, /ozFloatLabel/);
  assert.match(src, /if \(inComposer\(\)\)/);
  assert.match(src, /ozEnsureFloatSpend\(\)/);
  assert.match(src, /oz-spend-hud/);
  assert.match(src, /getElementById\('oz-spend-float'\)/);
  assert.match(src, / \|\| 'openzoo'/);
  assert.match(src, /bottom = '88px'/);
});

test('injectSpendChip evaluates the IIFE on each page target', async () => {
  const sent = [];
  const r = await injectSpendChip({
    port: 1,
    tries: 1,
    delayMs: 0,
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1' }],
    }),
    connect: async () => ({
      async send(method, params) {
        sent.push({ method, params });
        return {};
      },
      close() {},
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.injected, 1);
  assert.ok(sent.some((s) => s.method === 'Page.addScriptToEvaluateOnNewDocument'));
  const ev = sent.find((s) => s.method === 'Runtime.evaluate');
  assert.ok(ev);
  assert.match(ev.params.expression, /ozCollapseSpend/);
});
