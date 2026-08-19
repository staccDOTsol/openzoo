/**
 * Agent-shaped spill fixture — the live Claude Code shape, not the toy
 * "bind 250k, send a one-liner" 7x story.
 *
 * Live /v1/info (2026-08-19): boundChars ~5.4MB (almost all files),
 * lastSend 13–15 / 107–110, spilled savingX 1.2–1.5x. Tests that only
 * measure a one-line ask against a bound pile cannot see that.
 *
 * This fixture: ~250k already bound (conversation + files), then 13–15
 * recent messages that are assistant tool_call + fat Read/Bash tool_result
 * of those same files, interleaved with non-file actions, plus one real
 * last user ask.
 */
import path from 'node:path';
import { planSpillTail, boundAbsFromKeys, SPILL_DEFAULTS } from '../lib/spill.js';

export const ASK = 'What should I change next in the vault program?';
export const LEDGER_CHARS = 250_000;
export const FILE_BODY = 40_000;
export const TEST_OUTPUT = 30_000;
export const GREP_OUTPUT = 4_000;

const FILES = [
  '/workspace/programs/vault/src/lib.rs',
  '/workspace/programs/vault/src/state.rs',
  '/workspace/programs/vault/src/errors.rs',
  '/workspace/lib/spill.js',
  '/workspace/lib/proxy.js',
];

function pad(ch, n) {
  return ch.repeat(n);
}

function toolCall(id, name, args) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  };
}

function toolResult(id, content) {
  return { role: 'tool', tool_call_id: id, content };
}

/**
 * ~107 messages: system + older conversation + 13–15 recent tool turns + ask.
 * boundFiles already holds the file paths (previous-turn binds).
 */
export function agentShapedFixture() {
  const boundFiles = new Set(FILES.map((abs, i) => `${abs}:${i + 1}`));
  const msgs = [
    { role: 'system', content: 'You are Claude Code. Prefer the bound corpus via recall.' },
    { role: 'user', content: 'Work through the vault program and the sidecar spill path.' },
  ];

  // Older conversation so the transcript is ~107 messages like lastSend 13/107.
  let older = 0;
  while (msgs.length < 90) {
    older += 1;
    msgs.push({
      role: 'assistant',
      content: `Earlier step ${older}: ${pad('x', 400)}`,
    });
    if (older % 3 === 0) {
      msgs.push({
        role: 'user',
        content: `ok continue ${older}`,
      });
    }
  }

  // Recent window — live shape: Read/Bash of already-bound files (tens of KB)
  // interleaved with non-file actions the agent must still see.
  let seq = 0;
  const recent = [];
  const addRead = (abs) => {
    seq += 1;
    const id = `read_${seq}`;
    recent.push(toolCall(id, 'Read', { file_path: abs }));
    recent.push(toolResult(id, `FILE ${abs}\n${pad('F', FILE_BODY)}`));
  };
  const addBashHead = (abs) => {
    seq += 1;
    const id = `bash_${seq}`;
    recent.push(toolCall(id, 'Bash', { command: `head -80 ${abs}` }));
    recent.push(toolResult(id, pad('H', FILE_BODY)));
  };

  addRead(FILES[0]);
  addRead(FILES[1]);
  addRead(FILES[2]);
  seq += 1;
  recent.push(toolCall(`nf_${seq}`, 'Bash', { command: 'rg vault programs' }));
  recent.push(toolResult(`nf_${seq}`, `match ${pad('G', GREP_OUTPUT)}`));
  addBashHead(FILES[3]);
  seq += 1;
  recent.push(toolCall(`nf_${seq}`, 'Bash', { command: 'npm test' }));
  recent.push(toolResult(`nf_${seq}`, `FAIL ${pad('T', TEST_OUTPUT)}`));
  addRead(FILES[4]);
  recent.push({ role: 'user', content: ASK });

  msgs.push(...recent);

  return {
    msgs,
    boundFiles,
    boundAbs: boundAbsFromKeys(boundFiles),
    ask: ASK,
    ledgerChars: LEDGER_CHARS,
    recentMessages: recent.length,
    totalMessages: msgs.length,
  };
}

export function measureFixture(fx, opts) {
  const plan = planSpillTail(fx.msgs, {
    boundAbs: fx.boundAbs,
    boundFiles: fx.boundFiles,
    stub: opts.stub,
    keepTailMsgs: opts.keepTailMsgs,
    tailMaxChars: opts.tailMaxChars,
    tailMinTurns: opts.tailMinTurns,
  });
  const sentChars = plan.sentChars;
  const ratio = sentChars > 0 ? fx.ledgerChars / sentChars : Infinity;
  const tailHasAsk = plan.forwarded.some((m) => m.role === 'user' && m.content === fx.ask);
  const tailHasTest = plan.forwarded.some((m) => typeof m.content === 'string' && m.content.includes('FAIL '));
  const tailHasGrep = plan.forwarded.some((m) => typeof m.content === 'string' && m.content.includes('match '));
  const tailHasFileBody = plan.forwarded.some((m) => (
    typeof m.content === 'string' && (m.content.includes('F'.repeat(40)) || m.content.includes('H'.repeat(40)))
  ));
  return {
    ok: plan.ok,
    stub: Boolean(opts.stub),
    tailMaxChars: opts.tailMaxChars,
    tailMinTurns: opts.tailMinTurns,
    corpusChars: fx.ledgerChars,
    prefixChars: plan.corpusChars,
    sentChars,
    sentTokensApprox: plan.sentTokensApprox,
    ratio: Number(ratio.toFixed(2)),
    stubbed: plan.stubbed,
    dropped: plan.dropped,
    realTurns: plan.realTurns,
    lastAskKept: tailHasAsk,
    nonFileKept: tailHasTest || tailHasGrep,
    fileBodyKept: tailHasFileBody,
    forwardedMsgs: plan.forwarded.length,
    totalMsgs: fx.msgs.length,
  };
}

export function sweepAgentFixture(fx = agentShapedFixture()) {
  const rows = [];
  rows.push(measureFixture(fx, {
    stub: false,
    ...SPILL_DEFAULTS,
  }));
  for (const tailMaxChars of [2000, 6000, 12000]) {
    for (const tailMinTurns of [2, 4, 6]) {
      rows.push(measureFixture(fx, {
        stub: true,
        keepTailMsgs: SPILL_DEFAULTS.keepTailMsgs,
        tailMaxChars,
        tailMinTurns,
      }));
    }
  }
  return { fx, rows };
}

export function formatSweepTable(rows) {
  const hdr = 'stub  maxCh  minT  sentChars  tok~  ratio  ask  nonFile  fileBody  stubbed  dropped';
  const lines = [hdr];
  for (const r of rows) {
    lines.push([
      r.stub ? 'yes ' : 'no  ',
      String(r.tailMaxChars).padStart(5),
      String(r.tailMinTurns).padStart(4),
      String(r.sentChars).padStart(9),
      String(r.sentTokensApprox).padStart(5),
      String(r.ratio).padStart(6),
      r.lastAskKept ? 'yes' : 'NO ',
      r.nonFileKept ? 'yes' : 'no ',
      r.fileBodyKept ? 'yes' : 'no ',
      String(r.stubbed).padStart(7),
      String(r.dropped).padStart(8),
    ].join('  '));
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${path.resolve(process.argv[1] || '')}`) {
  const { fx, rows } = sweepAgentFixture();
  console.log(`fixture msgs=${fx.totalMessages} recent=${fx.recentMessages} ledger=${fx.ledgerChars}`);
  console.log(formatSweepTable(rows));
}
