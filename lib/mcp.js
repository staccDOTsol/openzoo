import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from './config.js';
import { PayClient, QuoteTooHighError, UnderfundedError } from './pay.js';
import { tokenBalance } from './x402.js';

const YUSDCX = '6ZjjxcoicqM4nniddkuPVwew4PDwY3swbfHsGbCuLuTv';
const WTOKENX = 'Bo7xBF7SY8EyUBPUxRP66SFafxoPf2n5uqiLjbxEebx9';
const DEFAULT_MODEL = process.env.OPENZOO_DEMO_MODEL || 'nvidia/nemotron-3.5-lightning';

function text(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

/** `npx openzoo mcp` — stdio MCP server sharing the proxy's wallet + payment core. */
export async function startMcp() {
  const client = new PayClient();
  const server = new McpServer({ name: 'openzoo', version: '0.1.0' });

  server.registerTool('zoo_ask', {
    description:
      'Ask a question through openzoo.fun, paying the x402 quote transparently from the local burner wallet. '
      + 'The zoo puts leCore holographic memory in front of every model, so `corpus` can be a HUGE text body '
      + '(hundreds of thousands to ~1M tokens) that the model itself would refuse — the zoo spills it and the '
      + 'model reads only a few thousand tokens. Returns the answer plus a payment receipt '
      + '(billedUsd, savesVsDirect, tokens actually read).',
    inputSchema: {
      prompt: z.string().describe('The question or instruction.'),
      corpus: z.string().optional().describe('Optional big context body (document dump, logs, book...). Placed before the prompt.'),
      model: z.string().optional().describe(`Model id from zoo_models. Default ${DEFAULT_MODEL}.`),
      max_tokens: z.number().int().positive().optional().describe('Completion cap. Default 1024.'),
    },
  }, async ({ prompt, corpus, model, max_tokens }) => {
    const content = corpus ? `${corpus}\n\n${prompt}` : prompt;
    try {
      const { data, receipt } = await client.chat({
        model: model || DEFAULT_MODEL,
        messages: [{ role: 'user', content }],
        max_tokens: max_tokens || 1024,
      });
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
    const [y, w] = await Promise.all([
      tokenBalance(client.connection, client.keypair.publicKey, YUSDCX),
      tokenBalance(client.connection, client.keypair.publicKey, WTOKENX),
    ]);
    return text({
      solanaAddress: client.address,
      fundWith: `yUSDCx (mint ${YUSDCX}) — wrap USDC at https://x402.accrue.fund/start`,
      balances: { yUSDCx: y.ui ?? 0, wTOKENx: w.ui ?? 0 },
      receipts: client.receipts.map((r) => ({ at: r.at, line: r.line })),
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`openzoo mcp on stdio — wallet ${client.address} — zoo ${config.apiBase}`);
}
