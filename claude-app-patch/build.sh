#!/bin/zsh
# Rebuild the patched Claude desktop app with the openzoo shim.
#   - repacks ~/openzoo-shim/claude-app-patch/app into app.asar
#   - installs to ~/Applications/Claude.app (Downloads original untouched)
#   - ad-hoc codesigns so Gatekeeper lets it run
set -euo pipefail
setopt null_glob

SHIM=~/openzoo-shim/claude-app-patch
SRC_APP=~/Downloads/Claude.app
DST_APP=~/Applications/Claude.app
ASAR="$SHIM/app.asar.new"

echo "==> repacking asar"
rm -f "$ASAR"
npx --yes @electron/asar pack "$SHIM/app" "$ASAR" \
  --unpack "{node_modules/**/*.node,resources/**/*.node,*.node}"

echo "==> staging app bundle"
rm -rf "$DST_APP"
mkdir -p ~/Applications
cp -R "$SRC_APP" "$DST_APP"

echo "==> swapping app.asar"
rm -rf "$DST_APP/Contents/Resources/app.asar" "$DST_APP/Contents/Resources/app.asar.unpacked"
mv "$ASAR" "$DST_APP/Contents/Resources/app.asar"
cp -R "$SHIM/app_unpacked" "$DST_APP/Contents/Resources/app.asar.unpacked" 2>/dev/null || true
if [ -d "$ASAR.unpacked" ]; then
  rm -rf "$DST_APP/Contents/Resources/app.asar.unpacked"
  mv "$ASAR.unpacked" "$DST_APP/Contents/Resources/app.asar.unpacked"
fi

echo "==> ad-hoc codesign"
codesign --force --deep --sign - "$DST_APP" 2>/dev/null || \
  codesign --force --sign - "$DST_APP"

echo "==> done: $DST_APP"
echo "    launch with: open ~/Applications/Claude.app"
echo "    env: OPENZOO_PROXY_PORT (default 8402)"
