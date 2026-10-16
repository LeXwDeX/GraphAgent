import { expect } from "bun:test"
import { Effect, Layer, Exit, Fiber } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { SettingsHook } from "@/hook/settings"
import { consumerContext } from "@/hook/consumer-context"
import { AppLayer } from "@/effect/app-runtime"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { SessionHooks } from "@/hook/session-hooks"
import { Permission } from "@/permission"
import { MessageID, PartID } from "@/session/schema"
import { HookTranscript } from "@/hook/transcript"
import { SessionConversationHooks } from "@opencode-ai/core/session/conversation-hooks"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../../../core/test/fixture/location"
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

it.instance("V2 stop wins over defer without waiting for its tool batch", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const session = yield* (yield* Session.Service).create({})
    yield* (yield* SessionHooks.Service).add(session.id, {
      event: "PreToolUse",
      hooks: [
        {
          type: "command",
          command: `printf '%s' '{"continue":false,"stopReason":"combined-stop","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"defer","updatedInput":{"path":"changed"}}}'`,
        },
      ],
    })
    let batches = 0
    const hooks = yield* SessionConversationHooks.Service
    const result = yield* hooks
      .beforeTool({
        sessionID: session.id,
        toolCallID: "combined",
        toolName: "write",
        toolInput: { path: "original" },
        isSingle: () => {
          batches++
          return Promise.resolve(true)
        },
      })
      .pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(instance.directory) })),
        ),
      )
    expect(result.stopped).toBe("combined-stop")
    expect(result.deferred).toBeUndefined()
    expect(result.toolInput).toEqual({ path: "original" })
    expect(batches).toBe(0)
  }),
)

it.instance(
  "plugin-derived agent hooks still execute after a permission-only config write",
  () =>
    Effect.gen(function* () {
      yield* (yield* Plugin.Service).list()
      const agent = yield* Agent.Service
      const config = yield* Config.Service
      const settings = yield* SettingsHook.Service
      const session = yield* (yield* Session.Service).create({})
      const trigger = Effect.gen(function* () {
        const current = yield* agent.get("plugin-permission-agent")
        if (!current) throw new Error("Expected configured agent fixture")
        expect(current.hookSource).toBe("plugin")
        expect(current.hooks).toBeDefined()
        yield* settings.unregisterScoped?.(session.id, current.hookOrigin!) ?? Effect.void
        yield* settings.registerScoped?.(session.id, {
          kind: "agent",
          origin: current.hookOrigin!,
          source: current.hookSource,
          hooks: current.hooks,
        }) ?? Effect.void
        yield* settings.trigger(
          { event: "Stop", stopHookActive: false },
          yield* consumerContext(session.id).pipe(Effect.orDie),
        )
      })
      yield* trigger
      yield* config.updateHookPermissions([
        {
          type: "addRules",
          destination: "projectSettings",
          behavior: "deny",
          rules: [{ toolName: "fixture-permission-only" }],
        },
      ])
      yield* trigger
      const instance = yield* TestInstance
      expect(yield* Effect.promise(() => fs.readFile(path.join(instance.directory, "plugin-hook-ran"), "utf8"))).toBe(
        "xx",
      )
    }),
  {
    init: (directory) =>
      Effect.promise(async () => {
        const plugin = path.join(directory, "permission-plugin.mjs")
        const audit = path.join(directory, "plugin-hook-ran")
        await fs.writeFile(
          plugin,
          `export default async()=>({config(config){config.agent["plugin-permission-agent"].hooks={Stop:[{hooks:[{type:"command",command:${JSON.stringify("printf x >> " + JSON.stringify(audit))}}]}]}}})`,
        )
        await fs.writeFile(
          path.join(directory, "opencode.json"),
          JSON.stringify({ plugin: [plugin], agent: { "plugin-permission-agent": {} } }),
        )
      }),
  },
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
    expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "opencode.jsonc")).exists())).toBe(false)
  }),
)
