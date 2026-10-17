import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

cliIt.live("a real pending permission emits Notification through a command hook", ({ home, opencode }) =>
  Effect.gen(function* () {
    const audit = path.join(home, "notification-hook.jsonl")
    const script = path.join(home, "notification-hook.ts")
    const target = path.join(home, "not-executed")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        script,
        `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({event:i.hook_event_name,type:i.notification_type,message:i.message,session:i.session_id,transcript:i.transcript_path,mode:i.permission_mode})+'\\n');`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({ Notification: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }] }),
      )
    })
    const server = yield* opencode.serve({ env: { OPENCODE_PERMISSION: JSON.stringify({ bash: "ask" }) } })
    const headers = { "content-type": "application/json", "x-opencode-directory": home }
    const post = (route: string, body: object) =>
      Effect.promise(() => fetch(server.url + route, { method: "POST", headers, body: JSON.stringify(body) }))
    const created = yield* post("/session", {})
    expect(created.status).toBe(200)
    const session = yield* Effect.promise(() => created.json())
    const running = yield* post(`/session/${session.id}/shell`, {
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      command: `printf forbidden > '${target}'`,
    }).pipe(Effect.forkScoped)
    const pending = yield* pollWithTimeout(
      Effect.promise(async () => {
        const response = await fetch(server.url + "/permission", { headers })
        const items = await response.json()
        return items.find((item: { sessionID: string }) => item.sessionID === session.id)
      }),
      "permission did not become pending",
      "10 seconds",
    )
    expect(yield* Effect.promise(() => Bun.file(audit).exists())).toBe(false)
    const rows = yield* pollWithTimeout(
      Effect.promise(async () => {
        const raw = await fs.readFile(audit, "utf8").catch(() => "")
        return raw.trim()
          ? raw
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : undefined
      }),
      "Notification command hook did not run",
      "10 seconds",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ event: "Notification", type: "permission_prompt", session: session.id })
    expect(rows[0].message).toContain("bash")
    expect(rows[0].mode).toBe("default")
    expect(rows[0].transcript.length).toBeGreaterThan(0)
    expect(yield* Effect.promise(() => Bun.file(rows[0].transcript).exists())).toBe(true)
    const reply = yield* post(`/permission/${pending.id}/reply`, { reply: "reject" })
    expect(reply.status).toBe(200)
    const response = yield* Fiber.join(running)
    expect(response.status).toBe(200)
    const result = yield* Effect.promise(() => response.json())
    expect(result.parts[0].state.status).toBe("error")
    expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
    server.kill()
    yield* Effect.promise(() => server.exited).pipe(Effect.timeout("3 seconds"))
  }),
)
