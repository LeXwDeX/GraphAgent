import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

// The PostToolBatch tool_response must be the result the model actually receives, not the tool's structured object.
cliIt.live("V2 PostToolBatch tool_response is the model-serialized tool result", ({ home, opencode, llm }) =>
  Effect.gen(function* () {
    const source = path.join(home, "batch-source.txt")
    const audit = path.join(home, "batch-audit.jsonl")
    const script = path.join(home, "batch-hook.ts")
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
        `const i=JSON.parse(await Bun.stdin.text());await(await import('node:fs/promises')).appendFile(${JSON.stringify(audit)},JSON.stringify(i)+'\\n');`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          PostToolBatch: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
        }),
      )
    })
    yield* llm.tool("read", { path: source })
    yield* llm.text("BATCH_SERIALIZATION_DONE")
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
    expect(
      (yield* Effect.promise(() => request(`/api/session/${id}/prompt`, { prompt: { text: "Read the batch source" } })))
        .status,
    ).toBe(200)
    yield* pollWithTimeout(
      Effect.gen(function* () {
        return (yield* llm.calls) >= 2 ? true : undefined
      }),
      "second model request",
      15000,
    )
    const recorded = yield* Effect.promise(async () =>
      JSON.parse((await fs.readFile(audit, "utf8")).trim().split("\n")[0]),
    )
    const second = JSON.stringify((yield* llm.inputs)[1])
    const response = recorded.tool_calls[0].tool_response
    expect(typeof response).toBe("string")
    expect(response).toContain("ACTUAL_BATCH_FILE_CONTENT")
    // The exact string the model was given for that tool call.
    expect(second).toContain(JSON.stringify(response).slice(1, -1))
  }),
)
