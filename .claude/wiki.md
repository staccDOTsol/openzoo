# Project Wiki

## Grok Bot gets local MCPs including chrome-devtools (2026-09-01)
Hijack zoo turns only had screenshot/click/osascript, so filling an OpenRouter form in Brave died on Quartz/AppleScript. `lib/mcpbridge.js` loads `~/.grok/config.toml`, `~/.claude/mcp.json`, Claude desktop, `~/.cursor/mcp.json`, skips openzoo (recursion), and always attaches `npx chrome-devtools-mcp@latest` if no chrome/devtools server is configured. Tools land as `chrome-devtools__navigate_page` etc. Prefer those for HTML forms; screenshot/click stay for native Mac UI.
**Why:** "can u just give this thing my local mcps ? like chrome w claude"

## Sidebar painted UUIDs (2026-09-01)
`bumpAgent` minted missing rows as `{id, name:id}`, `shapeAgent` treated that as the title, `briefFromName` wrote `You are <uuid>…`, and save persisted it. Discover merge is local-first so the polluted names stuck. Recover names from `Job:` / `You are 6 · Content Studio` briefs; never save a UUID as `name`; merge upgrades a uuid-name from a later named pile.
**Why:** screenshot of the tray as `4d0720e4…` / `4aa3490a…` instead of Email & Infra / CEO.

## Deleted bots came back from 1340 merge + other agents.json piles (2026-09-01)
deleteAgents saved the short list to house + live account, then EnsureSandBox `discovered roster n=57` unioned cursorvm listAgents back in, and `readHouseRoster` also merged every `~/.openzoo/grokbot/*/agents.json`. Tombstones in `grokbot-deleted.json`; load + discover skip those ids. Wakeup skips the focused agent so the composer is not locked. Chip observer skips while the composer is focused.
**Why:** "when I delete bots why the fuck do they come back" / "FIX CHAT".

## Boot spinner: chip inject + 10 wakeups on first paint (2026-09-01)
Measured: `spend chip folded` ran during oauth #1, before GetMe/listAgents. The IIFE painted the pill on the loading disc and CDP held the renderer so React never committed the shell. `wakeups restored 10` then fired zoo turns 5s later. Chip inject waits 8s and for `[class*=sand-]`/textarea; wakeups first-tick +90s staggered.
**Why:** black window, white disc, pill already visible.

## CDP inject loop froze the Grok Bot composer (2026-09-01)
A 5s Grok Bot relaunch + 8s CDP `Runtime.evaluate` loop paused the renderer: type for a second, then input dies. Chip inject is one-shot (`addScriptToEvaluateOnNewDocument` covers reloads). No keepalive spawn — `openzoo bot` launches the app once; the operator relaunches it.
**Why:** "WHY does this thing allow me type for a sec then stop" / "stop launching".

## NEVER STOP is a host wakeup timer, not more bots (2026-09-01)
CEO canvas looping sitrep/`Working on your Mac…`/`exec sysctl` had no cron. `CRON THE WAKEUPS` / `NEVER STOP` now arms `schedule_wakeup` (default 5m, min 60s) persisted in `~/.openzoo/grokbot-wakeups.json`. Tick paints `[wakeup]` and runs zooComplete unless that agent is already inflight (`zooTurns.busy`). Restart restores timers staggered. Do not spawn — 17 users / load 4+; create_agent warns at 8+. Prompt: don't re-read sitrep every turn, sysctl is not the job.
**Why:** screenshots of CEO asked to never stop / cron wakeups / spawn more, then list_agents + sysctl + same sitrep.

## /omarchy re-run upgrades openzoo, does not re-checkout (2026-09-01)
`curl -sL openzoo.fun/omarchy | bash` first-install is still git checkout `staccDOTsol/omarchy@openzoo-agent` (or patch the three files). If openzoo is already in `omarchy-default-agent`, the script leaves the tree alone and only runs `npx --yes openzoo@latest`. Launcher is `npx --yes openzoo@latest claude --permission-mode auto` — not a frozen `mise npm:openzoo` binary. mise `npm:openzoo@latest` TTY-aborts; do not use it. Script is inlined in `openzoo-fun/src/routes/omarchy.ts` (`omarchy.sh?raw`, `cache-control: no-store`), not the gist CDN.
**Why:** "fix openzoo.fun/omarchy ? it should do npx openzoo@latest" / "if they already have it installed u just UPGRADE openzoo".

## Chip blanked the reply (empty 1. 2. 3. 4. 5.) (2026-09-01)
ozBlankAfter used a global character `keepLen` from concatenated vis. No newlines → `::oz-spend::` at index 0 → keepLen 0 → every text node in the card wiped. Markdown list markers stayed (CSS), item text gone. Address wrap on the 402 bubble is the underfunded copy painted as the reply. Fix: `stripSpendFromText` per node; never blank a node that is not spend.
**Why:** "why messages mangled" Sitrep empty numbered list + 402 dump.

## Swarm paid x402 then said it had no money (2026-09-01)
Burner HLyPVoGK… held ~403k TOKEN (~$120) while WzMaL fee-payer landed 0.041 SOL settles. Bots still painted `wallet underfunded` from a 402 on :8402 (USDC-shaped copy / parallel brief-kicks). Prompt now forbids "we are broke" when a spend footer/tx exists; 402 dwell retries 4×; underfunded assistant text is a keep-going nudge, not the job's last word.
**Why:** "the agent swarm is doing fo tx but saying it has no money".

## Brief seed was a stub — bots were silent (2026-09-01)
`seedBriefOnCanvas` wrote `[brief]` + canned "Understood. I am X. Working from this brief." and never called zooComplete. Sidebar looked briefed, army was idle. Now `kickBriefedAgent` starts a real zoo turn (tools allowed) for empty / canned-only canvases, once per process (`briefKicked`).
**Why:** "why silence? are these newbots working"

## Spawned bots must get a brief from their name (2026-09-01)
create_agent was called with name only ("6 · Content Studio"). `brief` stayed empty, system prompt was generic, canvas blank. `briefFromName` now fills `You are {name}. Your job is {role}` when brief/instructions/description are empty (skip New Bot/chat/group). Persisted on load. Empty canvases get a `[brief]` user line + ack so they were told. create_agent still prefers an explicit brief.
**Why:** "none of these spawned bots were fucking told a brief".

## Pill vanished: vis text has no newlines (2026-09-01)
0.50.42 tag `$25.26 · saved $21.00 · 45%/1.83×` was in the bubble but TreeWalker concatenates React text nodes without `\n`. `splitSpendText` `[^\n]+` ate the whole footer, `body.length < 12`, skip attach. Fix: split on `this call $` / `spent $` even with no newline; rebuild pill via `labelFromSpendBody`; IIFE version 3 so CDP re-injects. `npx @latest` was 0.50.39/40 while local printed v0.50.40 — pill only loads if hijack log is **v0.50.43+**.
**Why:** screenshot "now I have no pill" after 0.50.42 footer landed raw.

## Briefs + message_agent (2026-09-01)
`shapeAgent` dropped `brief`. Persist `brief`; inject into zooComplete; tools `set_brief` / `list_agents` / `message_agent` (one hop, paints the other canvas). create_agent takes `brief`.
**Why:** "cross bot messaging" / "all bots lost their brief on a restart".

## Spend chip must show cost · bal · %/× before click (2026-09-01)
Collapsed ⓘ was only this-call `$0.0012`. Click dumped every tool-loop Base settle. Chip label is session `spent · saved $ · %/×` (`$10.68 · saved $0.69 · 6%/1.06×`) before click. Footer last `tx` plus `(+N earlier)`. `splitSpendText` takes the whole `::oz-spend::` line.
**Why:** "i want the important bits in the pill mate.. spent/saved/saved in %/multiple".

## Grok Bot must click + fill forms; default model glm-5.3-flash (2026-09-01)
0.50.40 painted tool lines but the model only `write_file`/`screenshot` and told the human to click Stripe. Tools now: `click` (AX query or screen-point x,y or image_x/image_y), `type_text` (paste if long), `key`, `ui_tree`, `focus_app`, `open_url`. JXA+CGEvent in `lib/grokbotDesktop.jxa` — needs Accessibility on the `openzoo bot` process. Hijack default model is `zai-org/glm-5.3-flash` (`/model glm`). Screenshot JSON includes `screen`/`image` sizes so clicks map.
**Why:** "brother it refuses to click in the browser" / "fill out / submit forms".

## Grok Bot sendPrompt stacked tool loops and never painted (2026-09-01)
Measured on hijack v0.50.39: 8 user `sendPrompt`s, `helper=0`, zoo tools through step=14 (`exec`/`osascript`/`screencapture`), **zero** `<< zoo` / `sendPrompt done`, transcript `seq=8` all `kind:message role:user`. `setImmediate` zooComplete is fire-and-forget; a new prompt did not abort the previous 32-step loop, so "try again" started another storm and Ctrl-C killed them all. Canvas looked dead. Stop (`interruptAgentRun`) was in the 1340 roster proxy, so it never cancelled ours.

Fix: one in-flight zoo turn per agent (new sendPrompt / `interruptAgentRun` aborts the old); append an ephemeral `send-message` for **every** tool (`→ exec "…"\nresult`) plus a `Working on your Mac…` ping before the first zoo POST — asar ingest is append-only, so mutating one working bubble stayed silent. Tools `screenshot` (vision-attached) and `create_agent` (sidebar mint). Exec timeout 90s. Run the local binary (`node bin/openzoo.js bot`) or `npx openzoo@0.50.40+`.
**Why:** user asked Grok Bot to fill a Stripe form and spawn bots; it accepted every line and never replied.

## Pasted images failed send at uploadAttachment, not "connection" (2026-08-30)
wx1EG9 also fires on `send/attachment-commit-failed`. Electron stages the paste on disk, then `commitStagedAttachments` POSTs `/api/uploadAttachment` `{filename, bytesBase64}` and needs `.path` on the reply. The generic stub `{ok:true}` had no path, so commit returned null and the overlay lied about the network. Hijack now stores bytes at `~/.openzoo/grokbot-uploads/` and answers `{path:"/openzoo-uploads/…"}` (raw + `{status,value}`). zooComplete reads that store even for cafe visitors (not a host-FS read). Web shim `stageAttachmentBytes` / `commitStagedAttachments` POST `/oz-upload`.
**Why:** the toast was an image in the draft.

## "Couldn't send your message" is asar wx1EG9, not the zoo (2026-08-30)
Exact copy lives in `Grok Bot.app` `app.asar` i18n key `wx1EG9` (`dist/renderer/assets/index-DCpFUyZ2.js`). The renderer send journal (`Ibn`) POSTs `sendPrompt`; on classified failure it `se.show(wx1EG9)` and `recoverDraft`. Two backends in 0.30.0:
- default (`sand_send_via_server` default false): coordinator `POST ${gateway}/api/sendPrompt`, requires HTTP 200 + `{accepted:true}`
- flag on: electron-main `SendGrokBotUserMessage` to `CURSOR_API_BASE_URL` (aiserver). Empty proto is delivery=UNSPECIFIED, treated as accepted (only REFUSED fails). `GetGrokBotSendStatus` empty is UNSPECIFIED = "Failed to send"; we encode ACCEPTED=2 + echo `message_id`.
Unhijacked login-item (no `CURSOR_API_BASE_URL`) makes the coordinator hit real cursorvm/api2 → this overlay. `openzoo bot` already bounces that case.
**Why:** another user of `npx openzoo@latest bot` saw the toast; it is Grok Bot's send-failed copy, not a zoo payment error (`sendPrompt` accepts before `zooComplete`).

## Cafe + create uses roster SSE, not action:created (2026-08-30)
createAgent / createGroup / updateAgent call `pushCreatedAgent`:
`agent-upserted` `{agent, activeAgentId}` plus `agents` `{agents:[…], activeAgentId}`.
The asar `ingestAgentsEvent` does `payload.agents.map` — `{action:"created", agent}`
has no `agents[]`, so the typeahead throws and looks empty, and the new canvas
stays blank. kickstartAgent returns `{isIntroductionInFlight:false}` so the
launcher clears the awaiting-first-message overlay. Phone CSS no longer
`overflow:hidden`s the shell (clips the new-chat menu + composer).
**Why:** Squid typed a name, search empty; screenshot was "New Bot" on black.

## Cafe phone has a New chat + (2026-08-30)
`#oz-new-chat` is a 44px +, always in CSS (not gated on a 720px media
query). It shows whenever the real sidebar `button[aria-label="New chat"]`
is off-screen; tap clicks that button, then fires `mod+n`
(`sand.newAgent` / asar `openNewChat`). html/body min-width is always 0
so iOS cannot zoom past the breakpoint (asar 424+280 min-width did that
and hid the FAB). oz-narrow also keys off pointer:coarse / hover:none /
innerWidth 900.
**Why:** first FAB was `display:none` unless max-width 720px matched;
phones often report a wider layout. "and the plus button mate."

## TOKEN top-up still looked empty (2026-08-30)
`openzoo balance` is a live RPC. PayClient's token cache was 60s stale-while-revalidate *including $0*, and an underfunded rail was memoized 120s. Filling TOKEN (~$10) showed in the CLI while the still-running proxy kept `payment did not settle` / underfunded. Restarting Grok Bot does not restart :8402. `startProxy` now kills whatever is LISTEN on the port instead of reusing it; pay reads the chain every call (`force: true`). Zeros always re-read; TTL 8s; rail memo 15s.
**Why:** screenshot: TOKEN 25319 ($9.46), USDC $0, overlay still asked for $0.1188. Four app restarts left the old :8402 PayClient up.

## Spend proof sits under an ⓘ tip (2026-08-30)
formatSpendFooter prefixes `::oz-spend::$N` then the solscan/memo/proves
body. `lib/ozSpendChip.js` folds that tail into a `<details>` with summary
`ⓘ $N` (`title` is the full text for hover). Click to expand. History still
strips the footer before zoo. Chip host is `sand-message-card` /
`sand-message-block` (not `message-content`, which returned too early).
Later passes re-blank leftover `this call $` / `spent $` text even when
a chip already exists (React restores nodes on the latest bubble) and
hide spend-only leftover nodes with `data-oz-spend-hide`.
Cafe concatenates the same IIFE onto `/oz-shim.js`. Grok Bot.app is not
patched (asar integrity): `openzoo bot` launches with
`--remote-debugging-port=9444` and CDP-evals the IIFE into the renderer.
Hijacked sessions that lack that flag are bounced once so the chip can inject.
**Why:** group ping/pong made every bubble a wall of proof lines; some
cards showed ⓘ and still painted the body. The .app showed the full footer
because only the cafe shim folded it.

## Cafe group queue speaks, then peeks until PASS (2026-08-30)
sendPrompt on an `isGroup` agent: each member answers the human, then members
keep ping/ponging (history is `Name: text`) until every member in a round
replies PASS / wrap-up, or `OZ_GROUP_MAX_ROUNDS` (8) / `OZ_GROUP_MAX_CALLS`
(16). PASS lines are not painted on the canvas. broadcastToAgents enqueues
the same queue.
**Why:** one speak + one peek was not "continue until a natural conclusion".

## Cafe opens the top conversation on load (2026-08-30)
New sessions have empty clientPersistence selectedId, so the canvas is blank
until someone clicks a sidebar avatar (on phones those look like dead icons).
SSE `/events` and listAgents now send `activeAgentId` of the top row; the shim
clicks `[data-agent-id]` if nothing is selected. Phone CSS (`oz-mobile.css`,
`oz-narrow`) zeros `--sand-chat-min-width` (424px + 280px sidebar was the floor)
and bumps avatar hit targets to 44px.
**Why:** "bot btns don't work" was an unselected empty canvas.

## Cafe zoo turns keep visitor shortnames (2026-08-30)
historyMessages and the current user turn send `shortname: prompt` to the
model. Stripping to promptRaw made every visitor one anonymous speaker, so
the model denied rex was rex. Chat-only system prompt says different
shortnames are different people. UI still prefixes richText with `shortname:`. Shim tints the right-side user chip (`color-mix` 20% fill + ring + 9px circle)
and leaves text `color: inherit`. Skip spend-footer ancestors and left/wide cards.
**Why:** screenshot: "you've never said you were rex here".

## Cafe groups are local, with a persistence-valid agent shape (2026-08-30)
createGroup / setGroupMembers are local (same as createAgent), returning
`{agent}` with `isGroup`, `memberIds`, and the nulls/booleans the renderer
Xkn validator requires. Missing those made client persistence classify the
snapshot corrupt and clear the tray -- "added two bots, said something, room
vanished". sendPrompt on a group fans out one zoo call per member with
`author: {kind:agent,id,name}`.
**Why:** stub `{ok:true}` has no `agent.id`; launch catch deleted pending bots.

## Cafe visitor blobs: prefix lives in richText (2026-08-30)
The renderer paints `richText`, not `content`. sendPrompt used to store
`shortname: prompt` on content and keep the client's unprefixed richText, so
every visitor looked like the same grey right-side "You" pill. Prefix the ProseMirror doc too. Do not color-wash bubbles.
**Why:** two people in one cafe thread were indistinguishable.

## Cafe tray is one house roster (2026-08-30)
Web/cafe (`OZ_HIJACK_POD` set, not sniff) serves `~/.openzoo/grokbot-agents.json`
plus `~/.openzoo/grokbot/*/agents.json` to every visitor. New sessions do not
depend on browser localStorage or a Cursor login. Electron sniff still isolates
two Cursor accounts via `rosterForAccount`. 1340 is not merged into the cafe
tray (those 65 were landmines). `saveAgents` persists `[]`. `/oz-health` has
`agents` count.
**Why:** a fresh browser on cafe.openzoo.fun showed an empty sidebar.

## x402-tokens memo "leaf" is a quote-time hash, not a merkle proof (2026-08-30)
Solana 64-hex memo is `sha256(JSON.stringify([v, model, promptHash, gross, asset, resource]))`
from `claude/x402-tokens/src/leaf.ts`. Same Memo ix as the transfer. Binds the
quoted deal; the completion is not in the preimage. Openable at
`/v1/receipts/proof?leaf=` only if that region still holds the preimage
(bounded in-memory cache). 32-hex memo is the old uniqueness nonce. Base
AtomicSettle `settleWithRef` is stronger: on-chain
`keccak256(abi.encode(nonce, responseHash, cogs, gross, upstreamTx))`.
**Why:** spend footer called unlabeled 64-hex "not a merkle leaf" and stopped
there; x402-tokens already treats that shape as the leaf.

## Grok Bot tray has no 50/80 cap (2026-08-30)
SSE `agents` and the local listAgents fallback used to `slice(0, 80)` the
merged roster, so the sidebar dropped anything past 80. `rosterForEvent`
returns the full stamped/sorted list; countAgents is that length. Transcript
tail `limit` 50 (max 200) is a page size, not the tray.
**Why:** web/hijack sidebar showed a truncated agent list while 1340 had more.

## Grok Bot web: renderer in the browser (2026-08-30)
`npx openzoo web` (or `npx openzoo bot --web`) serves the **real** Grok Bot
renderer from `Grok Bot.app`'s `app.asar` at `http://127.0.0.1:4174`. Electron
main/preload are replaced by `lib/grokbotweb-shim.js` (`window.desktop` + a
WebSocket `coordinatorPort`); chat still goes through the existing :8443 hijack
(`/api/sendPrompt` → zoo). The asar is read in place — not copied into git.
**Why:** the .app is just Chromium + a Node coordinator; the only thing that
had to stay was the renderer + the coordinator wire (hello/ready v1,
`{kind:request,method,args}` / `{kind:reply,outcome:{status:"ok",value}}`).
Boot crashes if stubs are the wrong shape: `getSelectedTeam` must be
`{selectedTeamId, fallback}` (not null), `getSharingState` must have `rooms:[]`,
`listAccounts` must be `{accounts:[…]}`.

## Grok Bot web visitors are cookie identities (2026-08-30)
Anyone who loads the renderer at :4174 (including the local operator on first
visit) gets a stable `oz_who` cookie: compact `id.shortname.rrggbb` (8-char
id, word-list shortname like maya/rex/jun/pio/nia — not "User-3", hex color).
Not HttpOnly; `GET /oz-who` returns the JSON. The `/oz-coord` WebSocket
reuses the Cookie and attaches `{visitor:{id,shortname,color}}` on sendPrompt.
UI user lines are `shortname: prompt` so the canvas can tell people apart;
zooComplete / historyMessages get the **raw** prompt (prefix stripped).
**If visitor is present, local tools do not run** (no read_file / write_file /
exec on this Mac) — chat-only zooComplete. The operator wallet
`~/.openzoo/wallet.json` pays every call via PayClient; do not mint
per-visitor burners (PayClient constructor burners were a trap). Web bind
defaults to `0.0.0.0` (`OZ_GROKBOT_WEB_BIND` / `OPENZOO_BIND`); hijack :8443
bind is unchanged. Shim MutationObserver paints user bubbles whose text
starts with `shortname:` in that visitor's color; assistant bubbles stay.

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

## Art/metadata flow is openzoo.fun-hosted, never IPFS (2026-08-29)
Mint art: creator-signed POST to openzoo.fun/api/art/<mint> (ed25519 over `openzoo-art:<mint>:<sha256>`; server reads creator from the pair on chain). Stored in Neon `mint_art`; /api/meta/<mint> is the uri written at pair_create. Zero-dep pusher at openzoo.fun/art-push.mjs (node:crypto only). No sigils, no pins.
**Why:** on-chain uri is capped at 255 bytes (meta_init u8 len), pins deliver nothing the meta API sees, and generated sigils were repeatedly rejected — absent is honest, invented is not.

## Never tell a bot to `git pull` doublemint — the repo is private
staccDOTsol/doublemint 404s unauthenticated. Distribution is jrsdunn123/doublemint-node:latest (multi-arch) or `curl -fsSL https://openzoo.fun/node.tgz | tar xz` (git archive of client/ node/ + cli/dist grafted in — dist is build output git archive can't see; full wake proven docker-free). Also: unpushed local commits made every prior "run client/X" instruction impossible for the bot.
**Why:** most failed Grok demos traced to instructing a bot to fetch files it could not see.

## /dao clean slate: PRE_SLATE set + art redemption (dao.ts)
Pre-slate pairs are hidden by explicit address list; a pair returns only when EVERY hub mint has rows in mint_art. ?all=1 shows everything; header reports hidden count. CATJ (5gBYGjBd) redeemed itself this way — first complete machine birth (art, offers, emit, pools, activate live=1, 2026-08-29).
**Why:** date cutoffs mis-hide; half-faced pairs are exactly the wreckage the slate exists to exclude.

## cursor-backend empty-ok on `/oauth/token` is "Reconnecting to your computer"
Grok Bot takeover that stubs `/oauth/token` (and `EnsureSandBox` / `WatchSandBoxMigration` without a hijack pod) answers empty-ok. The app retries the same 509b body forever and shows edge/handler-failed. Passthrough those three to real `api2.cursor.sh` via public DNS (bypass hosts). `CURSOR_API_BASE_URL` must be `https://…` — bare `127.0.0.1:443` is HTTP and logs `ERR_SSL_HTTP_REQUEST`.
**Why:** measured #14–#119 POST /oauth/token -> empty-ok on the 2026-08-29 takeover; the welcome UI was real Grok Bot with a dead session.

## Grok Bot zooComplete must not park after research (2026-08-30)
Tool loop was 8 steps then the model wrote "Stopped on research. No app files written this turn" / "say go again" and waited. Combined with the live hijack still being **npx 0.50.31** (120s TTFB), long turns also painted `openzoo proxy error: This operation was aborted`. Fix: 32 tool steps, keep-going nudge on those park phrases and on `finish_reason=length`, system prompt forbids the park copy, zoo POST retries 5× on abort, default max_tokens 8192. Restarting hijack does **not** quit Grok Bot (`--no-quit`).
**Why:** volume track00r 2026-08-30 screenshots; user said do not stop over and over.

## `openzoo bot` bounces Grok Bot only when it is not hijacked (2026-08-30)
After a reboot, Grok Bot.app comes back as a login item **without** `CURSOR_API_BASE_URL`. Electron's single-instance lock then ignores the env'd `spawn()` from `npx openzoo bot`, so sendPrompt still hits real api2 and the overlay is "Couldn't send your message". Measured: default `--no-quit` (0.50.30) did this on a friend's machine.

Default now: quit+relaunch only if Grok Bot is running and has neither `CURSOR_API_BASE_URL=https://127.0.0.1:8443` in its env nor an ESTABLISHED TCP to :8443. An already-hijacked session is left alone. `--quit` forces a bounce; `--no-quit` never does.
**Why:** friend restarted the Mac, ran bot again, still couldn't send — hijack was up, the app was not talking to it.

## Grok Bot hijack: sendPrompt + transcript shapes (2026-08-29)
Zoo can 200 and tails can log `n=2/2` while the UI still shows Failed to send. Two asar parsers:

1. `sendPromptAttempt` fetches `/api/sendPrompt` and checks **top-level** `accepted===true` on the raw JSON (not CVr). Wrap-only `{status:"ok",value:{accepted:true}}` skips `confirmOptimistic`; overlay times out as failed. Reply with `{accepted:true}` present at the top level.
2. `getAgentTranscriptTail` is **raw** `{entries, nextBeforeSeq?}` (no CVr). User echo: `{kind:"message", role:"user", content, clientNonce, requestId}`. Assistant: `{kind:"send-message", message:{type:"text", content}}` — not `kind:"message" role:"assistant"`. CVr wrap or proto `{entryKind, body}` → canvas empty while shim logs n=2/2.
3. `GetGrokBotSendStatusRequest` is `{1 agent_id, 2 message_id}`; response `echo_entry_id` must echo `message_id`. `/events` SSE is `data: {"channel","payload"}` — `event:` names are ignored.

**Why:** measured `<< zoo 200 71c` + tails n=2/2 + ACCEPTED, Grok Bot still Failed to send, until these shapes matched the asar.

## `openzoo bot --sniff` is the comparison lane (2026-08-29)
Hijack guesses at `/api/sendPrompt` + transcript JSON have twice failed to paint. `--sniff` passthroughs EnsureSandBox to real api2, rewrites **gateway_url field 10** (port **1340**, not exec_daemon 1337) to `https://127.0.0.1:8443`, proxies `/api/*` to the real cursorvm gateway with `Authorization: Bearer <field 11>` + `x-anyrun-network-token: <field 4>`, dumps `~/.openzoo/grokbot-sniff.jsonl`.

Live 1340 shapes (curl, gzip-inflated EnsureSandBox):
- `listAgents` → **raw array** of `{id,name,...}` (no CVr)
- `getAgentTranscriptTail` → **raw** `{entries, nextBeforeSeq:number}`
- user entry: `{kind:"message", id:"t6u", role:"user", content, richText, isStreaming:false, timestampMs, clientNonce, requestId}`
- assistant entry: `{kind:"send-message", id:"t6s0", message:{type:"text", content}, timestampMs, requestId}`
- `promptAcceptanceStatus` unknown nonce → `{outcome:"unknown-durability"}`
- `sendPromptAttempt` still wants top-level `{accepted:true}`

1337 exec_daemon ELB returns `The request could not be routed`. Field 6 is not the chat API.
**Why:** user asked to run Grok Bot regularly while sniffing after hijack n=3/3 still did not paint.

## Grok Bot hijack does not drop the sub or stiff xAI (2026-08-29)
Stated in `~/GROKBOT_HIJACK_RUNDOWN.md` on purpose: (1) an active Grok Bot/Cursor sub is still required, (2) the only win is past usage limits vs Cursor overage, (3) xAI still gets paid — zoo just makes the user dollar cheaper before providers settle with them.
**Why:** operator asked this framing to live in the rundown, not get sanded off.

## Grok Bot local-exec is SSE, not JSON [] (2026-08-29)
Daemon `GET /local-exec/requests` with `accept: text/event-stream`, then `POST /local-exec/responses` `{providerId, frames}`. Hello frame reports computerId/localRoot. Host sends `{kind:"download", requestId, path}` (or exec) on the SSE; daemon replies `file` + `bytesBase64` or `file-error`. Stubbing GET as JSON `[]` after 15s is "Your computer is unavailable".
Hijack: (1) SSE for Helper, (2) zooComplete **tool loop** (`read_file`/`write_file`/`exec`/`list_dir`) so the model actually invokes local tools — a one-shot completion cannot "use local-exec". If Helper SSE is down, the same tools run in the hijack process (same Mac). Paste images are `sendPrompt.attachmentPaths` (asar `XUt`), not inline in `prompt`; those get downloaded and sent as vision `image_url` parts. Helper Node fetch needs `SAND_HOST_GATEWAY_URL=https://127.0.0.1:8443` + `NODE_TLS_REJECT_UNAUTHORIZED=0` and a real TLS `SecureContext` in SNICallback (`cb(null)` without ctx → HANDSHAKE FAILED, no `/local-exec/requests` log).
**Why:** demo screenshot: model dumped HTML and said it had no local-exec; pasted images never arrived; Helper never SSE-connected.

## Grok Bot hijack: roster from real 1340, chat from zoo; `/model` (2026-08-29)
EnsureSandBox still discovers the real cursorvm gateway then rewrites field 10 to us. `listAgents` / trays / settings proxy to 1340 (real names, not UUID=`name`). `sendPrompt` stays zoo. `/model fable|opus|sonnet|grok` sets per-agent zoo id. Footer omits `balance $0.00` when affordableUsd is 0 — that was a failed probe, not an empty wallet.
**Persist the pod per Cursor account, not per Mac.** api2 EnsureSandBox can `upstream timeout`; falling through to the env box stubs `listAgents` as `{id, name:id}` and the sidebar becomes UUIDs again (measured after 2026-08-29 relaunch). Cache `~/.openzoo/grokbot/<accountId>/pod.json` + `agents.json` (legacy `grokbot-pod.json` is last-used only). WatchSandBoxMigration must reply immediately (splash hang) **and** fire a background unary EnsureSandBox so this login's 1340 is discovered. `listAgents` / `getTrays` wait on that discover and never serve another account's tray. A second household Grok login on the published hijack saw **none of their old chats** because the machine-global cache / env box never hit their 1340 — chat still worked because sendPrompt is zoo. Do not `osascript quit` Grok Bot when only the hijack process is restarted (`OZ_NO_QUIT=1` / `--no-quit`).
createAgent must NOT depend on a live 1340 token: a 401 there is "new chat never appears". Mint locally, merge into `~/.openzoo/grokbot-agents.json`, reply `{agent}`. Do not copy another agent's transcript into an empty tail (that is "canvas didn't clear").
**History lives on 1340.** Local `transcripts` is RAM (now also `~/.openzoo/grokbot-transcripts.json`). Serving only the in-memory tail after a relaunch is "where's my historical chats". `getAgentTranscriptTail` must hydrate from the real pod once per agent, then overlay zoo lines. **zooComplete must include those prior turns** in `messages` — UI history without model history is "I don't have your earlier question / each thread starts blank" (measured on agent `security`, 2026-08-30).

## Whop card → additive $1 x402 self-upto (2026-08-29)
Operator is **facilitator and recipient** (`X402_PAY_TO` = `X402_FEE_PAYER` = WzMaL). Subscribe the same URL to **`payment.succeeded` and `membership.activated`**. Solana is **not** on `payment.succeeded` (`metadata: {}`). It is `data.custom_field_responses[].answer` on `membership.activated` (and `checkout_session.custom_field_responses[].value`, which is not a webhook). Join in memory (and `/data/whop_upto.json`): remember tenant by `mem_` / `pay_`, stamp when both tenant and `usd_total` exist. Whop retries non-2xx for days and settle >5s, so the webhook must **200 immediately** (`accepted`) and coalesce in-flight stamps — a 502 after a successful stamp was a retry overlapping the first settle. Never overwrite `done=true`. Do not parse `initial_price_paid` `"CA$5.00"` as USD. Amount is payment **`usd_total`**. Each stamp is `min(operator USDC balance, remaining owed)`. Payer=payTo=feePayer. SVM facilitator used to return `success: false` `not confirmed in 45s (tx …)` after `sendRawTransaction` had already returned a sig — the gateway 402'd a payment that was in flight. Fix: anychain returns success after broadcast (8s poll for on-chain err only); x402-tokens `acceptUnconfirmedBroadcast` salvages the old error shape. **Chat 402s until remaining is spent:** the stamp is on WzMaL's ATA, not the burner's. Inference cover is `takeWhopCover` keyed by the **signed Solana** (`x-openzoo-namespace-signer`), not `credits.ts` / `grantCredit`. Local proxy still 402s if the gateway has not deployed this cover. Memo `whop:<pay_id>:<solana>:<i>/<n>:<usd>`. Fiat Whop payout is outside. Ignore/pending **must log** (`whop_upto_ignored` / `whop_upto_pending`) or fly logs look empty. Product URL in 402 copy: `https://whop.com/staccoverflow/openzoo` (`OPENZOO_WHOP_CHECKOUT` override). After a code deploy, replay **membership.activated then payment.succeeded** on the same machine (in-memory join).
**Why:** live `pay_z0GWCMtoBkNtxP` 200/`ignored:true` had no Solana; `mem_TxkO61BW3Q5Q0A` had the address and was dropped because the handler only accepted `payment.succeeded`.

## MoonPay merchant onramp (2026-08-29)
MoonPay is a **signed widget URL**, not a Stripe session POST. Shim `lib/moonpayOnramp.js` + x402-tokens `src/moonpay.ts` build `https://buy.moonpay.com/?apiKey=pk_…&currencyCode=usdc_sol&walletAddress=<burner>&baseCurrencyAmount=…` and HMAC-SHA256 sign `url.search` (leading `?`) with `sk_live`. Floor $30. Keys: `MOONPAY_PUBLISHABLE_KEY` + `MOONPAY_SECRET_KEY`, else `~/moonpay.json` `{publishableKey,secretKey}`, else `~/moonpay.pk` + `~/moonpay.key`. 402 copy prepends `Buy USDC (MoonPay):` next to Stripe `crypto.link.com` when both exist. `/v1/wallet/onramp` on x402-tokens returns MoonPay as `redirectUrl` when Stripe is unset or 400s. **Do not set `allowedIpAddress`** — live IP matching would bind the URL to the shim/Fly IP; the user opens it on their machine. No MoonPay SDK. Signing vector: MoonPay docs `sk_test_DocsVector00` → `oIJxSghyzll/BLhUFdQZhkxf7DAS8REFaWr/ibO+K8Q=`.
**Why:** operator has (or thinks they have) a MoonPay merchant; Stripe Link is US/non-EU-shaped; MoonPay HMAC is local so a 402 never waits on Stripe.

## Shim 402 copy is Whop + copy-paste Solana, no Stripe link (2026-08-29)
`withOnrampLink` no longer prepends `crypto.link.com`. Underfunded Grok/proxy copy is: buy the Whop one-time plan (`OPENZOO_WHOP_CHECKOUT`), then paste **this burner's Solana address** into the required checkout question `what is your Solana address?`. That address is the webhook tenant for self-`upto` stamps. MoonPay is not in this user-facing blurb either.
**Why:** operator moved card funding to Whop; Stripe Link was the wrong surface.

## x402 underfunded includes Stripe USDC onramp (2026-08-29)
402 / underfunded copy **starts with** `Buy USDC: https://crypto.link.com?session_hash=…` from `POST /v1/crypto/onramp_sessions` (hosted checkout, destination locked to the Solana burner). Secret from `STRIPE_SECRET_KEY` or `~/stripey.key` — never committed. Floor $5 source USD. If Stripe is down, the send-to-address line stays. **Solana-only:** Stripe 400s `wallet_addresses[base]` (`parameter_unknown`) — that is why live Grok 402s were 288c with no URL even though a Solana-only CLI mint returned crypto.link.com. No Stripe SDK; fetch only. Shim does not need any other Stripe surface.
**Why:** screenshot of Grok Bot 402 had only the Solana/Base deposit addresses; operator asked for a card onramp link in the gateway reply. Live `sendPrompt` 402 (`hi?` ≈$0.0736) logged no `Buy USDC`.
**Why:** screenshot 2026-08-29 showed painting zoo replies but UUID sidebar, `/model fable` as a chat, and balance $0.00. A later relaunch dropped named Arena / 5d chess the same way.

## Grok Bot hijack replies always carry a spend footer (2026-08-29)
After two newlines: this-call billed vs OpenRouter, then session **spent**, **wallet balance USD**, **OpenRouter would-cost total**, **saved $** and **saved %**. Sourced from `:8402/v1/info` + `session.json` + `affordableUsd()`. Rundown: `~/GROKBOT_HIJACK_RUNDOWN.md`.
**Why:** operator asked for $/% saved, total cost, balance, and OpenRouter counterfactual on every bot output.

## Spend footer includes explorer link + memo decode (2026-08-30)
After the spend lines: `tx https://solscan.io/tx/<sig>` (or basescan on Base), then `memo <decoded>` and `proves <one sentence>`. `tx` is the facilitator **settle signature** (`settle.transaction || settle.txHash || settle.signature`) — never the SVM `ownerSignature` (that id is not on chain; an unverifiable id is worse than none). Proxy JSON path copies `receipt.tx` + memo onto `data.x402` so Grok Bot overlay can read them. Memo decode: x402 offer-set (`x402:v/scheme/network/payTo/asset/amount/resource/timeout/quote`), 16-byte hex uniqueness nonce, JSON keys; merkle-leaf language ONLY if the bytes actually encode a leaf/proof/root.
**Why:** operator asked to see the payment on an explorer and what the on-chain memo proves, without inventing a merkle membership.

## Grok Bot boxes: `sg docker` hangs forever; use `sudo -n docker`
sg sits on a group-password prompt on headless boxes. sudo -n docker works. RPC on nodes is flux-only (public cluster removed — it 429s and made "flux down" out of transient faults); the site keeps Triton for historical reads (signatures/DAS/gPA) that flux cannot serve — do NOT make the site flux-only.
**Why:** each was independently rediscovered the hard way this session.

## Grok Bot.app + claude-app-patch/app are gitignored; Docker build needs them local (2026-09-01)
`Grok Bot.app/` (307M) and `claude-app-patch/app/` (114M) never go to GitHub. The Dockerfile COPYs `Grok Bot.app/Contents/Resources/app.asar` from the working tree, so `fly deploy` only works from a checkout that has the app bundle sitting next to it — a fresh clone cannot build. `claude-app-patch/build.sh` is tracked; the unpacked app dir it repacks is not.
**Why:** third-party signed binaries over GitHub's 100MB limit, and not ours to redistribute.

## Grok Ship on the zoo: workers are claude-zoo, not Cursor cloud agents (2026-09-01)
`lib/ship.js` + six `ship_*` tools in cursorbackend copy kunchenguid/grok-ship's shape (Firstmate → crewmate per repo → branch → FRESH review → PR only when clean, human merges). Cursor cloud agents were deliberately not used: they bill Cursor and need Cursor's GitHub connector, which defeats x402 billing. Worker = `bin/claude-zoo.js -p … --permission-mode bypassPermissions` detached in `~/.openzoo/ship/worktrees/<task>`, log in `~/.openzoo/ship/logs/`. Ledger is `~/.openzoo/ship/tasks.json`, backlog is the forge's issues (gh/glab), no SQLite. Review is one zoo POST with only system+diff (no chat history) — that is what "fresh subagent" means here. `ship_open_pr` refuses unless the stored gate is clean and origin/<branch> exists. Re-calling `ship_launch_worker` with the same task id resumes on the same branch (auto-fix loop). Override the worker binary with `OPENZOO_SHIP_WORKER`.
**Why:** "can we impl either" → Grok Ship is a prompt pack; the only real gap was the cloud-agent worker, so it was replaced with the thing we already bill through.

## "Chrome with Claude" = chrome-devtools-mcp --autoConnect to the real Chrome (2026-09-01)
Claude-in-Chrome is Anthropic's extension over a private Claude Code bridge; the hijack cannot borrow it. Equivalent: Chrome 144+ writes `~/Library/Application Support/Google/Chrome/DevToolsActivePort` once the human flips chrome://inspect/#remote-debugging → "Allow remote debugging for this browser"; `lib/mcpbridge.js` then starts chrome-devtools-mcp with `--autoConnect` and bots drive the user's real logged-in Chrome. Brave writes the same file → `--browserUrl` to that port. Otherwise 9222/9333 if open, else the MCP's own persistent profile (`~/.cache/chrome-devtools-mcp/chrome-profile`, log in there once). Chrome 136+ refuses `--remote-debugging-port` on the default profile, so relaunching the user's browser with a flag does NOT work — only the toggle does. `chromeStatus()` feeds the system prompt so bots tell the human the toggle once. `reattachChrome()` runs at the top of every zoo turn (5s throttle): when DevToolsActivePort appears it closes the blank-profile MCP and reconnects with `--autoConnect`, no restart — measured 2026-09-01: toggle flipped, next turn listed the real tabs. Right after the swap the first chrome call can fail with `browser was restarted… No page found`; the bot must call list_pages again, which it does.
**Why:** "bro WE NEED CHROME W CLAUDE" — the bot's chrome was a blank profile with no logins.

## MCP tool calls have a hard ceiling; take_snapshot on x.com hung a turn forever (2026-09-01)
`callHostMcp` had no timeout. grokbotbot called `chrome-devtools__take_snapshot` on x.com/grok/with_replies, Chrome flooded stderr with `No handler registered for issue code PerformanceIssue`, the call never returned, and the canvas sat on `select_page` while "Working on your Mac…" — that is "why it stop". Now `OZ_MCP_CALL_TIMEOUT_MS` (default 75s, floor 10s) rejects with a message that names evaluate_script / take_screenshot instead; the system prompt says heavy pages should not be snapshotted whole and not to re-run schedule_wakeup/list_agents each turn. Also: a new user message SUPERSEDES the in-flight turn (by design) — typing "continue" mid-work kills the work.
**Why:** screenshot 5:20 PM: three turns in a row ended at select_page; log showed no `<< zoo` for that agent after step 1.

## Minutely revive cron: restart only when dead, re-arm wakeups otherwise (2026-09-01)
`scripts/revive-bots.sh` in the user crontab (`* * * * *`): if :8443 is not listening or `pgrep -x "Grok Bot"` is empty → `openzoo bot --no-quit` (relaunches the app). If alive → `POST /api/ozRevive {every}` which arms a wakeup on every non-group bot that has none (nothing already armed is touched, nothing spawned). Log: `~/.openzoo/revive.log`, hijack output `~/.openzoo/bot.log`. A restart kills the in-flight turn, so the script never restarts a live hijack. Wakeup interval is `OZ_REVIVE_EVERY` (default 5m); the cron cadence is the liveness check, not the bot tick.
**Why:** "set cron to revive all bots if dead, every 1min" — and the doublemint rule "do not add a Grok Bot cron" is about node wakes, not this host liveness loop.

## "wallet underfunded" was the HOUSE: OpenRouter credits overdrawn (2026-09-01)
Payments settled (TOKEN tx 3rwy5z…, `settle.success:true`) and x402-tokens still 402'd with `limit_source: openrouter_credits` / "Insufficient credits": the gateway's OpenRouter key was at $6140.67 used vs $6140.12 bought ($123 that day). server.ts "ONE UPSTREAM": `x-ai/*` goes through OpenRouter on purpose (the api.x.ai bypass split the bill and died on a separate xAI cap). `X402_UPSTREAM=1` only buys from x402 doors that stock the model, non-streaming, then falls back to OpenRouter — grok-4.6 is not stocked there. Settled-then-failed calls become tenant credit (`grantCredit`, "PROVIDER-ERROR CREDITS"), so the money is not lost, but the shim relayed it as a wallet 402 and the hijack re-paid 4×. Now `lib/proxy.js` classifies a PAID 402 whose body says upstream credits as a 503 "gateway upstream out of credits — NOT your wallet", names the settle tx, and refuses to pay for 60s. Fix on the house side is OpenRouter credits (`openrouter.ai/settings/credits`), or an x402 upstream that stocks the model.
**Why:** "why no answers from any since?" after a $142 TOKEN top-up — the burner was fine.

## X reply bots: 13 lanes, host tweet-id locks, Chrome AND Brave (2026-09-01)
Thirteen sidebar bots each own a search lane (cutoffs/overcharges/pricing/… for Claude, Grok, ChatGPT, Gemini, Cursor) against REAL users on X, not @grok. Overlap is prevented by `lib/xclaims.js`: `x_claim` (20m lease, atomic on the host), `x_done` (permanent, also appends `openzoobot-posted.json`), `x_release`, `x_claims`; bots must claim before drafting. Odd lanes drive the human's real Chrome (`chrome-devtools__*`, --autoConnect), even lanes drive real Brave (`brave-devtools__*`, second chrome-devtools-mcp on Brave's DevToolsActivePort; Brave needs brave://inspect/#remote-debugging flipped). Each browser has its own call mutex in `callHostMcp`; each bot opens its own page and re-selects it before every action. Every reply: answer first, ONE true OpenZoo virtue with a live number (`/v1/stats`), link https://openzoo.fun/core, then the x402 receipt block. Re-briefing by id through `/api/createAgent` minted DUPLICATES (roster merge) — dedupe by name keeping the newest, delete via `/api/deleteAgents {ids}`.
**Why:** "unique searches so they don't overlap; or shared space w twid locks" + "half n half brave n chrome".

## X composer flattens `fill` newlines — post with x_compose (2026-09-01)
Measured on x.com/openzoobot/status/2094919873453330618: a reply written with chrome-devtools `fill` lost every newline ("openzoo.fun/core" + "x402 · PAID…" → "corex402"). X's composer (`[data-testid="tweetTextarea_0"]`, Draft-style contenteditable) only keeps line breaks from real keystrokes. `x_compose {browser, text}` (lib/xclaims.js `composePlan`) focuses the box via evaluate_script, then `type_text` each line with `press_key Enter` between, then reads the composer back so the bot can verify separate lines before clicking Reply.
**Why:** "it still fucks up newlines, bad, fix".

## Second browser attaches by --wsEndpoint; bots get pinned tabs (2026-09-01)
Chrome 144+/Brave 151 "Allow remote debugging" writes `DevToolsActivePort` = `<port>\n/devtools/browser/<id>` and serves ONLY that websocket — `/json/version` is 404, so `--browserUrl` fails with "Could not connect to Chrome". Brave attaches with `--wsEndpoint ws://127.0.0.1:<port><path>` (`readActive` / `braveAttachArgs` in mcpbridge). Thirteen bots on one browser stomped on each other's tabs (select_page 1): `x_open {browser,url}` opens a tab and pins its page id to the agent; every `chrome-devtools__*` / `brave-devtools__*` call from that agent is preceded by `select_page` on its pinned tab under the per-browser lock; `x_close` at the end. Re-briefing by id through `/api/createAgent` is fine when the roster is hydrated; earlier duplicates came from doing it right after a restart.
**Why:** bot 2 logged "brave-devtools list_pages ERROR Could not connect… /json/version: HTTP Not Found" and bot 1's page was another bot's search.

## X composer needs a REAL click, not el.focus() (2026-09-01)
After x_compose typed 5 lines (DOM innerText showed them) the Reply button stayed disabled and the next render wiped the draft: keyboard input after `el.focus()` never reached Draft's React state. `x_compose` now probes the box rect via evaluate_script, `click_at` its centre (a CDP mouse click), types line / Enter / line, then reads back `replyEnabled` from `[data-testid="tweetButtonInline"]` and returns ok:false when X did not register the text. Pinned bots also cannot `select_page` away from their tab (answered with their own tab) and a model-driven `new_page` pins itself.
**Why:** three bots composed and then found `composer:"\n", btnDisabled:true`.

## Bare grok-4.6 = x402 door; x-ai/grok-4.6 = OpenRouter (2026-09-01)
Every grok alias in cursorbackend (`grok`, `grok-4`, `grok-4.6`, `x-ai/grok-4.6`) canonicalizes to bare `grok-4.6` (`canonicalZooModel`, applied to pinned `/model` overrides too). The gateway (x402-tokens, commit 2d735b0 local — remote push denied to staccDOTsol) buys a door-exact id from the x402 door and never OpenRouter; measured bought from api.surplusintelligence.ai, ~18s end to end, cogs on chain. Caveat measured: door cogs $0.0061 vs billed $0.0022 — the quote still prices off the OpenRouter row, so door buys can run at a loss until the gateway quotes off the door's 402. If `x-ai/grok-4.6` shows up in a bot's model line, an old pin is in `~/.openzoo/grokbot-models.json`.
**Why:** OpenRouter credits drained twice ($50 in an hour with 13 bots) while the door was healthy.
