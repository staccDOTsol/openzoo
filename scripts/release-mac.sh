#!/bin/bash
# Build, sign, notarize and publish the macOS installers FROM THIS MAC.
#
# Why this exists: the mac leg is the slowest and most fragile part of CI, and
# everything it needs already lives on this machine (~/openzoo-signing). This
# also gives a way to ship macOS when GitHub is having an incident — which has
# already cost one release, with every installer built and nothing published.
#
# SIGNING USES A TEMPORARY KEYCHAIN, not your login keychain. The identity is
# imported into a throwaway keychain, used, and destroyed on exit — so nothing
# persists in your security settings after this script finishes, and a failed
# run cannot leave a signing identity lying around unlocked.
#
#   ./scripts/release-mac.sh                 build + sign + notarize
#   ./scripts/release-mac.sh --publish       ...and upload to the release for
#                                            the current grokui-v* tag
#
# Notarization needs, in the environment:
#   APPLE_ID                  your Apple ID email
#   APPLE_APP_SPECIFIC_PASSWORD   an app-specific password (NOT the account one)
#   APPLE_TEAM_ID             e.g. 38DS45YWYM
# Without them the app is signed but NOT notarized, and macOS will say
# "Apple could not verify openzoo is free of malware" on first launch.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIGN_DIR="${OZ_SIGN_DIR:-$HOME/openzoo-signing}"
P12="$SIGN_DIR/openzoo-devid.p12"
P12_PASS_FILE="$SIGN_DIR/p12-password.txt"
PUBLISH=0
# Default to BOTH architectures because a release needs Intel too. --arm64
# halves the work — a second full package, a second ~9,300-file codesign walk,
# a 104MB x64 Electron download and a second notarization wait on Apple's
# queue — and is the right choice when iterating on this Mac rather than
# cutting a release.
ARCHES="--arm64 --x64"
for a in "$@"; do
  case "$a" in
    --publish) PUBLISH=1 ;;
    --arm64)   ARCHES="--arm64" ;;
    --x64)     ARCHES="--x64" ;;
  esac
done

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

# Refuse to pack if grokui-app is not on openzoo@latest. A caret on 0.x is
# how 1.5.78 shipped last week's sidecar inside the DMG.
node "$REPO_ROOT/scripts/assert-grokui-pin.mjs" \
  || die "grokui-app must depend on openzoo latest (not ^0.48.x, not an exact leftover)"

[ -f "$P12" ] || die "no signing cert at $P12 (set OZ_SIGN_DIR)"
[ -f "$P12_PASS_FILE" ] || die "no p12 password at $P12_PASS_FILE"

# ---- temporary keychain -----------------------------------------------------
KEYCHAIN="$(mktemp -d)/ozbuild.keychain-db"
KEYCHAIN_PASS="$(openssl rand -hex 16)"
say "creating a temporary keychain (your login keychain is untouched)"
security create-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"
security set-keychain-settings -lut 3600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"
security import "$P12" -k "$KEYCHAIN" -P "$(cat "$P12_PASS_FILE")" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null
# Without this, codesign blocks on a GUI prompt for keychain access and the
# build appears to hang forever with no error.
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$KEYCHAIN_PASS" "$KEYCHAIN" >/dev/null 2>&1

# The temp keychain MUST join the search list or the identity shows up as
# "matching" but never "valid" — an isolated keychain cannot see Apple's roots
# in the System keychain, so the chain does not resolve and codesign refuses.
#
# Read the previous list into an ARRAY. Splitting it as a bare word mangles
# the "-db" suffix and leaves the search list as garbage like
#   "…/Keychains/  …/Keychains/  …/login.keychain-db -db -db"
# which is a mess on the user's machine that outlives this script. (Learned
# the hard way, on a real keychain.)
ORIG_KEYCHAINS=()
while IFS= read -r line; do
  line="${line//\"/}"; line="${line#"${line%%[![:space:]]*}"}"
  [ -n "$line" ] && ORIG_KEYCHAINS+=("$line")
done < <(security list-keychains -d user)

restore_keychain_list() {
  [ ${#ORIG_KEYCHAINS[@]} -gt 0 ] && security list-keychains -d user -s "${ORIG_KEYCHAINS[@]}" || true
}
cleanup() {
  restore_keychain_list
  security delete-keychain "$KEYCHAIN" 2>/dev/null || true
  rm -rf "$(dirname "$KEYCHAIN")" 2>/dev/null || true
}
trap cleanup EXIT

security list-keychains -d user -s "$KEYCHAIN" "${ORIG_KEYCHAINS[@]}"

IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" | grep 'Developer ID Application' | head -1 | sed 's/.*"\(.*\)"/\1/')"
[ -n "$IDENTITY" ] || die "the p12 imported but no Developer ID Application identity appeared"
say "signing as: $IDENTITY"

# ---- notarization -----------------------------------------------------------
cd "$REPO_ROOT/grokui-app"
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  say "notarization ENABLED (${APPLE_ID})"
  node -e "
    const fs=require('fs'), f='package.json';
    const p=JSON.parse(fs.readFileSync(f,'utf8'));
    p.build.mac.notarize = true;   // electron-builder 25 wants a boolean; team comes from APPLE_TEAM_ID
    fs.writeFileSync(f, JSON.stringify(p,null,2)+'\n');
  "
  RESTORE_NOTARIZE=1
else
  say "notarization SKIPPED — set APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID to enable"
  say "  (the app will be signed but macOS will still warn on first launch)"
  RESTORE_NOTARIZE=0
fi

# codesign --deep over the packaged dependency tree blows through the default
# descriptor limit; this is the same guard CI needs.
ulimit -n 65535 2>/dev/null || true

say "building $ARCHES — this takes a few minutes"
# CSC_NAME takes the BARE common name. Passing the full identity string fails
# with: 'Please remove prefix "Developer ID Application:" from the specified
# name — appropriate certificate will be chosen automatically'.
CSC_NAME_BARE="${IDENTITY#Developer ID Application: }"
CSC_KEYCHAIN="$KEYCHAIN" CSC_NAME="$CSC_NAME_BARE" npx electron-builder --mac $ARCHES

if [ "$RESTORE_NOTARIZE" = 1 ]; then
  node -e "
    const fs=require('fs'), f='package.json';
    const p=JSON.parse(fs.readFileSync(f,'utf8'));
    delete p.build.mac.notarize;
    fs.writeFileSync(f, JSON.stringify(p,null,2)+'\n');
  "
fi

# ---- verify what we actually produced --------------------------------------
say "verifying"
shopt -s nullglob
DMGS=(dist/*.dmg)
[ ${#DMGS[@]} -gt 0 ] || die "no DMG was produced"
APP="dist/mac-arm64/openzoo.app"
[ -d "$APP" ] || APP="$(find dist -maxdepth 2 -name 'openzoo.app' | head -1)"
if [ -d "$APP" ]; then
  codesign --verify --deep --strict "$APP" || die "signature does not verify"
  codesign -dv --verbose=2 "$APP" 2>&1 | grep -E 'Authority|TeamIdentifier' | sed 's/^/    /'
  spctl -a -vvv -t install "$APP" 2>&1 | sed 's/^/    /' || true
  xcrun stapler validate "$APP" 2>&1 | tail -1 | sed 's/^/    /' || true
fi
node "$REPO_ROOT/scripts/assert-packed-grokui-lib.mjs" dist \
  || die "packed grokui.mjs relatives missing"
node "$REPO_ROOT/scripts/assert-overlaid-openzoo.mjs" dist \
  || die "packed node_modules/openzoo is not the overlaid sidecar"
node "$REPO_ROOT/scripts/assert-packed-openzoo-lib.mjs" dist \
  || die "packed openzoo lib is missing think.js / cannot import livestatus.js"
for d in "${DMGS[@]}"; do printf '    %s  %s\n' "$(du -h "$d" | cut -f1)" "$d"; done

# ---- publish ----------------------------------------------------------------
if [ "$PUBLISH" = 1 ]; then
  TAG="$(git -C "$REPO_ROOT" describe --tags --abbrev=0 --match 'grokui-v*')"
  say "uploading to release $TAG"
  gh release upload "$TAG" --repo staccDOTsol/openzoo --clobber "${DMGS[@]}"
  say "done — $TAG now carries the macOS installers"
else
  say "not published (pass --publish to upload to the latest grokui-v* release)"
fi
