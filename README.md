# openzoo

Local x402-paying proxy + MCP server for [openzoo.fun](https://openzoo.fun) — point **any** OpenAI-compatible harness (Cursor, Claude Code, aider, raw SDKs) at `localhost` and it pays the zoo per call from a local burner wallet. No account, no API key, no crypto knowledge required by your tools.

```
npx openzoo
```

That's it. First run generates a burner wallet at `~/.openzoo/wallet.json` (chmod 600), prints the funding address, and starts the proxy:

```
base_url = http://localhost:8402/v1
api_key  = sk-openzoo        # any value works; the zoo takes payment, not keys
```

Every request forwards to the zoo. When the zoo answers `402 Payment Required`, the proxy reads the quote, signs a token transfer from your local wallet, retries with the `X-PAYMENT` header, and streams the response back — SSE included, unbuffered. Each payment prints a one-line receipt:

```
paid $0.002137 (9.5× cheaper than direct) · rail solana · tx 5Kd…
```

## 60-second quickstarts

**Cursor** (Settings → Models → OpenAI API): set *Override OpenAI Base URL* to `http://localhost:8402/v1`, API key `sk-openzoo`. (Cursor Hobby can't BYOK; Pro can.)

**Claude Code / any OpenAI-env tool:**
```bash
export OPENAI_BASE_URL=http://localhost:8402/v1
export OPENAI_API_KEY=sk-openzoo
```

**aider:**
```bash
aider --openai-api-base http://localhost:8402/v1 --openai-api-key sk-openzoo --model openai/nvidia/nemotron-3.5-lightning
```

**curl:**
```bash
curl http://localhost:8402/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"nvidia/nemotron-3.5-lightning","messages":[{"role":"user","content":"hi"}]}'
```

Model ids come from `GET http://localhost:8402/v1/models` (free, no payment).

## Use as MCP

The same package is an MCP server sharing the same wallet and payment core:

```bash
claude mcp add openzoo -- npx -y openzoo mcp
```

Other MCP hosts:

```json
{ "mcpServers": { "openzoo": { "command": "npx", "args": ["-y", "openzoo", "mcp"] } } }
```

Tools:
- **`zoo_ask`** — `{prompt, corpus?, model?, max_tokens?}`. The flagship: hand it a *huge* `corpus` (hundreds of thousands to ~1M tokens — a body the model itself would refuse) and a question; the zoo's leCore memory spills the corpus so the model reads only a few thousand tokens. Returns the answer plus the receipt (`billedUsd`, `savesVsDirect`, tokens actually read). An MCP-capable agent can delegate a giant-context question without touching its own model config.
- **`zoo_models`** — list the zoo's models and pricing (free).
- **`zoo_wallet`** — funding address, balances, and this session's receipts.

## The demo

```bash
npx openzoo demo
```

Builds a ~965k-token document with one planted fact, shows that buying direct refuses it (*"The input token count exceeds the maximum number of tokens allowed."* — recorded, see [benches.openzoo.fun](https://benches.openzoo.fun)), then fetches the live x402 quote for the same body — the quote is free:

```
quote: $0.009747 yUSDCx · pricing=counterfactual · direct would be $0.097474 · savesVsDirect=10.0×
```

If the wallet is funded it pays (capped at `OPENZOO_DEMO_MAX_USD`, default $0.01) and prints the answer, the tokens the model actually read, and the receipt. If not, it prints exactly what to fund.

## The wallet model

- **Burner, local, yours.** A keypair in `~/.openzoo/wallet.json`, created on first run, chmod 600. Keys never leave your machine — the zoo only ever sees signed transfers.
- **Fund it with yUSDCx** (mint `6ZjjxcoicqM4nniddkuPVwew4PDwY3swbfHsGbCuLuTv`), the $1-stable rail: wrap USDC at [x402.accrue.fund/start](https://x402.accrue.fund/start) and send to the address `npx openzoo address` prints. A few cents goes a long way.
- **You don't need SOL.** The gateway is the transaction feePayer; you only sign the token transfer.
- **Spend caps.** The proxy refuses any single quote above `OPENZOO_MAX_USD_PER_CALL` (default $0.50).
- `npx openzoo balance` / `npx openzoo address` — check funds / print the address.

## Honest pricing note

Two bases, reported per call in the 402 (`extra.pricing`):
- **Short prompts price at a markup** (3× provider cost) — there's nothing to spill, you're paying for passthrough.
- **Big bodies price at a counterfactual discount** (~10× cheaper than buying the same call direct) — the zoo's leCore memory means it never forwards your whole body upstream, and passes the savings on. Measured numbers at [benches.openzoo.fun](https://benches.openzoo.fun).

The receipt names which base you got; `extra.directUsd` / `extra.savesVsDirect` let you check the math.

## Payment rails

| rail | network | status |
|---|---|---|
| **Solana** (default) | `solana:5eykt…` | **live** — Token-2022 `TransferChecked`, partial-signed, gateway pays fees. Tested end-to-end against the production 402. |
| Base | `eip155:8453` | implemented (standard x402 EIP-3009 `transferWithAuthorization`), **live-untested** — the zoo's 402s currently offer only Solana rows. |
| Robinhood Chain | `eip155:4663` | experimental, behind `OPENZOO_ENABLE_RH=1` — the zoo ships this rail dark and facilitator settlement there is unverified. |

The rail is chosen from the 402's `accepts[]` itself (Solana first). Amounts are always taken as raw units from the 402, and Solana decimals are read from the mint **on-chain** — never hardcoded. (The zoo's own pasted prompt hardcodes `decimals = 6`; that's wrong for 18-decimal mints and this package deliberately does not copy the bug.)

## Configuration

| env | default | |
|---|---|---|
| `OPENZOO_PORT` | `8402` | proxy port |
| `OPENZOO_API_BASE` | `https://x402-tokens.fly.dev` | the zoo's door |
| `OPENZOO_RPC` | mainnet-beta public RPC | Solana RPC |
| `OPENZOO_TOKEN` | `yUSDCx` | which 402 row to pay |
| `OPENZOO_WALLET` | `~/.openzoo/wallet.json` | wallet path |
| `OPENZOO_MAX_USD_PER_CALL` | `0.5` | refuse quotes above this |
| `OPENZOO_DEMO_MAX_USD` | `0.01` | demo spend cap |
| `OPENZOO_ENABLE_RH` | `0` | allow the Robinhood rail |

## What's tested

- Unit tests run against a **captured production 402 body** (`test/fixtures/live-402.json`): parsing, rail selection, and byte-level verification of the signed Solana transaction and the EVM typed-data payload.
- Live-verified: `/v1/models` through the proxy (200), 402 parse + quote + wallet check against mainnet, on-chain mint/decimals read, and full payment construction (signed, not broadcast) against a production quote.
- **Not yet live-verified: an actual settled paid call** — this session's wallet was unfunded, so settlement (the facilitator accepting the signed transfer) is untested from this client. The construction matches the gateway's own documented flow byte-for-byte.

MIT
