// THE SAFETY PROPERTY: a gateway that refuses the atomic row must not break the
// call. Simulated by a fake fetch that 402s any payment for the contract payTo
// and accepts the plain one — the exact failure that would otherwise surface as
// "zoo returned HTTP 402" for every Base caller.
const CONTRACT = '0x87bf78e97ef643d890e2c6072f5e2d2d2876b1a3';
const row = (extra, payTo) => ({
  scheme: 'exact', network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  maxAmountRequired: '1500', payTo, resource: 'https://x/y', maxTimeoutSeconds: 900,
  extra: { name: 'USD Coin', version: '2', symbol: 'USDC', decimals: 6, billedUsd: 0.0015, ...extra },
});
const challenge = {
  x402Version: 1,
  accepts: [
    row({}, '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158'),
    row({ settlement: 'atomic', eip3009: 'ReceiveWithAuthorization', contract: CONTRACT }, CONTRACT),
  ],
};
let sawAtomic = false, sawPlain = false;
globalThis.fetch = async (url, init = {}) => {
  const pay = init.headers?.['X-PAYMENT'] || init.headers?.['x-payment'];
  if (!pay) return new Response(JSON.stringify(challenge), { status: 402, headers: { 'content-type': 'application/json' } });
  const env = JSON.parse(Buffer.from(pay, 'base64').toString('utf8'));
  const to = (env.payload?.authorization?.to || '').toLowerCase();
  if (to === CONTRACT) { sawAtomic = true; return new Response('{"error":"nope"}', { status: 402, headers: { 'content-type': 'application/json' } }); }
  sawPlain = true;
  return new Response(JSON.stringify({ choices: [{ message: { content: 'fell back' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
process.env.OPENZOO_RAIL = 'base';
const { PayClient } = await import('/Users/stacc/openzoo-shim/lib/pay.js');
const c = new PayClient();
const r = await c.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
console.log('tried atomic first :', sawAtomic);
console.log('fell back to plain :', sawPlain);
console.log('served             :', JSON.stringify(r?.choices?.[0]?.message?.content ?? r).slice(0, 80));
console.log(sawAtomic && sawPlain ? '\nPASS — a refused atomic row no longer kills the call' : '\nFAIL');
process.exit(sawAtomic && sawPlain ? 0 : 1);
