/**
 * Spend-footer proof lines: explorer URL for the settle signature, decoded
 * payment memo, one layman sentence of what that memo proves.
 *
 * The settle id is receipt.tx (facilitator transaction / txHash / signature).
 * Never the SVM ownerSignature — that id is not on chain.
 */

const SOLSCAN = 'https://solscan.io/tx/';
const BASESCAN = 'https://basescan.org/tx/';

export function isRealTx(tx) {
  if (typeof tx !== 'string') return false;
  const s = tx.trim();
  if (!s) return false;
  if (s === 'null' || s === 'undefined' || s === '0' || s === '0x') return false;
  return true;
}

export function collectTxs(src = {}) {
  const out = [];
  const seen = new Set();
  const add = (t) => {
    if (!isRealTx(t)) return;
    const s = String(t).trim();
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  add(src.tx);
  if (Array.isArray(src.txs)) src.txs.forEach(add);
  return out;
}

function railName(rail, network) {
  const r = String(rail || '').toLowerCase();
  const net = String(network || '').toLowerCase();
  if (r === 'base' || r === 'base-sepolia' || net === 'base' || net === 'base-sepolia'
      || net.startsWith('eip155:8453') || /\bbase\b/.test(net)) return 'base';
  if (r === 'solana' || net.startsWith('solana:') || net === 'solana') return 'solana';
  if (r === 'robinhood' || net.includes('4663') || net.includes('robinhood')) return 'robinhood';
  if (r === 'evm') return 'evm';
  return r || '';
}

/** Explorer URL for a real settle signature. Null if missing or rail unknown-and-ambiguous. */
export function explorerUrl(tx, { rail, network } = {}) {
  try {
    if (!isRealTx(tx)) return null;
    const sig = String(tx).trim();
    const r = railName(rail, network);
    if (r === 'base') return BASESCAN + sig;
    if (r === 'solana') return SOLSCAN + sig;
    if (r === 'robinhood' || r === 'evm') return null;
    if (/^0x[0-9a-fA-F]{64}$/.test(sig)) return null;
    if (!sig.startsWith('0x') && sig.length >= 32 && sig.length <= 128) return SOLSCAN + sig;
    return null;
  } catch {
    return null;
  }
}

function shortId(s, keep = 12) {
  const t = String(s || '');
  if (t.length <= keep * 2 + 1) return t;
  return `${t.slice(0, keep)}…${t.slice(-keep)}`;
}

function parseOfferSet(raw) {
  const s = String(raw || '').trim();
  if (!/^x402:/i.test(s)) return null;
  const parts = s.slice(s.indexOf(':') + 1).split('/');
  if (parts.length < 6) return null;
  const [v, scheme, network, payTo, asset, amount] = parts;
  const tail = parts.slice(6);
  let resource = '';
  let timeout = '';
  let quote = '';
  if (tail.length >= 2 && /^\d+$/.test(tail[tail.length - 2])) {
    quote = tail[tail.length - 1];
    timeout = tail[tail.length - 2];
    resource = tail.slice(0, -2).join('/');
  } else if (tail.length) {
    resource = tail.join('/');
  }
  return { v, scheme, network, payTo, asset, amount, resource, timeout, quote };
}

function isMerkleJson(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const leaf = obj.leaf || obj.merkleLeaf || obj.merkle_leaf;
  const proof = obj.proof || obj.merkleProof || obj.merkle_proof;
  const root = obj.root || obj.merkleRoot || obj.merkle_root;
  if (leaf && (Array.isArray(proof) || root)) return true;
  if (String(obj.kind || '').toLowerCase() === 'merkle' && leaf) return true;
  return false;
}

const LABELED_LEAF = /^(?:leaf|merkle[-_]?leaf)[:\s=]+(?:0x)?([0-9a-f]{64})$/i;

function jsonMeaningful(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null) continue;
    if (typeof v === 'string' && v.length > 120) out[k] = `${v.slice(0, 48)}…`;
    else if (Array.isArray(v)) out[k] = v.length > 8 ? `[${v.length}]` : v;
    else if (typeof v === 'object') out[k] = Object.keys(v).length > 12 ? '{…}' : v;
    else out[k] = v;
  }
  try { return JSON.stringify(out); } catch { return String(obj); }
}

/**
 * Decode a payment memo. Never claims a merkle membership proof unless the
 * bytes actually encode a leaf/proof/root (JSON) or a labeled 32-byte leaf.
 */
export function decodeMemo(memo) {
  try {
    if (memo == null) return { kind: 'empty', decoded: null, proves: null };
    const raw = Buffer.isBuffer(memo) ? memo.toString('utf8') : String(memo);
    const trimmed = raw.trim();
    if (!trimmed) return { kind: 'empty', decoded: null, proves: null };

    if ((trimmed.startsWith('{') && trimmed.endsWith('}'))
        || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const obj = JSON.parse(trimmed);
        if (isMerkleJson(obj)) {
          const leaf = obj.leaf || obj.merkleLeaf || obj.merkle_leaf;
          return {
            kind: 'merkle',
            decoded: jsonMeaningful(obj),
            proves: `This hash (${shortId(leaf)}) is the leaf of a merkle tree; publishing it in the memo binds this payment to that leaf so anyone with the tree can verify inclusion.`,
          };
        }
        return {
          kind: 'json',
          decoded: jsonMeaningful(obj),
          proves: 'The payment memo is this JSON; it records what the payer attached, not a merkle membership proof unless a leaf/proof/root is present.',
        };
      } catch { /* not JSON */ }
    }

    const offer = parseOfferSet(trimmed);
    if (offer) {
      const who = offer.payTo || 'the listed payTo';
      const asset = offer.asset || 'the listed asset';
      const amt = offer.amount || '?';
      const res = offer.resource || 'the listed resource';
      const net = offer.network || 'the listed network';
      return {
        kind: 'offer_set',
        decoded: `paid ${amt} of ${shortId(asset)} to ${shortId(who)} for ${res} on ${net}`
          + (offer.scheme ? ` (${offer.scheme})` : ''),
        proves: `This memo is the x402 offer: ${amt} units of asset ${asset} were paid to ${who} for ${res} on ${net}. Anyone can check it against the mint's on-chain offer; a server 402 that disagrees is lying.`,
      };
    }

    const labeled = LABELED_LEAF.exec(trimmed);
    if (labeled) {
      const leaf = labeled[1];
      return {
        kind: 'merkle',
        decoded: `merkle leaf ${leaf}`,
        proves: `This hash is the leaf of a merkle tree; publishing it in the memo binds this payment to that leaf so anyone with the tree can verify inclusion.`,
      };
    }

    const hex = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
    if (/^[0-9a-fA-F]{32}$/.test(hex) && !/\s/.test(trimmed)) {
      return {
        kind: 'nonce',
        decoded: `uniqueness nonce ${hex.toLowerCase()}`,
        proves: 'This is a uniqueness nonce so two identical payments in the same blockhash window are distinct transactions — it is not a secret and not a merkle membership proof.',
      };
    }

    if (/^[0-9a-fA-F]{64}$/.test(hex) && !/\s/.test(trimmed)) {
      const leaf = hex.toLowerCase();
      return {
        kind: 'leaf',
        decoded: `x402 leaf ${leaf}`,
        proves: `x402-tokens Solana work-commitment: sha256(JSON.stringify([v, model, promptHash, gross, asset, resource])). Same Memo instruction as the token transfer; binds the payment to that quoted deal (model, prompt hash, price, mint, endpoint). The completion is not in the preimage — it did not exist at quote time. Not a merkle-tree membership proof. Preimage: https://x402-tokens.fly.dev/v1/receipts/proof?leaf=${leaf}`,
      };
    }

    if (/^[\x20-\x7e\u00a0-\uffff]+$/.test(trimmed)) {
      return {
        kind: 'utf8',
        decoded: trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed,
        proves: 'The payment memo is this UTF-8 string; it was not an x402 offer-set record or a structured proof.',
      };
    }

    return {
      kind: 'unknown',
      decoded: `undecodable (${Buffer.byteLength(raw)} bytes)`,
      proves: 'The memo could not be decoded; it is not claimed as a merkle proof.',
    };
  } catch {
    return {
      kind: 'unknown',
      decoded: 'undecodable',
      proves: 'The memo could not be decoded; it is not claimed as a merkle proof.',
    };
  }
}

/** Copy settle tx / memo / rail onto the JSON body's x402 object (mutates). */
export function attachX402Proof(data, proof = {}) {
  try {
    if (!data || typeof data !== 'object') return data;
    if (!data.x402 || typeof data.x402 !== 'object') data.x402 = {};
    const x = data.x402;
    const txs = collectTxs({ tx: proof.tx ?? x.tx, txs: [...(Array.isArray(x.txs) ? x.txs : []), ...(Array.isArray(proof.txs) ? proof.txs : [])] });
    if (txs.length) {
      x.tx = txs[txs.length - 1];
      x.txs = txs;
    }
    const memo = proof.memo;
    if (typeof memo === 'string' && memo.length) x.memo = memo;
    if (proof.rail) x.rail = proof.rail;
    return data;
  } catch {
    return data;
  }
}

/** Merge x402 proof fields across the several paid calls of one Grok Bot turn. */
export function mergeTurnProof(prev, data) {
  try {
    const incoming = (data && typeof data === 'object' && data.x402 && typeof data.x402 === 'object')
      ? data.x402
      : {};
    const base = prev && typeof prev === 'object' ? prev : {};
    const txs = collectTxs({
      tx: incoming.tx || base.tx,
      txs: [...(Array.isArray(base.txs) ? base.txs : []), ...(Array.isArray(incoming.txs) ? incoming.txs : [])],
    });
    const out = { ...base, ...incoming };
    if (txs.length) {
      out.tx = txs[txs.length - 1];
      out.txs = txs;
    }
    if (!out.memo && base.memo) out.memo = base.memo;
    if (!out.rail && base.rail) out.rail = base.rail;
    return out;
  } catch {
    return (data && data.x402) || prev || {};
  }
}

function chipUsd(n) {
  const x = Number(n) || 0;
  if (Math.abs(x) >= 0.01) return `$${x.toFixed(2)}`;
  return `$${x.toFixed(4)}`;
}

function chipMult(would, spent) {
  if (!(spent > 0) || !(would > 0)) return null;
  const m = would / spent;
  if (!Number.isFinite(m) || m < 1) return null;
  if (m >= 100) return `${Math.round(m)}×`;
  if (m >= 10) return `${m.toFixed(1)}×`;
  return `${m.toFixed(2)}×`;
}

/** Collapsed chip: spent · saved $ · saved % / multiplier. Visible before click. */
export function spendChipLabel({
  billedUsd,
  directUsd,
  spent = 0,
  would = 0,
  saved = 0,
  pct = 0,
} = {}) {
  let spentN = Number(spent);
  let wouldN = Number(would);
  let savedN = Number(saved);
  if (!(spentN > 0.00005) && Number(billedUsd) > 0.00005) {
    spentN = Number(billedUsd);
    wouldN = Number(directUsd) > 0 ? Number(directUsd) : wouldN;
    savedN = Math.max(0, wouldN - spentN);
  }
  if (!(savedN > 0) && wouldN > spentN) savedN = wouldN - spentN;
  let pctN = Number(pct);
  if (wouldN > 0) pctN = 100 * Math.max(0, savedN) / wouldN;
  const bits = [chipUsd(spentN), `saved ${chipUsd(savedN)}`];
  const sav = [];
  if (Number.isFinite(pctN)) sav.push(`${Math.round(pctN)}%`);
  const mult = chipMult(wouldN, spentN);
  if (mult) sav.push(mult);
  if (sav.length) bits.push(sav.join('/'));
  return bits.join(' · ');
}

/**
 * Two leading newlines, then the existing spend lines, then optional
 * tx / memo / proves. Never throws. Collapsed chip reads the ::oz-spend:: line.
 */
export function formatSpendFooter({
  billedUsd,
  directUsd,
  spent = 0,
  would = 0,
  saved = 0,
  pct = 0,
  balance = null,
  x402 = {},
  tx,
  txs,
  memo,
  rail,
  network,
} = {}) {
  try {
    const lines = ['', ''];
    const x = (x402 && typeof x402 === 'object') ? x402 : {};
    if (billedUsd != null && Number.isFinite(Number(billedUsd))) {
      lines.push(`this call $${Number(billedUsd).toFixed(6)} · OpenRouter $${Number(directUsd || 0).toFixed(6)}`);
    }
    const spentN = Number.isFinite(Number(spent)) ? Number(spent) : 0;
    const wouldN = Number.isFinite(Number(would)) ? Number(would) : 0;
    const savedN = Number.isFinite(Number(saved)) ? Number(saved) : 0;
    const pctN = Number.isFinite(Number(pct)) ? Number(pct) : 0;
    const bal = balance != null && Number.isFinite(Number(balance)) ? Number(balance) : null;
    const balTxt = bal != null && bal > 0.004 ? ` · balance $${bal.toFixed(2)}` : '';
    lines.push(`spent $${spentN.toFixed(4)}${balTxt} · OpenRouter would $${wouldN.toFixed(4)} · saved $${savedN.toFixed(4)} (${pctN.toFixed(0)}%)`);

    const sigs = collectTxs({ tx: tx ?? x.tx, txs: txs ?? x.txs });
    const r = rail || x.rail;
    const net = network || x.network;
    const last = sigs[sigs.length - 1];
    if (last) {
      const url = explorerUrl(last, { rail: r, network: net });
      if (url) {
        lines.push(sigs.length > 1 ? `tx ${url}  (+${sigs.length - 1} earlier)` : `tx ${url}`);
      }
    }
    const mem = memo ?? x.memo;
    if (mem != null && String(mem).length) {
      const d = decodeMemo(mem);
      if (d.decoded) lines.push(`memo ${d.decoded}`);
      if (d.proves) lines.push(`proves ${d.proves}`);
    }
    const body = lines.filter((l) => l !== '').join('\n');
    const tag = spendChipLabel({
      billedUsd, directUsd, spent: spentN, would: wouldN, saved: savedN, pct: pctN,
    });
    return `\n\n::oz-spend::${tag}\n${body}`;
  } catch {
    return '\n\n';
  }
}
