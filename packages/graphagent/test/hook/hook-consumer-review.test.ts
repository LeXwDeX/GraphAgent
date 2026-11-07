import { expect } from "bun:test"
import { Effect, Layer, Exit, Fiber } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { consumerContext } from "@/hook/consumer-context"
import { AppLayer } from "@/effect/app-runtime"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { Session } from "@/session/session"
import { SessionHooks } from "@/hook/session-hooks"
import { Permission } from "@/permission"
import { MessageID, PartID } from "@/session/schema"
import { HookTranscript } from "@/hook/transcript"
import { TestInstance } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"

const it = testEffect(AppLayer.pipe(Layer.provideMerge(SessionHooks.defaultLayer)))

it.instance("raw permission and DirectoryAdded hooks receive actual JSONL, environment and mode", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const sessions = yield* Session.Service
    const session = yield* sessions.create({})
    const id = MessageID.ascending()
    yield* sessions.updateMessage({
      id,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: session.id,
      messageID: id,
      type: "text",
      text: "SYNTHETIC_PERMISSION_CONTEXT",
    })
    const env = yield* HookTranscript.environmentFile(session.id)
    yield* Effect.promise(() => fs.writeFile(env, "export FIXTURE_HOOK_CONTEXT=present\n"))
    const audit = path.join(instance.directory, "context.jsonl")
    const script = path.join(instance.directory, "context-hook.ts")
    yield* Effect.promise(() =>
      fs.writeFile(
        script,
        `const i=JSON.parse(await Bun.stdin.text()); const text=await Bun.file(i.transcript_path).text();await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify({event:i.hook_event_name,source:i.source,path:i.transcript_path,rows:text.trim().split("\\n").map(JSON.parse),env:process.env.FIXTURE_HOOK_CONTEXT,mode:i.permission_mode})+"\\n"); if(i.hook_event_name==="PermissionRequest") process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:i.hook_event_name,decision:{behavior:"allow"}}}));`,
      ),
    )
    const hooks = yield* SessionHooks.Service
    for (const event of ["PermissionRequest", "DirectoryAdded"] as const)
      yield* hooks.add(session.id, { event, hooks: [{ type: "command", command: process.execPath, args: [script] }] })
    const permission = yield* Permission.Service
    yield* permission.applyHookUpdates(session.id, [
      { type: "setMode", mode: "manual", destination: "session" },
      { type: "addDirectories", destination: "session", directories: [path.join(instance.directory, "added")] },
    ])
    yield* permission.ask({
      sessionID: session.id,
      permission: "fixture-context",
      patterns: ["*"],
      always: [],
      metadata: {},
      ruleset: [],
    })
    const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(rows.map((row) => row.event)).toEqual(["DirectoryAdded", "PermissionRequest"])
    expect(rows[0].source).toBe("register_repo_root")
    for (const row of rows) {
      expect(path.isAbsolute(row.path)).toBe(true)
      expect(row.rows[0].message.content).toEqual([{ type: "text", text: "SYNTHETIC_PERMISSION_CONTEXT" }])
      expect(row.env).toBe("present")
      expect(row.mode).toBe("default")
    }
  }),
)

it.instance("derives effort from the session model when the transcript prompt carries none", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      model: { id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("fixture"), variant: "high" },
    })
    const id = MessageID.ascending()
    yield* sessions.updateMessage({
      id,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: session.id,
      messageID: id,
      type: "text",
      text: "SESSION_EFFORT_PROMPT",
    })

    const context = yield* consumerContext(session.id)
    expect(context.promptID).toBe(id)
    expect(context.effort).toBe("high")
  }),
)

it.instance("bypass requires an isolated startup capability, retains deny and is cleared", () =>
  Effect.gen(function* () {
    const permissions = yield* Permission.Service
    const own = yield* (yield* Session.Service).create({})
    const other = yield* (yield* Session.Service).create({})
    const update = [{ type: "setMode" as const, mode: "bypassPermissions", destination: "projectSettings" as const }]
    yield* permissions.applyHookUpdates(other.id, update)
    expect((yield* permissions.hookPolicy(other.id)).mode).not.toBe("bypassPermissions")
    expect(permissions.grantHookBypass).toBeDefined()
    yield* permissions.grantHookBypass!(own.id)
    expect((yield* permissions.hookPolicy(own.id)).mode).not.toBe("bypassPermissions")
    yield* (yield* SessionHooks.Service).add(own.id, {
      event: "PermissionRequest",
      once: true,
      hooks: [
        {
          type: "command",
          command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedPermissions: update } } })}'`,
        },
      ],
    })
    const request = {
      sessionID: own.id,
      permission: "fixture-bypass",
      patterns: ["*"],
      always: [],
      metadata: {},
      ruleset: [],
    }
    yield* permissions.ask({ ...request, ruleset: [{ permission: "fixture-bypass", pattern: "*", action: "ask" }] })
    expect((yield* permissions.hookPolicy(own.id)).mode).toBe("bypassPermissions")
    expect(yield* permissions.list()).toEqual([])
    const otherAsk = yield* permissions.ask({ ...request, sessionID: other.id }).pipe(Effect.forkScoped)
    const pending = yield* pollWithTimeout(
      permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === other.id))),
      "other session must still ask",
    )
    yield* permissions.reply({ requestID: pending.id, reply: "reject" })
    expect(Exit.isFailure(yield* Fiber.await(otherAsk))).toBe(true)
    const denied = yield* permissions
      .ask({ ...request, ruleset: [{ permission: "fixture-bypass", pattern: "*", action: "deny" }] })
      .pipe(Effect.exit)
    expect(Exit.isFailure(denied)).toBe(true)
    const nativeDenied = yield* permissions
      .ask(request, {
        resolveRuleset: () =>
          Effect.succeed({
            native: [{ permission: "fixture-bypass", pattern: "*", action: "deny" }],
            rules: [{ permission: "fixture-bypass", pattern: "*", action: "allow" }],
          }),
      })
      .pipe(Effect.exit)
    expect(Exit.isFailure(nativeDenied)).toBe(true)
    yield* (yield* Session.Service).remove(own.id)
    yield* permissions.applyHookUpdates(own.id, update)
    expect((yield* permissions.hookPolicy(own.id)).mode).not.toBe("bypassPermissions")
    expect((yield* permissions.hookPolicy(other.id)).mode).not.toBe("bypassPermissions")
    const instance = yield* TestInstance
    expect(
      yield* Effect.promise(() => Bun.file(path.join(instance.directory, ".agents", "settings.json")).exists()),
    ).toBe(false)
    expect(
      yield* Effect.promise(() => Bun.file(path.join(instance.directory, ".agents", "settings.local.json")).exists()),
    ).toBe(false)
  }),
)
