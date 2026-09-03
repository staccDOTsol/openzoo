# Grok Bot × openzoo — the whole saga, TL;DR

**Goal:** get Grok Bot's own chat window (`/Applications/Grok Bot.app`) to run its
inference through openzoo instead of Cursor's backend — either by intercepting its
traffic, or by getting its own sandbox panel to load a page we control.

## What we tried (all dead ends, in order)

1. **pf NAT redirects** (`rdr pass on en0 ... -> 127.0.0.1:PORT`) + a passthrough TLS
   proxy, relaunching the app mid-capture to force fresh connections to known IPs.
   Connections rerouted fine — no chat/inference traffic ever showed up on them.
2. **Raw ClientHello/SNI capture** via `tcpdump`, across every candidate IP the app
   dialed. Mostly ECH (encrypted SNI) — even where readable, same result: nothing
   chat-shaped.
3. **`/etc/hosts` blackhole** of `api2.cursor.sh` — this didn't intercept anything,
   it just took the whole app offline ("Reconnecting to your computer…"). Had to be
   uninstalled/reinstalled twice before we figured out it was a DNS blackhole, not an
   app bug. `lib/hosts.js` now refuses to do this to Grok Bot at all.
4. **`--host-resolver-rules=MAP api2.cursor.sh 127.0.0.1:8443`** — scoped to one
   launch, no sudo. Verified in the process's own args. Didn't work: it only steers
   Chromium renderer traffic, and Grok Bot's chat/agent logic runs in Electron's
   **main process**, which uses Node's own DNS/TLS, not Chromium's.
5. **Full TLS MITM on `api2.cursor.sh`** (real interception, `NODE_TLS_REJECT_UNAUTHORIZED=0`,
   real cert swap) — this one actually worked as an intercept: 88 real API methods
   captured with real bodies, then passed through untouched. And there was still
   **zero inference traffic**. That's what proved the next point.
6. **The actual finding, confirmed from the wire:** `GrokBotService/EnsureSandBox`
   hands the app a pod on Anysphere's **own infrastructure**
   (`https://<id>-pod-<id>-1337.us9.cursorvm.com`, with its own `-6080/vnc.html`,
   `-1340`, `-6081`). The model calls happen **inside that remote pod** — they never
   touch the laptop's network stack at all. There was nothing local to intercept,
   ever. Not a missing trick — the surface we were hunting for doesn't exist on this
   machine.
7. We had also built `podagent.mjs`: a fake Grok-Bot-sandbox brain (ports
   1337/6080/1340/6081) meant to run on a RunPod box that `EnsureSandBox` would
   hopefully get pointed at, replacing Anysphere's pod with ours. It never got used —
   `EnsureSandBox` always returns Anysphere's own pod, never ours. **13 of those
   `openzoo-box-grokbot-*` RunPod boxes were still running and billing** ($0.06/hr
   each) when we found this; all terminated.

## What actually works

The **`grok` CLI** (not the app). `npx openzoo grokbot` writes `[model.*]` rows into
`~/.grok/config.toml` pointing at `http://localhost:8402/v1` (openzoo's local x402
proxy). Verified live: `grok -p "reply with exactly: PONG"` → `PONG`, paid per call
from the burner wallet, zero xAI billing. This is the entire "Grok on openzoo"
billing surface that exists — the CLI, never the app.

## What we built instead

Gave up on hijacking Grok Bot's actual window — proven impossible, not just hard.
Built our own standalone chat client instead:

- Screenshotted and zoomed into the real app's message canvas for exact reference
  (colors, bubble shapes, avatar/header behavior, input-bar states).
- Restyled `VNC_CHAT_HTML` (in `lib/podagent.mjs`) to match pixel-for-pixel: dark
  `#262626` filled reply pills, `#57575c` user pills, pink avatar-square "Message
  from" header shown once per reply run, pill input bar with `+`/mic that swaps for
  a white send-circle once you start typing.
- `lib/grokui.mjs` — a minimal standalone server (no fake sandbox/daemon needed)
  serving that same HTML and answering `/drive` with a direct openzoo chat call.
  Verified live end-to-end in a browser: typed "hi human", got a real paid reply,
  rendering matched the real app's screenshot.
- Now wrapping it as an actual Electron desktop app (`grokui-app/`) so it's a real
  `.app` window, not a browser tab.
