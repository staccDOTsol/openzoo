- Silicon Mac users download the arm64.dmg
- Windows: the exe
- Linux: the AppImage

1.6.2: Keep `:8402` up after launch. Host Node (`~/.local/bin` included) runs the packed bin detached so the sidecar is not the `.app` binary and survives window close / Cmd+Q. `whenReady` kicks ensureProxy before the window paints (does not await). Occupied + null session is wedged: displace then spawn (402 stays live). Ask and Auto both `waitForSidecarSession`. Health poll is not `unref`'d. `healer.stop()` drops timers only — it does not SIGTERM a healthy detached sidecar. Unreachable HUD/sitrep / "sidecar starting…" ask the main process to respawn via `heal-sidecar`. Silicon users take arm64.dmg; do not overlay the demo Mac.

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
