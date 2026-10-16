import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { AppLayer } from "@/effect/app-runtime"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import { Permission } from "@/permission"
import { Agent } from "@/agent/agent"
import { SessionHooks } from "@/hook/session-hooks"
import { SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"

const it = testEffect(AppLayer.pipe(Layer.provideMerge(SessionHooks.defaultLayer)))
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"

describe("permission updates through real AppLayer and command hooks", () => {
  it.instance(
    "four destinations apply, preserve JSONC and survive directory reload without session grants",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const cfg = yield* Config.Service
        const permissions = yield* Permission.Service
        const hooks = yield* SessionHooks.Service
        const originalGlobal = Global.Path.config
        const globalDir = path.join(instance.directory, "isolated-global")
        yield* Effect.promise(() => fs.mkdir(globalDir, { recursive: true }))
        ;(Global.Path as { config: string }).config = globalDir
        yield* cfg.invalidate()
        yield* Effect.gen(function* () {
          const projectFile = path.join(instance.directory, "opencode.jsonc")
          yield* Effect.promise(() =>
            fs.writeFile(projectFile, '{\n  // retain this unrelated comment\n  "username": "fixture-user"\n}\n'),
          )
          const id = SessionID.descending()
          const updates = ["session", "localSettings", "projectSettings", "userSettings"].map((destination) => ({
            type: "addRules",
            destination,
            behavior: "allow",
            rules: [{ toolName: `fixture_${destination}` }],
          }))
          const counter = path.join(instance.directory, "hook-count")
          yield* hooks.add(id, {
            event: "PermissionRequest",
            once: true,
            hooks: [
              {
                type: "command",
                command: `printf x >> ${quote(counter)}; printf '%s' ${quote(
                  JSON.stringify({
                    hookSpecificOutput: {
                      hookEventName: "PermissionRequest",
                      decision: { behavior: "allow", updatedPermissions: updates },
                    },
                  }),
                )}`,
              },
            ],
          })
          yield* permissions.ask({
            sessionID: id,
            permission: "fixture_trigger",
            patterns: ["*"],
            always: [],
            metadata: {},
            ruleset: [],
          })
          const current = yield* cfg.get()
          for (const destination of ["localSettings", "projectSettings", "userSettings"])
            expect(current.permissions).toContainEqual({
              action: `fixture_${destination}`,
              resource: "*",
              effect: "allow",
            })
          expect(yield* Effect.promise(() => fs.readFile(projectFile, "utf8"))).toContain(
            "retain this unrelated comment",
          )
          expect(
            yield* Effect.promise(() => fs.readFile(path.join(instance.directory, ".opencode", ".gitignore"), "utf8")),
          ).toContain("permissions.local.json")
          yield* permissions.ask({
            sessionID: id,
            permission: "fixture_session",
            patterns: ["*"],
            always: [],
            metadata: {},
            ruleset: [],
          })
          expect(yield* Effect.promise(() => fs.readFile(counter, "utf8"))).toBe("x")
          const agent = yield* Agent.Service
          expect(
            Permission.evaluate("fixture_projectSettings", "*", (yield* agent.permissionPolicy("build")).rules).action,
          ).toBe("allow")
          const reloaded = yield* (yield* InstanceStore.Service).reload({ directory: instance.directory })
          const after = yield* cfg.get().pipe(Effect.provideService(InstanceRef, reloaded))
          expect(after.permissions).toContainEqual({ action: "fixture_localSettings", resource: "*", effect: "allow" })
          const blocked = yield* permissions
            .ask({
              sessionID: id,
              permission: "fixture_session",
              patterns: ["*"],
              always: [],
              metadata: {},
              ruleset: [],
            })
            .pipe(Effect.provideService(InstanceRef, reloaded), Effect.forkScoped)
          const pending = yield* pollWithTimeout(
            permissions.list().pipe(
              Effect.provideService(InstanceRef, reloaded),
              Effect.map((items) => (items.length ? items : undefined)),
            ),
            "session permission was not pending",
          )
          yield* permissions
            .reply({ requestID: pending[0].id, reply: "reject" })
            .pipe(Effect.provideService(InstanceRef, reloaded))
          expect(Exit.isFailure(yield* Fiber.await(blocked))).toBe(true)
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              ;(Global.Path as { config: string }).config = originalGlobal
              yield* cfg.invalidate().pipe(Effect.orDie)
            }),
          ),
        )
      }),
    { git: true },
  )
})

it.instance("supported session modes govern the real permission dialog and native plan rules", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const agent = yield* Agent.Service
    const id = SessionID.descending()
    const request = {
      sessionID: id,
      permission: "edit",
      patterns: ["src/file.ts"],
      always: [],
      metadata: {},
      ruleset: [],
    }
    yield* permission.applyHookUpdates(id, [{ type: "setMode", mode: "dontAsk", destination: "session" }])
    expect(Exit.isFailure(yield* permission.ask(request).pipe(Effect.exit))).toBe(true)
    expect(yield* permission.list()).toHaveLength(0)
    yield* permission.applyHookUpdates(id, [{ type: "setMode", mode: "acceptEdits", destination: "session" }])
    expect(Exit.isSuccess(yield* permission.ask(request).pipe(Effect.exit))).toBe(true)
    const explicit = yield* permission
      .ask({ ...request, ruleset: [{ permission: "edit", pattern: "*", action: "ask" }] })
      .pipe(Effect.forkScoped)
    const pending = yield* pollWithTimeout(
      permission.list().pipe(Effect.map((items) => (items.length ? items : undefined))),
      "explicit ask must remain",
    )
    yield* permission.reply({ requestID: pending[0].id, reply: "once" })
    expect(Exit.isSuccess(yield* Fiber.await(explicit))).toBe(true)
    yield* permission.applyHookUpdates(id, [{ type: "setMode", mode: "plan", destination: "session" }])
    const options = { resolveRuleset: (mode?: "plan") => agent.permissionPolicy(mode ?? "build") }
    expect(Exit.isFailure(yield* permission.ask(request, options).pipe(Effect.exit))).toBe(true)
    expect(
      Exit.isSuccess(
        yield* permission.ask({ ...request, patterns: [".opencode/plans/fixture.md"] }, options).pipe(Effect.exit),
      ),
    ).toBe(true)
    yield* permission.applyHookUpdates(id, [{ type: "setMode", mode: "bypassPermissions", destination: "session" }])
    expect((yield* permission.hookPolicy(id)).mode).toBe("plan")
    yield* permission.clearHookPolicy(id)
    expect((yield* permission.hookPolicy(id)).mode).toBeUndefined()
  }),
)

it.instance("rule removals and replacements refresh an already cached Agent without losing unrelated JSONC", () =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const agent = yield* Agent.Service
    const instance = yield* TestInstance
    yield* agent.get("build")
    yield* cfg.updateHookPermissions([
      { type: "addRules", behavior: "deny", destination: "projectSettings", rules: [{ toolName: "fixture_rule" }] },
    ])
    const deniedAgent = yield* agent.get("build")
    if (!deniedAgent) throw new Error("Expected build agent after permission update")
    expect(Permission.evaluate("fixture_rule", "*", deniedAgent.permission).action).toBe("deny")
    yield* cfg.updateHookPermissions([
      { type: "removeRules", behavior: "deny", destination: "projectSettings", rules: [{ toolName: "fixture_rule" }] },
    ])
    const allowedAgent = yield* agent.get("build")
    if (!allowedAgent) throw new Error("Expected build agent after permission removal")
    expect(Permission.evaluate("fixture_rule", "*", allowedAgent.permission).action).toBe("allow")
    yield* cfg.updateHookPermissions([
      { type: "addRules", behavior: "allow", destination: "projectSettings", rules: [{ toolName: "old_rule" }] },
    ])
    yield* cfg.updateHookPermissions([
      { type: "replaceRules", behavior: "allow", destination: "projectSettings", rules: [{ toolName: "new_rule" }] },
    ])
    expect((yield* cfg.get()).permissions?.some((rule) => rule.action === "old_rule")).toBe(false)
    expect((yield* cfg.get()).permissions).toContainEqual({ action: "new_rule", resource: "*", effect: "allow" })
    const file = path.join(instance.directory, "opencode.jsonc")
    const before = yield* Effect.promise(() => fs.readFile(file, "utf8"))
    expect(
      Exit.isFailure(
        yield* cfg
          .updateHookPermissions([{ type: "setMode", mode: "auto", destination: "projectSettings" }])
          .pipe(Effect.exit),
      ),
    ).toBe(true)
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
    yield* cfg.updateHookPermissions([{ type: "setMode", mode: "bypassPermissions", destination: "projectSettings" }])
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
  }),
)

it.instance("directory grants emit the real hook and remain isolated from another session", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const permission = yield* Permission.Service
    const hooks = yield* SessionHooks.Service
    const id = SessionID.descending()
    const other = SessionID.descending()
    const directory = path.join(instance.directory, "additional")
    const capture = path.join(instance.directory, "directory-event.json")
    yield* hooks.add(id, { event: "DirectoryAdded", hooks: [{ type: "command", command: `cat > ${quote(capture)}` }] })
    yield* permission.applyHookUpdates(id, [
      { type: "addDirectories", destination: "session", directories: [directory] },
    ])
    const envelope = JSON.parse(yield* Effect.promise(() => fs.readFile(capture, "utf8")))
    expect(envelope.directory).toBe(directory)
    const request = {
      sessionID: id,
      permission: "external_directory",
      patterns: [path.join(directory, "child", "*")],
      always: [],
      metadata: {},
      ruleset: [],
    }
    expect(Exit.isSuccess(yield* permission.ask(request).pipe(Effect.exit))).toBe(true)
    const second = yield* permission.ask({ ...request, sessionID: other }).pipe(Effect.forkScoped)
    const pending = yield* pollWithTimeout(
      permission.list().pipe(Effect.map((items) => (items.length ? items : undefined))),
      "other session must still ask",
    )
    expect(pending[0].sessionID).toBe(other)
    yield* permission.reply({ requestID: pending[0].id, reply: "reject" })
    expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true)
    yield* permission.applyHookUpdates(id, [
      { type: "removeDirectories", destination: "session", directories: [directory] },
    ])
    expect((yield* permission.hookPolicy(id)).directories).toEqual([])
  }),
)

it.instance("PermissionRequest allow cannot override the deny it just installed", () =>
  Effect.gen(function* () {
    const id = SessionID.descending()
    yield* (yield* SessionHooks.Service).add(id, {
      event: "PermissionRequest",
      hooks: [
        {
          type: "command",
          command: `printf '%s' ${quote(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedPermissions: [{ type: "addRules", destination: "session", behavior: "deny", rules: [{ toolName: "fixture_guard" }] }] } } }))}`,
        },
      ],
    })
    const service = yield* Permission.Service
    const result = yield* service
      .ask({ sessionID: id, permission: "fixture_guard", patterns: ["*"], always: [], metadata: {}, ruleset: [] })
      .pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* service.list()).toEqual([])
    expect((yield* service.hookPolicy(id)).rules).toContainEqual({
      permission: "fixture_guard",
      pattern: "*",
      action: "deny",
    })
  }),
)

it.instance("ordered wildcard rules survive mixed-source reload and invalid files stay unchanged", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const cfg = yield* Config.Service
    const agent = yield* Agent.Service
    const file = path.join(instance.directory, "opencode.jsonc")
    yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ permission: { read: { a: "allow" } } })))
    yield* cfg.invalidate()
    yield* cfg.updateHookPermissions([
      { type: "addRules", destination: "projectSettings", behavior: "deny", rules: [{ toolName: "*" }] },
      {
        type: "addRules",
        destination: "projectSettings",
        behavior: "allow",
        rules: [{ toolName: "read", ruleContent: "b" }],
      },
    ])
    const stored = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))
    expect(stored.permission).toEqual({ read: { a: "allow" } })
    expect(stored.permissions).toEqual([
      { action: "read", resource: "a", effect: "allow" },
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "b", effect: "allow" },
    ])
    expect(Permission.evaluate("read", "a", (yield* agent.permissionPolicy("build")).rules).action).toBe("deny")
    expect(Permission.evaluate("read", "b", (yield* agent.permissionPolicy("build")).rules).action).toBe("allow")
    yield* cfg.updateHookPermissions([
      {
        type: "addRules",
        destination: "localSettings",
        behavior: "deny",
        rules: [{ toolName: "read", ruleContent: "b" }],
      },
    ])
    const reloaded = yield* (yield* InstanceStore.Service).reload({ directory: instance.directory })
    const policy = yield* agent.permissionPolicy("build").pipe(Effect.provideService(InstanceRef, reloaded))
    expect(Permission.evaluate("read", "a", policy.rules).action).toBe("deny")
    expect(Permission.evaluate("read", "b", policy.rules).action).toBe("deny")
    expect(Permission.evaluate("bash", "*", policy.rules).action).toBe("deny")
    const invalid = "{ not valid"
    yield* Effect.promise(() => fs.writeFile(file, invalid))
    expect(
      Exit.isFailure(
        yield* cfg
          .updateHookPermissions([
            { type: "addRules", destination: "projectSettings", behavior: "allow", rules: [{ toolName: "*" }] },
          ])
          .pipe(Effect.exit),
      ),
    ).toBe(true)
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(invalid)
  }),
)
