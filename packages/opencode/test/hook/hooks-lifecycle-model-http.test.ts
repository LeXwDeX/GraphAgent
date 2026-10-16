import { decodeRecord, decodeSession, decodeString } from "../lib/hook-json"
import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt, type RunOpts } from "../lib/cli-process"

cliIt.live("legacy HTTP preserves model-hook refusal and pending-resume reasons", ({ home, opencode }) =>
  Effect.gen(function* () {
    const script = path.join(home, "model-policy.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        script,
        `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreModelSwitch",permissionDecision:"deny",permissionDecisionReason:"MODEL_CHANGE_NEEDS_APPROVAL"}}))`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          PreModelSwitch: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
        }),
      )
    })
    const server = yield* opencode.serve()
    const request = (route: string, body: object) =>
      Effect.promise(() =>
        fetch(server.url + route, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          body: JSON.stringify(body),
        }),
      )
    const created = yield* request("/session", {
      title: "Model policy",
      model: { providerID: "test", id: "old-model", variant: "default" },
    })
    expect(created.status).toBe(200)
    const id = decodeSession(yield* Effect.promise(() => created.json())).id
    const denied = yield* request(`/session/${id}/model`, {
      model: { providerID: "test", modelID: "test-model" },
      source: "sdk",
    })
    expect(denied.status).toBe(400)
    expect(yield* Effect.promise(() => denied.json())).toMatchObject({
      _tag: "InvalidRequestError",
      message: "MODEL_CHANGE_NEEDS_APPROVAL",
    })
    const noPending = yield* request(`/session/${id}/resume`, {})
    expect(noPending.status).toBe(400)
    expect(yield* Effect.promise(() => noPending.text())).toContain(
      "No initial hook message or deferred tool call is pending",
    )
  }),
)

for (const transport of ["command", "http"] as const) {
  cliIt.live(
    `${transport} model hooks receive actual metrics and their guidance reaches the next model request`,
    ({ home, env, llm, opencode }) =>
      Effect.gen(function* () {
        const audit = path.join(home, "model-events.jsonl")
        const response = (event: string) =>
          event === "PostModelSwitch"
            ? { hookSpecificOutput: { hookEventName: event, additionalContext: "TARGET_MODEL_GUIDANCE" } }
            : { hookSpecificOutput: { hookEventName: event, permissionDecision: "allow" } }
        const http = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              async fetch(request) {
                const input = decodeRecord(await request.json())
                await fs.appendFile(audit, JSON.stringify(input) + "\n")
                return Response.json(response(decodeString(input.hook_event_name)))
              },
            }),
          ),
          (server) => Effect.sync(() => server.stop(true)),
        )
        const script = path.join(home, "model-hooks.ts")
        yield* Effect.promise(() =>
          fs.writeFile(
            script,
            `const i=JSON.parse(await Bun.stdin.text());await (await import("node:fs/promises")).appendFile(${JSON.stringify(audit)},JSON.stringify(i)+"\\n");process.stdout.write(JSON.stringify(i.hook_event_name==="PostModelSwitch"?{hookSpecificOutput:{hookEventName:i.hook_event_name,additionalContext:"TARGET_MODEL_GUIDANCE"}}:{hookSpecificOutput:{hookEventName:i.hook_event_name,permissionDecision:"allow"}}))`,
          ),
        )
        const handler =
          transport === "command"
            ? { type: "command", command: process.execPath, args: [script] }
            : { type: "http", url: `http://127.0.0.1:${http.port}/hook` }
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(home, ".config/opencode/hooks.json"),
            JSON.stringify({
              PreModelSwitch: [{ hooks: [handler] }],
              PostModelSwitch: [{ hooks: [handler] }],
            }),
          ),
        )
        const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
        config.provider.test.models.other = {
          ...config.provider.test.models["test-model"],
          id: "wire-other",
          cost: { input: 2, output: 3, cache_write: 4 },
        }
        const server = yield* opencode.serve({ env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } })
        const request = (route: string, body: object) =>
          Effect.promise(async () => {
            const result = await fetch(server.url + route, {
              method: "POST",
              headers: { "content-type": "application/json", "x-opencode-directory": home },
              body: JSON.stringify(body),
            })
            if (!result.ok) throw new Error(`${route}: ${result.status} ${await result.text()}`)
            return result.json()
          })
        const session = yield* request("/session", {
          title: "Model metric fixture",
          model: { providerID: "test", id: "test-model" },
        })
        yield* llm.text("FIRST_RESPONSE", { usage: { input: 100, output: 20 } })
        yield* request(`/session/${session.id}/message`, { parts: [{ type: "text", text: "first turn" }] })
        yield* request(`/session/${session.id}/model`, {
          model: { providerID: "test", modelID: "other" },
          source: "sdk",
        })
        yield* llm.text("SECOND_RESPONSE")
        yield* request(`/session/${session.id}/message`, { parts: [{ type: "text", text: "second turn" }] })
        const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(rows.map((row) => row.hook_event_name)).toEqual(["PreModelSwitch", "PostModelSwitch"])
        for (const row of rows) {
          expect(row).toMatchObject({
            from_model: "test-model",
            to_model: "wire-other",
            requested_model: "other",
            source: "sdk",
            context_tokens: 120,
            prompt_cache_warm: false,
            cache_ttl: "5m",
            pricing: "configured",
          })
          expect(row.estimated_cache_write_usd).toBeCloseTo(0.00048, 10)
          expect(yield* Effect.promise(() => Bun.file(row.transcript_path).exists())).toBe(true)
        }
        const calls = yield* llm.inputs
        expect(calls).toHaveLength(2)
        expect(calls[1].model).toBe("wire-other")
        expect(JSON.stringify(calls[1]).includes("TARGET_MODEL_GUIDANCE")).toBe(true)
      }),
  )
}

cliIt.live("V1 process restart restores model context once without a model change", ({ home, env, llm, opencode }) =>
  Effect.gen(function* () {
    const audit = path.join(home, "resume-model.jsonl")
    const hook = path.join(home, "resume-model.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        hook,
        `const i=JSON.parse(await Bun.stdin.text());await (await import('node:fs/promises')).appendFile(${JSON.stringify(audit)},JSON.stringify(i)+'\\n');if(i.hook_event_name==='PostModelSwitch')process.stdout.write('RESTORED_MODEL_CONTEXT');`,
      )
      const handler = { type: "command", command: process.execPath, args: [hook] }
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({ PreModelSwitch: [{ hooks: [handler] }], PostModelSwitch: [{ hooks: [handler] }] }),
      )
    })
    const opts = {
      format: "json",
      env: { ...env, OPENCODE_DB: path.join(home, "resume-model.sqlite") },
    } satisfies RunOpts
    yield* llm.text("BEFORE_RESTART", { usage: { input: 80, output: 20 } })
    const initial = yield* opencode.run("first input", opts)
    opencode.expectExit(initial, 0)
    const id = opencode.parseJsonEvents(initial.stdout).find((event) => typeof event.sessionID === "string")?.sessionID
    expect(id).toBeDefined()
    if (typeof id !== "string") throw new Error("Initial session ID missing")
    expect(yield* Effect.promise(() => Bun.file(audit).exists())).toBe(false)
    yield* llm.text("AFTER_RESTART")
    const resumed = yield* opencode.run("second input", { ...opts, extraArgs: ["--session", id] })
    opencode.expectExit(resumed, 0)
    const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      hook_event_name: "PostModelSwitch",
      session_id: id,
      source: "resume",
      from_model: "test-model",
      to_model: "test-model",
      context_tokens: 100,
    })
    const calls = (yield* llm.inputs).filter(
      (input) => !JSON.stringify(input).includes("Generate a title for this conversation"),
    )
    expect(calls).toHaveLength(2)
    expect(calls[1].model).toBe("test-model")
    expect(JSON.stringify(calls[0])).not.toContain("RESTORED_MODEL_CONTEXT")
    expect(JSON.stringify(calls[1])).toContain("RESTORED_MODEL_CONTEXT")
  }),
)

cliIt.live("V1 StopFailure receives exactly the displayed error", ({ home, llm, opencode }) =>
  Effect.gen(function* () {
    const audit = path.join(home, "stop-failure.json")
    const hook = path.join(home, "stop-failure.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(hook, `await Bun.write(${JSON.stringify(audit)},await Bun.stdin.text())`)
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({ StopFailure: [{ hooks: [{ type: "command", command: process.execPath, args: [hook] }] }] }),
      )
    })
    const server = yield* opencode.serve()
    const request = (route: string, body: object) =>
      Effect.promise(async () => {
        const response = await fetch(server.url + route, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          body: JSON.stringify(body),
        })
        expect(response.status).toBe(200)
        return response.json()
      })
    const session = yield* request("/session", { title: "Displayed error" })
    yield* llm.error(400, { error: { message: "VISIBLE_INVALID_REQUEST" } })
    const result = yield* request(`/session/${session.id}/message`, { parts: [{ type: "text", text: "fail once" }] })
    const envelope = JSON.parse(yield* Effect.promise(() => fs.readFile(audit, "utf8")))
    expect(result.info.error.data.message).toContain("VISIBLE_INVALID_REQUEST")
    expect(envelope).toMatchObject({
      error: "invalid_request",
      error_details: result.info.error.data.message,
      last_assistant_message: result.info.error.data.message,
    })
    expect(yield* llm.calls).toBe(1)
  }),
)
