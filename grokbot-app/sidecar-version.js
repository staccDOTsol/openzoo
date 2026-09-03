'use strict';

function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function sidecarIsAttachable({ listenerVersion, expectedVersion } = {}) {
  const cmp = cmpSemver(listenerVersion, expectedVersion);
  return cmp !== null && cmp >= 0;
}

module.exports = { parseSemver, cmpSemver, sidecarIsAttachable };
