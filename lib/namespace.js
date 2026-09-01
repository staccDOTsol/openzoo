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
 * ALWAYS ON. There is no flag.
 *
 * It used to be opt-in and off, because a header the client merely ASSERTED
 * was the wrong mechanism: the surfaces disagree in practice (the MCP server,
 * the CLI and the proxy are separate processes upgraded at different times,
 * and npx happily serves a stale cached build), so a corpus bound by a
 * namespaced `zoo_bind` went invisible to a chat sent through an older proxy —
 * the context vanished, spill binds 400'd, and the gateway fell open and
 * forwarded the whole body at full price. MEASURED twice in one session.
 *
 * That objection was about an UNVERIFIED claim and no longer holds: the value
 * is signed (see signNamespace) and the gateway REQUIRES the signature,
 * deriving the tenant from the proven signer. A flag was worse than useless
 * here — off meant every caller shared one tenant, where a context is
 * protected only by its id being unguessable and anyone may write into the
 * same space, and a flag that is sometimes off is exactly the version skew
 * that made contexts vanish. One behaviour, every surface, always.
 *
 * BREAKING: corpora bound before this lived in the shared tenant and are not
 * reachable from a signed request. Re-bind them.
 */
/**
 * ONE NAMESPACE ACROSS EVERY STACC APP (2026-08-18).
 *
 * This used to be sha256("openzoo-ns:" + pubkey) — stable, per-user, and
 * DIFFERENT from what every other stacc app sent. openzoo brain sent
 * HMAC(OPENZOO_TENANT_SECRET, pubkey); the open-webui wallet sent a literal
 * app name. Since the gateway keys a tenant on sha256(chain:signer:namespace),
 * one wallet therefore landed in THREE tenants: three separate leCore
 * memories and three separate credit balances, for the same person. Bind a
 * corpus in the CLI and it was invisible from the browser.
 *
 * The constant is safe because the reason for the per-user hash is gone. It
 * existed to stop someone addressing your tenant by guessing your namespace —
 * but the gateway now folds the VERIFIED SIGNER into the tenant hash (see
 * nsauth.ts / tenantFor), so the namespace string is no longer the
 * access-control boundary. Signing is what proves ownership; this string only
 * chooses WHICH of your namespaces you mean.
 *
 * A constant is in fact MORE private than what it replaces. A per-user hash is
 * stable and unique, i.e. a tracking identifier that correlates one user's
 * requests across time. A value every caller sends identically discloses
 * nothing at all.
 *
 * BREAKING: corpora bound under the old per-wallet namespace live in a
 * different tenant and will not be found. The gateway's tenantsToTry fallback
 * reaches pre-existing context ids by id, but anything relying on the old
 * namespace should be re-bound.
 */
export const STACC_NAMESPACE = 'stacc';

export function namespaceHeaderValue(wallet) {
  try {
    // Still require a wallet: the namespace is meaningless without a signer to
    // prove it, and sending one unsigned drops you into the SHARED tenant.
    if (!wallet?.keypair) loadOrCreateWallet();
    return STACC_NAMESPACE;
  } catch {
    return ''; // no wallet (read-only use): fall back to the shared tenant
  }
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

function signNamespace(namespace, wallet) {
  // SIGN WITH THE WALLET THAT IS PAYING, not with whatever this machine owns.
  // The gateway derives the tenant from the PROVEN signer, and credit is held
  // per tenant — so signing every burner's request with the operator's machine
  // key put all of them in the operator's tenant and let them spend the
  // operator's gateway credit. MEASURED: an empty burner got `paid: "credit"`
  // and a 200, with no 402 ever issued.
  const w = wallet?.keypair ? wallet : loadOrCreateWallet();
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
export function withNamespace(headers = {}, wallet) {
  const ns = namespaceHeaderValue(wallet);
  if (!ns) return headers;
  // No unsigned fallback. The gateway REQUIRES the signature, so a bare
  // namespace buys nothing — it would just be silently demoted to the shared
  // tenant, which looks like "my corpus vanished" instead of a clear failure.
  return { ...headers, 'x-openzoo-namespace': ns, ...signNamespace(ns, wallet) };
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
