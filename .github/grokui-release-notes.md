- Silicon Mac users download the arm64.dmg
- Windows: the exe
- Linux: the AppImage

#65: thinking… fold / short 400s.
#67: autoscroll.
#68: gzip relay (no Content-Encoding-stripped gzip 400s).
#66: Claude Auto on a PTY (/agents /tasks).
#69: autoheal packed :8402 sidecar (respawn without window restart; 402 still Pay).

## Claude Code / Auto

Orange Auto is `openzoo claude` then `openzoo-claude` — not a `RUN:` text parser. `openzoo claude` execs `openzoo-claude` (`npx -y` if needed) with the Anthropic base URL at the local OpenZoo proxy. No Claude login first. Do not curl `claude.ai/install.sh`.

Mac:

```
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install 24
npm i -g openzoo
openzoo claude
```

Windows — nvm-windows (https://github.com/coreybutler/nvm-windows — `nvm-setup.exe`). Do not use the unix nvm curl on Windows. Do not source `~/.zshrc`. Do not install official Claude Code.

Then nvm-windows:

```
nvm install 24
nvm use 24
npm i -g openzoo
openzoo claude
```

## Arch

**Apple Silicon Mac (M1 / M2 / M3 / M4): download `openzoo-*-arm64.dmg`.**

**Intel Mac: download `openzoo-*.dmg` (no `arm64` in the name).**

**Windows on a normal PC (Intel / AMD): download `openzoo.Setup.*.exe`.**

**Windows on Snapdragon / ARM: download `openzoo.Setup.*-arm64.exe` if that file is on this release, otherwise the Setup exe.**

**Linux x64: download `openzoo-*.AppImage` (no `arm64` in the name). chmod +x it, then run it.**

**Linux ARM (Pi, Ampere, most cloud ARM boxes): download `openzoo-*-arm64.AppImage`. chmod +x it, then run it.**

If you grab the other-arch file it will fail or run slow. Match the chip.

Race grid + classifier judging. Picker shows savings cut (1 model 0%, 4-racer −75%). Sitrep is a Pay-style drawer, not a chat dump.
