FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bin ./bin
COPY lib ./lib
COPY ["Grok Bot.app/Contents/Resources/app.asar", "/app/asar/app.asar"]
COPY scripts/fly-boot.sh /app/scripts/fly-boot.sh
RUN chmod +x /app/scripts/fly-boot.sh \
 && test -f /app/bin/openzoo.js \
 && test -f /app/lib/grokbotweb.js \
 && test -s /app/asar/app.asar

ENV NODE_ENV=production \
    OPENZOO_NO_TUNNEL=1 \
    OZ_GROKBOT_WEB_PORT=4174 \
    OZ_GROKBOT_WEB_BIND=0.0.0.0 \
    OPENZOO_BIND=0.0.0.0 \
    GROK_BOT_ASAR=/app/asar/app.asar \
    HOME=/data \
    NODE_TLS_REJECT_UNAUTHORIZED=0

EXPOSE 4174
CMD ["/app/scripts/fly-boot.sh"]
