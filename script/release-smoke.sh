#!/usr/bin/env bash
# Release smoke test for one built GraphAgent CLI binary (#1034).
#
#   bash script/release-smoke.sh <path-to-graphagent> <expected-version>
#
# Both release pipelines (.github/workflows/release-fork.yml and
# .azure-pipelines/release.yml) run this from their "Verify CLI executable"
# step on every platform they build (Linux and macOS), so the two pipelines and
# both platforms assert the same thing. It never touches the network, starts no
# server and runs no agent: every invocation below is an offline, read-only
# command. Checks, in order:
#
#   1. `--version` prints exactly the expected version.
#   2. `--help` (written to stderr) starts with the one-line mark
#      "◇─◆ GraphAgent" (the non-TTY form of the logo, because stderr is a pipe
#      here), lists commands as "graphagent <name>" lines, and `run --help`
#      starts with "graphagent run".
#   3. The command list holds none of the commands removed in v2.0 (names or
#      aliases). They are never executed: the default command `$0 [project]`
#      treats an unknown word as a project directory, exits 0 and may start
#      the TUI. `removed_commands` below is the set of names that are absent
#      from the commands registered in packages/graphagent/src/index.ts; drop a
#      name from it when that command is deliberately brought back. Hidden
#      commands (such as the `upgrade` compatibility stub) are not in the
#      --help list and are not covered.
#   4. Path isolation: HOME, XDG_{CONFIG,DATA,STATE,CACHE}_HOME and TMPDIR point
#      into one fresh sandbox. `debug paths` must report data, cache, config,
#      state and tmp ending in "graphagent" and bin, log and repos directly
#      inside a "graphagent" directory, every path must lie inside the sandbox,
#      and nothing whose name contains "opencode" (any case) may be created
#      there.
#   5. The legacy OPENCODE_CONFIG_DIR is ignored: `debug paths` is unchanged and
#      nothing is written to that directory. GRAPHAGENT_CONFIG_DIR is the
#      control: it must change the reported config path, so the comparison
#      cannot pass only because the output never reacts to such variables.
#   6. No network: GRAPHAGENT_DISABLE_MODELS_FETCH=1 for every invocation.
#
# macOS additionally runs script/oc-macos-acceptance.test.sh after this.
# Exit status: 0 all checks passed, 1 a check failed, 2 bad arguments.
set -euo pipefail

if [ "$#" -ne 2 ] || [ -z "$2" ]; then
  echo "usage: bash script/release-smoke.sh <path-to-graphagent> <expected-version>" >&2
  exit 2
fi
cli="$1"
expected_version="$2"
if [ ! -f "$cli" ] || [ ! -x "$cli" ]; then
  echo "release-smoke: '$cli' is not an executable file" >&2
  exit 2
fi
case "$cli" in
  /*) ;;
  *) cli="$PWD/$cli" ;;
esac

logo='◇─◆ GraphAgent'
removed_commands='serve web attach acp plug github console'

work=""
cleanup() {
  if [ -n "$work" ]; then rm -rf "$work"; fi
}
trap cleanup EXIT
work="$(mktemp -d)"
sandbox="$work/sandbox"
mkdir -p "$work/cwd" "$sandbox/home" "$sandbox/config" "$sandbox/data" "$sandbox/state" "$sandbox/cache" "$sandbox/tmp"

step() { printf '==> %s\n' "$*"; }
ok() { printf 'ok   - %s\n' "$*"; }
indent() { sed 's/^/    /'; }
# fail <step> <message>: report the failed check and stop.
fail() {
  printf 'release-smoke: FAIL (step %s): %s\n' "$1" "$2" >&2
  exit 1
}

# Run the CLI inside the sandbox: stdin closed, empty working directory, the
# caller's GRAPHAGENT_* and OPENCODE_* variables dropped. Leading
# `--env NAME=value` pairs add variables on top.
run_cli() {
  local extra=() name
  while [ "${1:-}" = "--env" ]; do
    extra+=("$2")
    shift 2
  done
  (
    for name in $(compgen -e); do
      case "$name" in
        GRAPHAGENT_* | OPENCODE_*) unset "$name" ;;
      esac
    done
    cd "$work/cwd"
    export HOME="$sandbox/home" XDG_CONFIG_HOME="$sandbox/config" XDG_DATA_HOME="$sandbox/data"
    export XDG_STATE_HOME="$sandbox/state" XDG_CACHE_HOME="$sandbox/cache" TMPDIR="$sandbox/tmp"
    export GRAPHAGENT_DISABLE_MODELS_FETCH=1
    for name in ${extra[@]+"${extra[@]}"}; do
      # shellcheck disable=SC2163 # every item is a complete NAME=value assignment
      export "$name"
    done
    exec "$cli" "$@" < /dev/null
  )
}

# First line of $1 that is not blank.
first_line() { awk 'NF && !seen { print; seen = 1 }' <<< "$1"; }

# Names of the commands listed by --help ("  graphagent <name> ...") and their aliases ("[aliases: a, b]").
listed_commands() {
  sed -n -E 's/^  graphagent ([^ ]+).*/\1/p' <<< "$1"
  sed -n -E '/^  graphagent /s/.*\[aliases: ([^]]*)\].*/\1/p' <<< "$1" | tr ',' '\n' | tr -d ' '
}

# Value that `debug paths` ("<key padded to 10> <value>") printed for key $1 in text $2.
path_of() {
  awk -v key="$1" '$1 == key { sub(/^[^ ]+ +/, ""); print; found = 1 } END { exit !found }' <<< "$2"
}

# Fail unless nothing under the sandbox has "opencode" (any case) in its name.
assert_no_old_brand_names() {
  local found
  found="$(cd "$sandbox" && find . -iname '*opencode*' -print)" || fail "$1" "could not scan the sandbox"
  if [ -n "$found" ]; then
    fail "$1" "the CLI created paths named after the old brand inside the sandbox:
$(indent <<< "$found")"
  fi
}

step "1. --version"
actual_version="$(run_cli --version)" || fail 1 "'$cli --version' exited with a non-zero status"
[ "$actual_version" = "$expected_version" ] ||
  fail 1 "expected version '$expected_version', the CLI printed '$actual_version'"
ok "version is $actual_version"

step "2. --help"
help_text="$(run_cli --help 2>&1)" || fail 2 "'$cli --help' exited with a non-zero status"
mark="$(first_line "$help_text")"
[ "$mark" = "$logo" ] || fail 2 "the first non-blank line of --help should be '$logo', it is '$mark'"
ok "--help starts with '$logo'"
listed="$(listed_commands "$help_text")"
[ -n "$listed" ] || fail 2 "--help lists no 'graphagent <command>' lines:
$(indent <<< "$help_text")"
for name in run debug; do
  grep -qxF -- "$name" <<< "$listed" || fail 2 "--help does not list the '$name' command"
done
ok "--help lists commands ($(tr '\n' ' ' <<< "$listed" | sed 's/ $//'))"
run_help="$(run_cli run --help 2>&1)" || fail 2 "'$cli run --help' exited with a non-zero status"
run_mark="$(first_line "$run_help")"
case "$run_mark" in
  "graphagent run" | "graphagent run "*) ;;
  *) fail 2 "the first non-blank line of 'run --help' should start with 'graphagent run', it is '$run_mark'" ;;
esac
ok "run --help starts with '$run_mark'"

step "3. removed commands are not listed"
for name in $removed_commands; do
  if grep -qxF -- "$name" <<< "$listed"; then
    fail 3 "--help still lists the removed command '$name' (as a command name or an alias)"
  fi
done
ok "none of: $removed_commands"

step "4. path isolation"
paths="$(run_cli debug paths)" || fail 4 "'$cli debug paths' exited with a non-zero status"
for key in data cache config state tmp; do
  value="$(path_of "$key" "$paths")" || fail 4 "'debug paths' prints no '$key' line"
  [ "$(basename "$value")" = graphagent ] || fail 4 "'$key' should end in 'graphagent': $value"
done
for key in bin log repos; do
  value="$(path_of "$key" "$paths")" || fail 4 "'debug paths' prints no '$key' line"
  [ "$(basename "$(dirname "$value")")" = graphagent ] ||
    fail 4 "'$key' should sit directly inside a 'graphagent' directory: $value"
done
while read -r key value; do
  case "$value" in
    "$sandbox"/*) ;;
    *) fail 4 "'$key' lies outside the sandbox '$sandbox': $value" ;;
  esac
done <<< "$paths"
ok "data, cache, config, state, tmp end in graphagent; bin, log, repos sit inside it; all paths are in the sandbox"
assert_no_old_brand_names 4
ok "no path named after the old brand under the sandbox"

step "5. legacy OPENCODE_CONFIG_DIR is ignored"
legacy="$work/legacy"
control="$work/control"
mkdir -p "$legacy" "$control"
legacy_paths="$(run_cli --env OPENCODE_CONFIG_DIR="$legacy" debug paths)" ||
  fail 5 "'debug paths' failed with OPENCODE_CONFIG_DIR set"
[ "$legacy_paths" = "$paths" ] ||
  fail 5 "OPENCODE_CONFIG_DIR changed the output of 'debug paths':
$(diff <(printf '%s\n' "$paths") <(printf '%s\n' "$legacy_paths") | indent || true)"
written="$(find "$legacy" -mindepth 1 -print)" || fail 5 "could not scan '$legacy'"
[ -z "$written" ] || fail 5 "the CLI wrote into the OPENCODE_CONFIG_DIR directory:
$(indent <<< "$written")"
ok "OPENCODE_CONFIG_DIR changes no path and receives no file"
control_paths="$(run_cli --env GRAPHAGENT_CONFIG_DIR="$control" debug paths)" ||
  fail 5 "'debug paths' failed with GRAPHAGENT_CONFIG_DIR set"
control_config="$(path_of config "$control_paths")" || fail 5 "'debug paths' prints no 'config' line"
[ "$control_config" = "$control" ] ||
  fail 5 "control: GRAPHAGENT_CONFIG_DIR=$control should be reported as config, it is '$control_config'"
ok "control: GRAPHAGENT_CONFIG_DIR moves the config path"
assert_no_old_brand_names 5

echo "release-smoke: OK ($cli $actual_version)"
