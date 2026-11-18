// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import stripAnsi from "strip-ansi"
import { spawn } from "../../../graphagent/test/lib/pty.bun"

/**
 * One end-to-end boot measurement: the real TUI in a pseudo-terminal, timed from spawn until the input box is on
 * screen. It prints one JSON report; `pty-report.ts` turns several of them into the nightly ratio table (#1279).
 */
const scenario = "boot-to-prompt"
const root = path.resolve(import.meta.dir, "../../../..")
const command = process.env.TUI_PTY_COMMAND ?? "bun"
const args = (process.env.TUI_PTY_ARGS ?? "run dev").split(" ").filter(Boolean)
/**
 * The input box shows this placeholder until the first keystroke. It is not `>`: the box has no prompt glyph, and the
 * first `>` in the stream is the renderer's terminal query (`ESC [ > 0 q`), about a second before any frame is drawn.
 */
const expected = process.env.TUI_PTY_EXPECTED ?? "Ask anything"
const timeoutMs = Number(process.env.TUI_PTY_TIMEOUT_MS ?? 30_000)
const baselinePath = process.env.TUI_PTY_BASELINE

/**
 * The commit the run measured. A copy of the tree without its `.git` (rsync'd or exported) has none to name, and
 * neither does a repository with no commit yet: both are `unknown`. `--verify` is for the second: a plain
 * `git rev-parse HEAD` prints the word `HEAD` on stdout before it fails.
 */
function gitCommit() {
  try {
    const output = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], {
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
    })
    return new TextDecoder().decode(output.stdout).trim() || "unknown"
  } catch {
    return "unknown"
  }
}

async function measure() {
  // Throwaway state: the number must not depend on the user's providers, plugins or sessions, and a run must not
  // write to them. The cache directory stays: bun keeps its transpile cache there, and a cold cache (400 ms or so
  // on the first boot) is not what a user waits for.
  const home = await mkdtemp(path.join(os.tmpdir(), "graphagent-pty-"))
  try {
    const inherited = Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    const env: Record<string, string> = {
      ...Object.fromEntries(inherited),
      GRAPHAGENT_FAST_BOOT: "1",
      GRAPHAGENT_TEST_HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      GRAPHAGENT_DISABLE_PROJECT_CONFIG: "1",
      GRAPHAGENT_DISABLE_MODELS_FETCH: "1",
      GRAPHAGENT_AUTH_CONTENT: "{}",
    }
    const started = performance.now()
    let output = ""
    let done!: (value: number) => void
    const ready = new Promise<number>((resolve) => (done = resolve))
    const proc = spawn(command, args, { name: "xterm-256color", cols: 100, rows: 30, cwd: root, env })
    const exited = new Promise<void>((resolve) => {
      proc.onExit(() => {
        // A process that ends before it draws the input box will not draw it later: fail now, not at the timeout.
        done(Number.POSITIVE_INFINITY)
        resolve()
      })
    })
    const data = proc.onData((chunk) => {
      output += chunk
      if (output.includes(expected)) done(performance.now() - started)
    })
    const timer = setTimeout(() => done(Number.POSITIVE_INFINITY), timeoutMs)
    const elapsedMs = await ready
    clearTimeout(timer)
    data.dispose()
    proc.kill("SIGTERM")
    // Let it release the state directory before that is removed, but do not wait on a process that ignores SIGTERM.
    let grace: ReturnType<typeof setTimeout> | undefined
    await Promise.race([exited, new Promise<void>((resolve) => (grace = setTimeout(resolve, 2_000)))])
    clearTimeout(grace)
    return { elapsedMs, output }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 3 })
  }
}

const { elapsedMs, output } = await measure()

let baselineMs: number | undefined
if (baselinePath) {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated benchmark report
  const baseline = (await Bun.file(path.resolve(baselinePath)).json()) as { elapsedMs?: number }
  baselineMs = baseline.elapsedMs
}

const finished = Number.isFinite(elapsedMs)
console.log(
  JSON.stringify(
    {
      scenario,
      command,
      args,
      expected,
      elapsedMs: finished ? Number(elapsedMs.toFixed(2)) : null,
      baselineMs,
      relative: baselineMs && finished ? Number((elapsedMs / baselineMs).toFixed(3)) : null,
      nightly: true,
      commit: gitCommit(),
      generatedAt: new Date().toISOString(),
      bun: Bun.version,
      machine: {
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model ?? "unknown",
        cpuCount: os.cpus().length,
      },
      // What the process printed instead, so a run that never reached the input box says why.
      outputTail: finished ? undefined : stripAnsi(output).slice(-600),
    },
    null,
    2,
  ),
)
if (!finished) process.exitCode = 1
