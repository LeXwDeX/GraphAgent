ARG REGISTRY=ghcr.io/lexwdex
FROM ${REGISTRY}/build/base:24.04

SHELL ["/bin/bash", "-lc"]

ARG NODE_VERSION
ARG BUN_VERSION

ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

COPY package.json .node-version /opt/opencode-toolchain/
COPY config_assistant/go.mod /opt/opencode-toolchain/config_assistant/go.mod
COPY packages/containers/rust-toolchain.toml /opt/opencode-toolchain/packages/containers/rust-toolchain.toml
COPY script/toolchain.mjs /opt/opencode-toolchain/script/toolchain.mjs

RUN set -euo pipefail; \
  arch=$(uname -m); \
  node_arch=x64; \
  if [ "$arch" = "aarch64" ]; then node_arch=arm64; fi; \
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
  | tar -xJf - -C /usr/local --strip-components=1; \
  corepack enable

RUN set -euo pipefail; \
  curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"; \
  bun --version; \
  node --version; \
  npm --version; \
  node /opt/opencode-toolchain/script/toolchain.mjs check
