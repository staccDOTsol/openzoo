/**
 * Live turn status + stream idle timeout.
 *
 * A long x402 pay or a quiet SSE used to leave grokui on mute "…" dots.
 * Callers paint ONE mutating status line (paying / waiting on model / current
 * tool) and abort a reader that has gone silent.
 */

export const STREAM_IDLE_MS = Number(process.env.OZ_STREAM_IDLE_MS || 180_000);
export const STALE_THINKING_MS = Number(process.env.OZ_STALE_THINKING_MS || 240_000);
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
  const n = Math.max(1, Number(need) || 1);
  const b = Math.min(n, Math.max(0, Number(back) || 0));
  return `racing ${b}/${n} back…`;
}

/** OpenRouter id → short cell label. `z-ai/glm-4.7` → `glm-4.7`. */
export function shortModelName(id) {
  const s = String(id || '').trim();
  if (!s) return 'model';
  const parts = s.split('/');
  return parts[parts.length - 1] || s;
}

/** Compact spectator preview — opening lines, not the whole answer. */
export function clipRacePreview(text, maxLines = 8, maxChars = 420) {
  const s = String(text || '').replace(/\r/g, '');
  if (!s) return '';
  const lines = s.split('\n');
  let out = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') + '\n…' : s;
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`;
  return out;
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

/** Classify one failed arrival without naming a model. */
export function raceFailKind(arrival) {
  const err = String(arrival?.error || '');
  const text = String(arrival?.text || '').trim();
  const s = `${err} ${text}`.trim();
  if (!s) return 'empty body';
  if (/timeout|STREAM_IDLE|aborted|AbortError/i.test(s)) return 'timeout';
  if (/402|payment failed/i.test(s)) return 'pay';
  if (/fetch failed/i.test(s)) return 'fetch failed';
  const http = /HTTP\s+(\d{3})/i.exec(s);
  if (http) return `HTTP ${http[1]}`;
  if (err) return 'error';
  if (!isRaceCountable(arrival)) return 'empty body';
  return 'ok';
}

/** Counts of failure kinds across a race. Used for lastRaceFail on GET. */
export function summarizeRaceFailures(arrivals) {
  const counts = {};
  for (const a of Array.isArray(arrivals) ? arrivals : []) {
    const k = raceFailKind(a);
    if (k === 'ok') continue;
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

/**
 * Transient racer deaths — retry the same slot once.
 * Pay/402 will not get better. A real answer is done.
 */
export function shouldRetryRaceArrival(arrival) {
  if (isRaceCountable(arrival)) return false;
  const k = raceFailKind(arrival);
  return k === 'fetch failed' || k === 'timeout' || k === 'empty body'
    || k === 'error' || /^HTTP 5/.test(k) || k === 'HTTP 000';
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
 *
 * `onRace(snap)` is the spectator feed — one cell per launched model, with
 * waiting/streaming/back/failed/abandoned plus a truncated preview. Not a
 * second racer: `phase: 'judging'` is the classifier looking at the X that
 * already made it back.
 */
export function createRaceFeed(onDelta, onStatus, need, onRace) {
  let live = null;
  let settled = false;
  let back = 0;
  let phase = 'racing';
  let winnerModel = '';
  let recutNote = '';
  const buf = new Map();
  const dead = new Set();
  const order = [];
  const cells = new Map();
  const paintStatus = () => { onStatus?.(formatRaceStatus(back, need)); };
  const ensure = (model) => {
    const id = String(model || '').trim() || 'model';
    if (cells.has(id)) return cells.get(id);
    const row = { model: id, status: 'waiting', preview: '', fail: '' };
    cells.set(id, row);
    order.push(id);
    return row;
  };
  const freezeStragglers = () => {
    if (back < need) return;
    for (const row of cells.values()) {
      if (row.status === 'waiting' || row.status === 'streaming') row.status = 'abandoned';
    }
  };
  const snapshot = () => ({
    need,
    launched: order.length,
    back,
    phase,
    winner: winnerModel || '',
    recut: recutNote || '',
    racers: order.map((id) => {
      const row = cells.get(id);
      return {
        model: id,
        short: shortModelName(id),
        status: row.status,
        preview: row.status === 'failed' ? '' : clipRacePreview(row.preview),
        fail: row.fail || '',
      };
    }),
  });
  const emitRace = () => { onRace?.(snapshot()); };
  return {
    start(models, extra) {
      if (Array.isArray(models)) {
        for (const m of models) if (m) ensure(m);
      }
      if (extra && extra.recut) recutNote = String(extra.recut);
      paintStatus();
      emitRace();
    },
    snapshot,
    liveModel() { return live; },
    onToken(model, chunk) {
      if (settled || chunk == null || chunk === '') return;
      const row = ensure(model);
      if (row.status === 'abandoned' || row.status === 'failed' || row.status === 'back') return;
      buf.set(model, (buf.get(model) || '') + chunk);
      row.preview = buf.get(model) || '';
      if (row.status === 'waiting') row.status = 'streaming';
      emitRace();
      if (!live) {
        live = model;
        onDelta?.(chunk, { model });
        return;
      }
      if (live === model) onDelta?.(chunk, { model });
    },
    onFail(model, arrival) {
      dead.add(model);
      const row = ensure(model);
      if (row.status !== 'abandoned' && row.status !== 'back') {
        row.status = 'failed';
        row.fail = raceFailKind(arrival || { model, text: '', error: 'error' });
        row.preview = '';
        emitRace();
      }
      if (settled || live !== model) return;
      const next = [...buf.entries()].find(([m, t]) => m !== model && t && !dead.has(m));
      if (next) {
        live = next[0];
        onDelta?.(next[1], { replace: true, model: live });
      } else {
        live = null;
      }
    },
    onBack(model) {
      // Late countable stragglers after ship used to paint "racing 4/2 back…"
      // onto an already-idle thread (GET /threads/:id returns raw liveStatus).
      if (settled || back >= need) return;
      back += 1;
      let row = model ? ensure(model) : null;
      if (!row) {
        row = [...cells.values()].find((r) => r.status === 'streaming' || r.status === 'waiting');
      }
      if (row && row.status !== 'abandoned' && row.status !== 'failed') {
        row.status = 'back';
        if (buf.has(row.model)) row.preview = buf.get(row.model);
      }
      freezeStragglers();
      paintStatus();
      emitRace();
    },
    judge() {
      if (settled) return;
      phase = 'judging';
      freezeStragglers();
      emitRace();
    },
    settle(winner) {
      settled = true;
      phase = 'winner';
      const text = String(winner?.text || '').trim()
        ? winner.text
        : RACE_EVERY_FAILED;
      winnerModel = winner?.error ? '' : (winner?.model || '');
      if (winnerModel) {
        const row = ensure(winnerModel);
        if (row.status !== 'failed') {
          row.status = 'back';
          if (winner?.text) row.preview = String(winner.text);
        }
      }
      emitRace();
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
