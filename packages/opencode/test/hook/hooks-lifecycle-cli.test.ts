import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "real local run emits startup and bounded SessionEnd with a readable completed transcript",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "lifecycle-audit.jsonl")
      const script = path.join(home, "lifecycle-hook.ts")
      const config = path.join(home, ".config/opencode/hooks.json")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          script,
          `const input=JSON.parse(await Bun.stdin.text());const transcript=await Bun.file(input.transcript_path).text();await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify({event:input.hook_event_name,session:input.session_id,source:input.source,reason:input.reason,model:input.model,title:input.session_title,context:input.context_tokens,warm:input.prompt_cache_warm,estimate:input.estimated_cache_write_usd,transcript})+"\\n");`,
        )
        const hook = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          config,
          JSON.stringify({ SessionStart: [{ hooks: [hook] }], SessionEnd: [{ hooks: [hook] }] }),
        )
      })
      yield* llm.text("lifecycle-real-answer")
      const result = yield* opencode.run("exercise local lifecycle", { format: "json" })
      expect(result.exitCode).toBe(0)
      const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(rows.map((row) => row.event)).toEqual(["SessionStart", "SessionEnd"])
      expect(rows[0]).toMatchObject({ source: "startup", model: "test-model" })
      expect(rows[0].context).toBeUndefined()
      expect(rows[0].warm).toBeUndefined()
      expect(rows[0].estimate).toBeUndefined()
      expect(rows[0].title).toBeUndefined()
      expect(rows[1].reason).toBe("other")
      expect(rows[1].session).toBe(rows[0].session)
      const transcript = rows[1].transcript
        .trim()
        .split("\n")
        .map((line: string) => JSON.parse(line))
      expect(
        transcript.some((row: { message: { content: { text?: string }[] } }) =>
          row.message.content.some((part) => part.text === "lifecycle-real-answer"),
        ),
      ).toBe(true)
      expect(result.stderr).not.toContain("lifecycle.")
    }),
)

for (const supplied of [false, true]) {
  cliIt.live(
    `SessionStart initial input is a real first turn${supplied ? " before supplied input" : " without CLI input"}`,
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const script = path.join(home, "initial-hook.ts")
        yield* Effect.promise(async () => {
          await fs.writeFile(
            script,
            `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",initialUserMessage:"HOOK_INITIAL_TURN"}}))`,
          )
          await fs.writeFile(
            path.join(home, ".config/opencode/hooks.json"),
            JSON.stringify({
              SessionStart: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
            }),
          )
        })
        yield* llm.text("INITIAL_TURN_COMPLETE")
        if (supplied) yield* llm.text("SUPPLIED_TURN_COMPLETE")
        const result = yield* opencode.run(supplied ? "SUPPLIED_NEXT_TURN" : "", { format: "json" })
        opencode.expectExit(result, 0)
        const inputs = yield* llm.inputs
        const relevant = inputs.filter(
          (input) =>
            JSON.stringify(input).includes("HOOK_INITIAL_TURN") &&
            !JSON.stringify(input).includes("Generate a title for this conversation"),
        )
        expect(relevant.length).toBe(supplied ? 2 : 1)
        expect(JSON.stringify(relevant[0])).not.toContain("SUPPLIED_NEXT_TURN")
        if (supplied) expect(JSON.stringify(relevant[1])).toContain("SUPPLIED_NEXT_TURN")
        expect(result.stdout).toContain("INITIAL_TURN_COMPLETE")
        if (supplied) expect(result.stdout).toContain("SUPPLIED_TURN_COMPLETE")
      }),
  )
}
