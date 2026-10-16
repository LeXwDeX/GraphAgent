import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

cliIt.live("direct shell validates replacement, asks permission, and uses replaced output", ({ home, opencode }) =>
  Effect.gen(function* () {
    const original = path.join(home, "original")
    const replacement = path.join(home, "replacement")
    const audit = path.join(home, "events")
    const script = path.join(home, "hook.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        script,
        `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+i.hook_event_name+"\\n");const event=i.hook_event_name;process.stdout.write(JSON.stringify(event==="PreToolUse"?{hookSpecificOutput:{hookEventName:event,permissionDecision:"ask",updatedInput:{command:"printf pre"}}}:event==="PermissionRequest"?{hookSpecificOutput:{hookEventName:event,decision:{behavior:"allow",updatedInput:{command:${JSON.stringify("printf executed > '" + replacement + "'")}}}}}:{hookSpecificOutput:{hookEventName:event,updatedToolOutput:{title:"replacement",output:"POST_REPLACED",metadata:{fixture:true}}}}));`,
      )
      const hooks = [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }]
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({ PreToolUse: hooks, PermissionRequest: hooks, PostToolUse: hooks }),
      )
    })
    const server = yield* opencode.serve()
    const post = (route: string, body: object) =>
      Effect.promise(() =>
        fetch(server.url + route, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          body: JSON.stringify(body),
        }),
      )
    const created = yield* post("/session", {})
    const session = yield* Effect.promise(() => created.json())
    const running = yield* post(`/session/${session.id}/shell`, {
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      command: `printf original > '${original}'`,
    }).pipe(Effect.forkScoped)
    const pending = yield* pollWithTimeout(
      Effect.promise(async () => {
        const response = await fetch(server.url + "/permission", { headers: { "x-opencode-directory": home } })
        const items = await response.json()
        return items.find((item: any) => item.sessionID === session.id)
      }),
      "forced permission was not pending",
    )
    yield* post(`/permission/${pending.id}/reply`, { reply: "once" })
    const response = yield* Fiber.join(running)
    expect(response.status).toBe(200)
    const result = yield* Effect.promise(() => response.json())
    expect(result.parts[0].state.output).toBe("POST_REPLACED")
    expect(result.parts[0].state.input).toEqual({ command: `printf executed > '${replacement}'` })
    expect(yield* Effect.promise(() => fs.readFile(replacement, "utf8"))).toBe("executed")
    expect(yield* Effect.promise(() => Bun.file(original).exists())).toBe(false)
    expect((yield* Effect.promise(() => fs.readFile(audit, "utf8"))).trim().split("\n")).toEqual([
      "PreToolUse",
      "PermissionRequest",
      "PermissionRequest",
      "PostToolUse",
    ])
  }),
)

cliIt.live("direct shell respects configured deny and never emits auto-only PermissionDenied", ({ home, opencode }) =>
  Effect.gen(function* () {
    const target = path.join(home, "forbidden")
    const audit = path.join(home, "unexpected-events")
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } })}'`,
                },
              ],
            },
          ],
          PermissionDenied: [{ hooks: [{ type: "command", command: `printf denied >> '${audit}'` }] }],
          PostToolUseFailure: [{ hooks: [{ type: "command", command: `printf failure >> '${audit}'` }] }],
        }),
      ),
    )
    const server = yield* opencode.serve({ env: { OPENCODE_PERMISSION: JSON.stringify({ bash: "deny" }) } })
    const post = (route: string, body: object) =>
      Effect.promise(() =>
        fetch(server.url + route, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          body: JSON.stringify(body),
        }),
      )
    const created = yield* post("/session", {})
    const session = yield* Effect.promise(() => created.json())
    const response = yield* post(`/session/${session.id}/shell`, {
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      command: `printf forbidden > '${target}'`,
    })
    expect(response.status).toBe(200)
    const result = yield* Effect.promise(() => response.json())
    expect(result.parts[0].state.status).toBe("error")
    expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
    expect(yield* Effect.promise(() => Bun.file(audit).exists())).toBe(false)
  }),
)

cliIt.live("direct shell reports a real spawn failure through PostToolUseFailure", ({ home, opencode }) =>
  Effect.gen(function* () {
    const shell = path.join(home, "fixture-shell")
    const audit = path.join(home, "failure-events")
    const script = path.join(home, "failure-hook.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(shell, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o700 })
      await fs.writeFile(path.join(home, ".config/opencode/opencode.json"), JSON.stringify({ shell }))
      await fs.writeFile(
        script,
        `const i=JSON.parse(await Bun.stdin.text());if(i.hook_event_name==="PreToolUse")await import("node:fs/promises").then(fs=>fs.unlink(${JSON.stringify(shell)}));else await Bun.write(${JSON.stringify(audit)},i.hook_event_name);`,
      )
      const hooks = [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }]
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({ PreToolUse: hooks, PostToolUse: hooks, PostToolUseFailure: hooks }),
      )
    })
    const server = yield* opencode.serve()
    const post = (route: string, body: object) =>
      Effect.promise(() =>
        fetch(server.url + route, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          body: JSON.stringify(body),
        }),
      )
    const created = yield* post("/session", {})
    const session = yield* Effect.promise(() => created.json())
    const response = yield* post(`/session/${session.id}/shell`, {
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      command: "printf never",
    })
    expect(response.status).toBe(200)
    const result = yield* Effect.promise(() => response.json())
    expect(result.parts[0].state.status).toBe("error")
    const observed = yield* pollWithTimeout(
      Effect.promise(() => fs.readFile(audit, "utf8").catch(() => undefined)),
      `missing failure hook, state=${JSON.stringify(result.parts[0].state)}`,
    )
    expect(observed).toBe("PostToolUseFailure")
  }),
)
