- Silicon Mac: download the arm64.dmg
- Intel Mac: the DMG with no `arm64` in the name
- Windows: the exe
- Linux: the AppImage (`-arm64` on ARM boxes)

This is Grok Bot + the openzoo CLI, **without installing Node**. Same trick as the old grokui desktop app: Electron is Node (`ELECTRON_RUN_AS_NODE`), and the sidecar lives in `node_modules/openzoo`.

On first launch the app:

1. Starts the local zoo proxy (`:8402`) and the Grok Bot hijack (`:8443`)
2. Downloads the matching **Grok Bot** binary from the `grokbot-v*` multiarch release if it is not already installed
3. Writes `~/.local/bin/openzoo` (Windows: `%LOCALAPPDATA%\openzoo\bin\openzoo.cmd`) so `openzoo claude` / `openzoo balance` work from a terminal with no npx

Grok Bot vendor builds (the 300MB Electron app) stay on the `grokbot-v*` release — this installer is the runtime.

Add `~/.local/bin` to PATH on Mac if `openzoo` is not found after launch:

```
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```
