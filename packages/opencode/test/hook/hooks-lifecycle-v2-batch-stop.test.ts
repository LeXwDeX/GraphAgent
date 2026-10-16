import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

for (const decision of ["block", "continue_false"] as const) {
  for (const deferred of [false, true]) {
    cliIt.live(
      `V2 PostToolBatch ${decision} stops ${deferred ? "a deferred resume" : "a tool turn"} before the next model call`,
      ({ home, opencode, llm }) =>
        Effect.gen(function* () {
          const source = path.join(home, "batch-source.txt")
          const allow = path.join(home, "batch-allow")
          const audit = path.join(home, "batch-audit.jsonl")
          const script = path.join(home, "batch-hook.ts")
          const reason = `BATCH_STOP_${decision}`
          yield* Effect.promise(async () => {
            await fs.writeFile(source, "ACTUAL_BATCH_FILE_CONTENT")
            await fs.writeFile(
              path.join(home, ".config/opencode/opencode.json"),
              JSON.stringify({
                providers: {
                  test: {
                    name: "Test",
                    api: {
                      type: "aisdk",
                      package: "@ai-sdk/openai-compatible",
                      url: llm.url,
                      settings: { apiKey: "test-key" },
                    },
                    request: { body: { apiKey: "test-key" } },
                    models: {
                      "test-model": {
                        name: "Test",
                        capabilities: { tools: true, input: ["text"], output: ["text"] },
                        limit: { context: 100000, output: 10000 },
                        cost: { input: 0, output: 0 },
                      },
                    },
                  },
                },
              }),
            )
            await fs.writeFile(
              script,
              `const i=JSON.parse(await Bun.stdin.text());if(i.hook_event_name==='PreToolUse'){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:!${deferred}||await Bun.file(${JSON.stringify(allow)}).exists()?'allow':'defer'}}));}else if(i.hook_event_name==='PostToolBatch'){await(await import('node:fs/promises')).appendFile(${JSON.stringify(audit)},JSON.stringify(i)+'\\n');process.stdout.write(JSON.stringify(${JSON.stringify(decision === "block" ? { decision: "block", reason } : { continue: false, stopReason: reason })}));}`,
            )
            const hook = { type: "command", command: process.execPath, args: [script] }
            await fs.writeFile(
              path.join(home, ".config/opencode/hooks.json"),
              JSON.stringify({ PreToolUse: [{ hooks: [hook] }], PostToolBatch: [{ hooks: [hook] }] }),
            )
          })
          yield* llm.tool("read", { path: source })
          yield* llm.text("FRESH_AFTER_BATCH_STOP")
          const server = yield* opencode.serve()
          const request = (route: string, body?: object) =>
            fetch(server.url + route, {
              method: body ? "POST" : "GET",
              headers: { "content-type": "application/json", "x-opencode-directory": home },
              ...(body ? { body: JSON.stringify(body) } : {}),
            })
          const created = yield* Effect.promise(async () =>
            (
              await request("/api/session", {
                location: { directory: home },
                model: { providerID: "test", id: "test-model" },
              })
            ).json(),
          )
          const id = created.data.id
          const context = () =>
            Effect.promise(async () => JSON.stringify(await (await request(`/api/session/${id}/context`)).json()))
          expect(
            (yield* Effect.promise(() =>
              request(`/api/session/${id}/prompt`, { prompt: { text: "Read the actual batch source" } }),
            )).status,
          ).toBe(200)
          if (deferred) {
            yield* pollWithTimeout(
              context().pipe(Effect.map((value) => (value.includes("tool_deferred") ? true : undefined))),
              "read was not deferred",
              8000,
            )
            expect(yield* llm.calls).toBe(1)
            yield* Effect.promise(() => fs.writeFile(allow, "allow"))
            expect((yield* Effect.promise(() => request(`/api/session/${id}/resume`, {}))).status).toBe(204)
          }
          const stopped = yield* pollWithTimeout(
            Effect.gen(function* () {
              const value = yield* context()
              return value.includes(reason) || (yield* llm.calls) > 1 ? value : undefined
            }),
            "batch neither stopped nor continued",
            8000,
          )
          expect(yield* llm.calls).toBe(1)
          expect(stopped).toContain("ACTUAL_BATCH_FILE_CONTENT")
          expect(stopped).toContain(reason)
          expect(stopped).not.toContain("FRESH_AFTER_BATCH_STOP")
          const recorded = yield* Effect.promise(async () =>
            JSON.parse((await fs.readFile(audit, "utf8")).trim().split("\n")[0]),
          )
          expect(recorded.tool_calls).toHaveLength(1)
          expect(recorded.tool_calls[0].tool_name.toLowerCase()).toBe("read")
          expect(recorded.tool_calls[0].tool_input.path).toBe(source)
          expect(JSON.stringify(recorded.tool_calls[0].tool_response)).toContain("ACTUAL_BATCH_FILE_CONTENT")
          expect(
            (yield* Effect.promise(() =>
              request(`/api/session/${id}/prompt`, { prompt: { text: "NEW_INPUT_AFTER_BATCH_STOP" } }),
            )).status,
          ).toBe(200)
          const fresh = yield* pollWithTimeout(
            context().pipe(Effect.map((value) => (value.includes("FRESH_AFTER_BATCH_STOP") ? value : undefined))),
            "fresh prompt did not resume after batch stop",
            8000,
          )
          expect(fresh).toContain("NEW_INPUT_AFTER_BATCH_STOP")
          expect(yield* llm.calls).toBe(2)
        }),
    )
  }
}
