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

# A DEV MACHINE, not a runtime. Agents in the box are asked to build, test and
# debug real projects, and a box that lacks cc/python3 fails in ways that read
# as the model's fault: observed live as `/bin/sh: 1: python3: not found`
# followed by the bot inventing a workaround for a tool it simply did not have.
# Installing this at boot is not an option — RunPod egress gets rate limited,
# and an apt-get on the critical path is the whole bug this image exists to fix.
#
# openssh-server especially: our dockerStartCmd REPLACES the image init, so
# nothing starts sshd, and without it every execInBox gets "connection refused"
# and the agent has no hands.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git tar gzip bzip2 xz-utils zip unzip rsync \
      openssh-server \
      build-essential pkg-config make cmake \
      python3 python3-dev python3-pip python3-venv \
      libssl-dev libffi-dev zlib1g-dev \
      jq ripgrep sqlite3 less nano vim-tiny \
      procps iproute2 net-tools lsof dnsutils ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # bookworm marks the system python as externally managed (PEP 668), so a plain
 # `pip install` dies with an error about a virtualenv. In a disposable box
 # that guard protects nothing and only blocks the agent.
 && rm -f /usr/lib/python3*/EXTERNALLY-MANAGED \
 && ln -sf /usr/bin/python3 /usr/local/bin/python

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
