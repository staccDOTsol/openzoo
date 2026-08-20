/**
 * Durable proxy-session spend. The HUD's /v1/session counters used to live
 * only in RAM, so launching a fresh openzoo on :8402 (opening the desktop
 * app, ensureProxy, a crash) reset spent/cogs/direct/paidCalls to $0 even
 * though ~/.openzoo/proxy.log still showed a real session.
 *
 * Same home as the wallet and corpus ledger: ~/.openzoo/session.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sessionSpendFile(home = os.homedir()) {
  return process.env.OPENZOO_SESSION_PATH
    || path.join(home, '.openzoo', 'session.json');
}

const EMPTY = { spentUsd: 0, cogsUsd: 0, directUsd: 0, paidCalls: 0 };

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function loadSessionSpend(file = sessionSpendFile()) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return { ...EMPTY, ok: false, reason: 'missing' }; }
  let data;
  try { data = JSON.parse(raw); }
  catch { return { ...EMPTY, ok: false, reason: 'corrupt' }; }
  return {
    spentUsd: num(data.spentUsd),
    cogsUsd: num(data.cogsUsd),
    directUsd: num(data.directUsd),
    paidCalls: Math.floor(num(data.paidCalls)),
    ok: true,
  };
}

export function saveSessionSpend(stats, file = sessionSpendFile()) {
  const payload = {
    spentUsd: num(stats?.spentUsd),
    cogsUsd: num(stats?.cogsUsd),
    directUsd: num(stats?.directUsd),
    paidCalls: Math.floor(num(stats?.paidCalls)),
    updatedAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
