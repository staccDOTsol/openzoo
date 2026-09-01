import { config, fundingLine } from './config.js';
import { PayClient, UnderfundedError } from './pay.js';
import { parse402, pickAccept, tokenBalance } from './x402.js';
import { startSpinner, postWithUploadSignal } from './spinner.js';
import { bindCorpus, askWithContext } from './hrr.js';
import { forgetContext } from './contexts.js';

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

async function quoteFor(bodyObj, headers = {}) {
  const body = JSON.stringify(bodyObj);
  const mb = (body.length / 1048576).toFixed(1);
  const approxTokens = Math.round(body.length / 4 / 1000);
  const big = body.length > 262144;
  const spin = startSpinner(big ? `uploading ${mb}MB body` : 'asking the zoo for a live quote');
  try {
    const r = await postWithUploadSignal(`${config.apiBase}/v1/chat/completions`, body, {
      headers,
      onUploaded: () => { if (big) spin.update(`zoo pricing ~${approxTokens}k tokens`); },
    });
    if (r.status !== 402) throw new Error(`expected 402 quote, got HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return parse402(await r.json());
  } finally {
    spin.stop();
  }
}

/**
 * Can the wallet cover this quote? The 402 names the raw mint the wallet
 * already holds, so this is one balance read — it used to also price the
 * wallet's plain token against a wrap pool, which no longer exists.
 */
async function coverage(connection, owner, accept) {
  const need = BigInt(accept.maxAmountRequired);
  const have = await tokenBalance(connection, owner, accept.asset);
  return { covered: have.raw >= need, usdcUi: have.ui ?? 0 };
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

  console.log('2) same body through the zoo — but the body never ships twice (0.3.0):');
  const doc = bigBody(tokens);
  const docMb = (Buffer.byteLength(doc) / 1048576).toFixed(1);
  const askBody = {
    model: DEMO_MODEL,
    messages: [{ role: 'user', content: QUESTION }],
    // Reasoning models burn budget on thinking before visible output — 32 was
    // returning empty content with finish_reason=length on nemotron.
    max_tokens: 512,
    temperature: 0,
  };

  const tRun = Date.now();
  let bindSpin = null;
  const bindStages = {
    onStage: (stage, info) => {
      if (stage === 'binding') bindSpin = startSpinner(`uploading + binding ${docMb}MB corpus (one-time)`);
      if (stage === 'bound-uploading-done') bindSpin?.update('zoo chunking + indexing the corpus');
    },
  };
  let bind = await bindCorpus(doc, bindStages);
  bindSpin?.stop();
  if (bind.reused) {
    console.log(`   ★ corpus already bound (context ${bind.contextId}) — skipped the ${docMb}MB upload entirely.`);
  } else {
    console.log(`   bound once in ${((Date.now() - tRun) / 1000).toFixed(1)}s: ${docMb}MB → context ${bind.contextId}.`);
    console.log('   re-run `npx openzoo demo` — this upload never happens again.');
  }

  let quote;
  try {
    quote = await quoteFor(askBody, { 'X-HRR-Context': bind.contextId });
  } catch (err) {
    // Sidecar wiped since we bound (stale manifest): 404 pre-402, nothing
    // paid. Never fail on it — re-bind once and re-quote.
    if (!/context_not_found/.test(err.message)) throw err;
    console.log('   bound context is gone on the zoo — re-binding once...');
    forgetContext(config.apiBase, bind.hash);
    bind = await bindCorpus(doc, { ...bindStages, force: true });
    bindSpin?.stop();
    console.log(`   re-bound: ${docMb}MB → context ${bind.contextId}.`);
    quote = await quoteFor(askBody, { 'X-HRR-Context': bind.contextId });
  }
  const accept = pickAccept(quote, config.token);
  const x = accept.extra || {};
  const saved = x.savedUsd != null ? Number(x.savedUsd)
    : (x.directUsd != null ? Math.max(0, Number(x.directUsd) - Number(x.billedUsd)) : 0);
  const saveBit = saved > 0 ? ` · $${saved.toFixed(6)} saved vs direct` : ' · at OpenRouter price';
  console.log(`   quote for the ask: $${Number(x.billedUsd).toFixed(6)} · pricing=${x.pricing}${saveBit} (the ${docMb}MB corpus is not re-priced)`);
  console.log('');

  if (Number(x.billedUsd) > config.demoMaxUsd) {
    console.log(`   quote is over the demo cap $${config.demoMaxUsd} — set OPENZOO_DEMO_MAX_USD higher to pay it.`);
    return;
  }

  const cov = await coverage(connection, keypair.publicKey, accept);
  if (!cov.covered) {
    console.log('3) wallet not funded yet, so stopping before payment.');
    console.log(`   quote : ≈ $${Number(x.billedUsd).toFixed(6)}`);
    console.log(`   wallet: ${cov.usdcUi ?? 0} ${accept.extra?.symbol || 'of the quoted asset'}`);
    console.log(`   fund  : ${fundingLine(pub)}`);
    console.log('   then re-run `npx openzoo demo`.');
    return;
  }

  console.log('3) paying and asking (the question rides alone — plus one header)...');
  const spin = startSpinner('sending the ask with X-HRR-Context');
  const t0 = Date.now();
  let out;
  try {
    out = await askWithContext(client, doc, askBody, {
      onStage: (stage) => {
        if (stage === 'reused') spin.update('reusing bound corpus');
        if (stage === 'rebinding') spin.update('context was wiped upstream — re-binding once');
        if (stage === 'binding') spin.update(`re-uploading ${docMb}MB corpus`);
        if (stage === 'quoted') spin.update('building the payment');
        if (stage === 'funding') spin.update('preparing funds (one-time)');
        if (stage === 'paying') spin.update('paying + waiting for the answer');
      },
    });
  } catch (err) {
    spin.stop();
    if (err instanceof UnderfundedError) { console.log(`   ${err.message}`); return; }
    throw err;
  }
  spin.stop();
  const { data, receipt } = out;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const totalSecs = ((Date.now() - tRun) / 1000).toFixed(1);
  const answer = data?.choices?.[0]?.message?.content ?? '';
  const usage = data?.usage || {};
  console.log(`   answer (${secs}s): ${answer.trim()}`);
  console.log(`   verdict: ${answer.includes('9243') ? 'HIT — the planted fact came back' : 'MISS'}`);
  if (usage.gpu_tokens != null || usage.prompt_tokens != null) {
    console.log(`   tokens the model actually read: ${usage.gpu_tokens ?? usage.prompt_tokens}${usage.spill_tokens ? ` (spilled: ${usage.spill_tokens})` : ''}`);
  }
  if (receipt) console.log(`   ${receipt.line}`);
  if (bind.reused) {
    const paidUsd = Number(receipt?.billedUsd);
    console.log('');
    console.log(`   ★ corpus already bound — skipped ${docMb}MB upload; whole run took ${totalSecs}s`
      + (Number.isFinite(paidUsd) ? ` and cost $${paidUsd.toFixed(6)}` : ''));
  }
}
