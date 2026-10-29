#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2317
# ok/bad always return 0, so `cond && ok .. || bad ..` cannot mis-fire (SC2015);
# cleanup() runs via the EXIT trap, which shellcheck does not count (SC2317).
#
# B2 (macOS post-install acceptance, #498): after the installer-style mutation
# (quarantine clearing via `xattr -cr` + ad-hoc re-sign via `codesign -fs -`,
# the real code path in oc's extract_and_install), acceptance must assert:
#
#   1. code-signature VALIDITY: `codesign --verify --strict` passes
#   2. executable smoke: the installed binary runs and answers --version
#   3. structural: the installer never compares the installed binary's hash to
#      the archive payload — ad-hoc re-signing can rewrite bytes, so byte
#      equality is not a stable signature-validity boundary, and #498 forbids
#      publishing a post-sign digest without a supported codesign
#      reproducibility matrix
#
# The verify assertion is self-checked: a negative control tampers a copy of
# the installed binary and must FAIL codesign --verify, proving assertion 1 is
# not vacuous.
#
# Modes:
#   bash script/oc-macos-acceptance.test.sh
#       self-sufficient: compiles an unsigned C stub and exercises the full
#       installer flow through the same stub-curl harness as
#       script/oc-install-boundary.test.sh (zero network).
#   bash script/oc-macos-acceptance.test.sh <artifact.zip>
#       CI release mode: runs the flow against a real packaged artifact,
#       e.g. packages/opencode/dist/opencode-darwin-x64.zip.
#
# Darwin-only; any other host exits 0. Wired into .azure-pipelines/release.yml (macOS job).
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OC="$ROOT/oc"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/oc-macos-acceptance.XXXXXX")
PASS=0
FAIL=0
TAG="v9.9.8-oc498"
STUB_VERSION="9.9.8-oc498"
ASSET="opencode-darwin-arm64.zip"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$1"; }

report() {
  printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ]
}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "skip: macOS acceptance boundary runs on Darwin only ($(uname -s))"
  exit 0
fi

for tool in cc codesign xattr zip unzip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    bad "required tool present: $tool"
    report
    exit 1
  fi
done

digest() { shasum -a 256 "$1" | awk '{print $1}'; }

# ---- fixture archive ---------------------------------------------------------

ARTIFACT="${1:-}"
if [ -n "$ARTIFACT" ]; then
  if [ ! -s "$ARTIFACT" ]; then
    bad "artifact zip exists: $ARTIFACT"
    report
    exit 1
  fi
  # Use the real artifact verbatim: extract_and_install finds the binary via
  # `find -name "opencode*"`, which matches the packaged layout.
  cp "$ARTIFACT" "$WORK/$ASSET"
else
  cat > "$WORK/stub.c" <<'EOF'
#include <stdio.h>
int main(void) { printf("STUB_VERSION_PLACEHOLDER\n"); return 0; }
EOF
  sed -i '' "s/STUB_VERSION_PLACEHOLDER/$STUB_VERSION/" "$WORK/stub.c"
  mkdir -p "$WORK/root"
  cc -o "$WORK/root/opencode" "$WORK/stub.c" || {
    bad "stub binary compiles"
    report
    exit 1
  }
  # Simulate an untrusted payload: strip the linker's ad-hoc signature so the
  # installer's re-sign step is what makes the binary valid.
  codesign --remove-signature "$WORK/root/opencode" 2>/dev/null || true
  (cd "$WORK/root" && zip -q "$WORK/$ASSET" opencode)
fi
ARCHIVE="$WORK/$ASSET"
[ -s "$ARCHIVE" ] || { bad "fixture archive built"; report; exit 1; }

REAL_HASH=$(digest "$ARCHIVE")
SUMS_DIR="$WORK/sums"
mkdir -p "$SUMS_DIR"
printf '%s  %s\n' "$REAL_HASH" "$ASSET" > "$SUMS_DIR/match"

# ---- stub tools (same contract as oc-install-boundary.test.sh) ---------------

STUBDIR="$WORK/stubs"
mkdir -p "$STUBDIR"
cat > "$STUBDIR/curl" <<'EOF'
#!/usr/bin/env bash
set -u
url=""
outfile=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    -o) i=$((i + 1)); outfile="${args[$i]}" ;;
    -*) ;;
    *) url="${args[$i]}" ;;
  esac
done
case "$url" in
  */SHA256SUMS)
    if [ -n "$outfile" ]; then
      cat "$SUMS_DIR/match" > "$outfile"
    else
      cat "$SUMS_DIR/match"
    fi
    exit 0
    ;;
  */$OC_TEST_ASSET)
    [ -n "$outfile" ] || exit 22
    cat "$OC_TEST_ARCHIVE" > "$outfile"
    exit 0
    ;;
esac
exit 22
EOF
printf '#!/bin/sh\nexit 0\n' > "$STUBDIR/fzf"
chmod +x "$STUBDIR/curl" "$STUBDIR/fzf"

# ---- run the installer flow against the real Darwin mutation path ----------

SBX="$WORK/sbx"
mkdir -p "$SBX/home" "$SBX/bin" "$SBX/local-missing"
(
  cd "$SBX"
  export PATH="$STUBDIR:$SBX/bin:$PATH"
  export HOME="$SBX/home"
  export OC_INSTALL_DIR="$SBX/bin"
  export OC_OPENCODE_NAME="opencode"
  export OC_LOCAL_DIR="$SBX/local-missing"
  export SUMS_DIR
  export OC_TEST_ARCHIVE="$ARCHIVE"
  export OC_TEST_ASSET="$ASSET"
  export OC_TEST_OC="$OC"
  export OC_TEST_TAG="$TAG"
  bash -c '
    set -u
    source "$OC_TEST_OC"
    set +euo pipefail
    rc=0
    do_upgrade "$OC_TEST_TAG" || rc=$?
    exit "$rc"
  '
) > "$WORK/run.out" 2> "$WORK/run.err"

rc=$?
[ "$rc" -eq 0 ] || bad "do_upgrade exits 0 (installer flow): $(tr '\n' '|' < "$WORK/run.err")"

TARGET="$SBX/bin/opencode"
[ -x "$TARGET" ] && ok "installer flow completed: target installed and executable" \
  || { bad "target missing or not executable: $TARGET"; report; exit 1; }

# ---- assertion 1: signature validity after installer-style re-sign ----------

if codesign --verify --strict "$TARGET" 2>"$WORK/verify.err"; then
  ok "codesign --verify --strict passes on installed binary (B2 validity)"
else
  bad "codesign --verify failed on installed binary: $(tr '\n' '|' < "$WORK/verify.err")"
fi

# Negative control: the validity assertion must be able to fail. Tampering a
# copy breaks the sealed resources, so verify must reject it.
cp "$TARGET" "$WORK/tampered"
printf 'x' >> "$WORK/tampered"
if codesign --verify --strict "$WORK/tampered" 2>/dev/null; then
  bad "negative control: tampered copy passed codesign --verify (assertion is vacuous)"
else
  ok "negative control: tampered copy rejected by codesign --verify (assertion non-vacuous)"
fi

# ---- assertion 2: executable smoke -------------------------------------------

smoke=$("$TARGET" --version 2>/dev/null)
if [ -n "$ARTIFACT" ]; then
  [ "$("$TARGET" --version >/dev/null 2>&1; echo $?)" = "0" ] && [ -n "$smoke" ] \
    && ok "artifact smoke: --version exits 0 with output" \
    || bad "artifact smoke failed: output '$smoke'"
else
  [ "$smoke" = "$STUB_VERSION" ] \
    && ok "smoke: installed binary --version correct ($STUB_VERSION)" \
    || bad "smoke output '$smoke', want $STUB_VERSION"
fi

# ---- assertion 3: structural — installer never hash-compares the target -----

# B2 draws the boundary at signature validity + smoke, NOT at byte identity:
# ad-hoc re-signing can rewrite bytes, so byte equality is not a stable
# signature-validity boundary and differing hashes are legitimate. Pin the
# absence of such a comparison.
if grep -nE 'file_sha256.*\$\{?target' "$OC" > "$WORK/struct-grep.txt"; then
  bad "structural: installer compares installed binary hash to payload: $(tr '\n' '|' < "$WORK/struct-grep.txt")"
else
  ok "structural: no installed-binary hash comparison in oc (B2 is not a digest boundary)"
fi
# The only hash machinery in the install path must live on the archive side
# (try_verify_sha256), before extraction.
if grep -nE 'try_verify_sha256' "$OC" | grep -q 'extract_and_install' ; then
  bad "structural: verify and extract lines fused unexpectedly"
else
  ok "structural: SHA256SUMS machinery stays on the pre-extract side"
fi

report
exit $?
