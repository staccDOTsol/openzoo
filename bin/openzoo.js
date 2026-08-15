#!/usr/bin/env node
const cmd = process.argv[2] || 'proxy';

const HELP = `openzoo — local x402-paying proxy + MCP server for openzoo.fun

usage:
  npx openzoo            start the proxy: http://localhost:8402/v1 (keyless) PLUS a
                         public HTTPS url for cloud IDEs (key required, printed at start)
  npx openzoo launch <cmd> [args]   launch a Messages API-compatible client
                                    (needs the proxy running)
  npx openzoo mcp        stdio MCP server (tools: zoo_ask, zoo_bind, zoo_models, zoo_wallet, zoo_contexts)
  npx openzoo tunnel     public-url-only mode (everything key-gated, no keyless localhost)
  npx openzoo demo       ~1M-token needle demo: direct refuses, the zoo answers
                         (run it twice — the second run reuses the bound corpus and is near-free)
  npx openzoo contexts   list corpora bound to the zoo (never re-uploaded)
  npx openzoo contexts --forget <hash|all>   drop manifest entries
  npx openzoo balance    wallet balance on every rail — Solana (USDC/TOKEN/SOL),
                         Base (USDC/ETH), Robinhood Chain (USDG/memecoins/ETH)
  npx openzoo address    print both funding addresses (Solana + EVM)
  npx openzoo help       this text

point any OpenAI-compatible harness at:
  base_url = http://localhost:8402/v1
  api_key  = sk-openzoo   (any value; the zoo takes payment, not keys)

rails (all three settle real payments; Solana is the default):
  OPENZOO_RAIL=solana|base|robinhood forces one rail — errors clearly if the
  live 402 does not offer it. Unset = Solana first.

env:
  OPENZOO_PORT (8402)  OPENZOO_API_BASE (https://x402-tokens.fly.dev)
  OPENZOO_RPC (mainnet-beta)  OPENZOO_TOKEN (402 rail preference)  OPENZOO_WALLET (~/.openzoo/wallet.json)
  OPENZOO_RAIL (unset — force a rail: solana | base | robinhood)
  OPENZOO_BASE_RPC (https://mainnet.base.org)  OPENZOO_RH_RPC (rpc.mainnet.chain.robinhood.com)
  OPENZOO_MAX_USD_PER_CALL (unset — NO per-call ceiling; set to add one)  OPENZOO_DEMO_MAX_USD (0.01)
  OPENZOO_CONTEXT_MIN_CHARS (16384 — bodies bigger than this bind once + reuse)
  OPENZOO_NO_CONTEXT_CACHE (0 — set 1 to always ship the full body)
  OPENZOO_ENABLE_RH (0 — let DEFAULT selection fall through to the Robinhood rail;
                     OPENZOO_RAIL=robinhood forces it without this)
  OPENZOO_TUNNEL_MAX_USD (unset — NO public-url session ceiling; set to add one)  OPENZOO_TUNNEL_TOKEN (pin the api key)
  OPENZOO_NO_TUNNEL (0 — set 1 for localhost-only, no public url)`;

async function main() {
  switch (cmd) {
    case 'proxy':
    case 'start':
      await (await import('../lib/proxy.js')).startProxy({ autoTunnel: true });
      break;
    case 'mcp':
      await (await import('../lib/mcp.js')).startMcp();
      break;
    case 'launch': {
      const rest = process.argv.slice(3);
      const [harness, hargs] = [rest[0], rest.slice(1)];
      if (!harness) throw new Error('usage: openzoo launch <command> [args...]');
      await (await import('../lib/launch.js')).launchHarness(harness, hargs);
      break;
    }
    case 'tunnel':
      await (await import('../lib/tunnel.js')).runTunnel();
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
    case 'bind': {
      const target = process.argv[3];
      if (!target) throw new Error('usage: openzoo bind <file-or-directory> [--ext .txt,.md] [--force]');
      const { bindPath } = await import('../lib/bindpath.js');
      const ei = process.argv.indexOf('--ext');
      const exts = ei !== -1 && process.argv[ei + 1]
        ? process.argv[ei + 1].split(',').map((e) => (e.startsWith('.') ? e : `.${e}`))
        : undefined;
      const mb = (n) => (n / 1048576).toFixed(1);
      const out = await bindPath(target, {
        exts,
        force: process.argv.includes('--force'),
        onProgress: (p) => {
          if (p.stage === 'reused') console.log(`already bound — ${mb(p.bytes)}MB across ${p.files} file(s) reused, nothing uploaded`);
          if (p.stage === 'start') console.log(`binding ${mb(p.bytes)}MB from ${p.files} file(s) in ${p.parts} part(s)...`);
          if (p.stage === 'part') console.log(`  part ${p.index}/${p.of} bound (${mb(p.bytes)}MB)`);
        },
      });
      console.log('');
      console.log(`context: ${out.contextId}`);
      console.log(`ask it:  npx openzoo ask "your question" --context ${out.contextId}`);
      console.log('or send X-HRR-Context: <id> with a small body to /v1/chat/completions');
      break;
    }
    case 'ask': {
      const question = process.argv[3];
      if (!question) throw new Error('usage: openzoo ask "<question>" [--context <id>] [--model <id>]');
      const ci = process.argv.indexOf('--context');
      const mi = process.argv.indexOf('--model');
      const { PayClient } = await import('../lib/pay.js');
      const { config } = await import('../lib/config.js');
      const client = new PayClient();
      const headers = { 'content-type': 'application/json' };
      if (ci !== -1 && process.argv[ci + 1]) headers['x-hrr-context'] = process.argv[ci + 1];
      const { response, receipt } = await client.fetch(`${config.apiBase}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: (mi !== -1 && process.argv[mi + 1]) || process.env.OPENZOO_DEFAULT_MODEL || 'deepseek/deepseek-v4-pro-0813',
          messages: [{ role: 'user', content: question }],
          max_tokens: Number(process.env.OPENZOO_ASK_MAX_TOKENS || 1024),
        }),
      });
      if (!response.ok) throw new Error(`zoo returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const data = await response.json();
      console.log(data.choices?.[0]?.message?.content ?? '(no content)');
      if (receipt) console.error(`\n${receipt.line}`);
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
