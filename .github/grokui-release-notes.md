Silicon Mac: arm64.dmg
Windows: exe
Linux: AppImage

Race grid + classifier judging. Picker shows savings cut (1 model 0%, 4-racer −75%). Sitrep is a Pay-style drawer, not a chat dump.

## Arch

**Apple Silicon Mac (M1 / M2 / M3 / M4): download `openzoo-*-arm64.dmg`.**

**Intel Mac: download `openzoo-*.dmg` (no `arm64` in the name).**

**Windows on a normal PC (Intel / AMD): download `openzoo.Setup.*.exe`.**

**Windows on Snapdragon / ARM: download `openzoo.Setup.*-arm64.exe` if that file is on this release, otherwise the Setup exe.**

**Linux x64: download `openzoo-*.AppImage` (no `arm64` in the name). chmod +x it, then run it.**

**Linux ARM (Pi, Ampere, most cloud ARM boxes): download `openzoo-*-arm64.AppImage`. chmod +x it, then run it.**

If you grab the other-arch file it will fail or run slow. Match the chip.

## Claude Code / Auto

Orange Auto is `openzoo claude` then `claude` — not a `RUN:` text parser. `openzoo claude` sets the Anthropic API key + base URL to the local OpenZoo proxy. No Claude login first. PATH `~/.local/bin` is required on Mac so `claude` is found.

Mac:

```
curl -fsSL https://claude.ai/install.sh | bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install 24
npm i -g openzoo
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
openzoo claude
```

Windows — official Claude install, then nvm-windows (https://github.com/coreybutler/nvm-windows — `nvm-setup.exe`). Do not use the unix nvm curl on Windows. Do not source `~/.zshrc`.

PowerShell:

```
irm https://claude.ai/install.ps1 | iex
```

CMD:

```
curl -fsSL https://downloads.claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Then nvm-windows:

```
nvm install 24
nvm use 24
npm i -g openzoo
openzoo claude
```
