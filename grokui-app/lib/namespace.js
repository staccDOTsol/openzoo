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

/**
 * PROVE the namespace claim instead of merely asserting it.
 *
 * The header above is derived from the PUBLIC key, so on its own it is not
 * authentication: anyone who knows this wallet's address can recompute the
 * same value and land in the same sidecar tenant — and since the sidecar gates
 * context access purely on tenant match, that is the whole door. The gateway
 * (nsauth.ts) verifies a signature over `openzoo-namespace:<ns>:<ts>` and
 * derives the tenant from sha256(chain:signer:namespace), which binds the
 * PROVEN signer in, so another wallet signing an identical label lands
 * somewhere else.
 *
 * Signed with the same Solana key x402 already pays from — no new secret, and
 * nothing leaves the machine but a public key and a signature. The timestamp
 * is what bounds replay (the gateway enforces its own window), so it is minted
 * per call and these headers are deliberately NOT cached.
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function signNamespace(namespace) {
  const w = loadOrCreateWallet();
  const timestamp = String(Date.now());
  // Node has no raw-ed25519 signer, but it will build one from a PKCS8 DER
  // wrapper around the 32-byte seed (a Solana secretKey is seed||pubkey).
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(w.keypair.secretKey.slice(0, 32))]);
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const sig = crypto.sign(null, Buffer.from(`openzoo-namespace:${namespace}:${timestamp}`), key);
  return {
    'x-openzoo-namespace-sig': base58encode(sig),
    'x-openzoo-namespace-signer': w.keypair.publicKey.toBase58(),
    'x-openzoo-namespace-ts': timestamp,
    'x-openzoo-namespace-chain': 'solana',
  };
}

/** Merge the namespace header — and its proof — into any headers object. */
export function withNamespace(headers = {}) {
  const ns = namespaceHeaderValue();
  if (!ns) return headers;
  let proof = {};
  try {
    proof = signNamespace(ns);
  } catch {
    // Unsigned still works while the gateway is in soft launch. Sending the
    // bare namespace is strictly better than sending nothing: it keeps the
    // caller in their existing tenant instead of silently relocating every
    // bound corpus to the shared one.
  }
  return { ...headers, 'x-openzoo-namespace': ns, ...proof };
}

// Bitcoin-alphabet base58, matching what the gateway's bs58 decode expects.
// Local rather than a dependency for the same reason lib/x402.js keeps its own.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const b of bytes) { if (b === 0) out += '1'; else break; } // leading zeros
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
