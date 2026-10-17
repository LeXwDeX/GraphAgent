import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

const TIMEOUT = 60_000

function auditLayer(home: string) {
  const audit = path.join(home, "setup-hook-audit.jsonl")
  const script = path.join(home, "setup-hook.ts")

  return Effect.promise(async () => {
    await Bun.$`git -C ${home} init -q`.quiet()
    await fs.writeFile(
      script,
      `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({event:i.hook_event_name,trigger:i.trigger,session:i.session_id})+'\\n');`,
    )
    await fs.writeFile(
      path.join(home, ".config/opencode/hooks.json"),
      JSON.stringify({
        Setup: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
      }),
    )
  }).pipe(Effect.as(audit))
}

function rows(file: string) {
  return Effect.promise(async () => {
    const text = await fs.readFile(file, "utf8").catch(() => "")
    return (
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        .map((line) => JSON.parse(line) as { event: string; trigger: string; session: string })
    )
  })
}

cliIt.live(
  "ordinary run does not emit Setup",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = yield* auditLayer(home)
      yield* llm.text("OK")
      const result = yield* opencode.spawn(["run", "hello"], {
        env: { PWD: home, OPENCODE_DB: "" },
      })
      opencode.expectExit(result, 0)
      expect(yield* rows(audit)).toEqual([])
    }),
  TIMEOUT,
)

cliIt.live(
  "run --init emits Setup(init) with the real session and continues the prompt",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = yield* auditLayer(home)
      yield* llm.text("INITIALIZED")
      const result = yield* opencode.spawn(["run", "--init", "hello"], {
        env: { PWD: home, OPENCODE_DB: "" },
      })
      opencode.expectExit(result, 0)
      const events = yield* rows(audit)
      expect(events.map((row) => [row.event, row.trigger])).toEqual([["Setup", "init"]])
      expect(events[0].session).toMatch(/^ses_/)
      const inputs = yield* llm.inputs
      expect(inputs.length).toBeGreaterThan(0)
    }),
  TIMEOUT,
)

cliIt.live(
  "run --maintenance emits Setup(maintenance)",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = yield* auditLayer(home)
      yield* llm.text("MAINTAINED")
      const result = yield* opencode.spawn(["run", "--maintenance", "hello"], {
        env: { PWD: home, OPENCODE_DB: "" },
      })
      opencode.expectExit(result, 0)
      const events = yield* rows(audit)
      expect(events.map((row) => [row.event, row.trigger])).toEqual([["Setup", "maintenance"]])
    }),
  TIMEOUT,
)

cliIt.live(
  "run --init-only emits Setup(init) and exits without a model turn",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = yield* auditLayer(home)
      const result = yield* opencode.spawn(["run", "--init-only"], {
        env: { PWD: home, OPENCODE_DB: "" },
      })
      opencode.expectExit(result, 0)
      const events = yield* rows(audit)
      expect(events.map((row) => [row.event, row.trigger])).toEqual([["Setup", "init"]])
      expect(yield* llm.inputs).toEqual([])
    }),
  TIMEOUT,
)
