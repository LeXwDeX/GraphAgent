// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1034: behavior of script/release-smoke.sh. Kept apart from ci-azure.test.mjs because the stand-in CLI
// below must name the retired brand and its config variable to prove the smoke script rejects them; the
// brand-literal guard allows exactly this file and the script for that purpose.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// The smoke script itself, against a stand-in CLI that prints the real output formats. The release pipelines
// only run it when a release is cut, so its pass and fail paths are exercised here on every pull request.
// STUB_FAULT picks one regression for the stand-in to inject.
const smokeStub = `#!/usr/bin/env bash
if [ "$STUB_FAULT" = old-dir ]; then mkdir -p "$XDG_CONFIG_HOME/opencode"; fi
case "$*" in
  --version) echo 9.9.9 ;;
  --help)
    {
      if [ "$STUB_FAULT" = no-logo ]; then echo "OpenCode"; else echo "◇─◆ GraphAgent"; fi
      echo
      echo "Commands:"
      echo "  graphagent completion          generate shell completion script"
      echo "  graphagent [project]           start graphagent tui                       [default]"
      echo "  graphagent run [message..]     run graphagent with a message"
      echo "  graphagent debug               debugging and troubleshooting tools"
      echo "  graphagent providers           manage AI providers                   [aliases: auth]"
      echo "  graphagent pr <number>         fetch and checkout a GitHub PR branch, then run graphagent"
      if [ "$STUB_FAULT" = removed ]; then echo "  graphagent serve               start a server"; fi
    } >&2
    ;;
  "run --help") echo "graphagent run [message..]" >&2 ;;
  "debug paths")
    config="$XDG_CONFIG_HOME/graphagent"
    if [ -n "$GRAPHAGENT_CONFIG_DIR" ]; then config="$GRAPHAGENT_CONFIG_DIR"; fi
    if [ "$STUB_FAULT" = legacy-env ] && [ -n "$OPENCODE_CONFIG_DIR" ]; then config="$OPENCODE_CONFIG_DIR"; fi
    printf '%-10s %s\\n' home "$HOME" data "$XDG_DATA_HOME/graphagent" bin "$XDG_CACHE_HOME/graphagent/bin" \\
      log "$XDG_DATA_HOME/graphagent/log" repos "$XDG_DATA_HOME/graphagent/repos" cache "$XDG_CACHE_HOME/graphagent" \\
      config "$config" state "$XDG_STATE_HOME/graphagent" tmp "$TMPDIR/graphagent"
    ;;
esac
`

await test("release-smoke.sh passes a conforming CLI and names the step of each regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-smoke-test-"))
  try {
    const script = fileURLToPath(new URL("./release-smoke.sh", import.meta.url))
    const cli = join(dir, "graphagent")
    writeFileSync(cli, smokeStub, { mode: 0o755 })
    const smoke = (fault, { version = "9.9.9", env = {} } = {}) =>
      spawnSync("bash", [script, cli, version], {
        encoding: "utf8",
        env: { ...process.env, ...env, STUB_FAULT: fault },
      })

    const pass = smoke("none")
    assert.equal(pass.status, 0, pass.stderr)
    assert.match(pass.stdout, /release-smoke: OK/)
    // Variables of the caller that move paths must not reach the CLI.
    const inherited = { GRAPHAGENT_CONFIG_DIR: join(dir, "elsewhere"), OPENCODE_CONFIG_DIR: join(dir, "legacy") }
    const hermetic = smoke("none", { env: inherited })
    assert.equal(hermetic.status, 0, hermetic.stderr)

    const regressions = [
      { regression: "a different version", result: smoke("none", { version: "2.0.0" }), step: 1 },
      { regression: "the old logo", result: smoke("no-logo"), step: 2 },
      { regression: "a removed command", result: smoke("removed"), step: 3 },
      { regression: "a directory named after the old brand", result: smoke("old-dir"), step: 4 },
      { regression: "a legacy variable that is honored", result: smoke("legacy-env"), step: 5 },
    ]
    for (const { regression, result, step } of regressions) {
      assert.equal(result.status, 1, `${regression}: ${result.stderr}`)
      assert(result.stderr.includes(`FAIL (step ${step})`), `${regression}: ${result.stderr}`)
    }
    assert.equal(spawnSync("bash", [script, cli], { encoding: "utf8" }).status, 2, "arguments are checked")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
