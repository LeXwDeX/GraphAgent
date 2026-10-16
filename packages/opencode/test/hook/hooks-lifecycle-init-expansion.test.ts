import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "explicit /init runs Setup and UserPromptExpansion before the model",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "init-hook-audit.jsonl")
      const script = path.join(home, "init-hook.ts")
      yield* Effect.promise(async () => {
        await Bun.$`git -C ${home} init -q`.quiet()
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({event:i.hook_event_name,trigger:i.trigger,command:i.command_name,source:i.command_source,expansion:i.expansion_type,session:i.session_id})+'\\n');if(i.hook_event_name==='UserPromptExpansion')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptExpansion',additionalContext:'EXPANSION_CONTEXT'}}));`,
        )
        const hook = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({ Setup: [{ hooks: [hook] }], UserPromptExpansion: [{ matcher: "init", hooks: [hook] }] }),
        )
      })
      yield* llm.text("INITIALIZED")
      const result = yield* opencode.run("/init", { format: "json", env: { PWD: home, OPENCODE_DB: "" } })
      opencode.expectExit(result, 0)
      const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(rows.map((row) => row.event)).toEqual(["Setup", "UserPromptExpansion"])
      expect(rows[0]).toMatchObject({ trigger: "init" })
      expect(rows[1]).toMatchObject({ command: "init", source: "command", expansion: "slash_command" })
      expect(rows[1].session).toBe(rows[0].session)
      const inputs = yield* llm.inputs
      expect(inputs.some((input) => JSON.stringify(input).includes("EXPANSION_CONTEXT"))).toBe(true)
    }),
  30_000,
)
