# Bake latest (or a given) openzoo tag. Debian only.
# Used by staccDOTsol/openzoo .github/workflows/docker-box.yml
#
# ARG OZ_TAG=latest  → newest grokui-v* / v* tag
# ARG OZ_TAG=grokui-v1.5.0 → that tag

FROM node:22-bookworm-slim

ARG OZ_TAG=latest
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    OPENZOO_MODEL=anthropic/claude-sonnet-5 \
    OPENZOO_NO_TUNNEL=1 \
    OZ_GROKUI_PORT=4173

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tar \
 && rm -rf /var/lib/apt/lists/*

# Resolve "latest" to the newest version tag (grokui-v* preferred, else v*).
# Clone that tag. Never alpine. Never raw.githubusercontent (429).
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
    test -f /opt/openzoo/lib/grokui.mjs; \
    test -f /opt/openzoo/lib/podagent.mjs; \
    mkdir -p /opt/grokui; \
    cp /opt/openzoo/lib/grokui.mjs /opt/openzoo/lib/podagent.mjs /opt/grokui/; \
    echo "${TAG}" >/opt/openzoo/.oz-tag; \
    head -c 80 /opt/grokui/grokui.mjs | grep -qE '^(//|import )'

WORKDIR /workspace
EXPOSE 8080 4173 8402

COPY box-boot.sh /opt/box-boot.sh
RUN chmod +x /opt/box-boot.sh
CMD ["/opt/box-boot.sh"]
