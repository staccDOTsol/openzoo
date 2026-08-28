# Project Wiki

## elizaOS fork is the successor to xbot
lib/xbot.js is retiring. Its behaviors live on in the elizaOS fork at
https://github.com/staccDOTsol/eliza, branch `openzoo-port`, local clone
`~/eliza`: `plugins/plugin-openzoo` (x402 keyless inference, OpenRouter
receipt on every reply, $HOME/open* + $HOME/lecore knowledge binding,
HMAC-derived per-group burners keyed `tg:<chatId>` / `x:<userId>`, master
at ~/.openzoo/eliza-master.key), plus forked plugin-telegram (addressed-only
replies, /wallet /balance /topup) and plugin-x (receipt appended pre-send).
**Why:** one agent runtime for both X and Telegram beats two bespoke pollers;
the receipt/burner/knowledge semantics were ported, not reinvented — the shim
(`openzoo` on npm) IS the payment stack the plugin imports.

## eliza monorepo on this Mac needs arm64 node
nvm's default node is x86_64 (Rosetta); bun is arm64, so esbuild-based
builds/tests in ~/eliza fail with a darwin-x64/darwin-arm64 mismatch unless
run with `PATH="/opt/homebrew/bin:$PATH"` (arm64 node).
**Why:** cost several failed builds to diagnose; applies to any esbuild/vite
tooling in that repo, not just one package.

## `claude` on this Mac is open-claude-code, not Claude Code
Both ~/.local/bin/claude and nvm bin/claude symlink to `occ`
(@ruvnet/open-claude-code v2 alpha, since Aug 20). occ hardcodes
api.anthropic.com in callAnthropic, hard-requires ANTHROPIC_API_KEY, and
speaks its own stream-json dialect — it can NEVER route through the zoo
proxy. paperclip-adapter/ therefore vendors real @anthropic-ai/claude-code
as a dependency and defaults to that binary; on Apple Silicon it must be
npm-installed with arm64 node or the darwin-x64 native binary lands (AVX,
dies under Rosetta).
**Why:** cost a long debugging chain of "ANTHROPIC_API_KEY not set" /
"Failed to parse claude JSON output" run failures; applies to anything that
spawns `claude` from PATH expecting zoo routing.

## Paperclip: a stale `npx paperclipai onboard` can shadow the service
The launchd service (ing.paperclip.paperclipai) and a leftover
`npx paperclipai onboard --yes` process can both exist; whichever holds
port 3100 answers the API. When the stale one holds it, adapter
install/reload/reinstall and even `service restart` appear to succeed but
the served code/schema never changes. Diagnose with
`lsof -nP -iTCP:3100 -sTCP:LISTEN` + health `processStartedAt` vs service
PID; kill the squatter, then `paperclipai service restart`.
**Why:** made three rounds of adapter fixes look like they didn't work.

## Paperclip launchd service needs PATH in its plist
~/Library/LaunchAgents/ing.paperclip.paperclipai.plist now carries a PATH
(homebrew arm64 bin first, then ~/.local/bin, nvm bin, system dirs) —
without it launchd's bare default PATH has no `node`, so every
claude-agent-acp spawn (board chat / ACP engine) died in a
"env: node: No such file or directory" crash loop. `paperclipai service
install` REGENERATES the plist and will drop this key — re-add PATH after
any service reinstall. Reload env changes with launchctl bootout+bootstrap,
not `service restart` (restart keeps the old process env).
**Why:** the UI "loops agent name" / dead-chat symptoms all traced to this.

## openzoo PayClient ignores its constructor arg
`new PayClient(burner)` silently pays from the MACHINE wallet — the burner
param was deliberately removed. Per-burner settlement must go through
x402.js primitives (buildPaymentOnline with the burner keypair) and
namespace headers signed by the burner; that is what plugin-openzoo's
src/pay.ts does.
**Why:** xbot's paid lane looked per-asker but was operator-paid because of
this exact trap; do not reintroduce it.

## Orca update_fees_and_rewards fails on an emptied position (0x177c)
`update_fees_and_rewards` requires liquidity > 0 and returns LiquidityZero
(6012 / 0x177c) otherwise — so prepending it to a collect AFTER a 100%
withdraw kills the whole transaction, stranding the fees AND the rent
(close_position refuses a position that owes fees). On a liquidation path
call `collect_fees` alone; the withdraw already settled fees into fee_owed.
The update is only needed on a still-funded position, i.e. during a cycle.
**Why:** cost 52 positions stuck in a half-unwound state and read as
"harvested 0" with no error, because the failure was swallowed.

## doublemint `sweep_lamports` (disc 15) can never work as written
It sets lamports directly on the auth PDA, but that PDA is owned by the
System Program, and only the owning program may debit an account — runtime
rejects with "instruction spent from the balance of an account it does not
own". The fix is a CPI to System `transfer` with the auth seeds as signer
(a system-owned PDA can sign for itself). Needs a redeploy.
**Why:** all four auth-PDA drains failed at liquidation; looks like a
permissions bug, is actually a runtime ownership invariant.

## WzMaL's wSOL ATA is owned by Red1rrqv…, not the wallet
`FCfwoXBHHQxXGghjzxqRvYMwBpikwket6jGyjfwwzuyU` (the canonical wSOL ATA for
WzMaL78s) has its token-account owner field set to `Red1rrqvSVXrfMDWgMM2yX
L573S1JyBrTcm5zWcszcY`, so every Jupiter route that unwraps to SOL aborts
with "owned by … instead of the user". Route to USDC instead, or pass an
explicit `destinationTokenAccount`.
**Why:** silently defeated all 32 dump attempts; nothing about it is
visible from a balance check.

## Birdeye prices our own hub mints off our own pools
APKR7z / Gt2ntb / 31P9ct / 6jfHut / 2zS8ri / 8d1SeJ quote in the thousands
of dollars only because the doublemint pools were their entire market. Once
those pools are drained the marks are fiction. Any USD total that includes
hub mints overstates recoverable value by roughly an order of magnitude.
**Why:** a liquidation report showing "$4,336 recovered" was ~$600 real.

## doublemint offer_set is live: the mint IS the x402 offer (2026-08-27)
Program 5Hn6DXAu… upgraded on mainnet with disc 3 = offer_set restored
(binary 129,840 B, fits the 137,656 B allocation — the "parked for deploy
size" reason is moot). Key spec (written by ~/doublemint/client/offer-set.mjs
--full): x402:v/scheme/network/payTo/asset/amount/resource/timeout/quote —
TOKEN-factual amounts, payTo = auth PDA, quote=pool (USD is derived, never
the quote). janus hub 1 (31P9ct…) carries the first full offer. The fixed
sweep_lamports (System CPI with auth seeds) shipped in the same upgrade.
**Why:** clients can now build a 402 from an RPC read; a server's 402 that
disagrees with the mint is provably lying. Metaplex Agent Registry composes
client-side only (their EIP-8004 services[] can reference the hub mint) —
never CPI into it from the program.

## Dashboard read liquidity from the baked snapshot, not chain
doublemint-dash/api/state.js fetched pairs/mints/treasuries/whirlpools/vaults
live but NEVER the position accounts, so `e.liquidity` was always the
build-time value from data/edges.js. Liquidity is the one field liquidation
changes, so the page showed 268 "live pools" against 29 real ones, printing
stale liquidity next to live (empty) vault balances. Fixed by adding
`e.position` to the fetch set and reading offset 72; a closed position has no
account, which is the only available signal that it is gone.
**Why:** every count on the page derived from that filter, so the whole
dashboard read as healthy while the system was fully unwound.
