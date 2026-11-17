#!/usr/bin/env bash

set -euo pipefail

: "${GH_CLI_VERSION:?GH_CLI_VERSION is required}"
: "${GH_CLI_LINUX_AMD64_SHA256:?GH_CLI_LINUX_AMD64_SHA256 is required}"
: "${GH_CLI_DOWNLOAD_BASE_URL:?GH_CLI_DOWNLOAD_BASE_URL is required}"
: "${RUNNER_OS:?RUNNER_OS is required}"
: "${RUNNER_ARCH:?RUNNER_ARCH is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "::error::A SHA-256 tool (sha256sum, shasum, or openssl) is required." >&2
    return 1
  fi
}

case "$RUNNER_OS:$RUNNER_ARCH" in
  Linux:X64)
    asset="gh_${GH_CLI_VERSION}_linux_amd64.tar.gz"
    expected="$GH_CLI_LINUX_AMD64_SHA256"
    member="gh_${GH_CLI_VERSION}_linux_amd64/bin/gh"
    installed_name="gh"
    ;;
  *)
    echo "::error::Unsupported GitHub CLI bootstrap platform: $RUNNER_OS/$RUNNER_ARCH" >&2
    exit 1
    ;;
esac

download_dir="$(mktemp -d "$RUNNER_TEMP/gh-cli-download.XXXXXX")"
install_dir="$(mktemp -d "$RUNNER_TEMP/gh-cli-install.XXXXXX")"
trap 'rm -rf "$download_dir"' EXIT

archive="$download_dir/$asset"
extract_dir="$download_dir/extract"
mkdir -p "$extract_dir" "$install_dir/bin"

curl --fail --location --silent --show-error \
  --connect-timeout 20 --max-time 300 --retry 3 --retry-delay 1 \
  --output "$archive" "$GH_CLI_DOWNLOAD_BASE_URL/$asset"

actual="$(digest "$archive")"
if [ "$actual" != "$expected" ]; then
  echo "::error::GitHub CLI archive checksum mismatch for $asset: expected $expected, got $actual" >&2
  exit 1
fi

tar -xzf "$archive" -C "$extract_dir"

source_binary="$extract_dir/$member"
if [ ! -f "$source_binary" ]; then
  echo "::error::GitHub CLI archive is missing expected member: $member" >&2
  exit 1
fi

installed_binary="$install_dir/bin/$installed_name"
cp "$source_binary" "$installed_binary"
chmod +x "$installed_binary"

printf '%s\n' "$install_dir/bin" >> "$GITHUB_PATH"

"$installed_binary" --version
