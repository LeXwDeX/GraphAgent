import { decodeV2Record, decodeV2Session } from "../lib/hook-json"
import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.live("V2 HTTP model switch runs PreModelSwitch before persisting and returns its refusal", ({ home, opencode }) =>
  Effect.gen(function* () {
    const audit = path.join(home, "v2-model-audit.jsonl")
    const allow = path.join(home, "allow-v2-model")
    const script = path.join(home, "v2-model-hook.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        script,
        `const input=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify(input)+"\\n");if(!await Bun.file(${JSON.stringify(allow)}).exists())process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreModelSwitch",permissionDecision:"deny",permissionDecisionReason:"MODEL_POLICY_DENIED"}}));`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          PreModelSwitch: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
        }),
      )
    })
    const server = yield* opencode.serve()
    const request = (route: string, method: string, body?: object) =>
      Effect.promise(() =>
        fetch(server.url + route, {
          method,
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      )
    const created = yield* request("/api/session", "POST", {
      location: { directory: home },
      model: { providerID: "test", id: "old-model" },
    })
    expect(created.status).toBe(200)
    const id = decodeV2Session(yield* Effect.promise(() => created.json())).data.id
    const route = `/api/session/${id}/model`
    const model = { providerID: "test", id: "test-model" }
    const denied = yield* request(route, "POST", { model })
    expect(denied.status).toBe(400)
    expect(yield* Effect.promise(() => denied.text())).toContain("MODEL_POLICY_DENIED")
    const before = yield* request(`/api/session/${id}`, "GET")
    expect(decodeV2Record(yield* Effect.promise(() => before.json())).data.model).toMatchObject({
      id: "old-model",
    })
    yield* Effect.promise(() => fs.writeFile(allow, "yes"))
    const accepted = yield* request(route, "POST", { model })
    expect(accepted.status).toBe(204)
    const after = yield* request(`/api/session/${id}`, "GET")
    expect(decodeV2Record(yield* Effect.promise(() => after.json())).data.model).toMatchObject(model)
    const rows = yield* Effect.promise(async () =>
      (await fs.readFile(audit, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    )
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.hook_event_name === "PreModelSwitch" && row.session_id === id)).toBe(true)
  }),
)

cliIt.live(
  "V2 model guidance and completed async context reach only the next actual request",
  ({ home, env, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "v2-next-request-audit.jsonl")
      const release = path.join(home, "v2-async-release")
      const done = path.join(home, "v2-async-done")
      const script = path.join(home, "v2-next-request-hook.ts")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());await (await import('node:fs/promises')).appendFile(${JSON.stringify(audit)},JSON.stringify(i)+'\\n');if(i.hook_event_name==='PostModelSwitch')process.stdout.write('V2_POST_MODEL_GUIDANCE');if(i.hook_event_name==='UserPromptSubmit'&&i.prompt==='FIRST_INPUT'){while(!await Bun.file(${JSON.stringify(release)}).exists())await Bun.sleep(20);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'V2_ASYNC_GUIDANCE'}}));await Bun.write(${JSON.stringify(done)},String(process.pid));}`,
        )
        const command = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            PostModelSwitch: [{ hooks: [command] }],
            UserPromptSubmit: [{ hooks: [{ ...command, async: true }] }],
          }),
        )
        const model = {
          name: "Fixture",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
        }
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
                models: { "old-model": model, "test-model": model },
              },
            },
          }),
        )
      })
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
      config.provider.test.models["old-model"] = { ...config.provider.test.models["test-model"] }
      const server = yield* opencode.serve({ env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } })
      const request = (route: string, body?: object) =>
        Effect.promise(async () => {
          const response = await fetch(server.url + route, {
            method: body ? "POST" : "GET",
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            ...(body ? { body: JSON.stringify(body) } : {}),
          })
          if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`)
          return response.status === 204 ? undefined : response.json()
        })
      const { data: session } = yield* request("/api/session", {
        location: { directory: home },
        model: { providerID: "test", id: "old-model" },
      })
      const route = `/api/session/${session.id}`
      const waitText = (text: string) =>
        Effect.promise(async () => {
          const deadline = Date.now() + 5000
          while (Date.now() < deadline) {
            const response = await fetch(server.url + route + "/context", { headers: { "x-opencode-directory": home } })
            const body = await response.json()
            if (JSON.stringify(body).includes(text)) return body.data
            await Bun.sleep(25)
          }
          throw new Error(`Missing V2 output ${text}; ${server.stderrTail()}`)
        })
      yield* llm.text("FIRST_DONE", { usage: { input: 100, output: 20 } })
      yield* request(route + "/prompt", { prompt: { text: "FIRST_INPUT" }, resume: true })
      yield* waitText("FIRST_DONE")
      expect(yield* llm.calls).toBe(1)
      yield* Effect.promise(() => fs.writeFile(release, "complete"))
      yield* Effect.promise(async () => {
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          const pid = Number(await fs.readFile(done, "utf8").catch(() => "0"))
          if (pid) {
            try {
              process.kill(pid, 0)
            } catch {
              await Bun.sleep(50)
              return
            }
          }
          await Bun.sleep(25)
        }
        throw new Error("The task-owned asynchronous hook did not finish")
      })
      expect(yield* llm.calls).toBe(1)
      yield* request(route + "/model", { model: { providerID: "test", id: "test-model" } })
      yield* llm.text("SECOND_DONE")
      yield* request(route + "/prompt", { prompt: { text: "SECOND_INPUT" }, resume: true })
      yield* waitText("SECOND_DONE")
      yield* llm.text("THIRD_DONE")
      yield* request(route + "/prompt", { prompt: { text: "THIRD_INPUT" }, resume: true })
      const context = yield* waitText("THIRD_DONE")
      const calls = yield* llm.inputs
      expect(calls).toHaveLength(3)
      expect(JSON.stringify(calls[0])).not.toContain("V2_ASYNC_GUIDANCE")
      expect(JSON.stringify(calls[1])).toContain("V2_ASYNC_GUIDANCE")
      expect(JSON.stringify(calls[1])).toContain("V2_POST_MODEL_GUIDANCE")
      expect(JSON.stringify(calls[2])).not.toContain("V2_ASYNC_GUIDANCE")
      expect(JSON.stringify(calls[2])).not.toContain("V2_POST_MODEL_GUIDANCE")
      expect(context.filter((item: { type?: unknown }) => item.type === "user")).toHaveLength(3)
      const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(rows.filter((row) => row.hook_event_name === "PostModelSwitch")).toEqual([
        expect.objectContaining({ session_id: session.id, source: "sdk", to_model: "test-model", context_tokens: 120 }),
      ])
    }),
)
