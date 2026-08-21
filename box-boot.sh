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
#
# :8080 is code-server (password auth). Cline is preinstalled and pointed at
# OpenZoo. Never --auth none — this URL is public on *.proxy.runpod.net.
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
export OPENZOO_NO_TUNNEL="${OPENZOO_NO_TUNNEL:-1}"

# GATEWAY AUTH, NOT A HOUSE ANTHROPIC KEY.
# ANTHROPIC_API_KEY bills api.anthropic.com and takes precedence over a custom
# base URL. Unset it every boot. The subscriber Bearer is ANTHROPIC_AUTH_TOKEN
# / OPENZOO_SUB_KEY (injected at spawn — never baked).
if [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ] && [ -n "${OPENZOO_SUB_KEY:-}" ]; then
  export ANTHROPIC_AUTH_TOKEN="$OPENZOO_SUB_KEY"
fi
if [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ] && [ -n "${OPENZOO_SUBSCRIPTION_KEY:-}" ]; then
  export ANTHROPIC_AUTH_TOKEN="$OPENZOO_SUBSCRIPTION_KEY"
fi
unset ANTHROPIC_API_KEY || true

OZ_API_BASE="${OPENZOO_API_BASE:-https://x402-tokens.fly.dev}"
OZ_API_BASE="${OZ_API_BASE%/}"
OZ_API_BASE="${OZ_API_BASE%/v1}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-${OZ_API_BASE}/v1}"
# Prefer the fly.dev completions door when a sub token is present. Sidecar
# on :8402 stays as a cheap local fallback (no ANTHROPIC_API_KEY required).
if [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  export OPENAI_BASE_URL="${OPENAI_BASE_URL:-${OZ_API_BASE}/v1}"
else
  export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://127.0.0.1:8402/v1}"
fi

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

# ---- 2. SEED /workspace BEFORE services start --------------------------------
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
    log "seed FAILED — continuing; code-server still owns :8080"
  fi
fi
# Do not cherry-pick grokui.mjs + podagent.mjs into /workspace/.grokui.
# grokui.mjs now has a growing relative-import graph (livestatus.js, …);
# a two-file copy then MODULE_NOT_FOUND at boot. Run from the baked clone
# (or the staged .oz-app copy of it), which already has the whole lib tree
# plus node_modules (worktree.mjs imports dugite).
mkdir -p /workspace/.grokui
if [ -d /opt/grokui ]; then
  cp -a /opt/grokui/. /workspace/.grokui/ 2>/dev/null || true
fi
cp /opt/openzoo/.oz-tag /workspace/.oz-tag 2>/dev/null || true

# OZ_UI_B64 used to inject box-server onto :8080. code-server is the front
# door now. Missing B64 must not fail boot; present B64 must not steal :8080.
if [ -n "${OZ_UI_B64:-}" ]; then
  log "OZ_UI_B64 present — ignored; code-server owns :8080"
fi

# ---- 3. RUN FROM /opt. Do not stage the app onto the volume. ----------------
OZ_ENTRY=/opt/openzoo/bin/openzoo.js
UI_ENTRY=/opt/openzoo/lib/grokui.mjs
log "running ${OZ_ENTRY} ($(cat /opt/openzoo/.oz-tag 2>/dev/null || echo unknown)) from the image"

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
  [ -f "$OZ_DIR/.copy-complete" ] && OZ_ENTRY="$OZ_DIR/bin/openzoo.js" && UI_ENTRY="$OZ_DIR/lib/grokui.mjs"
fi

# ---- 4. IDE password + Cline settings (never log tokens / password) ----------
# Persist Cline + code-server user data on the volume so a pod restart keeps them.
mkdir -p /workspace/.cline /workspace/.code-server
if [ ! -e /root/.cline ] || [ -L /root/.cline ]; then
  ln -sfn /workspace/.cline /root/.cline
fi
if [ -d /opt/code-server-user/User ] && [ ! -f /workspace/.code-server/User/settings.json ]; then
  mkdir -p /workspace/.code-server/User
  cp -a /opt/code-server-user/User/. /workspace/.code-server/User/
fi

# Password: OPENZOO_IDE_PASSWORD, else sha256 of the sub Bearer, else a
# persisted random. Never --auth none on a public RunPod URL.
ide_password() {
  if [ -n "${OPENZOO_IDE_PASSWORD:-}" ]; then
    printf '%s' "$OPENZOO_IDE_PASSWORD"
    return
  fi
  if [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
    printf '%s' "$ANTHROPIC_AUTH_TOKEN" | sha256sum | awk '{print $1}'
    return
  fi
  if [ -f /workspace/.openzoo-ide-password ]; then
    cat /workspace/.openzoo-ide-password
    return
  fi
  local pw
  pw="$(openssl rand -hex 16)"
  printf '%s' "$pw" > /workspace/.openzoo-ide-password
  chmod 600 /workspace/.openzoo-ide-password
  printf '%s' "$pw"
}

IDE_PASSWORD="$(ide_password)"
export PASSWORD="$IDE_PASSWORD"
if [ -n "${OPENZOO_IDE_PASSWORD:-}" ]; then
  log "code-server password from OPENZOO_IDE_PASSWORD"
elif [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  log "code-server password derived from subscription token"
else
  log "code-server password written to /workspace/.openzoo-ide-password"
fi

if [ -f /opt/box-cline-config.mjs ]; then
  node /opt/box-cline-config.mjs || log "cline settings write failed — IDE still starts"
fi

# ---- 5. supervise: RESTART a dead service, don't kill the box ---------------
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

# Packed openzoo sidecar on :8402. Cheap, optional — Cline talks to
# x402-tokens.fly.dev with the sub Bearer. No ANTHROPIC_API_KEY.
supervise "openzoo proxy" 8402 node "$OZ_ENTRY" &
log "openzoo proxy :8402"
supervise "grokui" "$OZ_GROKUI_PORT" node "$UI_ENTRY" &
log "grokui :${OZ_GROKUI_PORT}"

# code-server binds loopback :8081. The front on :8080 adds GET /health
# (waitBoxHttp) and proxies HTTP + WebSocket. --auth password, never none.
CODE_SERVER_BIND="${CODE_SERVER_BIND:-127.0.0.1:8081}"
supervise "code-server" 8081 \
  env PASSWORD="$IDE_PASSWORD" \
  code-server \
    --bind-addr "$CODE_SERVER_BIND" \
    --auth password \
    --disable-telemetry \
    --disable-update-check \
    --disable-workspace-trust \
    --user-data-dir /workspace/.code-server \
    --extensions-dir /opt/code-server-extensions \
    /workspace &
log "code-server ${CODE_SERVER_BIND} (password auth)"

supervise "box-front" 8080 \
  env BOX_FRONT_BIND=0.0.0.0 BOX_FRONT_PORT=8080 BOX_UPSTREAM="$CODE_SERVER_BIND" \
  node /opt/box-front.mjs &
log "box-front :8080 → code-server (GET /health)"

# ---- 6. reaper: spawn sets an absolute expiry -------------------------------
if [ -n "${OPENZOO_EXPIRES_UNIX:-}" ]; then
  ( while :; do
      if [ "$(date +%s)" -ge "$OPENZOO_EXPIRES_UNIX" ]; then log "expired"; kill -TERM 0; fi
      sleep 15
    done ) &
fi

# Hold the container open regardless of what any one service is doing.
wait
