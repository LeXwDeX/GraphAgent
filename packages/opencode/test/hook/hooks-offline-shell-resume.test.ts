import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { decodeRecord, decodeRecords, decodeSession, decodeString } from "../lib/hook-json"

cliIt.live(
  "cold HTTP resume skips an unavailable old model and validates the explicit replacement",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "switch-events.jsonl")
      const script = path.join(home, "switch-hook.ts")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          script,
          `await (await import('node:fs/promises')).appendFile(${JSON.stringify(audit)},(await Bun.stdin.text())+'\\n')`,
        )
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            PostModelSwitch: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
          }),
        )
      })
      const options = { env: { OPENCODE_DB: path.join(home, "cold-model.sqlite") } }
      const first = yield* opencode.serve(options)
      const post = (url: string, route: string, body: object) =>
        Effect.promise(() =>
          fetch(url + route, {
            method: "POST",
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            body: JSON.stringify(body),
          }),
        )
      const created = yield* post(first.url, "/session", {
        title: "Explicit replacement",
        model: { providerID: "removed-provider", id: "removed-model", variant: "default" },
      })
      expect(created.status).toBe(200)
      const session = decodeRecord(yield* Effect.promise(() => created.json()))
      const id = decodeString(session.id)
      expect(decodeRecord(session.model).id).toBe("removed-model")
      first.kill()
      yield* Effect.promise(() => first.exited)
      const second = yield* opencode.serve(options)
      yield* llm.text("VALID_REPLACEMENT")
      const response = yield* post(second.url, `/session/${id}/message`, {
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "Use the explicit available model" }],
      })
      expect(response.status).toBe(200)
      const result = decodeRecord(yield* Effect.promise(() => response.json()))
      expect(decodeRecord(result.info)).toMatchObject({ providerID: "test", modelID: "test-model" })
      expect(decodeRecord(result.info).error).toBeUndefined()
      expect(
        decodeRecords(result.parts).some((part) => part.type === "text" && part.text === "VALID_REPLACEMENT"),
      ).toBe(true)
      const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
        .trim()
        .split("\n")
        .map((line) => decodeRecord(JSON.parse(line)))
      expect(rows.some((row) => row.source === "resume")).toBe(false)
      expect(rows.some((row) => row.to_model === "test-model")).toBe(true)
      expect(yield* llm.calls).toBe(1)
      const unavailable = yield* post(second.url, `/session/${id}/message`, {
        model: { providerID: "removed-provider", modelID: "still-unavailable" },
        parts: [{ type: "text", text: "Reject an explicitly unavailable new model" }],
      })
      expect(unavailable.status).toBe(500)
      expect(yield* llm.calls).toBe(1)
    }),
)

for (const deny of [false, true]) {
  cliIt.live(
    `offline explicit shell ${deny ? "preserves native deny" : "rewrites the actual command"} and releases execution`,
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const marker = path.join(home, "rewritten-marker")
        const original = path.join(home, "original-marker")
        const audit = path.join(home, "tool-events.jsonl")
        const script = path.join(home, "tool-hook.ts")
        yield* Effect.promise(async () => {
          await fs.writeFile(
            script,
            `const i=JSON.parse(await Bun.stdin.text());await (await import('node:fs/promises')).appendFile(${JSON.stringify(audit)},JSON.stringify(i)+'\\n');if(i.hook_event_name==='PreToolUse')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:${JSON.stringify(`printf rewritten > '${marker}'`)}}}}))`,
          )
          const hooks = [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }]
          await fs.writeFile(
            path.join(home, ".config/opencode/hooks.json"),
            JSON.stringify({ PreToolUse: hooks, PostToolUse: hooks }),
          )
        })
        const server = yield* opencode.serve({
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: {}, enabled_providers: [] }),
            ...(deny ? { OPENCODE_PERMISSION: JSON.stringify({ bash: "deny" }) } : {}),
          },
        })
        const request = (route: string, body?: object) =>
          Effect.promise(() =>
            fetch(server.url + route, {
              method: body ? "POST" : "GET",
              headers: { "content-type": "application/json", "x-opencode-directory": home },
              ...(body ? { body: JSON.stringify(body) } : {}),
            }),
          )
        const providers = yield* request("/config/providers")
        expect(decodeRecord(yield* Effect.promise(() => providers.json())).providers).toEqual([])
        const created = yield* request("/session", { title: "Offline shell" })
        const id = decodeSession(yield* Effect.promise(() => created.json())).id
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = yield* request(`/session/${id}/shell`, {
            agent: "build",
            model: { providerID: "removed-provider", modelID: "removed-model" },
            command: `printf original > '${original}'`,
          })
          expect(response.status).toBe(200)
          const result = decodeRecord(yield* Effect.promise(() => response.json()))
          const part = decodeRecords(result.parts).find((part) => part.type === "tool")
          if (!part) throw new Error("explicit shell did not return its tool result")
          const state = decodeRecord(part.state)
          expect(state.status).toBe(deny ? "error" : "completed")
          if (!deny) expect(decodeRecord(state.input).command).toBe(`printf rewritten > '${marker}'`)
        }
        expect(yield* Effect.promise(() => Bun.file(original).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(!deny)
        if (!deny) expect(yield* Effect.promise(() => fs.readFile(marker, "utf8"))).toBe("rewritten")
        const permission = yield* request("/permission")
        expect(yield* Effect.promise(() => permission.json())).toEqual([])
        expect(yield* llm.calls).toBe(0)
        const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
          .trim()
          .split("\n")
          .map((line) => decodeRecord(JSON.parse(line)))
        expect(rows.filter((row) => row.hook_event_name === "PreToolUse")).toHaveLength(2)
        expect(rows.filter((row) => row.hook_event_name === "PostToolUse")).toHaveLength(deny ? 0 : 2)
      }),
  )
}
