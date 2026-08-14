#!/usr/bin/env node
const cmd = process.argv[2] || 'proxy';

const HELP = `openzoo — local x402-paying proxy + MCP server for openzoo.fun

usage:
  npx openzoo            start the proxy on http://localhost:8402/v1
  npx openzoo mcp        stdio MCP server (tools: zoo_ask, zoo_models, zoo_wallet)
  npx openzoo demo       ~1M-token needle demo: direct refuses, the zoo answers
                         (run it twice — the second run reuses the bound corpus and is near-free)
  npx openzoo contexts   list corpora bound to the zoo (never re-uploaded)
  npx openzoo contexts --forget <hash|all>   drop manifest entries
  npx openzoo balance    wallet balance (USDC + SOL, with USD value)
  npx openzoo address    print the funding address
  npx openzoo help       this text

point any OpenAI-compatible harness at:
  base_url = http://localhost:8402/v1
  api_key  = sk-openzoo   (any value; the zoo takes payment, not keys)

env:
  OPENZOO_PORT (8402)  OPENZOO_API_BASE (https://x402-tokens.fly.dev)
  OPENZOO_RPC (mainnet-beta)  OPENZOO_TOKEN (402 rail preference)  OPENZOO_WALLET (~/.openzoo/wallet.json)
  OPENZOO_MAX_USD_PER_CALL (0.5)  OPENZOO_DEMO_MAX_USD (0.01)
  OPENZOO_CONTEXT_MIN_CHARS (16384 — bodies bigger than this bind once + reuse)
  OPENZOO_NO_CONTEXT_CACHE (0 — set 1 to always ship the full body)
  OPENZOO_ENABLE_RH (0 — Robinhood Chain rail, experimental)`;

async function main() {
  switch (cmd) {
    case 'proxy':
    case 'start':
      await (await import('../lib/proxy.js')).startProxy();
      break;
    case 'mcp':
      await (await import('../lib/mcp.js')).startMcp();
      break;
    case 'demo':
      await (await import('../lib/demo.js')).runDemo();
      break;
    case 'contexts': {
      const { listContexts, forgetContexts } = await import('../lib/contexts.js');
      const fi = process.argv.indexOf('--forget');
      if (fi !== -1) {
        const sel = process.argv[fi + 1];
        if (!sel) throw new Error('usage: openzoo contexts --forget <hash-prefix|all>');
        console.log(`forgot ${forgetContexts(sel)} context(s)`);
        break;
      }
      const all = listContexts();
      if (!all.length) {
        console.log('no bound corpora yet — run `npx openzoo demo` or ask with a big body.');
        break;
      }
      const age = (iso) => {
        const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
        return s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`;
      };
      for (const c of all) {
        console.log(`${c.hash.slice(0, 12)}  ${c.context_id}  bound ${age(c.boundAt)} ago  ${c.apiBase}`);
      }
      console.log('\nthese corpora never ship again — asks against them send only the question + X-HRR-Context.');
      break;
    }
    case 'balance':
      await (await import('../lib/info.js')).printBalance();
      break;
    case 'address':
      (await import('../lib/info.js')).printAddress();
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`openzoo: ${err.message}`);
  process.exit(1);
});
