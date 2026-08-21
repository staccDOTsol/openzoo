#!/bin/bash
# Boot the openzoo box from files ALREADY ON DISK.
#
# bash, not sh: Debian's /bin/sh is dash, which has no `wait -n`, and the
# supervise-and-die-together logic at the bottom depends on it.
#
# Product on :8080 is a mobile-first Cline Agent (code-server underneath).
# grokui is not the UI. Sidecar on 127.0.0.1:8402 is optional. Cline's door
# is https://x402-tokens.fly.dev/v1 with the OpenZoo subscription Bearer.
#
# Nothing is fetched at boot. RunPod egress IPs are rate limited.
set -eu

export OPENZOO_NO_TUNNEL=1
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://x402-tokens.fly.dev/v1}"
export OZ_WORKSPACE_DIR="${OZ_WORKSPACE_DIR:-/workspace}"
# Live gateway is the door. A local sidecar, if started, stays on loopback.
export OPENZOO_BIND="${OPENZOO_BIND:-127.0.0.1}"
export OPENZOO_PORT="${OPENZOO_PORT:-8402}"
export CODE_SERVER_USER_DATA="${CODE_SERVER_USER_DATA:-/root/.local/share/code-server}"
export CODE_SERVER_EXTENSIONS="${CODE_SERVER_EXTENSIONS:-/opt/code-server/extensions}"
export OZ_CODE_SERVER_PORT="${OZ_CODE_SERVER_PORT:-8081}"
export OZ_BOX_FRONT_PORT="${OZ_BOX_FRONT_PORT:-8080}"

# Never a stock Anthropic key. Never bill api.anthropic.com.
unset ANTHROPIC_API_KEY || true

log() { echo "[box-boot] $*"; }

if [[ "${ANTHROPIC_BASE_URL}" == *api.anthropic.com* ]]; then
  log "refusing api.anthropic.com — resetting ANTHROPIC_BASE_URL to the OpenZoo gateway"
  export ANTHROPIC_BASE_URL="https://x402-tokens.fly.dev/v1"
fi

# ---- 1. wallet (per-visitor burner, injected at spawn, never baked) ----------
if [ -n "${OPENZOO_WALLET_JSON:-}" ]; then
  mkdir -p /root/.openzoo
  printf '%s' "$OPENZOO_WALLET_JSON" > /root/.openzoo/wallet.json
  chmod 600 /root/.openzoo/wallet.json
  log "wallet written"
else
  log "no OPENZOO_WALLET_JSON — sidecar (if started) will mint its own burner"
fi

# ---- 2. SEED /workspace BEFORE the IDE starts --------------------------------
# RunPod mounts an EMPTY volume over /workspace, hiding anything baked there.
# Marker written only after cp SUCCEEDS so a partial copy is retried.
if [ ! -f /workspace/.oz-app/.seeded ]; then
  log "seeding /workspace from the image (once)"
  rm -rf /workspace/.oz-app.tmp
  mkdir -p /workspace/.oz-app.tmp
  if cp -a /opt/openzoo/. /workspace/.oz-app.tmp/ 2>/dev/null; then
    rm -rf /workspace/.oz-app
    mv /workspace/.oz-app.tmp /workspace/.oz-app
    touch /workspace/.oz-app/.seeded
    log "seeded $(find /workspace/.oz-app -type f | wc -l | tr -d ' ') files"
  else
    rm -rf /workspace/.oz-app.tmp
    log "seed FAILED — continuing; code-server still starts on an empty workspace"
  fi
fi
cp /opt/openzoo/.oz-tag /workspace/.oz-tag 2>/dev/null || true

# ---- 3. subscription key + IDE password (never --auth none) -----------------
SUB_KEY="${OPENZOO_SUB_KEY:-${ANTHROPIC_AUTH_TOKEN:-${OPENZOO_SUBSCRIPTION_KEY:-}}}"
if [ -n "$SUB_KEY" ]; then
  export ANTHROPIC_AUTH_TOKEN="$SUB_KEY"
  export OPENZOO_SUBSCRIPTION_KEY="$SUB_KEY"
fi

if [ -n "${OPENZOO_IDE_PASSWORD:-}" ]; then
  IDE_PASSWORD="$OPENZOO_IDE_PASSWORD"
elif [ -n "$SUB_KEY" ]; then
  IDE_PASSWORD="$(printf '%s' "$SUB_KEY" | sha256sum | awk '{print $1}')"
  log "IDE password is sha256 of the subscription key (OPENZOO_IDE_PASSWORD unset)"
else
  mkdir -p /root/.openzoo
  if [ -f /root/.openzoo/ide-password ]; then
    IDE_PASSWORD="$(cat /root/.openzoo/ide-password)"
  else
    IDE_PASSWORD="$(openssl rand -hex 24)"
    printf '%s' "$IDE_PASSWORD" > /root/.openzoo/ide-password
    chmod 600 /root/.openzoo/ide-password
  fi
  log "IDE password written to /root/.openzoo/ide-password (no sub key, no OPENZOO_IDE_PASSWORD)"
fi
export PASSWORD="$IDE_PASSWORD"
unset HASHED_PASSWORD || true

mkdir -p /root/.config/code-server
# Password is PASSWORD= in the environment, not --auth none. Never write auth: none.
cat > /root/.config/code-server/config.yaml <<EOF
bind-addr: 127.0.0.1:${OZ_CODE_SERVER_PORT}
auth: password
cert: false
EOF
chmod 600 /root/.config/code-server/config.yaml
if grep -qE '^[[:space:]]*auth:[[:space:]]*none' /root/.config/code-server/config.yaml; then
  log "FATAL: auth none is forbidden"
  exit 1
fi

# ---- 4. Cline User settings + secrets (real keys from the baked package.json)
node /opt/box-cline-config.mjs || log "Cline config write failed — IDE still starts"
node /opt/box-mobile-inject.mjs || log "workbench HTML inject skipped"

# ---- 5. supervise: RESTART a dead service, don't kill the box ---------------
supervise() {
  local name="$1" port="$2"; shift 2
  local delay=1
  while :; do
    "$@" || true
    log "$name exited — restarting in ${delay}s"
    sleep "$delay"
    [ "$delay" -lt 30 ] && delay=$((delay * 2)) || true
  done
}

# ---- 6. optional sidecar on loopback :8402 ----------------------------------
OZ_ENTRY=/opt/openzoo/bin/openzoo.js
if [ "${OPENZOO_BOX_SIDECAR:-1}" != "0" ] && [ -f "$OZ_ENTRY" ]; then
  supervise "openzoo sidecar" 8402 \
    env OPENZOO_NO_TUNNEL=1 OPENZOO_BIND=127.0.0.1 OPENZOO_PORT=8402 \
    node "$OZ_ENTRY" &
  log "openzoo sidecar 127.0.0.1:8402 (optional; Cline uses ${ANTHROPIC_BASE_URL})"
else
  log "sidecar skipped"
fi

# ---- 7. code-server is the box. Bound internally; front door is :8080. ------
# --auth password only. --auth none is forbidden.
supervise "code-server" "$OZ_CODE_SERVER_PORT" \
  env PASSWORD="$IDE_PASSWORD" \
  code-server \
    --bind-addr "127.0.0.1:${OZ_CODE_SERVER_PORT}" \
    --auth password \
    --disable-telemetry \
    --disable-update-check \
    --extensions-dir "$CODE_SERVER_EXTENSIONS" \
    --user-data-dir "$CODE_SERVER_USER_DATA" \
    /workspace &
log "code-server 127.0.0.1:${OZ_CODE_SERVER_PORT} (auth=password)"

supervise "box-front" "$OZ_BOX_FRONT_PORT" \
  node /opt/box-front.mjs &
log "box-front 0.0.0.0:${OZ_BOX_FRONT_PORT} → code-server (GET /health)"

# Do not launch grokui.mjs. Do not wait on :4173.

# ---- 8. reaper: spawn sets an absolute expiry -------------------------------
if [ -n "${OPENZOO_EXPIRES_UNIX:-}" ]; then
  ( while :; do
      if [ "$(date +%s)" -ge "$OPENZOO_EXPIRES_UNIX" ]; then log "expired"; kill -TERM 0; fi
      sleep 15
    done ) &
fi

wait
