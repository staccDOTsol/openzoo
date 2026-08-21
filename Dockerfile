# Hosted OCC HTTP API for Fly (`openzoo-occ`).
#
# box.Dockerfile is the grokui RunPod box — do not reuse it here. This image
# only needs to run `node bin/openzoo.js occ` and speak the same /occ routes
# iOS/Android already call. Product URL stays https://zoo.openzoo.fun/occ
# (Vercel still HTML-404s; a later site rewrite points /occ at this app).
#
# Auth is Authorization: Bearer <OpenZoo subscription key>. Never set
# ANTHROPIC_API_KEY. Missing Bearer → 401 without spawning a PTY.
#
# Spawn bits: node + node-pty@1.1.0 + openzoo-claude@2.0.2 (same pins as
# grokui) with vendor/openzoo-claude overlays (/goal, AskUser guard). Packed
# lookup finds them under /app/node_modules; PATH also has the bins.

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    OPENZOO_OCC_BIND=0.0.0.0 \
    OPENZOO_OCC_PORT=8080 \
    PORT=8080 \
    OPENZOO_OCC_BASE_URL=https://x402-tokens.fly.dev/v1 \
    OPENZOO_API_BASE=https://x402-tokens.fly.dev \
    OPENZOO_OCC_ROOT=/var/lib/openzoo/occ-sessions \
    HOME=/home/node \
    PATH=/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates python3 make g++ git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY bin ./bin
COPY lib ./lib
COPY vendor ./vendor
COPY README.md LICENSE ./

RUN npm ci --omit=dev --no-audit --no-fund \
 && npm install --omit=dev --no-audit --no-fund --no-save node-pty@1.1.0 openzoo-claude@2.0.2 \
 && test -f node_modules/openzoo-claude/package.json \
 && test -f node_modules/node-pty/package.json \
 && test -e node_modules/.bin/openzoo-claude \
 && cp -a vendor/openzoo-claude/. node_modules/openzoo-claude/ \
 && test -f node_modules/openzoo-claude/v2/src/core/goal.mjs \
 && npm cache clean --force \
 && mkdir -p /var/lib/openzoo/occ-sessions /home/node/.openzoo /home/node/.claude \
 && chown -R node:node /app /var/lib/openzoo /home/node

# Do not ENV ANTHROPIC_API_KEY. Per-request Bearer is the only door.

USER node
EXPOSE 8080
CMD ["node", "bin/openzoo.js", "occ"]
