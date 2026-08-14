/**
 * Measure the pay path end-to-end, stage by stage, against the live zoo.
 *
 *   node scripts/paylatency.mjs [model] [repeats]
 *
 * Spends real dust from ~/.openzoo/wallet.json. Not published to npm
 * (package.json `files` ships bin + lib + README only) — this is a bench.
 *
 * Stages, wall-clock, in the order PayClient.fetch runs them:
 *   quote     POST without X-PAYMENT -> 402 (gateway prices the call)
 *   balance   getTokenAccountBalance for the quoted settlement mint
 *   build     getMintInfo (cached after first) + getLatestBlockhash + sign
 *   retry     POST with X-PAYMENT -> 200 (facilitator settles + model runs)
 *
 * Note what is NOT here: the shim never submits or confirms a Solana tx on the
 * pay path. It partial-signs and hands the tx to the facilitator inside the
 * retry. There is no confirm to cut.
 */
import { PayClient } from '../lib/pay.js';
import { config } from '../lib/config.js';
import { parse402, pickAccept, tokenBalance, railOf } from '../lib/x402.js';

const model = process.argv[2] || 'openai/gpt-4o-mini';
const repeats = Number(process.argv[3] || 3);
const url = `${config.apiBase}/v1/chat/completions`;
const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'what is 2+2?' }], max_tokens: 100 });
const ms = (a, b) => `${(b - a).toFixed(0)}ms`;

const client = new PayClient();

for (let i = 0; i < repeats; i++) {
  const t = [performance.now()];
  const mark = () => t.push(performance.now());

  const first = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  mark(); // 1: quote
  if (first.status !== 402) {
    console.log(`run ${i + 1}: unexpected HTTP ${first.status} (no 402 to pay)`);
    continue;
  }
  const accept = pickAccept(parse402(await first.json()), config.token, { allowRH: false });
  const bal = await tokenBalance(client.connection, client.keypair.publicKey, accept.asset);
  mark(); // 2: balance
  const short = BigInt(accept.maxAmountRequired) > bal.raw;
  const payment = await client.buildPaymentFor(accept);
  mark(); // 3: build+sign (includes a wrap top-up when short)
  const paid = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-PAYMENT': payment.header },
    body,
  });
  const text = await paid.text();
  mark(); // 4: retry (settle + inference)

  console.log(
    `run ${i + 1}  HTTP ${paid.status}  rail ${railOf(accept)}  $${accept.extra?.billedUsd}  `
    + `quote ${ms(t[0], t[1])}  balance ${ms(t[1], t[2])}  build+sign ${ms(t[2], t[3])}`
    + `${short ? ' (incl. wrap top-up)' : ''}  retry ${ms(t[3], t[4])}  TOTAL ${ms(t[0], t[4])}`,
  );
  if (!paid.ok) console.log(`   body: ${text.slice(0, 200)}`);
}
