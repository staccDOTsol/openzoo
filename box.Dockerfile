# OpenZoo box: code-server + Cline on :8080, gated by the subscription Bearer.
# Debian only. Never alpine. CI: .github/workflows/docker-box.yml
# Image names: jrsdunn123/grokui:latest and jrsdunn123/openzoo-box:latest
#
# ARG OZ_TAG=latest  → newest grokui-v* / v* tag (sidecar tree)
# ARG OZ_TAG=grokui-v1.5.0 → that tag
#
# The product on RunPod :8080 is a mobile-first Cline Agent (not grokui,
# not a tiny desktop workbench). Cline (saoudrizwan.claude-dev) is
# preinstalled and pointed at https://x402-tokens.fly.dev/v1.
# Sidecar on :8402 is optional.

FROM node:22-bookworm-slim

ARG OZ_TAG=latest
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    OPENZOO_MODEL=anthropic/claude-sonnet-5 \
    OPENZOO_NO_TUNNEL=1 \
    ANTHROPIC_BASE_URL=https://x402-tokens.fly.dev/v1
# Never ENV ANTHROPIC_API_KEY — Cline must use the OpenZoo subscription Bearer.

# A DEV MACHINE, not a runtime. Agents in the box are asked to build, test and
# debug real projects, and a box that lacks cc/python3 fails in ways that read
# as the model's fault. Installing this at boot is not an option — RunPod
# egress gets rate limited.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git tar gzip bzip2 xz-utils zip unzip rsync openssl \
      openssh-server \
      build-essential pkg-config make cmake \
      python3 python3-dev python3-pip python3-venv \
      libssl-dev libffi-dev zlib1g-dev \
      jq ripgrep sqlite3 less nano vim-tiny \
      procps iproute2 net-tools lsof dnsutils \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /usr/lib/python3*/EXTERNALLY-MANAGED \
 && ln -sf /usr/bin/python3 /usr/local/bin/python

# Official code-server install. Standalone prefix — no systemd in this image.
# Never alpine / npm-on-musl.
RUN curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone --prefix=/usr/local \
 && command -v code-server \
 && code-server --version

# Cline. Marketplace / Open VSX id is saoudrizwan.claude-dev — verify, do not invent.
# Bake into /opt so a RunPod volume over /workspace cannot hide the extension.
RUN set -eu; \
    mkdir -p /opt/code-server/extensions /tmp/cs-user; \
    if ! code-server --install-extension saoudrizwan.claude-dev \
          --extensions-dir /opt/code-server/extensions \
          --user-data-dir /tmp/cs-user; then \
      echo 'marketplace install failed — Open VSX fallback'; \
      VSIX_URL=$(curl -fsSL https://open-vsx.org/api/saoudrizwan/claude-dev/latest \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);console.log((j.files&&j.files.download)||(j.downloads&&j.downloads.universal)||"");});'); \
      test -n "$VSIX_URL"; \
      curl -fsSL "$VSIX_URL" -o /tmp/cline.vsix; \
      code-server --install-extension /tmp/cline.vsix \
        --extensions-dir /opt/code-server/extensions \
        --user-data-dir /tmp/cs-user; \
    fi; \
    EXT=$(find /opt/code-server/extensions -maxdepth 1 -type d -name 'saoudrizwan.claude-dev*' | head -1); \
    test -n "$EXT"; \
    test -f "$EXT/package.json"; \
    node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const id=(p.publisher||"")+"."+(p.name||"");if(id!=="saoudrizwan.claude-dev"){console.error("unexpected extension id "+id);process.exit(1);}const props=(p.contributes&&p.contributes.configuration&&p.contributes.configuration.properties)||{};const keys=Object.keys(props);fs.writeFileSync("/opt/code-server/cline-config-keys.json",JSON.stringify({id,name:p.name,publisher:p.publisher,version:p.version,packageJson:process.argv[1],configurationKeys:keys},null,2)+"\n");console.log("Cline "+p.version+" configuration keys: "+keys.length);' "$EXT/package.json"; \
    test -f /opt/code-server/cline-config-keys.json; \
    grep -q saoudrizwan.claude-dev /opt/code-server/cline-config-keys.json; \
    rm -rf /tmp/cs-user /tmp/cline.vsix

# Optional sidecar: bake openzoo so Cline can hit a local :8402, but the live
# gateway is the default door. Clone that tag. Never alpine. Never
# raw.githubusercontent (429).
RUN set -eu; \
    TAG="${OZ_TAG}"; \
    if [ "$TAG" = "latest" ] || [ -z "$TAG" ]; then \
      TAG=$(git ls-remote --tags --sort=-v:refname https://github.com/staccDOTsol/openzoo.git \
        | awk -F/ '/refs\/tags\/grokui-v[0-9]/{print $NF}' | grep -v '\^{}' | head -1); \
      if [ -z "$TAG" ]; then \
        TAG=$(git ls-remote --tags --sort=-v:refname https://github.com/staccDOTsol/openzoo.git \
          | awk -F/ '/refs\/tags\/v[0-9]/{print $NF}' | grep -v '\^{}' | head -1); \
      fi; \
    fi; \
    echo "baking ${TAG}"; \
    git clone --depth 1 --branch "${TAG}" https://github.com/staccDOTsol/openzoo.git /opt/openzoo; \
    cd /opt/openzoo; \
    npm install --omit=dev --no-audit --no-fund; \
    test -f /opt/openzoo/bin/openzoo.js; \
    echo "${TAG}" >/opt/openzoo/.oz-tag

WORKDIR /workspace
EXPOSE 8080 8402
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

COPY box-boot.sh /opt/box-boot.sh
COPY box-front.mjs /opt/box-front.mjs
COPY box-cline-config.mjs /opt/box-cline-config.mjs
COPY box-mobile-inject.mjs /opt/box-mobile-inject.mjs
COPY box-mobile.css /opt/code-server/mobile.css
COPY box-mobile.js /opt/code-server/mobile.js
COPY box-mobile-ext /opt/code-server/extensions/openzoo.box-mobile-1.0.0
RUN chmod +x /opt/box-boot.sh /opt/box-front.mjs /opt/box-cline-config.mjs /opt/box-mobile-inject.mjs \
 && test -f /opt/code-server/extensions/openzoo.box-mobile-1.0.0/package.json \
 && test -f /opt/code-server/mobile.css \
 && grep -q 'width=device-width' /opt/code-server/mobile.js
CMD ["/opt/box-boot.sh"]
