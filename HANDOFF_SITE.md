# openzoo.fun — site handoff

You are replacing the current openzoo.fun landing page. The design/vibe of the
existing page is fine (black, lime `TOKEN` mark, mono code cards, `Project /
CLI / Models / Benchmarks` nav) — keep it. **What is wrong is the content: it
describes a version of the product that no longer exists.**

Everything below is verified against the shipped package (`openzoo@0.12.0` on
npm) and the live gateway as of 2026-08-15. Do not embellish it. This project
gets read by engineers who will run the commands, and every number here has
been measured — inventing a better-sounding one is worse than saying nothing.

---

## 1. What openzoo actually is

`npx openzoo` is a **local proxy + MCP server**. It runs on the user's machine
and holds a burner wallet. Every model call is paid per-request over **x402**
(HTTP 402 → sign → retry) from that wallet. There is no account, no signup, no
dashboard, no API key to obtain.

Two things sit behind it:

- **The zoo** (`x402-tokens`, a gateway in front of OpenRouter) — ~435 models,
  priced live at OpenRouter rates. If the caller saves vs sending the body
  direct, zoo takes 33% of the savings. There is no 3× markup.
- **leCore HRR** — a holographic-memory sidecar that sits *in front of every
  model*. Big request bodies are carved and bound to it before the model sees
  them, and the model then reads only the retrieved passages.

The second one is the actual product. Everything else is plumbing.

---

## 2. What the current page gets wrong (fix all of these)

| Current page says | Reality |
|---|---|
| "Point Cursor at localhost" as the headline | Cloud IDEs **cannot reach localhost** — they return `Access to private networks is forbidden`. `npx openzoo` now also prints a public HTTPS tunnel URL automatically. The headline should not tell people to do the thing that fails. |
| MCP only via `npx -y openzoo mcp` (stdio) | MCP is **also served on the proxy's own port at `/mcp`** (Streamable HTTP). One command gives both surfaces. stdio still works for clients that spawn a process. |
| `zoo_ask · zoo_models · zoo_wallet` | There are **five** tools now: `zoo_ask`, `zoo_bind`, `zoo_models`, `zoo_wallet`, `zoo_contexts`. |
| No mention of binding | `zoo_bind` and `npx openzoo bind` are the headline feature (see §4). |
| Payment described vaguely | **Three chains settle real payments**: Solana (default), Base, Robinhood Chain. |

---

## 3. Copy blocks — use these verbatim

**Install / run (one command, both surfaces):**
```
npx openzoo
```
It prints, on startup:
- `http://localhost:8402/v1` — keyless, for local harnesses
- `http://localhost:8402/mcp` — MCP endpoint
- a `https://<random>.trycloudflare.com/v1` public URL + an `oz_…` key, for
  cloud IDEs that cannot dial localhost
- the wallet's Solana and EVM addresses, live balances on all three chains, and
  the contract address of every token it accepts

**Cursor (`~/.cursor/mcp.json`):**
```json
{ "mcpServers": { "openzoo": { "command": "npx", "args": ["-y", "openzoo", "mcp"] } } }
```

**Claude Code:**
```
claude mcp add openzoo -- npx -y openzoo mcp
```

**Any OpenAI-compatible client:**
```
export OPENAI_BASE_URL=http://localhost:8402/v1
export OPENAI_API_KEY=sk-openzoo      # any string; payment is x402, not keys
```

**CLI:**
```
npx openzoo bind <file-or-dir>          # chunk + bind a corpus, returns a context id
npx openzoo ask "question" --context <id>
npx openzoo demo                        # ~1M-token needle demo
npx openzoo balance | address | contexts
```

---

## 4. The pitch — lead with this, not with "point Cursor at localhost"

**The body never ships twice.**

A harness can only send a model what fits in its window, and it truncates long
files before they ever reach the wire (Cursor caps every file read at 100,000
characters). openzoo removes both limits:

1. `zoo_bind({path})` — the MCP server runs **on the same machine as the file**,
   so it reads the whole thing itself, splits it into transport-sized parts, and
   binds them into one context. No truncation, no manual chunking, no terminal.
2. Every later question ships **only the question** plus a context id. The model
   reads a few thousand tokens of the corpus, not all of it.

Measured, end to end, on a real 8.7MB Telegram export (343,841 lines):
- bind: **3 parts, 44 seconds, free** (binding is never billed)
- a question against it: **5,296 tokens actually read**, ~$0.24 on a flagship
  model, answer correct and sourced
- re-binding the same content: **0 bytes uploaded** (content-hash manifest)

Same mechanism applies transparently to plain chat: a 2.83MB conversation sent
to `/v1/chat/completions` was spilled from **702,914 tokens → 4,863 tokens**,
billed **$0.35 instead of $3.39**.

---

## 5. Honesty constraints — do not break these

These matter more than the marketing. Getting one wrong makes the whole page
untrustworthy to exactly the audience that would otherwise use this.

- **Do NOT claim a 128M-token attention window.** `context_length: 128000000`
  is the *client-usable* ceiling via bind/retrieval. The transformer's real
  window is `max_model_len` (e.g. 1,050,000). Say "bind 128M, the model reads
  what's relevant" — never "128M context window".
- **A single request must stay under ~8MB.** Bigger bodies are dropped by the
  network hop. Corpora larger than that are bound in parts. Say so.
- **"No API key" needs one qualifier.** True for payment and true on localhost.
  The *public tunnel URL* requires the printed `oz_…` bearer token for paid
  endpoints (binding stays keyless). Don't state it unqualified.
- **Don't claim HRR beats softmax on quality.** Our own 303M matched-pair run
  has gated-HRR **32.7% worse** than softmax (3.1494 vs 4.1805 val loss). An
  earlier published 41.5% was partly artifact and was corrected. HRR's win here
  is *retrieval over unbounded context*, not attention quality. The benchmarks
  page already states this; the landing page must not contradict it.
- Every benchmark number must link to benches.openzoo.fun.

---

## 6. Nav / structure suggestion

Keep the four-item nav. Suggested page order:

1. **Hero** — "Bind a corpus once. Ask it anything, forever, for cents."
   Subhead: local x402 proxy + MCP. No account, no key, burner wallet.
   One command: `npx openzoo`.
2. **The 60-second demo** — the 8.7MB numbers above, as a receipt-style block.
3. **Wire it up** — the four code cards (proxy, MCP, Cursor json, env vars).
   Add the public-URL card for cloud IDEs.
4. **What it costs** — OpenRouter prices (33% of savings vs direct when any), per-request, three chains, no subscription.
   Show a real receipt line:
   `paid $0.086130 · rail solana · tx dTmnxEhv…` .
5. **Benchmarks** — link out, with the honest framing from §5.

---

## 7. Facts you may cite (all verified)

- `openzoo@0.12.0` on npm; source github.com/staccDOTsol/openzoo
- ~435 models; gateway `x402-tokens.fly.dev`; wallet path is OpenRouter prices, plus 33% of savings vs direct when any (no 3× markup)
- Rails live and settling: **Solana** (default), **Base**, **Robinhood Chain**
- Accepted tokens, all raw and native: USDC/TOKEN/LEOS (Solana), USDC (Base),
  USDG (Robinhood Chain). These are the exact mints the 402 quotes — nothing is
  wrapped and nothing is converted, so **never show a wrapped ticker on the
  site**. The ODDBALLER / IOU / ROBINHOODS memecoins were dropped 2026-08-24
  with the rest of the wrapped rails; do not list them as fundable.
- Contexts are isolated per wallet (namespace hashed into the sidecar tenant)
- Model ids are forgiving: unknown ids are matched to the nearest served model
  (`gpt-4o` → `openai/gpt-4o`, `composer-2.5` → a code model, etc.)
