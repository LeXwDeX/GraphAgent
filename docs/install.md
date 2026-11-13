# Install

Prebuilt CLI binaries (Linux / macOS / Windows, with SHA256SUMS) are published on the [releases page](https://github.com/LeXwDeX/GraphAgent/releases). Stable releases are built from `main`; the `oc` installer selects and installs a release.

Built-in application updating is disabled in CLI and TUI. Install a new release manually with the installer or release artifacts. Legacy `autoupdate` settings are accepted but ignored; `opencode upgrade` and `POST /global/upgrade` report that updates are disabled.

Release acceptance enforces two distinct integrity boundaries:

- **Archive integrity (before extraction)**: the `oc` installer verifies the release `SHA256SUMS` entry before unpacking and refuses to extract on mismatch. If upstream serves no `SHA256SUMS`, it installs with a warning (GitHub HTTPS transport only).
- **Post-install signature validity (macOS)**: the installer clears quarantine attributes (`xattr -cr`) and ad-hoc re-signs (`codesign -fs -`); acceptance then asserts `codesign --verify` passes and the binary runs. The installed binary's hash is intentionally **not** compared to the archive payload — ad-hoc signing can rewrite the binary's bytes, so differing hashes are legitimate. No post-signature digest is published (cross-version reproducibility of codesign output has not been established, and no supported reproducibility matrix exists).

From source (requires the [Bun](https://bun.sh) version pinned in `package.json` `packageManager` and the Node version in `.node-version`):

```bash
bun install
bun dev              # TUI
bun dev serve        # headless API server (port 4096)

# standalone binary
./packages/graphagent/script/build.ts --single
```

> This fork is not published to npm/brew/scoop. The upstream `opencode-ai` package installs upstream opencode, not this fork.
