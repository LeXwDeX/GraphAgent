import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

// InstructionsLoaded is background observation: the model request must not wait for the hook.
cliIt.live("V2 InstructionsLoaded does not delay the first model request", ({ home, opencode, llm }) =>
  Effect.gen(function* () {
    const done = path.join(home, "v2-instructions-done")
    const script = path.join(home, "v2-instructions-hook.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(path.join(home, ".config/opencode/AGENTS.md"), "# User instructions\n")
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
        `await Bun.stdin.text();await new Promise((resolve)=>setTimeout(resolve,9000));await (await import('node:fs/promises')).writeFile(process.argv[2],'done');`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          InstructionsLoaded: [{ hooks: [{ type: "command", command: process.execPath, args: [script, done] }] }],
        }),
      )
    })
    yield* llm.text("V2_INSTRUCTIONS_ANSWER")
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
      (yield* Effect.promise(() => request(`/api/session/${id}/prompt`, { prompt: { text: "hello" } }))).status,
    ).toBe(200)
    yield* pollWithTimeout(
      Effect.promise(async () =>
        JSON.stringify(await (await request(`/api/session/${id}/context`)).json()).includes("V2_INSTRUCTIONS_ANSWER")
          ? true
          : undefined,
      ),
      "model answer was delayed by the InstructionsLoaded hook",
      "8 seconds",
    )
    expect(yield* Effect.promise(() => fs.exists(done))).toBe(false)
    yield* pollWithTimeout(
      Effect.promise(async () => ((await fs.exists(done)) ? true : undefined)),
      "background hook completion",
      "30 seconds",
    )
  }),
)
