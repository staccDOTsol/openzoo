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
 *
 * OPT-IN (OPENZOO_NAMESPACE=1), and off by default, deliberately.
 *
 * Isolation is only sound if EVERY surface agrees on the namespace. In
 * practice they do not: the MCP server, the CLI and the proxy are separate
 * processes that a user upgrades at different times (npx happily serves a
 * stale cached build), so a corpus bound by a namespaced `zoo_bind` became
 * invisible to a chat sent through an older proxy — the context vanished,
 * every spill bind returned 400, and the gateway fell open and forwarded the
 * whole body at full price. MEASURED twice in one session, in both directions.
 *
 * A header the client controls was the wrong mechanism: real isolation should
 * key off the settling payer, which the gateway already knows and cannot get
 * out of sync. Until that exists, defaulting off restores the behaviour that
 * always worked, and the gateway's fallback keeps namespaced contexts
 * reachable for anyone who opts in.
 */
let cached = null;

export function namespaceHeaderValue() {
  if (process.env.OPENZOO_NAMESPACE !== '1') return '';
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
