import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"
cliIt.live("review V2 interrupt clears client busy status", ({ home, llm, opencode }) =>
  Effect.gen(function* () {
    const audit = path.join(home, "audit.jsonl")
    const hook = path.join(home, "hook.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        path.join(home, ".config/opencode/opencode.json"),
        JSON.stringify({
          providers: {
            test: {
              api: {
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                url: llm.url,
                settings: { apiKey: "fixture" },
              },
              models: { "test-model": {} },
            },
          },
        }),
      )
      await fs.writeFile(
        hook,
        `const i=JSON.parse(await Bun.stdin.text());if(i.hook_event_name==="PreToolUse")process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask"}}));if(i.hook_event_name==="Notification")await(await import("node:fs/promises")).appendFile(${JSON.stringify(audit)},JSON.stringify(i)+"\\n");`,
      )
      const handlers = [{ hooks: [{ type: "command", command: process.execPath, args: [hook] }] }]
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({ PreToolUse: handlers, Notification: handlers }),
      )
    })
    yield* llm.tool("write", { path: "review-file.txt", content: "fixture" })
    yield* llm.text("DONE")
    const server = yield* opencode.serve()
    const headers = { "content-type": "application/json", "x-opencode-directory": home }
    const request = (route: string, body?: object) =>
      Effect.promise(() =>
        fetch(server.url + route, {
          method: body ? "POST" : "GET",
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      )
    const created = yield* request("/api/session", {
      location: { directory: home },
      model: { providerID: "test", id: "test-model" },
    })
    expect(created.status).toBe(200)
    const id = (yield* Effect.promise(() => created.json())).data.id
    const controller = new AbortController()
    const events: { type?: string; properties?: { sessionID?: string; status?: { type: string } } }[] = []
    const stream = yield* Effect.promise(() => fetch(server.url + "/event", { headers, signal: controller.signal }))
    const reading = (async () => {
      const reader = stream.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop()!
          for (const line of lines) if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5)))
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error
      } finally {
        reader.releaseLock()
      }
    })()
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        controller.abort()
        await reading
      }),
    )
    const submit = yield* request(`/api/session/${id}/prompt`, {
      prompt: { text: "Write synthetic fixture" },
      resume: true,
    })
    expect(submit.status).toBe(200)
    yield* pollWithTimeout(
      request(`/api/session/${id}/permission`).pipe(
        Effect.flatMap((r) => Effect.promise(() => r.json())),
        Effect.map((r) => r.data?.[0]),
      ),
      "V2 permission pending",
      "10 seconds",
    )
    const cancelled = yield* request(`/api/session/${id}/interrupt`, {})
    expect(cancelled.status).toBe(204)
    yield* Effect.sleep("200 millis")
    const snapshot = yield* request("/session/status")
    const state = yield* Effect.promise(() => snapshot.json())
    const statuses = events
      .filter((x) => x.type === "session.status" && x.properties?.sessionID === id)
      .map((x) => x.properties?.status?.type)
    expect(state[id] ?? "idle").toBe("idle")
    expect(statuses.at(-1)).toBe("idle")
  }),
)
