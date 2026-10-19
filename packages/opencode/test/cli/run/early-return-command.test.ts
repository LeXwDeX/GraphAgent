// Regression test for #409: run mode hangs forever on early-return commands.
//
// Early-return command dispatches (/memory, /goal non-kick at
// src/session/prompt.ts) write a user message + text parts and return without
// an assistant step. The run CLI exits its event loop only on the
// `session.status {type:"idle"}` event, which the runner publishes on the
// busy→idle transition — a transition these commands never made, so
// `opencode run "/memory"` (and `run --command memory`) waited forever.
//
// Secondary bug under test: run.ts prints text parts only when `time.end` is
// set; the early-return response parts carried no `time`, so even a fixed
// hang would print nothing.
//
// Fix under test: the early-return branches run as a micro-turn through
// SessionRunState.startIfIdle when the session is idle (busy sessions keep
// today's inline semantics), and their response parts carry
// `time: { start, end }`.
//
// Harness notes (mirrors test/cli/run/headless-init.test.ts):
// - run.ts resolves its directory from process.env.PWD, so arms pin PWD to
//   the fixture home.
// - OPENCODE_DB="" restores the file-backed DB under the isolated home.
// - Arms stub one LLM reply only so the CLI has a default model to resolve;
//   the early-return paths themselves never call it.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"

const RUN_ENV = { OPENCODE_DB: "" }

const expectCompleted = (result: { exitCode: number; stdout: string }) => {
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim().length).toBeGreaterThan(0)
}

describe("run mode early-return commands complete (#409)", () => {
  // The #409 repro: "/memory" as a plain text prompt through the run CLI.
  // RED before the fix (hangs until the spawn timeout kills it).
  cliIt.live(
    'opencode run "/memory" prints the status and exits',
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("unused")
        const result = yield* opencode.run("/memory", { env: { PWD: home, ...RUN_ENV }, timeoutMs: 30_000 })
        expectCompleted(result)
      }),
    120_000,
  )

  // The --command flag arm from the issue evidence (v1.0.29 hangs the same way).
  cliIt.live(
    "opencode run --command memory prints the status and exits",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("unused")
        const result = yield* opencode.run("", { command: "memory", env: { PWD: home, ...RUN_ENV }, timeoutMs: 30_000 })
        expectCompleted(result)
      }),
    120_000,
  )

  // /goal with no arguments takes the non-kick early-return shape (status line).
  cliIt.live(
    'opencode run "/goal" prints the goal status and exits',
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("unused")
        const result = yield* opencode.run("/goal", { env: { PWD: home, ...RUN_ENV }, timeoutMs: 30_000 })
        expectCompleted(result)
      }),
    120_000,
  )
})

cliIt.live(
  "retired trust command follows normal unknown-command handling and preserves old trust data",
  ({ llm, home, opencode }) =>
    Effect.gen(function* () {
      yield* llm.text("unused")
      const file = path.join(home, ".local/share/opencode/trusted-workspaces.json")
      const old = '["/old-workspace"]\n'
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, old)
      })
      for (const args of ["", "status"]) {
        const result = yield* opencode.run(args, {
          command: "trust",
          env: { PWD: home, ...RUN_ENV },
          timeoutMs: 30_000,
        })
        expect(result.exitCode).not.toBe(0)
        // The HTTP boundary redacts unknown-command defects to UnknownError.
        expect(result.stdout + result.stderr).toContain("UnknownError")
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(old)
      }
      expect(yield* llm.calls).toBe(0)
    }),
  120_000,
)
