# OpenZoo Launcher

One installer for ChatGPT. Setup starts automatically when you open the launcher, with a floating savings window showing wallet balance, spend, and savings. Node and npm are bundled; no global runtime or terminal is required. The launcher checks npm's stable `openzoo` release on each launch, installs newer versions into its per-user application data directory, and falls back to the bundled or last successfully installed CLI when offline. It never downgrades. The selected CLI downloads the current chat app if missing and preserves existing installations.

Build natively with `npm ci`, `npm run prepare:bundle`, then `npm run dist`. Preparation resolves current Node LTS from nodejs.org, checks the archive SHA-256, and bundles this checkout's OpenZoo package. Push a `launcher-v1.0.0` style tag to publish six native installers through Actions; manual dispatch builds downloadable workflow artifacts without publishing a release. macOS uses existing Apple signing/notarization secrets. Windows currently ships unsigned.

Downloaded CLI updates execute as the current user, just like installing OpenZoo from npm. Updates are staged and promoted after a CLI smoke check. Launcher/Electron updates require downloading a newer installer. Configuration, wallets, downloaded apps and background proxy processes belong to OpenZoo and survive closing/uninstalling the launcher.
