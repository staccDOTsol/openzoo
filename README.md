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

**OpenAI SDK (Python):**
```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8402/v1", api_key="sk-openzoo")
r = client.chat.completions.create(model="nvidia/nemotron-3.5-lightning",
                                   messages=[{"role": "user", "content": "hi"}])
```

**OpenAI SDK (JS/TS):**
```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:8402/v1", apiKey: "sk-openzoo" });
const r = await client.chat.completions.create({
  model: "nvidia/nemotron-3.5-lightning",
  messages: [{ role: "user", content: "hi" }],
});
```

Model ids come from `GET http://localhost:8402/v1/models` (free, no payment). Requires Node ≥ 18 (for `npx openzoo` itself; your harness can be anything).

## Use as MCP

The same package is an MCP server sharing the same wallet and payment core:

```bash
claude mcp add openzoo -- npx -y openzoo mcp
```

**Claude Desktop** — add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart the app:

```json
{ "mcpServers": { "openzoo": { "command": "npx", "args": ["-y", "openzoo", "mcp"] } } }
```

**Cursor** — Settings → MCP → *Add new global MCP server*, or drop the same JSON into `~/.cursor/mcp.json` (per-project: `.cursor/mcp.json`).

**Windsurf / Cline / any MCP host** — same shape: command `npx`, args `["-y", "openzoo", "mcp"]`, stdio transport.

Tools:
- **`zoo_ask`** — `{prompt, corpus?, model?, max_tokens?}`. The flagship: hand it a *huge* `corpus` (hundreds of thousands to ~1M tokens — a body the model itself would refuse) and a question; the zoo's leCore memory spills the corpus so the model reads only a few thousand tokens. Returns the answer plus the receipt (`billedUsd`, `savesVsDirect`, tokens actually read). An MCP-capable agent can delegate a giant-context question without touching its own model config.
- **`zoo_models`** — list the zoo's models and pricing (free).
- **`zoo_wallet`** — funding address, balances, and this session's receipts.

## The demo

```bash
npx openzoo demo
```

Builds a ~965k-token document with one planted fact, shows that buying direct refuses it (*"The input token count exceeds the maximum number of tokens allowed."* — recorded, see [benches.openzoo.fun](https://benches.openzoo.fun)), binds the body ONCE to the zoo's holographic memory, then pays for a question that ships alone:

```
bound once in 14.8s: 3.7MB → context ctx_01KZZY8YQE…
quote for the ask: $0.000480 · pricing=markup (3× a tiny body — the 3.7MB corpus is not re-priced)
```

If the wallet is funded with USDC or TOKEN it pays (capped at `OPENZOO_DEMO_MAX_USD`, default $0.01) and prints the answer, the tokens the model actually read, and the receipt. If not, it prints exactly what to fund. Long waits (the one-time upload, pricing, payment, the answer) show a live progress line with stage + elapsed seconds.

**Run it twice.** The second run finds the corpus in the local manifest and never uploads it:

```
★ corpus already bound (context ctx_01KZZY8YQE…) — skipped the 3.7MB upload entirely.
...
★ corpus already bound — skipped 3.7MB upload; whole run took 4.3s and cost $0.000480
```

## Repeat calls are near-free (0.3.0: the body never ships twice)

The zoo keeps your corpus in leCore holographic memory; the shim keeps a manifest at `~/.openzoo/contexts.json` (chmod 600) mapping `sha256(corpus)` → the zoo's `context_id`, scoped per API base. When a request carries a corpus the manifest already knows:

- **nothing big is uploaded** — the ask ships alone with an `X-HRR-Context` header,
- **the 402 prices the tiny ask** (markup basis, honestly labeled `pricing=markup`), typically a few hundredths of a cent instead of re-pricing megabytes,
- **the answer still comes from your corpus** — the zoo recalls the relevant slices server-side.

This works in all three fronts: the **proxy** (a big pasted body in the last message is split at its last blank line, bound once, and reused on every later call — even with a different question), the **MCP** `zoo_ask` `corpus` parameter, and the **demo**. If the zoo ever forgets a context (sidecar wipe), the gateway answers 404 *before* any payment and the shim transparently re-binds once and retries — a stale manifest never fails a call.

Manage it:

```bash
npx openzoo contexts                  # list bound corpora (hash, context id, age, api base)
npx openzoo contexts --forget 60464d  # drop one by hash prefix
npx openzoo contexts --forget all     # drop everything
```

Opt out with `OPENZOO_NO_CONTEXT_CACHE=1` (always ship the full body); tune the threshold with `OPENZOO_CONTEXT_MIN_CHARS` (default 16384 chars).

## Using openzoo from a cloud IDE (Cursor, Windsurf, hosted agents)

Some IDEs run their model calls **from their own servers**, not your machine. Point one of those at `http://localhost:8402` and you get, verbatim:

```
Provider returned error: Access to private networks is forbidden
```

That is reachability, not payment — their cloud cannot dial your laptop. Give it a public URL instead:

```bash
npx openzoo tunnel
```

It installs `cloudflared` itself (one-time, cached in `~/.openzoo/bin`; a Cloudflare account is not needed), opens a quick tunnel to your local proxy, and prints:

```
base_url = https://<random>.trycloudflare.com/v1
api_key  = oz_<random>          # in tunnel mode the key is REAL auth
```

**Tunnel mode is the one mode where the api key matters.** A public URL in front of a wallet is a public URL in front of your money, so:

- every request without `Authorization: Bearer <that key>` is refused **401** before anything is forwarded, quoted or paid;
- the per-call cap (`OPENZOO_MAX_USD_PER_CALL`, default $0.50) still applies;
- a session ceiling stops all spending at `OPENZOO_TUNNEL_MAX_USD` (default **$1.00**);
- every served request prints its receipt and the running session total;
- the URL dies when you Ctrl-C, and the session's total spend is printed on exit.

Pin the key with `OPENZOO_TUNNEL_TOKEN` if your IDE stores it. Keys never leave your machine either way — the tunnel forwards to the same local proxy, which signs with the same local wallet.

**MCP clients don't need any of this.** If your tool speaks MCP, use the hosted server at `https://mcp.openzoo.fun/mcp` — cloud-reachable, no local process, mint a wallet with `zoo_wallet`.

## The wallet model

- **Burner, local, yours.** A keypair in `~/.openzoo/wallet.json`, created on first run, chmod 600. Keys never leave your machine — the zoo only ever sees signed transfers.
- **Fund it with USDC or TOKEN.** Send a few cents of either to the address `npx openzoo address` prints:
  - **USDC** — `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
  - **TOKEN** — `EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump`

  Both are first-class: each is the underlying of a live Solana rail the zoo quotes (USDC → yUSDCx, TOKEN → wTOKENx). That's the whole funding story — the shim converts whichever the 402 quotes internally, at payment time, for exactly the amount needed.
- **SOL is optional but nice.** The gateway sponsors payment-transaction fees. If the wallet holds a pinch of SOL (~0.003), the internal conversion settles as its own transaction first; with zero SOL the conversion rides inside the gateway-sponsored payment transaction instead.
- **Spend caps.** The proxy refuses any single quote above `OPENZOO_MAX_USD_PER_CALL` (default $0.50).
- `npx openzoo balance` / `npx openzoo address` — check funds (USDC + TOKEN + SOL + USD value) / print the address.

## Honest pricing note

Two bases, reported per call in the 402 (`extra.pricing`):
- **Short prompts price at a markup** (3× provider cost) — there's nothing to spill, you're paying for passthrough.
- **Big bodies price at a counterfactual discount** (~10× cheaper than buying the same call direct) — the zoo's leCore memory means it never forwards your whole body upstream, and passes the savings on. Measured numbers at [benches.openzoo.fun](https://benches.openzoo.fun).
- **Asks against a bound corpus price on the markup basis** (3× a tiny body — the receipt says `pricing=markup`). That is not a discount trick: 3× of a few hundred tokens is normally far below even the counterfactual price of shipping the corpus, which is the whole point of binding once.

The receipt names which base you got; `extra.directUsd` / `extra.savesVsDirect` let you check the math.

## Payment rails

| rail | network | status |
|---|---|---|
| **Solana** (default) | `solana:5eykt…` | **live** — Token-2022 `TransferChecked`, partial-signed, gateway pays fees. Tested end-to-end against the production 402. Settlement uses a wrapped settlement mint as internal plumbing; you only ever hold and send USDC or TOKEN. |
| Base | `eip155:8453` | **offered by the zoo** — standard x402 EIP-3009 `transferWithAuthorization` against native USDC. Fund the wallet's EVM address with USDC on Base; nothing is converted. Settlement from this package is live-untested. |
| Robinhood Chain | `eip155:4663` | experimental, behind `OPENZOO_ENABLE_RH=1`. The zoo quotes it, but its settlement asset has no conversion path here (conversion is Solana-only), so there is no plain balance you can fund and have the shim spend — use Solana or Base. |

`npx openzoo` prints the rails off a live 402 at startup, and the funding line is derived from those rails — so a new chain shows up without this package shipping again.

The rail is chosen from the 402's `accepts[]` itself (Solana first). Amounts are always taken as raw units from the 402, and Solana decimals are read from the mint **on-chain** — never hardcoded. (The zoo's own pasted prompt hardcodes `decimals = 6`; that's wrong for 18-decimal mints and this package deliberately does not copy the bug.)

## Configuration

| env | default | |
|---|---|---|
| `OPENZOO_PORT` | `8402` | proxy port |
| `OPENZOO_API_BASE` | `https://x402-tokens.fly.dev` | the zoo's door |
| `OPENZOO_RPC` | mainnet-beta public RPC | Solana RPC |
| `OPENZOO_TOKEN` | (internal) | preferred 402 rail — leave unset |
| `OPENZOO_WALLET` | `~/.openzoo/wallet.json` | wallet path |
| `OPENZOO_MAX_USD_PER_CALL` | `0.5` | refuse quotes above this |
| `OPENZOO_DEMO_MAX_USD` | `0.01` | demo spend cap |
| `OPENZOO_CONTEXT_MIN_CHARS` | `16384` | bodies bigger than this bind once + reuse |
| `OPENZOO_NO_CONTEXT_CACHE` | `0` | set `1` to always ship the full body |
| `OPENZOO_ENABLE_RH` | `0` | allow the Robinhood rail |

## What's tested

- Unit tests run against a **captured production 402 body** (`test/fixtures/live-402.json`): parsing, rail selection, and byte-level verification of the signed Solana transaction and the EVM typed-data payload.
- Live-verified: `/v1/models` through the proxy (200), 402 parse + quote against mainnet, on-chain mint/decimals read, the internal USDC conversion (funded from plain USDC, settled on mainnet), and **a real settled paid call** — the full demo ran end-to-end against the production gateway: quote, automatic top-up from USDC, payment accepted by the facilitator, answer + receipt returned.

MIT
