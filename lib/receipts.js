/**
 * The receipt ledger — every paid call, kept.
 *
 * WHY ON DISK: the receipt is the product. A line that scrolls past in a
 * terminal proves nothing an hour later, and "59x cheaper than OpenRouter"
 * is a claim anyone can ask you to back up. This is the backing: an
 * append-only JSONL of every call the shim has paid for, with both the
 * billed price and what the SAME tokens on the SAME model would have cost
 * buying direct, so the multiple is arithmetic rather than marketing.
 *
 * Append-only and never rewritten: a ledger you can edit is not evidence.
 * 0600, local, never uploaded — it contains what you wrote and what it
 * cost, which is nobody's business but yours.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RECEIPTS_FILE = process.env.OPENZOO_RECEIPTS
  || path.join(os.homedir(), '.openzoo', 'receipts.jsonl');

/**
 * Record one paid call. Never throws: a ledger write must not be able to
 * fail the thing it is recording.
 *
 * `input`/`output` are kept because a before/after pair is the only part
 * of a receipt anyone actually enjoys reading. OPENZOO_RECEIPTS_NO_TEXT=1
 * stores lengths only.
 */
export function recordReceipt(rec) {
  try {
    const keepText = process.env.OPENZOO_RECEIPTS_NO_TEXT !== '1';
    const row = {
      at: new Date().toISOString(),
      kind: rec.kind || 'call',
      model: rec.model || 'unknown',
      billedUsd: Number(rec.billedUsd || 0),
      directUsd: Number(rec.directUsd || 0),
      seconds: Number(rec.seconds || 0),
      inChars: Number(rec.inChars || (rec.input ? rec.input.length : 0)),
      outChars: Number(rec.outChars || (rec.output ? rec.output.length : 0)),
      ...(rec.stage ? { stage: rec.stage } : {}),
      ...(rec.tool ? { tool: rec.tool } : {}),
      ...(keepText && rec.input ? { input: rec.input } : {}),
      ...(keepText && rec.output ? { output: rec.output } : {}),
    };
    fs.mkdirSync(path.dirname(RECEIPTS_FILE), { recursive: true, mode: 0o700 });
    fs.appendFileSync(RECEIPTS_FILE, JSON.stringify(row) + '\n', { mode: 0o600 });
    return row;
  } catch {
    return null;
  }
}

export function readReceipts(file = RECEIPTS_FILE) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function usd(n) {
  if (!(n > 0)) return '$0';
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.000001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(1)}`;
}

/**
 * Roll the ledger up into the numbers worth quoting.
 *
 * The headline multiple is TOTAL direct over TOTAL billed, not the mean of
 * per-call multiples: averaging ratios lets one cheap call with a big
 * multiple dominate a hundred expensive ones, which would be the exact
 * kind of flattering-but-wrong number this ledger exists to avoid.
 * Calls the gateway reported no direct price for are excluded from the
 * comparison and counted separately, never silently treated as 1x.
 */
export function summarizeReceipts(rows = readReceipts()) {
  const comparable = rows.filter((r) => r.billedUsd > 0 && r.directUsd > 0);
  const billed = rows.reduce((n, r) => n + r.billedUsd, 0);
  const cmpBilled = comparable.reduce((n, r) => n + r.billedUsd, 0);
  const cmpDirect = comparable.reduce((n, r) => n + r.directUsd, 0);
  const best = comparable
    .map((r) => ({ ...r, x: r.directUsd / r.billedUsd }))
    .sort((a, b) => b.x - a.x)[0] || null;
  const byKind = {};
  for (const r of rows) {
    const k = byKind[r.kind] ||= { calls: 0, billed: 0, direct: 0, seconds: 0 };
    k.calls += 1; k.billed += r.billedUsd; k.direct += r.directUsd; k.seconds += r.seconds;
  }
  return {
    calls: rows.length,
    since: rows[0]?.at ?? null,
    billedUsd: billed,
    comparable: comparable.length,
    freeOrUnpriced: rows.length - comparable.length,
    directUsd: cmpDirect,
    savedUsd: Math.max(0, cmpDirect - cmpBilled),
    multiple: cmpBilled > 0 ? cmpDirect / cmpBilled : 0,
    avgSeconds: rows.length ? rows.reduce((n, r) => n + r.seconds, 0) / rows.length : 0,
    best,
    byKind,
  };
}

/** The boast, printable. */
export function formatSummary(s = summarizeReceipts()) {
  if (!s.calls) return 'no receipts yet — nothing has been paid for.';
  const lines = [
    `openzoo receipts — ${s.calls} paid call${s.calls === 1 ? '' : 's'} since ${String(s.since).slice(0, 10)}`,
    '',
    `  spent          ${usd(s.billedUsd)}`,
    `  same calls direct on OpenRouter  ${usd(s.directUsd)}   (over ${s.comparable} comparable call${s.comparable === 1 ? '' : 's'})`,
    `  saved          ${usd(s.savedUsd)}${s.multiple >= 1.05 ? `  —  ${s.multiple.toFixed(1)}× cheaper overall` : ''}`,
    `  avg latency    ${s.avgSeconds.toFixed(1)}s`,
  ];
  if (s.freeOrUnpriced) {
    lines.push(`  (${s.freeOrUnpriced} call${s.freeOrUnpriced === 1 ? '' : 's'} had no comparable direct price — cached or unpriced, excluded above)`);
  }
  const kinds = Object.entries(s.byKind).sort((a, b) => b[1].calls - a[1].calls);
  if (kinds.length > 1) {
    lines.push('', '  by kind:');
    for (const [k, v] of kinds) lines.push(`    ${k.padEnd(10)} ${String(v.calls).padStart(4)} calls  ${usd(v.billed)}`);
  }
  if (s.best) {
    lines.push('', `  best single call: ${s.best.x.toFixed(1)}× — ${s.best.model} ${usd(s.best.billedUsd)} vs ${usd(s.best.directUsd)} direct`);
    if (s.best.input) lines.push(`    in:  ${String(s.best.input).replace(/\s+/g, ' ').slice(0, 100)}`);
    if (s.best.output) lines.push(`    out: ${String(s.best.output).replace(/\s+/g, ' ').slice(0, 100)}`);
  }
  lines.push('', `  ledger: ${RECEIPTS_FILE}`);
  return lines.join('\n');
}
