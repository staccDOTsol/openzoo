import { config } from './config.js';
import { PayClient } from './pay.js';
import { parse402, pickAccept, tokenBalance } from './x402.js';

const DEMO_MODEL = process.env.OPENZOO_DEMO_MODEL || 'nvidia/nemotron-3.5-lightning';
const NEEDLE = 'The zebra vault code is 7-ALPHA-9243.';
const QUESTION = 'Somewhere in the document above there is a zebra vault code. What is it? Answer with just the code.';

/** ~4 chars/token synthetic prose, distinct per paragraph (the zoo dedupes identical chunks). */
function bigBody(targetTokens) {
  const targetChars = targetTokens * 4;
  const parts = [];
  let chars = 0;
  let i = 0;
  const needleAt = Math.floor(targetChars * 0.7);
  let planted = false;
  while (chars < targetChars) {
    const p = `Field report ${i}: sector ${i % 977} logged a routine survey at hour ${i % 24}. `
      + `Instrument ${((i * 7919) % 65536).toString(16)} recorded nominal telemetry; archivist note ${i * 31 % 10007} `
      + `filed under shelf ${i % 431}. Nothing unusual was observed during pass ${i}.`;
    parts.push(p);
    chars += p.length + 2;
    if (!planted && chars >= needleAt) { parts.push(NEEDLE); planted = true; }
    i += 1;
  }
  if (!planted) parts.push(NEEDLE);
  return parts.join('\n\n');
}

async function quoteFor(bodyObj) {
  const r = await fetch(`${config.apiBase}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  if (r.status !== 402) throw new Error(`expected 402 quote, got HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return parse402(await r.json());
}

export async function runDemo() {
  const client = new PayClient();
  const { keypair, connection } = client;
  const pub = client.address;

  const tokens = Number(process.env.OPENZOO_DEMO_TOKENS || 965000);
  console.log(`openzoo demo — model ${DEMO_MODEL}, ~${Math.round(tokens / 1000)}k-token body, one planted fact.`);
  console.log('');
  console.log('1) buying direct: a body this size does not run at all. OpenRouter returns:');
  console.log('   "The input token count exceeds the maximum number of tokens allowed."');
  console.log('   (recorded against the same model class, 2026-08-13 — benches.openzoo.fun)');
  console.log('');

  console.log('2) same body through the zoo — asking for the live x402 quote (the quote is free)...');
  const doc = bigBody(tokens);
  const bodyObj = {
    model: DEMO_MODEL,
    messages: [{ role: 'user', content: `${doc}\n\n${QUESTION}` }],
    max_tokens: 32,
    temperature: 0,
  };
  const quote = await quoteFor(bodyObj);
  const accept = pickAccept(quote, config.token);
  const x = accept.extra || {};
  console.log(`   quote: $${Number(x.billedUsd).toFixed(6)} ${x.symbol} · pricing=${x.pricing}`
    + (x.directUsd != null ? ` · direct would be $${Number(x.directUsd).toFixed(6)} · savesVsDirect=${Number(x.savesVsDirect).toFixed(1)}×` : ''));
  console.log('');

  // Decide what we can actually pay for under the demo cap.
  let payBody = bodyObj;
  let payAccept = accept;
  if (Number(x.billedUsd) > config.demoMaxUsd) {
    const fitTokens = Math.max(20000, Math.floor(tokens * (config.demoMaxUsd / Number(x.billedUsd)) * 0.8));
    console.log(`   (full-size quote is over the demo cap $${config.demoMaxUsd} — paying for a ${Math.round(fitTokens / 1000)}k-token slice instead;`);
    console.log('    set OPENZOO_DEMO_MAX_USD higher to pay for the whole thing)');
    const doc2 = bigBody(fitTokens);
    payBody = { ...bodyObj, messages: [{ role: 'user', content: `${doc2}\n\n${QUESTION}` }] };
    const q2 = await quoteFor(payBody);
    payAccept = pickAccept(q2, config.token);
  }

  const need = BigInt(payAccept.maxAmountRequired);
  const bal = await tokenBalance(connection, keypair.publicKey, payAccept.asset);
  if (bal.raw < need) {
    console.log('3) wallet not funded yet, so stopping before payment.');
    console.log(`   need : ${need} raw units of ${payAccept.extra?.symbol} (mint ${payAccept.asset}) ≈ $${Number(payAccept.extra?.billedUsd).toFixed(6)}`);
    console.log(`   have : ${bal.raw}`);
    console.log(`   fund : ${pub}`);
    console.log('   get yUSDCx by wrapping USDC: https://x402.accrue.fund/start — then re-run `npx openzoo demo`.');
    return;
  }

  console.log('3) paying and asking...');
  const t0 = Date.now();
  const { data, receipt } = await client.chat(payBody);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const answer = data?.choices?.[0]?.message?.content ?? '';
  const usage = data?.usage || {};
  console.log(`   answer (${secs}s): ${answer.trim()}`);
  console.log(`   verdict: ${answer.includes('9243') ? 'HIT — the planted fact came back' : 'MISS'}`);
  if (usage.gpu_tokens != null || usage.prompt_tokens != null) {
    console.log(`   tokens the model actually read: ${usage.gpu_tokens ?? usage.prompt_tokens}${usage.spill_tokens ? ` (spilled: ${usage.spill_tokens})` : ''}`);
  }
  if (receipt) console.log(`   ${receipt.line}`);
}
