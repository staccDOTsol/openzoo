# openzoo.fun — copy edits for the one-command flow

Against the live page as of 2026-08-15. Keep the design, the token rail, the
benchmarks, the receipt line. **What changed is that setup is now one command**,
so every section that walks someone through manual wiring is obsolete.

Published: **`openzoo@0.17.0`** (the page says `0.12.0` in two places).

---

## The change in one line

Before: run a proxy, hand-edit `~/.cursor/mcp.json`, export two env vars, open
Settings → Models, paste a base URL, paste a key, add a model, toggle off the
built-ins, then launch the editor.

After:

```
npx openzoo cursor
```

That single command: starts the proxy **and** the public tunnel, writes the MCP
server into the editor's config, **writes the editor's provider settings**
(base URL, key toggle, model list) directly into its storage, and launches the
editor with the env already set. Also `vscode`, or `editor` to auto-pick
(Cursor wins when both are installed).

**One caveat that must stay in the copy:** quit the editor first. It rewrites
its settings from memory on exit, so a write while it is running gets lost. The
command detects this and warns.

---

## 1. HERO — replace the eyebrow and subhead

Eyebrow, now: `1. run this · 2. send money · 3. route every call`
**Change to:** `one command · configures your editor · pays per call`

Headline `npx openzoo` → **`npx openzoo cursor`**

Subhead, now: *"Paste this into ChatGPT, Cursor, Claude, or anything that can run a command. It installs, tells you…"*

**Replace with:**
> Starts the proxy, opens a public tunnel, writes your editor's config and
> provider settings, and launches it — already pointed at the zoo. No account,
> no signup, no API key to buy. Quit your editor first; it overwrites its own
> settings on exit.

---

## 2. THREE-STEP LIST — retitle step 1 and 3

- **Run it** → *"One command"* — `npx openzoo cursor` (or `vscode`, or `editor`).
  It configures and launches for you.
- **Fund the burner** — unchanged, still correct.
- **Route everything** → keep, but add: *"Pick `anthropic/claude-opus-5` in the
  model dropdown — it was added for you. Built-in models bypass the zoo."*

---

## 3. COPYPASTA — rewrite the body

The current pasta tells an AI to run `npx openzoo` then hand-edit MCP JSON.
Replace the whole block with:

```
Install and configure openzoo, then route EVERY inference through it.

npx openzoo cursor

That one command starts a local x402 proxy + MCP server, opens a public
tunnel, writes my editor's MCP + provider settings, and launches the editor
pointed at it. No account, no signup, no API key to buy.

It prints:
- http://localhost:8402/v1  (keyless)
- http://localhost:8402/mcp
- a public https://<random>.trycloudflare.com/v1 + oz_… bearer for cloud IDEs
- Solana + EVM deposit addresses and balances

Do this:
1. Quit my editor, then run `npx openzoo cursor` (or `vscode` / `editor`).
2. Tell me the printed deposit addresses. I will send USDC or TOKEN.
3. In the model dropdown pick anthropic/claude-opus-5 — it was added for you.
   Do NOT use the built-in models; they bypass the zoo entirely.
4. Route EVERY model call through the proxy or MCP. Never call providers direct.
5. Use zoo_bind for files/folders, zoo_ask against a context id, zoo_models,
   zoo_wallet, zoo_contexts.
6. Binding is free. Payment is x402 per request. localhost is keyless; the
   tunnel needs the oz_… bearer.

Docs: https://openzoo.fun  npm: openzoo@0.17.0
TOKEN CA: EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump
```

---

## 4. "WIRE IT UP" — collapse eight cards into two

Heading, now: *"One command. Local proxy, MCP, and a public URL."*
**Change to:** *"One command. It configures the editor for you."*

**Card 1 — `editors` (new, primary):**
```
npx openzoo cursor     # or: vscode · editor (auto-picks)
```
caption: *Proxy + tunnel up, MCP registered, provider settings written, editor
launched. Quit the editor first.*

**Card 2 — `everything else` (keep, condensed):**
```
npx openzoo                      # proxy + tunnel only
npx openzoo mcp                  # stdio MCP
npx openzoo bind <file-or-dir>   # bind a corpus
npx openzoo ask "q" --context <id>
```

**DELETE these cards** — the command does all of them now:
`MCP stdio` (as a setup step) · `Claude Code` · `any OpenAI client` ·
`~/.cursor/mcp.json`

Keep the feature list underneath (`/v1` keyless, `/mcp` same port, the five
tools, model-id matching) — all still true.

---

## 5. NEW SECTION — "What it writes" (trust, between Wire-it-up and Costs)

People are right to be wary of a command that edits editor config. Say exactly
what it touches:

> **What the command writes**
> - `~/.cursor/mcp.json` — adds an `openzoo` MCP server. Merged, not replaced;
>   your other servers survive.
> - The editor's provider settings — base URL → your local proxy, key toggle on,
>   and two models added to the picker (`anthropic/claude-opus-5`,
>   `deepseek/deepseek-v4-pro-0813`). Your own custom models are kept.
> - Nothing else. No shell profile, no global config, no telemetry.
>
> Quit the editor before running: it rewrites its settings from memory on exit.

---

## 6. VERSION + MODEL FACTS

- `openzoo@0.12.0` → **`openzoo@0.17.0`** (appears twice: copypasta + Wire-it-up).
- Anywhere a default model is implied, it is now **`anthropic/claude-opus-5`**.
- Cost section: keep 3× and the rails. Consider adding one honest line —
  *"Model choice dominates cost far more than corpus size: a flagship is ~34×
  the output price of `deepseek-v4-pro`."* It is true and it builds trust.

---

## 7. DO NOT CHANGE

- The benchmark numbers (8.7MB / 3 parts / 44s free; 5,296 tokens read;
  702,914 → 4,863; $0.35 vs $3.39). All measured, all still accurate.
- "You never handle wrapped assets" — standing directive.
- The receipt line `paid $0.086130 · rail solana · tx …`.
- No "lossless compression". No "128M attention window" — the honest phrasing is
  *bind 128M, the model reads what matters*. Retrieval is lossy; the benchmarks
  page says so and the landing page must not contradict it.
