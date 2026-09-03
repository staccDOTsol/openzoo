#!/usr/bin/env bash
# release-grokbot.sh — multiarch Grok Bot release pipeline.
#
# Queries the vendor update feed (api2.cursor.sh/updates/api/update/...) for the
# official "sand" (Grok Bot) builds, downloads every platform/arch, verifies each
# artifact, renames them Grok_Bot_<version>_<platform>-<arch> and publishes the
# whole set to a GitHub release tagged grokbot-v<version>.
#
# The paid-subscription requirement is removed at runtime by the openzoo-shim
# overlay (see repo root README / `npx openzoo@latest bot`) — these artifacts
# are the stock vendor builds, renamed and re-hosted multiarch from our releases.
#
# Env:
#   GROKBOT_VERSION     pin a vendor version (default: latest from the feed)
#   GROKBOT_BASE_VERSION old version used to seed the feed query (default 0.30.0)
#   GROKBOT_OUT         output dir (default dist/grokbot)
#   GROKBOT_NO_PUBLISH  =1 -> download+verify only, skip gh release
#   GROKBOT_ONLY        comma list of target names to process (testing)
#   GH_TOKEN            required unless GROKBOT_NO_PUBLISH=1
set -euo pipefail

MACHINE_ID="${GROKBOT_MACHINE_ID:-11111111-2222-3333-4444-555555555555}"
BASE_VERSION="${GROKBOT_BASE_VERSION:-0.30.0}"
FEED="https://api2.cursor.sh/updates/api/update"
OUT="${GROKBOT_OUT:-dist/grokbot}"
STAGE="$OUT/stage"
VERSION="${GROKBOT_VERSION:-}"

mkdir -p "$STAGE"

jsonget() { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

# query <feed-platform> -> V_VERSION, V_URL
query() {
  local j
  j="$(curl -fsSL -m 60 "$FEED/$1/sand/$BASE_VERSION/$MACHINE_ID/stable")"
  V_VERSION="$(jsonget "$j" version)"
  V_URL="$(jsonget "$j" url)"
  # linux feed points at the .zsync sidecar; the AppImage is the same path without it
  case "$V_URL" in *.zsync) V_URL="${V_URL%.zsync}";; esac
  if [ -z "$V_VERSION" ] || [ -z "$V_URL" ]; then
    echo "!! feed parse failed for $1:" >&2; printf '%s\n' "$j" >&2; exit 1
  fi
}

# feed key | asset name | extension
TARGETS=(
  "darwin-arm64|darwin-arm64|zip"
  "darwin-x64|darwin-x64|zip"
  "win32-x64-user|win-x64|exe"
  "win32-arm64-user|win-arm64|exe"
  "linux-x64|linux-x64|AppImage"
  "linux-arm64|linux-arm64|AppImage"
)

# resolve the version once from the darwin-arm64 feed
query darwin-arm64
if [ -z "$VERSION" ]; then VERSION="$V_VERSION"; fi
echo "==> vendor version: $VERSION"

verify() { # $1=asset $2=ext
  local a="$1" e="$2"
  [ -s "$a" ] || { echo "!! $a is empty"; exit 1; }
  local sz; sz="$(stat -c%s "$a" 2>/dev/null || stat -f%z "$a")"
  [ "$sz" -gt 50000000 ] || { echo "!! $a suspiciously small ($sz bytes)"; exit 1; }
  case "$e" in
    zip)
      unzip -l "$a" | grep -q '\.app/' || { echo "!! $a has no .app bundle"; exit 1; }
      ;;
    AppImage)
      local magic; magic="$(head -c 4 "$a" | od -An -tx1 | tr -d ' \n')"
      [ "$magic" = "7f454c46" ] || { echo "!! $a not an ELF (got $magic)"; exit 1; }
      chmod +x "$a"
      ;;
    exe)
      local magic; magic="$(head -c 2 "$a")"
      [ "$magic" = "MZ" ] || { echo "!! $a not an MZ executable"; exit 1; }
      ;;
  esac
  echo "   verified ($(( sz / 1024 / 1024 )) MB)"
}

BUILT=()
for T in "${TARGETS[@]}"; do
  F="${T%%|*}"; REST="${T#*|}"; N="${REST%%|*}"; E="${REST##*|}"
  if [ -n "${GROKBOT_ONLY:-}" ] && ! printf ',%s,' "$GROKBOT_ONLY" | grep -q ",$N,"; then
    echo "-- skip $N (GROKBOT_ONLY)"; continue
  fi
  query "$F"
  [ "$V_VERSION" = "$VERSION" ] || { echo "!! version skew on $F: $V_VERSION != $VERSION"; exit 1; }
  ASSET="$STAGE/Grok_Bot_${VERSION}_${N}.${E}"
  echo "==> $N: $V_URL"
  curl -fL --retry 3 --retry-delay 5 -o "$ASSET" "$V_URL"
  verify "$ASSET" "$E"
  BUILT+=("$ASSET")
done

if [ "${GROKBOT_NO_PUBLISH:-0}" = "1" ]; then
  echo "==> GROKBOT_NO_PUBLISH=1 — staged ${#BUILT[@]} artifacts in $STAGE"
  exit 0
fi

command -v gh >/dev/null || { echo "!! gh CLI not installed"; exit 1; }
TAG="grokbot-v$VERSION"
NOTES="Grok Bot $VERSION — official vendor builds, re-hosted multiarch.

- darwin-arm64 / darwin-x64: Grok_Bot_${VERSION}_darwin-*.zip (contains Grok Bot.app)
- linux-x64 / linux-arm64: Grok_Bot_${VERSION}_linux-*.AppImage
- win-x64 / win-arm64: Grok_Bot_${VERSION}_win-*-Setup.exe (NSIS)

The paid-subscription requirement is removed at runtime by the openzoo-shim
overlay — run the bot with \`npx openzoo@latest bot\` (installs from these
releases if not already present)."
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "==> uploading to existing release $TAG"
  gh release upload "$TAG" "${BUILT[@]}" --clobber
else
  echo "==> creating release $TAG with ${#BUILT[@]} assets"
  gh release create "$TAG" "${BUILT[@]}" --title "Grok Bot $VERSION (multiarch)" --notes "$NOTES"
fi
echo "==> done: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/$TAG"
