/** Coalesce live reads, retain unknowns, and never cache an empty balance for a minute. */
export function liveBalance(read, { ttlMs = 3000, now = Date.now } = {}) {
  let value = null, at = 0, inflight, generation = 0;
  return {
    reset() { generation++; value = null; at = 0; inflight = undefined; },
    get value() { return value; },
    get checkedAt() { return at || null; },
    async refresh(force = false) {
      if (inflight) return inflight;
      if (!force && at && now() - at < ttlMs) return value;
      const readGeneration = generation;
      inflight = Promise.resolve().then(read).then(next => {
        if (typeof next !== 'number' || !Number.isFinite(next) || next < 0) throw new Error('Balance unavailable');
        if (readGeneration !== generation) return value;
        value = next; at = now(); return value;
      }).catch(() => value).finally(() => { if (readGeneration === generation) inflight = null; });
      return inflight;
    },
  };
}
