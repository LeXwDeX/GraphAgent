#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SETUP="$ROOT/.github/actions/setup-gh/setup.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/setup-gh-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

version="0.0.0-test"
assets="$TMP/assets"
mkdir -p "$assets/linux/gh_${version}_linux_amd64/bin"

cat > "$assets/linux/gh_${version}_linux_amd64/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "gh version fixture-linux"
EOF
chmod +x "$assets/linux/gh_${version}_linux_amd64/bin/gh"
tar -czf "$assets/gh_${version}_linux_amd64.tar.gz" -C "$assets/linux" "gh_${version}_linux_amd64"

linux_sha="$(digest "$assets/gh_${version}_linux_amd64.tar.gz")"

run_setup() {
  local os="$1"
  local runner_temp="$TMP/run-$os space"
  local github_path="$TMP/github-path-$os space"
  mkdir -p "$runner_temp"
  : > "$github_path"
  env \
    GH_CLI_VERSION="$version" \
    GH_CLI_LINUX_AMD64_SHA256="$linux_sha" \
    GH_CLI_DOWNLOAD_BASE_URL="file://$assets" \
    RUNNER_OS="$os" \
    RUNNER_ARCH=X64 \
    RUNNER_TEMP="$runner_temp" \
    GITHUB_PATH="$github_path" \
    bash "$SETUP"
}

linux_output="$(run_setup Linux)"
grep -q "gh version fixture-linux" <<< "$linux_output"
linux_bin="$(cat "$TMP/github-path-Linux space")/gh"
test -x "$linux_bin"

bad_log="$TMP/bad-checksum.log"
if env \
  GH_CLI_VERSION="$version" \
  GH_CLI_LINUX_AMD64_SHA256="$(printf '0%.0s' {1..64})" \
  GH_CLI_DOWNLOAD_BASE_URL="file://$assets" \
  RUNNER_OS=Linux \
  RUNNER_ARCH=X64 \
  RUNNER_TEMP="$TMP" \
  GITHUB_PATH="$TMP/bad-github-path" \
  bash "$SETUP" > "$bad_log" 2>&1; then
  echo "checksum mismatch unexpectedly succeeded" >&2
  exit 1
fi
grep -q "archive checksum mismatch" "$bad_log"
test ! -e "$TMP/bad-github-path"

# Only Linux x64 is bootstrapped; native Windows is no longer supported.
for unsupported in macOS:ARM64 Windows:X64; do
  os="${unsupported%%:*}"
  arch="${unsupported##*:}"
  unsupported_log="$TMP/unsupported-$os.log"
  if env \
    GH_CLI_VERSION="$version" \
    GH_CLI_LINUX_AMD64_SHA256="$linux_sha" \
    GH_CLI_DOWNLOAD_BASE_URL="file://$assets" \
    RUNNER_OS="$os" \
    RUNNER_ARCH="$arch" \
    RUNNER_TEMP="$TMP" \
    GITHUB_PATH="$TMP/unsupported-github-path-$os" \
    bash "$SETUP" > "$unsupported_log" 2>&1; then
    echo "unsupported platform $os/$arch unexpectedly succeeded" >&2
    exit 1
  fi
  grep -q "Unsupported GitHub CLI bootstrap platform: $os/$arch" "$unsupported_log"
  test ! -e "$TMP/unsupported-github-path-$os"
done

echo "setup-gh: linux positive, checksum failure, and unsupported platforms passed"
