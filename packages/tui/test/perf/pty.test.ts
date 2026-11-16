// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { existsSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { tmpdir } from "../fixture/fixture"

// The stand-in TUI is a shell script, and the PTY driver has no Windows backend.
const ptyTest = process.platform === "win32" ? test.skip : test
const script = path.join(import.meta.dir, "pty.ts")
const repoRoot = realpathSync(path.resolve(import.meta.dir, "../../../.."))

/** What the real TUI prints first: the renderer's terminal query, a `>` long before any frame. */
const QUERY = String.raw`printf '\033[>0q'`
const INPUT_BOX = `printf 'Ask anything... "Fix broken tests"'`

/** Runs `pty.ts` against a shell script that stands in for the TUI, so the measurement logic is tested without it. */
async function measure(directory: string, body: string, env: Record<string, string> = {}) {
  const fake = path.join(directory, "fake-tui.sh")
  await Bun.write(fake, `#!/usr/bin/env bash\n${body}\n`)
  const started = performance.now()
  const result = Bun.spawnSync(["bun", script], {
    // Not the repository: the script finds its own root.
    cwd: directory,
    env: {
      ...process.env,
      TUI_PTY_COMMAND: "bash",
      TUI_PTY_ARGS: fake,
      TUI_PTY_TIMEOUT_MS: "20000",
      PROBE_DIR: directory,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the report `pty.ts` prints
  const report = JSON.parse(result.stdout.toString()) as Record<string, unknown> & { machine: { platform: string } }
  return { code: result.exitCode, report, wallMs: performance.now() - started }
}

ptyTest("the wait ends at the input box, not at the first `>` of the terminal query", async () => {
  await using directory = await tmpdir()
  const { code, report } = await measure(directory.path, `${QUERY}\nsleep 0.8\n${INPUT_BOX}\nexec sleep 30`)
  expect(code).toBe(0)
  expect(report).toMatchObject({ scenario: "boot-to-prompt", expected: "Ask anything", nightly: true })
  // The query arrives at once; the input box 800 ms later. A `>` match would report a few milliseconds.
  expect(report.elapsedMs).toBeGreaterThanOrEqual(800)
  expect(report.elapsedMs).toBeLessThan(15_000)
  expect(report.machine.platform).toBe(process.platform)
  expect(report.commit).toMatch(/^[0-9a-f]{40}$/)
  expect(report.outputTail).toBeUndefined()
})

ptyTest("a process that ends before it draws the input box fails at once and says what it printed", async () => {
  await using directory = await tmpdir()
  const { code, report, wallMs } = await measure(directory.path, `echo 'error: Script not found "dev"'\nexit 1`)
  expect(code).toBe(1)
  expect(report.elapsedMs).toBeNull()
  expect(report.outputTail).toContain('error: Script not found "dev"')
  // The timeout is 20 s: the exit, not the timer, ended the wait.
  expect(wallMs).toBeLessThan(10_000)
})

ptyTest("a process that never draws the input box fails at the timeout", async () => {
  await using directory = await tmpdir()
  const { code, report, wallMs } = await measure(directory.path, `echo loading\nexec sleep 30`, {
    TUI_PTY_TIMEOUT_MS: "1500",
  })
  expect(code).toBe(1)
  expect(report.elapsedMs).toBeNull()
  expect(report.outputTail).toContain("loading")
  expect(wallMs).toBeGreaterThanOrEqual(1_500)
})

ptyTest("the TUI runs from the repository root on throwaway state that is removed afterwards", async () => {
  await using directory = await tmpdir()
  const probe = path.join(directory.path, "probe.txt")
  const body = [
    `{ pwd -P; echo "$GRAPHAGENT_TEST_HOME"; echo "$XDG_CONFIG_HOME"; echo "$XDG_DATA_HOME"; echo "$XDG_STATE_HOME"`,
    `  echo "$GRAPHAGENT_FAST_BOOT"; echo "$GRAPHAGENT_DISABLE_PROJECT_CONFIG"; echo "$GRAPHAGENT_DISABLE_MODELS_FETCH"`,
    `  echo "$GRAPHAGENT_AUTH_CONTENT"; } > "$PROBE_DIR/probe.txt"`,
    `mkdir -p "$XDG_DATA_HOME" && touch "$XDG_DATA_HOME/state.db"`,
    INPUT_BOX,
    `exec sleep 30`,
  ].join("\n")
  const { code } = await measure(directory.path, body)
  expect(code).toBe(0)
  const [cwd, home, config, data, state, fast, project, models, auth] = (await Bun.file(probe).text())
    .trim()
    .split("\n")
  expect(realpathSync(cwd)).toBe(repoRoot)
  expect(path.dirname(home)).toBe(os.tmpdir().replace(/\/$/, ""))
  expect([config, data, state].every((dir) => dir.startsWith(home + path.sep))).toBe(true)
  expect([fast, project, models, auth]).toEqual(["1", "1", "1", "{}"])
  expect(existsSync(home)).toBe(false)
})
