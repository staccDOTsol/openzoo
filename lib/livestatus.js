/**
 * Live turn status + stream idle timeout.
 *
 * A long x402 pay or a quiet SSE used to leave grokui on mute "…" dots.
 * Callers paint ONE mutating status line (paying / waiting on model / current
 * tool) and abort a reader that has gone silent.
 */

export const STREAM_IDLE_MS = Number(process.env.OZ_STREAM_IDLE_MS || 55_000);
export const STALE_THINKING_MS = Number(process.env.OZ_STALE_THINKING_MS || 90_000);
export const MODEL_WAIT_TICK_MS = 1000;
export const MODEL_WAIT_SECONDS_AFTER_MS = 2000;

const DIRECTIVE = /^(?:[ \t>*-]*)(SPAWN|SEND|PING|PEEK|WRITE|READ|EDIT|MULTIEDIT|NOTEBOOK|LS|LIST|DIR|GLOB|FIND|GREP|TODO|SERVE|FETCH|MCP|RUN):\s*(.*)$/im;

export function clipStatusArg(s, n = 42) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function formatModelWait(elapsedMs) {
  const s = Math.floor(Math.max(0, Number(elapsedMs) || 0) / 1000);
  return s >= 2 ? `waiting on model… ${s}s` : 'waiting on model…';
}

export function formatPayStatus(attempt = 0) {
  return Number(attempt) > 0 ? 'waiting on x402…' : 'paying…';
}

export function peekDirectiveStatus(reply, runCmd) {
  if (runCmd) return `RUN: ${clipStatusArg(runCmd)}`;
  const raw = String(reply || '');
  const m = DIRECTIVE.exec(raw);
  if (!m) return '';
  let kind = m[1].toUpperCase();
  if (kind === 'LS' || kind === 'LIST' || kind === 'DIR' || kind === 'FIND') kind = 'GLOB';
  const rest = clipStatusArg(m[2]);
  return rest ? `${kind}: ${rest}` : `${kind}:`;
}

/** One-shot wait clock. Calls onStatus immediately, then every 1s with elapsed. */
export function startModelWait(onStatus, now = Date.now) {
  if (typeof onStatus !== 'function') return () => {};
  const t0 = now();
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    onStatus(formatModelWait(now() - t0));
  };
  tick();
  const iv = setInterval(tick, MODEL_WAIT_TICK_MS);
  iv.unref?.();
  return () => { stopped = true; clearInterval(iv); };
}

/**
 * On-chain holdings as money. Stables are $1 even without a quote; everything
 * else needs tokenUsd from the chat 402 (same prices `openzoo balance` uses).
 * A TOKEN pile that used to print as "18584 TOKEN" becomes $4.25 here.
 */
export function priceHoldings(snap, prices = {}) {
  let chainUsd = 0;
  const holdings = [];
  for (const b of snap || []) {
    const symbol = String(b.symbol || '');
    const ui = Number(b.ui) || 0;
    const key = symbol.toUpperCase();
    const listed = prices[key] ?? prices[symbol];
    const stable = (key === 'USDC' || key === 'USDG') ? 1 : null;
    const tokenUsd = listed != null && Number.isFinite(Number(listed)) ? Number(listed) : stable;
    const usd = tokenUsd != null ? ui * tokenUsd : null;
    if (usd != null) chainUsd += usd;
    holdings.push({ symbol, ui, chain: b.chain || 'solana', tokenUsd, usd });
  }
  return { chainUsd, holdings };
}

export function formatHoldingMoney(h) {
  const qty = `${h.ui} ${h.symbol}`;
  if (h.usd == null || !Number.isFinite(h.usd)) return qty;
  const money = h.usd >= 0.01 || h.usd === 0 ? h.usd.toFixed(2) : h.usd.toFixed(4);
  return `${qty}  ($${money})`;
}

export async function readWithIdleTimeout(reader, idleMs = STREAM_IDLE_MS) {
  let to;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        to = setTimeout(() => {
          const err = new Error('stream idle timeout');
          err.code = 'STREAM_IDLE';
          reject(err);
        }, idleMs);
      }),
    ]);
  } finally {
    clearTimeout(to);
  }
}
