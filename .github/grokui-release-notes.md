- Silicon Mac users download the arm64.dmg
- Windows: the exe
- Linux: the AppImage

## CLI

Desktop installers above are the default. For the sidecar / proxy from a terminal, current main is **openzoo@0.49.9** on npm (gzip relay, thinking fold, PTY Auto, sidecar autoheal) — not the 0.49.8 / 1.5.97-era recipe:

```
npx openzoo
```

or `npm i -g openzoo` then `openzoo`. `openzoo claude` points Claude Code / grokui orange Auto at the local x402 proxy. PATH `~/.local/bin` is required on Mac so `claude` is found.

#65: thinking… fold / short 400s.
#67: autoscroll.
#68: gzip relay (no Content-Encoding-stripped gzip 400s).
#66: Claude Code / Auto on a PTY (`/agents` `/tasks`).
#69: autoheal packed :8402 sidecar (respawn without window restart; 402 still Pay).
#70: grokui 1.5.99.

## Arch

**Apple Silicon Mac (M1 / M2 / M3 / M4): download `openzoo-*-arm64.dmg`.**

**Intel Mac: download `openzoo-*.dmg` (no `arm64` in the name).**

**Windows on a normal PC (Intel / AMD): download `openzoo.Setup.*.exe`.**

**Windows on Snapdragon / ARM: download `openzoo.Setup.*-arm64.exe` if that file is on this release, otherwise the Setup exe.**

**Linux x64: download `openzoo-*.AppImage` (no `arm64` in the name). chmod +x it, then run it.**

**Linux ARM (Pi, Ampere, most cloud ARM boxes): download `openzoo-*-arm64.AppImage`. chmod +x it, then run it.**

If you grab the other-arch file it will fail or run slow. Match the chip.

Race grid + classifier judging. Picker shows savings cut (1 model 0%, 4-racer −75%). Sitrep is a Pay-style drawer, not a chat dump.
