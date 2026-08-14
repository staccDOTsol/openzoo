#!/usr/bin/env node
const cmd = process.argv[2] || 'proxy';

const HELP = `openzoo — local x402-paying proxy + MCP server for openzoo.fun

usage:
  npx openzoo            start the proxy on http://localhost:8402/v1
  npx openzoo mcp        stdio MCP server (tools: zoo_ask, zoo_models, zoo_wallet)
  npx openzoo demo       ~1M-token needle demo: direct refuses, the zoo answers
  npx openzoo balance    wallet balances (yUSDCx / wTOKENx)
  npx openzoo address    print the funding address
  npx openzoo help       this text

point any OpenAI-compatible harness at:
  base_url = http://localhost:8402/v1
  api_key  = sk-openzoo   (any value; the zoo takes payment, not keys)

env:
  OPENZOO_PORT (8402)  OPENZOO_API_BASE (https://x402-tokens.fly.dev)
  OPENZOO_RPC (mainnet-beta)  OPENZOO_TOKEN (yUSDCx)  OPENZOO_WALLET (~/.openzoo/wallet.json)
  OPENZOO_MAX_USD_PER_CALL (0.5)  OPENZOO_DEMO_MAX_USD (0.01)
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
