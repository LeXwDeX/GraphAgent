#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2317
# ok/bad always return 0, so `cond && ok .. || bad ..` cannot mis-fire (SC2015);
# cleanup() runs via the EXIT trap, which shellcheck does not count (SC2317).
#
# B1 (archive integrity, #498): the installer must verify SHA256SUMS BEFORE
# extraction and fail closed on mismatch. These tests pin that boundary by
# driving the real `do_upgrade` path A (remote hash → download → verify →
# extract) from `./oc` sourced in a sandboxed subshell.
#
#   tamper  — SUMS declares hash A, archive is hash B: do_upgrade must exit
#             non-zero AND the install target must not exist (extraction never
#             happened). If anyone moves verify after extract, this goes red.
#   match   — consistent SUMS: end-to-end install succeeds and the installed
#             binary smokes (`--version`).
#   missing — upstream serves no SUMS: current behavior is warn-and-continue
#             (HTTPS transport only). Pinned explicitly so a silent change to
#             that policy is a visible test change, not a drift.
#
# Zero network: `curl` is a stub placed first on PATH mapping release URLs to
# local fixtures; `fzf` is
# stubbed so hosts without it can still source ./oc. HOME, OC_INSTALL_DIR and
# OC_LOCAL_DIR point into a throwaway sandbox; the repo and host are never
# touched. All do_upgrade invocations run in subshells because `die` calls
# exit, which under `source` would kill the harness.
#
# Wired into .azure-pipelines/ci.yml Typecheck (#498); also runnable manually on any bash host:
#   bash script/oc-install-boundary.test.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# OC_TEST_OC_PATH: target script override (falsifier drills can point at a
# mutated copy, e.g. verify/extract order swapped, to show the suite goes red).
OC="${OC_TEST_OC_PATH:-$ROOT/oc}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/oc-install-boundary-test.XXXXXX")
PASS=0
FAIL=0
TAG="v9.9.8-oc498"
FAKE_VERSION="9.9.8-oc498"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$1"; }

report() {
  printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ]
}

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Mirror oc's detect_asset for hosts this suite supports; anything else skips.
asset_for_host() {
  local os arch
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux)
      case "$arch" in
        x86_64|amd64) echo "opencode-linux-x64.tar.gz" ;;
        *) echo "" ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        arm64|aarch64) echo "opencode-darwin-arm64.zip" ;;
        *) echo "" ;;
      esac
      ;;
    *) echo "" ;;
  esac
}

ASSET=$(asset_for_host)
if [ -z "$ASSET" ]; then
  echo "skip: unsupported host platform ($(uname -s)/$(uname -m)); suite covers linux-x64 and darwin-arm64"
  exit 0
fi

# ---- fixtures ---------------------------------------------------------------

# A minimal "binary" whose --version smoke output the cases assert on.
FIXTURE_BIN_DIR="$WORK/fixture/root"
mkdir -p "$FIXTURE_BIN_DIR"
cat > "$FIXTURE_BIN_DIR/opencode" <<EOF
#!/bin/sh
echo "$FAKE_VERSION"
EOF
chmod +x "$FIXTURE_BIN_DIR/opencode"

case "$ASSET" in
  *.tar.gz) tar -czf "$WORK/fixture/$ASSET" -C "$FIXTURE_BIN_DIR" opencode ;;
  *.zip) (cd "$FIXTURE_BIN_DIR" && zip -q "$WORK/fixture/$ASSET" opencode) ;;
esac
ARCHIVE="$WORK/fixture/$ASSET"
[ -s "$ARCHIVE" ] || { bad "fixture archive built"; report; exit 1; }

REAL_HASH=$(digest "$ARCHIVE")
SUMS_DIR="$WORK/sums"
mkdir -p "$SUMS_DIR"
printf '%s  %s\n' "$REAL_HASH" "$ASSET" > "$SUMS_DIR/match"
printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "$ASSET" > "$SUMS_DIR/tamper"
# missing: discovery (stdout) still sees valid SUMS; only try_verify's fetch
# fails, which is how oc's warn-and-continue verify branch is reachable.
cp "$SUMS_DIR/match" "$SUMS_DIR/missing"

# ---- stub tools -------------------------------------------------------------

make_stub_dir() { # <case>
  local dir="$WORK/stubs/$1"
  mkdir -p "$dir"
  cat > "$dir/curl" <<'EOF'
#!/usr/bin/env bash
# stub curl: maps release URLs to local fixtures. -o writes to a file,
# otherwise SUMS content goes to stdout (fetch_remote_hash's contract).
# Fully literal: all knobs (OC_TEST_*, SUMS_DIR) arrive via the environment.
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
mode="${OC_TEST_SUMS:-match}"
case "$url" in
  */SHA256SUMS)
    # "missing" fails only the -o fetch (try_verify_sha256); the stdout fetch
    # (fetch_remote_hash) still succeeds, so path A runs and oc's
    # warn-and-continue branch at the verify step is what gets exercised.
    [ "$mode" = "missing" ] && [ -n "$outfile" ] && exit 22
    if [ -n "$outfile" ]; then
      cat "$SUMS_DIR/$mode" > "$outfile"
    else
      cat "$SUMS_DIR/$mode"
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
  # oc `need fzf` before anything runs; the TUI never starts under the guard.
  printf '#!/bin/sh\nexit 0\n' > "$dir/fzf"
  chmod +x "$dir/curl" "$dir/fzf"
}

# run_case <case> — env knobs (OC_TEST_SUMS) must already be exported.
run_case() { # <case>
  local case="$1"
  local sbx="$WORK/$case"
  mkdir -p "$sbx/home" "$sbx/bin" "$sbx/local-missing"
  make_stub_dir "$case"
  (
    cd "$sbx"
    export PATH="$WORK/stubs/$case:$sbx/bin:$PATH"
    export HOME="$sbx/home"
    export OC_INSTALL_DIR="$sbx/bin"
    export OC_OPENCODE_NAME="opencode"
    # No candidate dir has VERSION + asset (sandbox dirs are empty), so
    # find_local_dir fails and do_upgrade takes path A (online download).
    export OC_LOCAL_DIR="$sbx/local-missing"
    export OC_TEST_ARCHIVE="$ARCHIVE"
    export OC_TEST_ASSET="$ASSET"
    export OC_TEST_TAG="$TAG"
    export OC_TEST_OC="$OC"
    export SUMS_DIR
    bash -c '
      set -u
      source "$OC_TEST_OC"
      set +euo pipefail
      rc=0
      do_upgrade "$OC_TEST_TAG" || rc=$?
      exit "$rc"
    '
  ) > "$WORK/$case.out" 2> "$WORK/$case.err"
}

target_of() { # <case>
  printf '%s' "$WORK/$1/bin/opencode"
}

# ---- case tamper: SUMS mismatch must fail closed BEFORE extraction ----------
OC_TEST_SUMS=tamper run_case tamper
rc=$?
assert_rc() { [ "$1" = "$2" ]; }
assert_rc 1 "$rc" && ok "tamper: do_upgrade exits non-zero on hash mismatch" || bad "tamper: exit $rc, want non-zero (1)"
grep -q "SHA256 不匹配" "$WORK/tamper.err" && ok "tamper: die reports SHA256 mismatch" || bad "tamper: no mismatch diagnostic: $(tr '\n' '|' < "$WORK/tamper.err")"
[ ! -e "$(target_of tamper)" ] && ok "tamper: install target absent — extraction never ran after verify" || bad "tamper: target exists; verification did not gate extraction"

# ---- case match: consistent SUMS installs end-to-end ------------------------
run_case match
rc=$?
assert_rc 0 "$rc" && ok "match: do_upgrade exits 0" || bad "match: exit $rc, want 0: $(tr '\n' '|' < "$WORK/match.err")"
target=$(target_of match)
[ -x "$target" ] && ok "match: target installed and executable" || bad "match: target missing or not executable: $target"
[ "$("$target" --version 2>/dev/null)" = "$FAKE_VERSION" ] && ok "match: installed binary smoke --version correct" || bad "match: smoke output '$("$target" --version 2>/dev/null)', want $FAKE_VERSION"

# ---- case missing: warn-and-continue policy pinned as-is (#498 non-goal) ----
OC_TEST_SUMS=missing run_case missing
rc=$?
assert_rc 0 "$rc" && ok "missing: warn-skip policy continues to install (current behavior)" || bad "missing: exit $rc, want 0: $(tr '\n' '|' < "$WORK/missing.err")"
grep -q "未提供 SHA256SUMS" "$WORK/missing.err" && ok "missing: warns about absent SHA256SUMS" || bad "missing: no warn diagnostic: $(tr '\n' '|' < "$WORK/missing.err")"
[ -x "$(target_of missing)" ] && ok "missing: install completed under warn-skip" || bad "missing: target not installed"

report
exit $?
