/** Coalesce live reads, retain unknowns, and never cache an empty balance for a minute. */
export function liveBalance(read, { ttlMs = 3000, now = Date.now } = {}) {
  let value = null, at = 0, inflight;
  return {
    get value() { return value; },
    get checkedAt() { return at || null; },
    async refresh(force = false) {
      if (inflight) return inflight;
      if (!force && at && now() - at < ttlMs) return value;
      inflight = Promise.resolve().then(read).then(next => {
        if (typeof next !== 'number' || !Number.isFinite(next) || next < 0) throw new Error('Balance unavailable');
        value = next; at = now(); return value;
      }).catch(() => value).finally(() => { inflight = null; });
      return inflight;
    },
  };
}
