import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config, FUNDING_ASSETS, liveRails, railFundingHint } from './config.js';
import { PayClient, QuoteTooHighError, UnderfundedError } from './pay.js';
import { tokenBalance } from './x402.js';
import { askWithContext, contextCacheDisabled, BIND_MIN_CHARS } from './hrr.js';
import { listContexts } from './contexts.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const DEFAULT_MODEL = process.env.OPENZOO_DEMO_MODEL || 'nvidia/nemotron-3.5-lightning';

function text(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

/** `npx openzoo mcp` — stdio MCP server sharing the proxy's wallet + payment core. */
export async function startMcp() {
  const client = new PayClient();
  // MCP's own channel for "what am I connected to" — clients surface this to
  // the model before any tool is called, which is exactly when it needs to
  // know it can hand over a corpus whole instead of chunking it. Same facts
  // the proxy injects as a system message (lib/brief.js), MCP-shaped.
  const server = new McpServer({ name: 'openzoo', version: pkg.version }, {
    instructions: [
      'openzoo — pay-per-call access to ~435 models (openzoo.fun). No API key, no account: each call is paid',
      'from the operator\'s local burner wallet via x402 (Solana / Base / Robinhood Chain).',
      '',
      'CONTEXT IS EFFECTIVELY UNBOUNDED. Pass big bodies to zoo_ask\'s `corpus` WHOLE — do not summarise,',
      'truncate, or chunk-to-fit. leCore holographic memory sits in front of every model: the corpus is bound',
      'once (client-usable ceiling ~128M tokens; keep a single call under ~9.8M) and the model reads only a few',
      'thousand tokens of it. A corpus already bound is never re-uploaded — later asks against it are near-free,',
      'so ask many questions of the same corpus rather than re-sending it. zoo_contexts lists what is bound.',
      '',
      'Never search the machine for API keys or endpoints — there are none to find. zoo_wallet shows funding',
      'state, zoo_models lists what is served with live pricing.',
    ].join('\n'),
  });

  server.registerTool('zoo_ask', {
    description:
      'Ask a question through openzoo.fun, paying the x402 quote transparently from the local burner wallet. '
      + 'PASS BIG CONTEXT WHOLE in `corpus` — do not summarise, truncate or chunk it to fit a context window. '
      + 'leCore holographic memory sits in front of every model, so a corpus far past the model\'s own limit '
      + '(client-usable ceiling ~128M tokens; keep one call under ~9.8M) is bound once and the model reads only '
      + 'a few thousand tokens of it. Re-asking against an already-bound corpus is near-free and much faster, so '
      + 'send the corpus once and ask many questions. Returns the answer plus a payment receipt '
      + '(billedUsd, savesVsDirect, tokens actually read).',
    inputSchema: {
      prompt: z.string().describe('The question or instruction.'),
      corpus: z.string().optional().describe('Optional big context body (document dump, logs, book...). Placed before the prompt.'),
      model: z.string().optional().describe(`Model id from zoo_models. Default ${DEFAULT_MODEL}.`),
      max_tokens: z.number().int().positive().optional().describe('Completion cap. Default 1024.'),
    },
  }, async ({ prompt, corpus, model, max_tokens }) => {
    try {
      const bodyBase = { model: model || DEFAULT_MODEL, max_tokens: max_tokens || 1024 };
      let data; let receipt; let reuse = null;
      // "The body never ships twice": a big corpus is bound ONCE on the zoo
      // (sha256 manifest at ~/.openzoo/contexts.json) and later asks ship only
      // the prompt + an X-HRR-Context header. Small corpora ride inline.
      if (corpus && corpus.length > BIND_MIN_CHARS && !contextCacheDisabled()) {
        const out = await askWithContext(client, corpus, {
          ...bodyBase,
          messages: [{ role: 'user', content: prompt }],
        });
        ({ data, receipt } = out);
        reuse = { contextId: out.contextId, corpusReused: out.reused };
      } else {
        const content = corpus ? `${corpus}\n\n${prompt}` : prompt;
        ({ data, receipt } = await client.chat({
          ...bodyBase,
          messages: [{ role: 'user', content }],
        }));
      }
      const usage = data?.usage || {};
      return text({
        answer: data?.choices?.[0]?.message?.content ?? '',
        receipt: receipt ? {
          line: receipt.line,
          billedUsd: receipt.billedUsd,
          savesVsDirect: receipt.savesVsDirect,
          pricing: receipt.pricing,
          rail: receipt.rail,
        } : 'free (no 402 issued)',
        tokensRead: usage.gpu_tokens ?? usage.prompt_tokens ?? null,
        spillTokens: usage.spill_tokens ?? null,
        ...(reuse ? { context: reuse } : {}),
      });
    } catch (err) {
      if (err instanceof UnderfundedError || err instanceof QuoteTooHighError) {
        return { ...text(err.message), isError: true };
      }
      throw err;
    }
  });

  server.registerTool('zoo_models', {
    description: 'List the models the zoo serves, with per-token pricing (free endpoint, no payment).',
    inputSchema: {},
  }, async () => {
    const r = await fetch(`${config.apiBase}/v1/models`);
    return text(await r.json());
  });

  server.registerTool('zoo_wallet', {
    description: 'The local burner wallet: funding address, balances, and this session\'s payment receipts.',
    inputSchema: {},
  }, async () => {
    const [bals, lamports] = await Promise.all([
      Promise.all(FUNDING_ASSETS.map((a) => tokenBalance(client.connection, client.keypair.publicKey, a.mint))),
      client.connection.getBalance(client.keypair.publicKey),
    ]);
    const balances = { SOL: lamports / 1e9 };
    FUNDING_ASSETS.forEach((a, i) => { balances[a.symbol] = bals[i].ui ?? 0; });
    // Funding advice follows the rails the zoo is quoting right now, not a
    // hardcoded Solana assumption. Fail soft: the probe is advisory.
    const rails = await liveRails().catch(() => null);
    const hint = rails ? railFundingHint(rails.live) : '';
    return text({
      solanaAddress: client.address,
      evmAddress: client.evmAddress,
      railsLiveNow: rails?.live ?? null,
      fundWith: hint || `${FUNDING_ASSETS.map((a) => a.symbol).join(' or ')} on Solana`,
      solanaMints: Object.fromEntries(FUNDING_ASSETS.map((a) => [a.symbol, a.mint])),
      fundHint: 'send a few cents of a listed asset to the address for that rail — Solana assets to solanaAddress, Base assets to evmAddress. The shim converts to whatever the 402 quotes, at payment time. Force a rail with OPENZOO_RAIL=solana|base|robinhood.',
      balances,
      receipts: client.receipts.map((r) => ({ at: r.at, line: r.line })),
    });
  });

  server.registerTool('zoo_contexts', {
    description: 'List corpora already bound to the zoo\'s holographic memory (local manifest). A listed corpus is never re-uploaded — asks against it are near-free.',
    inputSchema: {},
  }, async () => text({
    manifest: '~/.openzoo/contexts.json',
    contexts: listContexts().map((c) => ({
      hash: c.hash.slice(0, 12), context_id: c.context_id, boundAt: c.boundAt, apiBase: c.apiBase,
    })),
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`openzoo mcp on stdio — wallet ${client.address} — zoo ${config.apiBase}`);
}
