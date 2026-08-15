import crypto from 'node:crypto';
import { loadOrCreateWallet } from './wallet.js';

/**
 * The namespace that isolates THIS wallet's bound corpora from everyone
 * else's on the shared sidecar.
 *
 * Contexts used to live in one global tenant, so a context was protected only
 * by its id being unguessable — and the bind endpoint is free and open, so
 * anyone could write into that same space. The gateway now hashes this header
 * into the sidecar tenant id, which means a leaked context id is useless to a
 * different wallet.
 *
 * Derived from the PUBLIC key, never the secret: it must be stable across
 * restarts and reveal nothing. It is hashed again server-side, so the value on
 * the wire is not the address either.
 */
let cached = null;

export function namespaceHeaderValue() {
  if (cached) return cached;
  try {
    const w = loadOrCreateWallet();
    cached = crypto.createHash('sha256')
      .update(`openzoo-ns:${w.keypair.publicKey.toBase58()}`)
      .digest('hex');
  } catch {
    cached = ''; // no wallet (read-only use): fall back to the shared tenant
  }
  return cached;
}

/** Merge the namespace header into any headers object. */
export function withNamespace(headers = {}) {
  const ns = namespaceHeaderValue();
  return ns ? { ...headers, 'x-openzoo-namespace': ns } : headers;
}
