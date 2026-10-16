import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

for (const block of [false, true]) {
  cliIt.live(
    `real local compaction ${block ? "is vetoed before the model call" : "publishes committed summary before compact startup"}`,
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const script = path.join(home, "compact-hook.ts")
        const audit = path.join(home, "compact-audit.jsonl")
        yield* Effect.promise(async () => {
          await fs.writeFile(
            script,
            `const i=JSON.parse(await Bun.stdin.text());const transcript=await Bun.file(i.transcript_path).text();await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify({...i,transcript})+"\\n");if(${block}&&i.hook_event_name==='PreCompact')process.stdout.write(JSON.stringify({decision:'block',reason:'fixture precompact veto'}));`,
          )
          const hook = { type: "command", command: process.execPath, args: [script] }
          await fs.writeFile(
            path.join(home, ".config/opencode/hooks.json"),
            JSON.stringify({
              PreCompact: [{ hooks: [hook] }],
              PostCompact: [{ hooks: [hook] }],
              SessionStart: [{ matcher: "compact", hooks: [hook] }],
            }),
          )
        })
        const server = yield* opencode.serve()
        const post = (route: string, body: object) =>
          Effect.promise(() =>
            fetch(server.url + route, {
              method: "POST",
              headers: { "content-type": "application/json", "x-opencode-directory": home },
              body: JSON.stringify(body),
            }),
          )
        const created = yield* post("/session", {})
        const session = yield* Effect.promise(() => created.json())
        yield* llm.text("ORIGINAL_COMPACTION_ANSWER")
        const prompted = yield* post(`/session/${session.id}/message`, {
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "COMPACTION_ORIGINAL_USER" }],
        })
        expect(prompted.status).toBe(200)
        yield* Effect.promise(() => prompted.text())
        if (!block) yield* llm.text("REAL_COMMITTED_COMPACT_SUMMARY")
        const calls = llm.inputs.pipe(
          Effect.map(
            (inputs) =>
              inputs.filter((input) => !JSON.stringify(input).includes("Generate a title for this conversation"))
                .length,
          ),
        )
        const before = yield* calls
        const compacted = yield* post(`/session/${session.id}/summarize`, {
          providerID: "test",
          modelID: "test-model",
          auto: false,
        })
        expect(compacted.status).toBe(200)
        yield* Effect.promise(() => compacted.text())
        const rows = yield* Effect.promise(async () =>
          (await fs.readFile(audit, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        )
        expect(rows.map((row) => row.hook_event_name)).toEqual(
          block ? ["PreCompact"] : ["PreCompact", "PostCompact", "SessionStart"],
        )
        expect(rows[0].custom_instructions).toBeNull()
        expect(rows[0].trigger).toBe("manual")
        expect(rows[0].transcript).toContain("COMPACTION_ORIGINAL_USER")
        if (block) expect(yield* calls).toBe(before)
        else {
          expect(rows[1].compact_summary).toBe("REAL_COMMITTED_COMPACT_SUMMARY")
          expect(rows[1].transcript).toContain("REAL_COMMITTED_COMPACT_SUMMARY")
          expect(rows[2].source).toBe("compact")
        }
      }),
  )
}
