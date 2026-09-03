#!/usr/bin/env node
/**
 * Fire N paid calls over the BASE rail, to prove the CDP settle path and get
 * the resource indexed in Coinbase's x402 Bazaar.
 *
 * WHY BASE SPECIFICALLY. The CDP facilitator only settles Base for third
 * parties, and the sampled-CDP gate in x402.ts is scoped to eip155:8453. Our
 * live payers are all Solana, so the CDP path had never once fired since the
 * JWT fix — this is the deliberate trigger.
 *
 * EIP-3009 MEANS THE PAYER NEEDS NO ETH. The facilitator relays and pays gas;
 * the payer only signs an authorization. So the wallet needs USDC on Base and
 * nothing else.
 *
 *   OPENZOO_KEY=~/staccoverflow.eth node scripts/fire-base.mjs 100
 *   OPENZOO_KEY=... node scripts/fire-base.mjs 100 --dry   # quote only, no spend
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import { PayClient } from '../lib/pay.js';

const N = Number(process.argv.find((a) => /^\d+$/.test(a)) || 10);
const DRY = process.argv.includes('--dry');
const BASE = process.env.OPENZOO_API_BASE || 'https://x402-tokens.fly.dev';
const URL = `${BASE}/v1/chat/completions`;

const keyPath = (process.env.OPENZOO_KEY || `${homedir()}/staccoverflow.eth`).replace(/^~/, homedir());
let raw = readFileSync(keyPath, 'utf8').trim();
if (!raw.startsWith('0x')) raw = `0x${raw}`;
const account = privateKeyToAccount(raw);

// PayClient wants both rails on the wallet object. Solana is never used here
// (OPENZOO_RAIL pins Base), but a throwaway keypair keeps the constructor from
// falling back to the machine wallet — see the note in its header.
process.env.OPENZOO_RAIL = 'base';
const client = new PayClient({ keypair: Keypair.generate(), evmPrivateKey: raw });

console.log(`payer   ${account.address}`);
console.log(`target  ${URL}`);
console.log(`rail    eip155:8453 (Base) · CDP-sampled settle`);
console.log(`plan    ${N} call${N === 1 ? '' : 's'}${DRY ? ' (DRY — quote only, nothing spent)' : ''}\n`);

const body = (i) => JSON.stringify({
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user', content: `ping ${i}` }],
  max_tokens: 16,
});

if (DRY) {
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(0) });
  const q = await r.json();
  const rows = (q.accepts || []).filter((a) => a.network === 'eip155:8453');
  console.log(`402 returned ${q.accepts?.length ?? 0} rows, ${rows.length} on Base:`);
  for (const a of rows) {
    console.log(`  ${a.extra?.symbol} ${a.maxAmountRequired} raw · billed $${a.extra?.billedUsd} · direct $${a.extra?.directUsd} · payTo ${a.payTo}`);
  }
  const need = Number(rows[0]?.extra?.billedUsd || 0) * N;
  console.log(`\nestimated spend for ${N} calls: $${need.toFixed(4)} USDC`);
  process.exit(0);
}

let ok = 0, fail = 0, spent = 0;
for (let i = 0; i < N; i++) {
  try {
    const res = await client.fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body(i),
    });
    if (res.status === 200) {
      ok += 1;
      const r = client.lastReceipt;
      if (r?.usd) spent += Number(r.usd) || 0;
      console.log(`${String(i + 1).padStart(3)}  200  ${r?.tx ? `tx ${String(r.tx).slice(0, 16)}…` : 'settled'}`);
    } else {
      fail += 1;
      console.log(`${String(i + 1).padStart(3)}  ${res.status}  ${(await res.text()).slice(0, 120)}`);
    }
  } catch (e) {
    fail += 1;
    console.log(`${String(i + 1).padStart(3)}  ERR  ${e.message.slice(0, 140)}`);
  }
}
console.log(`\n${ok} paid · ${fail} failed · ~$${spent.toFixed(4)} spent`);
console.log('now check:  fly logs -a x402-tokens | grep settled_via_cdp');
