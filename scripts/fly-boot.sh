#!/bin/bash
# Fly boot: volume is HOME (/data). Wallet comes from the OPENZOO_WALLET_JSON
# secret so the operator key is never baked into the image.
set -eu
export HOME="${HOME:-/data}"
mkdir -p "$HOME/.openzoo"
if [ -n "${OPENZOO_WALLET_JSON:-}" ]; then
  printf '%s' "$OPENZOO_WALLET_JSON" > "$HOME/.openzoo/wallet.json"
  chmod 600 "$HOME/.openzoo/wallet.json"
  echo "[fly-boot] wallet written"
else
  echo "[fly-boot] no OPENZOO_WALLET_JSON — proxy will mint a fresh burner"
fi
if [ -n "${STRIPE_SECRET_KEY:-}" ]; then
  printf '%s' "$STRIPE_SECRET_KEY" > "$HOME/stripey.key"
  chmod 600 "$HOME/stripey.key"
fi
export OPENZOO_WALLET="${OPENZOO_WALLET:-$HOME/.openzoo/wallet.json}"
export GROK_BOT_ASAR="${GROK_BOT_ASAR:-/app/asar/app.asar}"
export OZ_GROKBOT_WEB_BIND="${OZ_GROKBOT_WEB_BIND:-0.0.0.0}"
export OPENZOO_BIND="${OPENZOO_BIND:-0.0.0.0}"
export OPENZOO_NO_TUNNEL="${OPENZOO_NO_TUNNEL:-1}"
export NODE_TLS_REJECT_UNAUTHORIZED=0
exec node /app/bin/openzoo.js web --no-open
