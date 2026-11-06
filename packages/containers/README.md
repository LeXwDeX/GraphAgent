# CI containers

Prebuilt images intended to speed up GitHub Actions jobs by baking in
large, slow-to-install dependencies. These are designed for Linux jobs
that can use `job.container` in workflows.

Images

- `base`: Ubuntu 24.04 with common build tools and utilities
- `bun-node`: `base` plus the exact Bun (`packageManager`) and Node.js (`.node-version`) pins
- `rust`: `bun-node` plus the stable Rust pin in `rust-toolchain.toml` (minimal profile)
- `publish`: `bun-node` plus Docker CLI and AUR tooling

Build

```
REGISTRY=ghcr.io/anomalyco TAG=24.04 bun ./packages/containers/script/build.ts
REGISTRY=ghcr.io/anomalyco TAG=24.04 bun ./packages/containers/script/build.ts --push
```

The build script reads the central pins and passes them as Docker build arguments.
The image checks its installed versions against those same files. Rebuild it after
changing any runtime pin. Rust is an auxiliary container toolchain.

Workflow usage

```
jobs:
  build-cli:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/anomalyco/build/bun-node:24.04
```

Notes

- These images only help Linux jobs. macOS and Windows jobs cannot run
  inside Linux containers.
- `--push` publishes multi-arch (amd64 + arm64) images using Buildx.
- If a job uses Docker Buildx, the container needs access to the host
  Docker daemon (or `docker-in-docker` with privileged mode).
