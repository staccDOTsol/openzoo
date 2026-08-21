Silicon Mac users download the arm64.dmg, Windows the exe, Linux the AppImage.

1.6.7: Windows exe actually builds. 1.6.6 win #92 died in electron-builder npmRebuild of bigint-buffer — the SAME distutils miss as Mac #91. Python 3.12+ on windows-2022 has no distutils; setup-python 3.12 + `pip install setuptools` (and `py -m pip install setuptools` so node-gyp's launcher finds it) puts it back before npmRebuild. npmRebuild, extraResources, afterPack pack gate, think.js next to livestatus.js, and the exact openzoo `latest` pin are unchanged. First boot still ships node + openzoo-claude + node-pty/conpty. Auto never paints "install node-pty" / npx / `--print cannot grow` on the canvas.

1.6.6: Mac dmg and Windows exe actually build. 1.6.5 Linux AppImages packed; mac #91 and win #91 died in electron-builder npmRebuild of bigint-buffer before afterPack — macOS Python 3.12+ has no distutils (setuptools restores it), windows-latest is VS 2026 which node-gyp cannot see (pin windows-2022). npmRebuild, extraResources, and the packed node-pty / openzoo-claude / think.js-next-to-livestatus.js gate are unchanged. First boot still ships node + openzoo-claude + node-pty/conpty. Auto never paints "install node-pty" / npx / `--print cannot grow` on the canvas.

1.6.5: First boot already has node + openzoo-claude + node-pty/conpty; Auto never dumps an install recipe; waitIdle 90s so a send completes; sidecar stays up. Every artifact (arm64.dmg, Intel dmg, Setup exe, Setup arm64 exe, AppImage, arm64 AppImage) packs host Node / Electron-as-node, `openzoo-claude`, and `node-pty` rebuilt for that Electron ABI — Windows ships the conpty backend inside the exe. Auto never paints "install node-pty" / npx / `--print cannot grow` on the canvas.

1.6.4: Auto PTY waitIdle so a send completes on Claude Code. Orange Auto is `openzoo-claude` on a PTY (never official Anthropic `claude`): `~/.local/bin` + nvm 24 on PATH, zoo env `:8402`, no `ANTHROPIC_API_KEY`. `waitIdle` hard-caps ~90s — spinner / think / keepFold events must not reset that wall clock — and finishes early when visible assistant text AND idle/result. Do not skip the PTY. Do not invent `(no response)` after 3s so Ask/completions steal the send. Sidecar stays up after launch.

1.6.3: tagged on main at the #79 merge (`retrieval_dispatch`). Leave that tag alone.

1.6.2: Hung PTY Auto falls through to completions in 3s — do not ship a PTY that eats the send. `runAutoClaudeTurn` caps `runClaudeCode` on a separate AbortController (does not abort `turnAbort`; completions use that). Timeout / empty / missing / HTTP-N returns `(no response)` without a dead bot row (`isClaudeFallbackReply`). `ensureHarness` is Promise.race 2.5s and never blocks the send. Keep `:8402` up after launch. Host Node (`~/.local/bin` included) runs the packed bin detached so the sidecar is not the `.app` binary and survives window close / Cmd+Q. Occupied + null session is wedged: displace then spawn (402 stays live). Silicon users take the arm64.dmg. Windows: the exe. Linux: the AppImage. Do not overlay the demo Mac.

1.6.1: Auto never eats a send. Orange Auto tries `openzoo-claude` on a PTY, then falls through to the same chat/completions path as Ask/Auto when the PTY is empty, `(no response)`, missing, or HTTP-N — even on a thread that already has a bot reply. First launch / heal installs `openzoo-claude` (and `node` / `npx`) into `~/.local/bin`. Packed `:8402` sidecar includes the whole openzoo `lib/` (think.js next to livestatus.js) and falls back to host Node if the Electron bin cannot load. Do not pkill the window to heal.

#65: thinking… fold / short 400s.
#67: autoscroll.
#68: gzip relay (no Content-Encoding-stripped gzip 400s).
#66: Claude Auto on a PTY (/agents /tasks).
#69: autoheal packed :8402 sidecar (respawn without window restart; 402 still Pay).

## Claude Code / Auto

Orange Auto is `openzoo-claude` via OpenZoo — not a `RUN:` text parser, not official Anthropic bun `claude`. The grokui dmg/exe/AppImage installs `openzoo-claude` on first launch into `~/.local/bin`. No Claude login first. Do not curl the official Anthropic installer. Do not dump an npx recipe as the product path.

Pay is an OpenZoo subscription Bearer or x402. Never `ANTHROPIC_API_KEY`.

## Arch

**Apple Silicon Mac (M1 / M2 / M3 / M4): download `openzoo-*-arm64.dmg`.**

**Intel Mac: download `openzoo-*.dmg` (no `arm64` in the name).**

**Windows on a normal PC (Intel / AMD): download `openzoo.Setup.*.exe`.**

**Windows on Snapdragon / ARM: download `openzoo.Setup.*-arm64.exe` if that file is on this release, otherwise the Setup exe.**

**Linux x64: download `openzoo-*.AppImage` (no `arm64` in the name). chmod +x it, then run it.**

**Linux ARM (Pi, Ampere, most cloud ARM boxes): download `openzoo-*-arm64.AppImage`. chmod +x it, then run it.**

If you grab the other-arch file it will fail or run slow. Match the chip.

Race grid + classifier judging. Picker shows savings cut (1 model 0%, 4-racer −75%). Sitrep is a Pay-style drawer, not a chat dump.
