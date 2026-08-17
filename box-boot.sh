#!/bin/bash
# Boot the openzoo box from files ALREADY ON DISK.
#
# bash, not sh: Debian's /bin/sh is dash, which has no `wait -n`, and the
# supervise-both-and-die-together logic at the bottom depends on it.
#
# The whole point: no GitHub at boot. RunPod egress IPs are rate limited, and a
# 429 from raw.githubusercontent lands as a 200-byte file whose contents are the
# literal text "429: Too Many Requests" — which node happily accepts as the
# entrypoint and then fails in a way that looks like an app bug, not a download
# bug. Everything is baked into /opt by box.Dockerfile; this script only copies.
#
# RunPod mounts an EMPTY volume over /workspace, hiding anything baked there, so
# /opt is the source of truth and /workspace is the (writable, persisted) copy.
set -eu

GROKUI_DIR=/workspace/.grokui
OZ_DIR=/workspace/.oz-app

# Containers must listen on all interfaces or a published port refuses the
# connection — the default 127.0.0.1 is the container's own loopback.
export OZ_GROKUI_BIND="${OZ_GROKUI_BIND:-0.0.0.0}"
export OPENZOO_BIND="${OPENZOO_BIND:-0.0.0.0}"
export OZ_GROKUI_PORT="${OZ_GROKUI_PORT:-4173}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://127.0.0.1:8402/v1}"

log() { echo "[box-boot] $*"; }

# ---- 1. wallet (per-visitor burner, injected at spawn, never baked) ----------
if [ -n "${OPENZOO_WALLET_JSON:-}" ]; then
  mkdir -p /root/.openzoo
  printf '%s' "$OPENZOO_WALLET_JSON" > /root/.openzoo/wallet.json
  chmod 600 /root/.openzoo/wallet.json
  log "wallet written"
else
  log "no OPENZOO_WALLET_JSON — proxy will mint its own burner"
fi

# ---- 2. box-server on :8080 (upload/files/health), injected as base64 --------
if [ -n "${OZ_UI_B64:-}" ]; then
  printf '%s' "$OZ_UI_B64" | base64 -d > /opt/box-server.mjs 2>/dev/null || \
    printf '%s' "$OZ_UI_B64" | base64 --decode > /opt/box-server.mjs
  node /opt/box-server.mjs &
  log "box-server :8080"
fi

# ---- 3. grokui from /opt, replacing any 429 corpse ---------------------------
# The "starts with 429" test is deliberate: an older box may have a POISONED
# /workspace on a persisted volume. Re-copy rather than trusting the file exists.
mkdir -p "$GROKUI_DIR"
if [ ! -f "$GROKUI_DIR/grokui.mjs" ] || head -c 3 "$GROKUI_DIR/grokui.mjs" | grep -q '429'; then
  cp /opt/grokui/grokui.mjs /opt/grokui/podagent.mjs "$GROKUI_DIR/"
  log "grokui copied from /opt"
fi

# ---- 4. openzoo proxy from /opt ---------------------------------------------
if [ ! -f "$OZ_DIR/bin/openzoo.js" ]; then
  mkdir -p "$OZ_DIR"
  cp -a /opt/openzoo/. "$OZ_DIR/"
  log "openzoo copied from /opt ($(cat /opt/openzoo/.oz-tag 2>/dev/null || echo unknown))"
fi

# ---- 5. run both; if either dies the container dies (so RunPod restarts it) --
node "$OZ_DIR/bin/openzoo.js" &
OZ_PID=$!
log "openzoo proxy :8402"

node "$GROKUI_DIR/grokui.mjs" &
UI_PID=$!
log "grokui :${OZ_GROKUI_PORT}"

# ---- 6. reaper: spawn sets an absolute expiry -------------------------------
if [ -n "${OPENZOO_EXPIRES_UNIX:-}" ]; then
  ( while :; do
      [ "$(date +%s)" -ge "$OPENZOO_EXPIRES_UNIX" ] && { log "expired"; kill -TERM $OZ_PID $UI_PID 2>/dev/null; exit 0; }
      sleep 15
    done ) &
fi

wait -n $OZ_PID $UI_PID
log "a service exited — shutting the box down"
kill -TERM $OZ_PID $UI_PID 2>/dev/null || true
wait || true
