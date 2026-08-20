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

/** First-X-back race: how many of the K we asked for have actually landed. */
export function formatRaceStatus(back, need) {
  const b = Math.max(0, Number(back) || 0);
  const n = Math.max(1, Number(need) || 1);
  return `racing ${b}/${n} back…`;
}

/** Race-level failure when no countable answer exists. Never a single model name. */
export const RACE_EVERY_FAILED = '(race: every model failed — no reply)';

const RACE_HTTP_NOTE = /^\((?:upstream error|request failed|payment failed|rate limited|stream timed out|stream stalled)/i;
const RACE_MODEL_FAILED = /^\([^)]+ (?:failed:|returned nothing)/i;
const RACE_FETCH_FAILED = /^(?:typeerror:\s*)?fetch failed$/i;

/**
 * Real answers count toward X.
 * Empty, HTTP/pay/timeout notes, TypeError `fetch failed`, `(model failed: …)`,
 * and any arrival with `.error` do not — those racers are abandoned.
 * Accepts a string or `{ text, error }`.
 */
export function isRaceCountable(textOrArrival) {
  const arrival = textOrArrival && typeof textOrArrival === 'object' && !Array.isArray(textOrArrival)
    ? textOrArrival
    : { text: textOrArrival };
  if (arrival.error) return false;
  const s = String(arrival.text || '').trim();
  if (!s) return false;
  if (RACE_FETCH_FAILED.test(s)) return false;
  if (RACE_HTTP_NOTE.test(s)) return false;
  if (RACE_MODEL_FAILED.test(s)) return false;
  return true;
}

/**
 * Fallback when X never fills: one race-level error, not `(one-model failed: …)`.
 * Failed arrivals are abandoned, not shipped as the assistant message.
 */
export function raceLastShip(arrivals) {
  const list = Array.isArray(arrivals) ? arrivals : [];
  const last = [...list].reverse().find((a) => isRaceCountable(a));
  if (last) return { ...last, text: String(last.text) };
  return { model: '', text: RACE_EVERY_FAILED, error: true };
}

/** Default bar a classified race answer must clear (0–10). Overridable. */
export const RACE_MIN_SCORE = Number(process.env.OZ_RACE_MIN_SCORE || 6);

/**
 * Parse a cheap classify reply into a 0–10 score.
 * Prefers `SCORE 7` / `SCORE: 7`; falls back to a lone 0–10.
 * Unparseable → 0 (does not clear the bar).
 */
export function parseClassifyScore(text) {
  const s = String(text || '');
  const tagged = /SCORE\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i.exec(s);
  const lone = tagged || /\b(10|[0-9])(?:\s*\/\s*10)?\b/.exec(s);
  if (!lone) return 0;
  const n = Number(lone[1]);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

/**
 * Pick a winner among the first-X-back candidates after they have been scored.
 * Passing = score >= minScore. Highest score wins; a tie is returned as
 * `reason: 'tie'` so the caller can pairwise-break it. If nobody clears the
 * bar, the last of the X is accepted — never blank.
 */
export function pickRaceWinner(cands, minScore = RACE_MIN_SCORE) {
  const list = Array.isArray(cands) ? cands.filter(Boolean) : [];
  if (!list.length) return { winner: null, reason: 'empty', tied: [] };
  const passing = list.filter((c) => (Number(c.score) || 0) >= minScore);
  if (!passing.length) {
    return { winner: list[list.length - 1], reason: 'fallback-last', tied: [] };
  }
  let max = -Infinity;
  for (const c of passing) {
    const sc = Number(c.score) || 0;
    if (sc > max) max = sc;
  }
  const tied = passing.filter((c) => (Number(c.score) || 0) === max);
  if (tied.length === 1) return { winner: tied[0], reason: 'score', tied };
  return { winner: null, reason: 'tie', tied };
}

/**
 * Live race bubble: stream the fastest still-alive entrant, swap once if the
 * winner is someone else. `onDelta(text, { replace, model })`.
 */
export function createRaceFeed(onDelta, onStatus, need) {
  let live = null;
  let settled = false;
  let back = 0;
  const buf = new Map();
  const dead = new Set();
  const paintStatus = () => { onStatus?.(formatRaceStatus(back, need)); };
  return {
    start() { paintStatus(); },
    liveModel() { return live; },
    onToken(model, chunk) {
      if (settled || chunk == null || chunk === '') return;
      buf.set(model, (buf.get(model) || '') + chunk);
      if (!live) {
        live = model;
        onDelta?.(chunk, { model });
        return;
      }
      if (live === model) onDelta?.(chunk, { model });
    },
    onFail(model) {
      dead.add(model);
      if (settled || live !== model) return;
      const next = [...buf.entries()].find(([m, t]) => m !== model && t && !dead.has(m));
      if (next) {
        live = next[0];
        onDelta?.(next[1], { replace: true, model: live });
      } else {
        live = null;
      }
    },
    onBack() {
      back += 1;
      paintStatus();
    },
    settle(winner) {
      settled = true;
      const text = String(winner?.text || '').trim()
        ? winner.text
        : RACE_EVERY_FAILED;
      // Live stream already showing this answer — keep going, do not re-dump.
      if (winner?.model && live === winner.model && !winner.error) return;
      live = winner?.model || live;
      onDelta?.(text, { replace: true, model: winner?.model });
    },
  };
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
