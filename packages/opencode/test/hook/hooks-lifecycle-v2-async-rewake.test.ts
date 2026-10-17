import { decodeRecords, decodeV2Context, decodeV2Session } from "../lib/hook-json"
import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.live("V2 Stop async exit-2 rewakes its own runner without a synthetic user prompt", ({ home, llm, opencode }) =>
  Effect.gen(function* () {
    const script = path.join(home, "v2-async-stop.ts")
    const audit = path.join(home, "v2-async-stop-audit.jsonl")
    yield* Effect.promise(async () => {
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
                  name: "Test Model",
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  limit: { context: 100_000, output: 10_000 },
                  cost: { input: 0, output: 0 },
                },
              },
            },
          },
        }),
      )
      await fs.writeFile(
        script,
        `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({event:i.hook_event_name,active:i.stop_hook_active})+'\\n');if(!i.stop_hook_active){await Bun.sleep(100);console.error('ASYNC_REWAKE_CONTEXT');process.exit(2)}`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          Stop: [{ hooks: [{ type: "command", command: process.execPath, args: [script], asyncRewake: true }] }],
        }),
      )
    })
    yield* llm.text("FIRST_DONE")
    yield* llm.text("SECOND_DONE")
    const server = yield* opencode.serve()
    const headers = { "content-type": "application/json", "x-opencode-directory": home }
    const created = yield* Effect.promise(() =>
      fetch(server.url + "/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ location: { directory: home }, model: { providerID: "test", id: "test-model" } }),
      }),
    )
    expect(created.status).toBe(200)
    const id = decodeV2Session(yield* Effect.promise(() => created.json())).data.id
    const submitted = yield* Effect.promise(() =>
      fetch(server.url + `/api/session/${id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: { text: "one prompt" }, hookMode: "noninteractive", resume: true }),
      }),
    )
    expect(submitted.status).toBe(200)
    const messages = yield* Effect.promise(async () => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const response = await fetch(server.url + `/api/session/${id}/context`, { headers })
        const data = decodeV2Context(await response.json()).data
        if (JSON.stringify(data).includes("SECOND_DONE")) return data
        await Bun.sleep(50)
      }
      const response = await fetch(server.url + `/api/session/${id}/context`, { headers })
      throw new Error(
        `V2 async Stop did not rewake: ${JSON.stringify({ audit: await fs.readFile(audit, "utf8").catch(() => "none"), context: await response.json(), calls: await Effect.runPromise(llm.calls), stderr: server.stderrTail() })}`,
      )
    })
    expect(messages.filter((message) => message.type === "user")).toHaveLength(1)
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "synthetic", text: expect.stringContaining("ASYNC_REWAKE_CONTEXT") }),
    )
    const inputs = (yield* llm.inputs).filter((input) => !JSON.stringify(input).includes("Generate a title"))
    expect(inputs).toHaveLength(2)
    expect(JSON.stringify(inputs[1])).toContain("ASYNC_REWAKE_CONTEXT")
  }),
)

cliIt.live(
  "ordinary async JSON reaches the next V2 model call without a synthetic message",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const script = path.join(home, "v2-ordinary-async.ts")
      const release = path.join(home, "release-ordinary-async")
      yield* Effect.promise(async () => {
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
                    name: "Test Model",
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    limit: { context: 100_000, output: 10_000 },
                    cost: { input: 0, output: 0 },
                  },
                },
              },
            },
          }),
        )
        await fs.writeFile(
          script,
          `while(!await Bun.file(${JSON.stringify(release)}).exists())await Bun.sleep(10);console.log('work log');console.log(JSON.stringify({systemMessage:'V2_ASYNC_SYSTEM_TO_MODEL',hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'V2_ASYNC_CONTEXT_TO_MODEL'}}))`,
        )
      })
      yield* llm.text("FIRST_DONE")
      yield* llm.text("SECOND_DONE")
      const server = yield* opencode.serve()
      const headers = { "content-type": "application/json", "x-opencode-directory": home }
      const created = yield* Effect.promise(() =>
        fetch(server.url + "/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ location: { directory: home }, model: { providerID: "test", id: "test-model" } }),
        }),
      )
      expect(created.status).toBe(200)
      const id = decodeV2Session(yield* Effect.promise(() => created.json())).data.id
      const hookAdded = yield* Effect.promise(() =>
        fetch(server.url + `/session/${id}/hook`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            event: "UserPromptSubmit",
            once: true,
            hooks: [{ type: "command", command: process.execPath, args: [script], async: true }],
          }),
        }),
      )
      expect(hookAdded.status).toBe(200)
      const prompt = (text: string) =>
        Effect.promise(() =>
          fetch(server.url + `/api/session/${id}/prompt`, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt: { text }, hookMode: "noninteractive", resume: true }),
          }),
        )
      expect((yield* prompt("start async feedback")).status).toBe(200)
      yield* Effect.promise(async () => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          if ((await Effect.runPromise(llm.calls)) >= 1) return
          await Bun.sleep(20)
        }
        throw new Error(`first V2 model call did not arrive: ${server.stderrTail()}`)
      })
      yield* Effect.promise(() => fs.writeFile(release, "go"))
      yield* Effect.promise(async () => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const response = await fetch(server.url + `/session/${id}/hook`, { headers })
          if (response.status === 200 && decodeRecords(await response.json()).length === 0) return
          await Bun.sleep(20)
        }
        throw new Error("V2 ordinary async hook did not settle successfully")
      })
      expect((yield* prompt("consume async feedback")).status).toBe(200)
      yield* Effect.promise(async () => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          if ((await Effect.runPromise(llm.calls)) >= 2) return
          await Bun.sleep(20)
        }
        throw new Error(`second V2 model call did not arrive: ${server.stderrTail()}`)
      })
      const inputs = (yield* llm.inputs).filter((input) => !JSON.stringify(input).includes("Generate a title"))
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs[1])).toContain("V2_ASYNC_SYSTEM_TO_MODEL")
      expect(JSON.stringify(inputs[1])).toContain("V2_ASYNC_CONTEXT_TO_MODEL")
      const context = yield* Effect.promise(() =>
        fetch(server.url + `/api/session/${id}/context`, { headers }).then((response) => response.json()),
      )
      const messages = decodeV2Context(context).data
      expect(messages.filter((message) => message.type === "user")).toHaveLength(2)
      expect(
        messages.some((message) => message.type === "synthetic" && JSON.stringify(message).includes("V2_ASYNC_")),
      ).toBe(false)
    }),
)

cliIt.live("a new V2 user prompt invalidates the earlier asynchronous Stop callback", ({ home, llm, opencode }) =>
  Effect.gen(function* () {
    const script = path.join(home, "v2-async-old-stop.ts")
    const audit = path.join(home, "v2-async-old-stop-audit.jsonl")
    const started = path.join(home, "old-stop-started")
    const release = path.join(home, "release-old-stop")
    yield* Effect.promise(async () => {
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
                  name: "Test Model",
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  limit: { context: 100_000, output: 10_000 },
                  cost: { input: 0, output: 0 },
                },
              },
            },
          },
        }),
      )
      await fs.writeFile(
        script,
        `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({active:i.stop_hook_active})+'\\n');if(await Bun.file(${JSON.stringify(started)}).exists())process.exit(0);await Bun.write(${JSON.stringify(started)},'1');for(let n=0;n<300&&!await Bun.file(${JSON.stringify(release)}).exists();n++)await Bun.sleep(10);console.error('STALE_ASYNC_CONTEXT');process.exit(2)`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          Stop: [{ hooks: [{ type: "command", command: process.execPath, args: [script], asyncRewake: true }] }],
        }),
      )
    })
    yield* llm.text("FIRST_USER_DONE")
    yield* llm.text("SECOND_USER_DONE")
    const server = yield* opencode.serve()
    const headers = { "content-type": "application/json", "x-opencode-directory": home }
    const created = yield* Effect.promise(() =>
      fetch(server.url + "/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ location: { directory: home }, model: { providerID: "test", id: "test-model" } }),
      }),
    )
    expect(created.status).toBe(200)
    const id = decodeV2Session(yield* Effect.promise(() => created.json())).data.id
    const prompt = (text: string) =>
      Effect.promise(() =>
        fetch(server.url + `/api/session/${id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: { text }, hookMode: "noninteractive", resume: true }),
        }),
      )
    const readContext = () =>
      Effect.promise(async () => {
        const response = await fetch(server.url + `/api/session/${id}/context`, { headers })
        return decodeV2Context(await response.json()).data
      })
    const waitText = (needle: string) =>
      Effect.promise(async () => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const rows = await Effect.runPromise(readContext())
          if (JSON.stringify(rows).includes(needle)) return rows
          await Bun.sleep(50)
        }
        throw new Error(
          `V2 turn did not reach ${needle}: ${JSON.stringify({ audit: await fs.readFile(audit, "utf8").catch(() => "none"), context: await Effect.runPromise(readContext()), stderr: server.stderrTail() })}`,
        )
      })
    expect((yield* prompt("first user request")).status).toBe(200)
    yield* waitText("FIRST_USER_DONE")
    yield* Effect.promise(async () => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && !(await Bun.file(started).exists())) await Bun.sleep(20)
      if (!(await Bun.file(started).exists())) throw new Error("First async Stop never started")
    })
    expect((yield* prompt("second user request")).status).toBe(200)
    yield* waitText("SECOND_USER_DONE")
    yield* Effect.promise(() => fs.writeFile(release, "1"))
    yield* Effect.promise(() => Bun.sleep(200))
    const messages = yield* readContext()
    expect(messages.filter((message) => message.type === "user")).toHaveLength(2)
    expect(JSON.stringify(messages)).not.toContain("STALE_ASYNC_CONTEXT")
    const inputs = (yield* llm.inputs).filter((input) => !JSON.stringify(input).includes("Generate a title"))
    expect(inputs).toHaveLength(2)
  }),
)
