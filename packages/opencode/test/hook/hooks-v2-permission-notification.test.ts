import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"
for (const outcome of ["pending", "reply", "cancel"] as const)
  cliIt.live(`V2 permission notification: ${outcome}`, ({ home, llm, opencode }) =>
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
      const submit = yield* request(`/api/session/${id}/prompt`, {
        prompt: { text: "Write synthetic fixture" },
        resume: true,
      })
      expect(submit.status).toBe(200)
      const pending = yield* pollWithTimeout(
        request(`/api/session/${id}/permission`).pipe(
          Effect.flatMap((r) => Effect.promise(() => r.json())),
          Effect.map((r) => r.data?.[0]),
        ),
        "V2 permission pending",
        "10 seconds",
      )
      if (outcome === "reply") yield* request(`/api/session/${id}/permission/${pending.id}/reply`, { reply: "reject" })
      if (outcome === "cancel") yield* request(`/api/session/${id}/interrupt`, {})
      yield* Effect.sleep("7 seconds")
      const raw = yield* Effect.promise(() => fs.readFile(audit, "utf8").catch(() => ""))
      const stillPending = yield* request(`/api/session/${id}/permission`)
      const still = (yield* Effect.promise(() => stillPending.json())).data
      expect(still.length).toBe(outcome === "pending" ? 1 : 0)
      if (outcome === "pending")
        yield* request(`/api/session/${id}/permission/${pending.id}/reply`, { reply: "reject" })
      if (outcome === "pending") expect(raw).toContain("permission_prompt")
      else expect(raw).toBe("")
    }),
  )
