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

# ---- 3. RUN FROM /opt. Do not stage the app onto the volume. ----------------
# This used to copy /opt/openzoo (20,555 files) onto /workspace and run from
# there, guarded by `if [ ! -f /workspace/.oz-app/bin/openzoo.js ]`. That guard
# is a TRAP on a network volume: one interrupted copy leaves bin/openzoo.js in
# place, so every later boot SKIPS the copy and re-runs the same incomplete
# tree forever. Observed in production as an unrecoverable crash loop —
#   Cannot find module '/workspace/.oz-app/node_modules/viem/accounts'
# — every ~15s, which also meant the container never stayed up long enough to
# hold an HTTP port mapping, so every *.proxy.runpod.net URL 404'd.
#
# The copy bought nothing: the app is read-only at runtime and all mutable
# state lives in /root/.openzoo. Running from the image is faster to boot,
# cannot half-succeed, and is identical on every restart.
OZ_ENTRY=/opt/openzoo/bin/openzoo.js
UI_ENTRY=/opt/grokui/grokui.mjs
log "running ${OZ_ENTRY} ($(cat /opt/openzoo/.oz-tag 2>/dev/null || echo unknown)) from the image"

# A workspace copy is still available for anything that wants to EDIT the app,
# but it is opt-in and never on the boot path.
if [ "${OZ_STAGE_WORKSPACE:-0}" = "1" ]; then
  mkdir -p "$OZ_DIR" "$GROKUI_DIR"
  # Marker written only after a COMPLETE copy, so a partial one retries.
  if [ ! -f "$OZ_DIR/.copy-complete" ]; then
    rm -rf "$OZ_DIR"; mkdir -p "$OZ_DIR"
    cp -a /opt/openzoo/. "$OZ_DIR/" && touch "$OZ_DIR/.copy-complete" && log "staged to $OZ_DIR"
  fi
  cp /opt/grokui/grokui.mjs /opt/grokui/podagent.mjs "$GROKUI_DIR/" 2>/dev/null || true
  [ -f "$OZ_DIR/.copy-complete" ] && OZ_ENTRY="$OZ_DIR/bin/openzoo.js" && UI_ENTRY="$GROKUI_DIR/grokui.mjs"
fi

# ---- 4. supervise: RESTART a dead service, don't kill the box ---------------
# Tearing the container down on any single exit turned one crash into a restart
# loop, and a thrashing container loses its port mappings. Restart the service
# that died and leave the box — and its HTTP routes — up.
supervise() {
  local name="$1" port="$2"; shift 2
  local delay=1
  while :; do
    "$@" || true
    log "$name exited — restarting in ${delay}s"
    sleep "$delay"
    [ "$delay" -lt 30 ] && delay=$((delay * 2))
  done
}

supervise "openzoo proxy" 8402 node "$OZ_ENTRY" &
log "openzoo proxy :8402"
supervise "grokui" "$OZ_GROKUI_PORT" node "$UI_ENTRY" &
log "grokui :${OZ_GROKUI_PORT}"

# ---- 5. reaper: spawn sets an absolute expiry -------------------------------
if [ -n "${OPENZOO_EXPIRES_UNIX:-}" ]; then
  ( while :; do
      if [ "$(date +%s)" -ge "$OPENZOO_EXPIRES_UNIX" ]; then log "expired"; kill -TERM 0; fi
      sleep 15
    done ) &
fi

# Hold the container open regardless of what any one service is doing.
wait
