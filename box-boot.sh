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
# Threads default to the volume, because that is where box-server unpacks
# uploads. Without this a bot GLOBs ~/.openzoo/grokui-workspace, finds nothing,
# and looks broken while the user's files sit in /workspace.
export OZ_WORKSPACE_DIR="${OZ_WORKSPACE_DIR:-/workspace}"
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

# ---- 2. SEED /workspace BEFORE box-server starts -----------------------------
# box-server.mjs is its own orchestrator: on listen it calls seedFromImage(),
# which runs a SYNCHRONOUS execFileSync `cp -a /opt/openzoo/. /workspace/.oz-app/`
# with a 60s timeout — 20,555 files onto a RunPod network volume. Called from
# inside the server.listen() callback, that BLOCKS THE EVENT LOOP: the socket is
# open but nothing is served, which RunPod reports as
#   502 — Waiting for service to respond
# and setInterval(ensureOz, 90_000) re-blocks every 90s, so :8080 never settles.
#
# Grok's old inline entrypoint did this copy in the shell first, so
# seedFromImage() found the tree present and skipped it. Removing the staging
# from this script (to kill the /workspace crash loop) handed that copy to the
# web server's own event loop. Do it here instead: same files, no event loop.
#
# The marker is what makes it safe — the thing the old code got wrong was
# gating on bin/openzoo.js, which a half-finished copy leaves behind. A marker
# written only after cp SUCCEEDS means a partial copy is retried, not inherited.
if [ ! -f /workspace/.oz-app/.seeded ]; then
  log "seeding /workspace from the image (once; box-server would otherwise do this on its event loop)"
  rm -rf /workspace/.oz-app.tmp
  mkdir -p /workspace/.oz-app.tmp
  if cp -a /opt/openzoo/. /workspace/.oz-app.tmp/ 2>/dev/null; then
    rm -rf /workspace/.oz-app
    mv /workspace/.oz-app.tmp /workspace/.oz-app
    touch /workspace/.oz-app/.seeded
    log "seeded $(find /workspace/.oz-app -type f | wc -l | tr -d ' ') files"
  else
    rm -rf /workspace/.oz-app.tmp
    log "seed FAILED — box-server will retry it (and may stall :8080 while it does)"
  fi
fi
mkdir -p /workspace/.grokui
cp /opt/grokui/grokui.mjs /opt/grokui/podagent.mjs /workspace/.grokui/ 2>/dev/null || true
cp /opt/openzoo/.oz-tag /workspace/.oz-tag 2>/dev/null || true

# ---- 3. box-server on :8080 (upload/files/health), injected as base64 --------
if [ -n "${OZ_UI_B64:-}" ]; then
  printf '%s' "$OZ_UI_B64" | base64 -d > /opt/box-server.mjs 2>/dev/null || \
    printf '%s' "$OZ_UI_B64" | base64 --decode > /opt/box-server.mjs
  node /opt/box-server.mjs &
  log "box-server :8080"
fi

# ---- 4. RUN FROM /opt. Do not stage the app onto the volume. ----------------
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

# Publish the baked tag where the box UI looks for it. box-server.mjs reads
# ROOT/.oz-tag (ROOT=/workspace) to report which build a box is running, but
# the image writes it to /opt/openzoo/.oz-tag and we deliberately no longer
# copy /opt into /workspace — that copy is what caused the unrecoverable
# crash loop. Without this one line the version silently reads as null on an
# otherwise healthy box, which looks like a broken box rather than a
# cosmetic gap.
cp /opt/openzoo/.oz-tag /workspace/.oz-tag 2>/dev/null || true

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

# ---- 5. supervise: RESTART a dead service, don't kill the box ---------------
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
    # `|| true` is load-bearing under `set -e`: once delay reaches 32 the test
    # returns 1, and as the LAST command in the loop body that kills the
    # function — both supervisors exit, `wait` returns, and the container dies
    # after ~6 restarts. The backoff cap must never be able to end the loop.
    [ "$delay" -lt 30 ] && delay=$((delay * 2)) || true
  done
}

# ONE ORCHESTRATOR, NOT TWO.
#
# box-server.mjs runs ensureOz() on boot and every 90s, and ensureOz starts its
# OWN openzoo (from /workspace/.oz-app) and its OWN grokui. If this script also
# starts them, both race for the same ports and the log fills with
#   openzoo: listen EADDRINUSE: address already in use 0.0.0.0:8402
# The loser dies, supervise() restarts it, it loses again — and a thrashing
# grokui drops in-flight requests, which surfaces in the UI as
# "the model returned nothing", i.e. it looks like a provider fault when it is
# two of our own processes fighting.
#
# So: when OZ_UI_B64 is present, box-server is the orchestrator and owns both
# services. Without it (a bare `docker run`), nothing else would start them and
# this script must.
if [ -z "${OZ_UI_B64:-}" ]; then
  supervise "openzoo proxy" 8402 node "$OZ_ENTRY" &
  log "openzoo proxy :8402"
  supervise "grokui" "$OZ_GROKUI_PORT" node "$UI_ENTRY" &
  log "grokui :${OZ_GROKUI_PORT}"
else
  log "box-server present — it owns openzoo/grokui; not starting duplicates (EADDRINUSE)"
fi

# ---- 6. reaper: spawn sets an absolute expiry -------------------------------
if [ -n "${OPENZOO_EXPIRES_UNIX:-}" ]; then
  ( while :; do
      if [ "$(date +%s)" -ge "$OPENZOO_EXPIRES_UNIX" ]; then log "expired"; kill -TERM 0; fi
      sleep 15
    done ) &
fi

# Hold the container open regardless of what any one service is doing.
wait
