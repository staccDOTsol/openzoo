# openzoo-paperclip-adapter

A [Paperclip](https://github.com/paperclipai/paperclip) external adapter that runs
**Claude Code as the harness with [OpenZoo](https://openzoo.fun) as the biller**.
Every inference call pays x402 through the local openzoo proxy from a local burner
wallet — no Anthropic login, no API key.

Registers adapter type **`openzoo_claude`**. It wraps the built-in `claude_local`
adapter, so you keep everything it does — streaming transcripts, session resume,
skills sync, instructions bundle — and only the billing path changes.

## Prerequisites

1. **The openzoo proxy** running locally (defaults to `:8402`), with a funded burner:

   ```sh
   npx openzoo
   ```

2. **Claude Code** on PATH (no login needed — the adapter points
   `ANTHROPIC_BASE_URL` at the proxy):

   ```sh
   curl -fsSL https://claude.ai/install.sh | bash
   ```

## Install

```sh
paperclipai adapter install --payload-json '{"packageName":"openzoo-paperclip-adapter"}'
```

Then verify:

```sh
paperclipai adapter list
paperclipai adapter test-environment openzoo_claude --company-id <your-company-id>
```

Create an agent with adapter type `openzoo_claude` and pick a model from the live
zoo catalog (`anthropic/claude-opus-5`, `x-ai/grok-4.6`, …) — the model list comes
from the proxy's `GET /v1/models`, so it always matches what the zoo actually serves.

## What it sets (and why)

The adapter injects the same environment `openzoo claude` writes:

| Env | Value | Why |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | `http://localhost:8402/v1` | Route inference through the paying proxy |
| `ANTHROPIC_AUTH_TOKEN` | `sk-openzoo` | Gateway auth, not an API key |
| `ANTHROPIC_API_KEY` | *(force-emptied)* | An inherited key **outranks** the base URL and silently bills api.anthropic.com |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` | Claude Code's `/model` picker shows the live zoo catalog |
| `DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT` | `1` | The proxy already binds the transcript prefix and forwards a bounded tail; compaction only loses context |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | `1000000` | Raise the local ceiling the proxy already removed |

## Adapter config

All `claude_local` fields work unchanged (`model`, `cwd`, `promptTemplate`, `env`,
`engine`, skills, timeouts). OpenZoo adds:

| Key | Default | Purpose |
| --- | --- | --- |
| `proxyBase` | `http://localhost:8402/v1` | Proxy base URL |
| `gatewayToken` | `sk-openzoo` | `ANTHROPIC_AUTH_TOKEN` sent to the proxy |
| `keepCompact` | `false` | Re-enable Claude Code auto-compact |
| `contextTokens` | `1000000` | Context ceiling when compaction is off |

Anything you set in `adapterConfig.env` wins over the injected defaults —
overriding the base URL or token is treated as deliberate.

Run results report `provider: "openzoo"` and `billingType: "metered_api"` so
Paperclip cost tracking attributes spend to the zoo, not to a subscription.

## Failure modes

- **Proxy down** → `test-environment` fails with a hint; runs error immediately.
- **Burner empty** → upstream returns HTTP 402; the run surfaces a payment-required error.
