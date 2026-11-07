import { PermissionV1 } from "@graphagent/core/v1/permission"
import { test, expect } from "bun:test"
import os from "os"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Database } from "@graphagent/core/database/database"
import { Permission, globCovers } from "../../src/permission"
import { Wildcard } from "../../src/util/wildcard"
import type { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission, subagentRoleDefaultRuleIndices } from "../../src/agent/subagent-permissions"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MessageID, SessionID } from "../../src/session/schema"
import { SettingsHook } from "../../src/hook/settings"
import { HookStartContext } from "../../src/hook/start-context"

const events = EventV2Bridge.defaultLayer
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const noopSettingsHook = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: () =>
      Effect.succeed({
        blocked: undefined,
        permissionDecision: undefined,
        permissionDecisionReason: undefined,
        additionalContexts: [],
        systemMessages: [],
        hookSpecificOutput: undefined,
      }),
    list: () => Effect.succeed([]),
  }),
)

const noopStartContext = Layer.succeed(
  HookStartContext.Service,
  HookStartContext.Service.of({
    append: () => Effect.void,
    consume: () => Effect.succeed([]),
    markStarted: () => Effect.void,
    claimResume: () => Effect.succeed(false),
  }),
)

const env = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(events), Layer.provide(noopSettingsHook)),
  events,
  CrossSpawnSpawner.defaultLayer,
  InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
  noopStartContext,
)
const it = testEffect(env)

const rejectAll = (message?: string) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (const req of yield* permission.list()) {
      yield* permission.reply({
        requestID: req.id,
        reply: "reject",
        message,
      })
    }
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === count) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
  })

const fail = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected permission effect to fail")
  })

const denied = (error: unknown) => {
  if (!(error instanceof PermissionV1.DeniedError)) throw new Error("expected DeniedError")
  return error
}

const ask = (input: Parameters<Permission.Interface["ask"]>[0], options?: Parameters<Permission.Interface["ask"]>[1]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input, options)
  })

const reply = (input: Parameters<Permission.Interface["reply"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

const list = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.list()
  })

// fromConfig tests

test("fromConfig - string value becomes wildcard rule", () => {
  const result = Permission.fromConfig({ bash: "allow" })
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("fromConfig - object value converts to rules array", () => {
  const result = Permission.fromConfig({ bash: { "*": "allow", rm: "deny" } })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
})

test("fromConfig - mixed string and object values", () => {
  const result = Permission.fromConfig({
    bash: { "*": "allow", rm: "deny" },
    edit: "allow",
    webfetch: "ask",
  })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ])
})

test("fromConfig - empty object", () => {
  const result = Permission.fromConfig({})
  expect(result).toEqual([])
})

test("fromConfig - expands tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME without trailing slash", () => {
  const result = Permission.fromConfig({ external_directory: { $HOME: "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("fromConfig - does not expand tilde in middle of path", () => {
  const result = Permission.fromConfig({ external_directory: { "/some/~/path": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: "/some/~/path", action: "allow" }])
})

// Permission precedence follows config insertion order. `evaluate()` uses the
// last matching rule, so later config entries intentionally override earlier
// entries even when a wildcard appears after a specific permission.

test("fromConfig - preserves top-level config key order", () => {
  const wildcardFirst = Permission.fromConfig({ "*": "deny", bash: "allow" })
  const specificFirst = Permission.fromConfig({ bash: "allow", "*": "deny" })

  expect(wildcardFirst.map((r) => r.permission)).toEqual(["*", "bash"])
  expect(specificFirst.map((r) => r.permission)).toEqual(["bash", "*"])

  expect(Permission.evaluate("bash", "ls", wildcardFirst).action).toBe("allow")
  expect(Permission.evaluate("bash", "ls", specificFirst).action).toBe("deny")
})

test("fromConfig - wildcard acts as fallback when it appears before specifics", () => {
  const ruleset = Permission.fromConfig({ "*": "ask", bash: "allow" })
  expect(Permission.evaluate("edit", "foo.ts", ruleset).action).toBe("ask")
  expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
})

test("fromConfig - top-level ordering is not sorted by wildcard specificity", () => {
  const ruleset = Permission.fromConfig({
    bash: "allow",
    "*": "ask",
    edit: "deny",
    "mcp_*": "allow",
  })
  expect(ruleset.map((r) => r.permission)).toEqual(["bash", "*", "edit", "mcp_*"])
})

test("fromConfig - sub-pattern insertion order inside a tool key is preserved", () => {
  const ruleset = Permission.fromConfig({ bash: { "*": "deny", "git *": "allow" } })
  expect(ruleset.map((r) => r.pattern)).toEqual(["*", "git *"])
  expect(Permission.evaluate("bash", "rm foo", ruleset).action).toBe("deny")
  expect(Permission.evaluate("bash", "git status", ruleset).action).toBe("allow")
})

test("fromConfig - documented fallback-first example", () => {
  const ruleset = Permission.fromConfig({ "*": "ask", bash: "allow", edit: "deny" })
  expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
  expect(Permission.evaluate("edit", "foo.ts", ruleset).action).toBe("deny")
  expect(Permission.evaluate("read", "foo.ts", ruleset).action).toBe("ask")
})

test("fromConfig - expands exact tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("evaluate - matches expanded tilde pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

test("evaluate - matches expanded $HOME pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

// merge tests

test("merge - simple concatenation", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - adds new permission", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "edit", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ])
})

test("merge - concatenates rules for same permission", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "foo", action: "ask" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "foo", action: "ask" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - multiple rulesets", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "rm", action: "ask" }],
    [{ permission: "edit", pattern: "*", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "ask" },
    { permission: "edit", pattern: "*", action: "allow" },
  ])
})

test("merge - empty ruleset does nothing", () => {
  const result = Permission.merge([{ permission: "bash", pattern: "*", action: "allow" }], [])
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("merge - preserves rule order", () => {
  const result = Permission.merge(
    [
      { permission: "edit", pattern: "src/*", action: "allow" },
      { permission: "edit", pattern: "src/secret/*", action: "deny" },
    ],
    [{ permission: "edit", pattern: "src/secret/ok.ts", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret/*", action: "deny" },
    { permission: "edit", pattern: "src/secret/ok.ts", action: "allow" },
  ])
})

test("merge - config permission overrides default ask", () => {
  const defaults: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "ask" }]
  const config: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const merged = Permission.merge(defaults, config)

  expect(Permission.evaluate("bash", "ls", merged).action).toBe("allow")
  expect(Permission.evaluate("edit", "foo.ts", merged).action).toBe("ask")
})

test("merge - config ask overrides default allow", () => {
  const defaults: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const config: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
  const merged = Permission.merge(defaults, config)

  expect(Permission.evaluate("bash", "ls", merged).action).toBe("ask")
})

// evaluate tests

test("evaluate - exact pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "bash", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "bash", pattern: "*", action: "allow" }])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching rule wins", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - last matching rule wins (wildcard after specific)", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - glob pattern match", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [{ permission: "edit", pattern: "src/*", action: "allow" }])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching glob wins", () => {
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/*", action: "deny" },
    { permission: "edit", pattern: "src/components/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - order matters for specificity", () => {
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/components/*", action: "allow" },
    { permission: "edit", pattern: "src/*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - unknown permission returns ask", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - empty ruleset returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - no matching pattern returns ask", () => {
  const result = Permission.evaluate("edit", "etc/passwd", [{ permission: "edit", pattern: "src/*", action: "allow" }])
  expect(result.action).toBe("ask")
})

test("evaluate - empty rules array returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - multiple matching patterns, last wins", () => {
  const result = Permission.evaluate("edit", "src/secret.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret.ts", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - non-matching patterns are skipped", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "test/*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - exact match at end wins over earlier wildcard", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard at end overrides earlier exact match", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

// wildcard permission tests

test("evaluate - wildcard permission matches any permission", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission with specific pattern", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "*", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - glob permission pattern", () => {
  const result = Permission.evaluate("mcp_server_tool", "anything", [
    { permission: "mcp_*", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - specific permission and wildcard permission combined", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - wildcard permission does not match when specific exists", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - multiple matching permission patterns combine rules", () => {
  const result = Permission.evaluate("mcp_dangerous", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "mcp_*", pattern: "*", action: "allow" },
    { permission: "mcp_dangerous", pattern: "*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission fallback for unknown tool", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - later wildcard permission can override earlier specific permission", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "*", pattern: "*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - merges multiple rulesets", () => {
  const config: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const approved: PermissionV1.Ruleset = [{ permission: "bash", pattern: "rm", action: "deny" }]
  const result = Permission.evaluate("bash", "rm", config, approved)
  expect(result.action).toBe("deny")
})

// disabled tests

test("disabled - returns empty set when all tools allowed", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "allow" }])
  expect(result.size).toBe(0)
})

test("disabled - disables tool when denied", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(false)
  expect(result.has("read")).toBe(false)
})

test("disabled - disables edit/write/apply_patch when edit denied", () => {
  const result = Permission.disabled(
    ["edit", "write", "apply_patch", "bash"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("edit")).toBe(true)
  expect(result.has("write")).toBe(true)
  expect(result.has("apply_patch")).toBe(true)
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when partially denied", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm *", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when action is ask", () => {
  const result = Permission.disabled(["bash", "edit"], [{ permission: "*", pattern: "*", action: "ask" }])
  expect(result.size).toBe(0)
})

test("disabled - does not disable when specific allow after wildcard deny", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "echo *", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when wildcard allow after deny", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "rm *", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - disables multiple tools", () => {
  const result = Permission.disabled(
    ["bash", "edit", "webfetch"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("webfetch")).toBe(true)
})

test("disabled - wildcard permission denies all tools", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

test("disabled - specific allow overrides wildcard deny", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

test("disabled - universal deny followed only by narrower denies stays denied", () => {
  const result = Permission.disabled(
    ["edit", "write", "apply_patch"],
    Permission.fromConfig({
      edit: { "*": "deny", "*.md": "deny" },
    }),
  )
  expect(result.has("edit")).toBe(true)
  expect(result.has("write")).toBe(true)
  expect(result.has("apply_patch")).toBe(true)
})

test("disabled - universal deny followed by a narrower allow stays advertised", () => {
  const result = Permission.disabled(["edit"], Permission.fromConfig({ edit: { "*": "deny", "*.md": "allow" } }))
  expect(result.has("edit")).toBe(false)
})

test("disabled - wildcard precedence keeps only tools with a potential allow", () => {
  const result = Permission.disabled(["edit", "read"], Permission.fromConfig({ "*": "deny", edit: "allow" }))
  expect(result.has("edit")).toBe(false)
  expect(result.has("read")).toBe(true)
})

test("disabled - trailing optional wildcard covers a literal allow", () => {
  const result = Permission.disabled(
    ["bash"],
    Permission.fromConfig({
      bash: { "*": "deny", git: "allow", "git *": "deny" },
    }),
  )
  expect(result.has("bash")).toBe(true)
})

test("disabled - trailing optional wildcard does not cover a broader allow", () => {
  const result = Permission.disabled(
    ["bash"],
    Permission.fromConfig({
      bash: { "*": "deny", "git *": "allow", git: "deny" },
    }),
  )
  expect(result.has("bash")).toBe(false)
})

test("disabledByPolicy - native allow coverage must include a later inherited deny", () => {
  const native = Permission.fromConfig({
    bash: { "*": "deny", git: "allow" },
  })
  const inherited = Permission.fromConfig({ bash: { "git *": "deny" } })
  const configured = Permission.merge(native, inherited)
  expect(Permission.disabledByPolicy(["bash"], native, configured).has("bash")).toBe(true)
  expect(Permission.disabledByPolicy(["bash"], native, native).has("bash")).toBe(false)
})

test("disabled - an astral allow is not covered by a UTF-16 question mark", () => {
  const result = Permission.disabled(
    ["edit"],
    Permission.fromConfig({
      edit: { "*": "deny", "😀": "allow", "?": "deny" },
    }),
  )
  expect(result.has("edit")).toBe(false)
  expect(Wildcard.match("😀", "😀")).toBe(true)
  expect(Wildcard.match("😀", "?")).toBe(false)
})

test("globCovers - uses UTF-16 code units like Wildcard.match", () => {
  expect(globCovers("?", "😀")).toBe(false)
  expect(globCovers("😀", "😀")).toBe(true)
  expect(globCovers("*", "😀")).toBe(true)
  expect(globCovers("😀 *", "😀")).toBe(true)
  expect(globCovers("😀 *", "😀?")).toBe(false)
  expect(globCovers("😀 *", "😀 😀")).toBe(true)
})

test("globCovers - proven coverage never contradicts Wildcard.match on a representative corpus", () => {
  const atoms = ["a", "b", "?", "*", " ", "😀", " *"]
  const patterns = [""]
  for (const a of atoms) {
    patterns.push(a)
    for (const b of atoms) {
      patterns.push(a + b)
      for (const c of atoms) patterns.push(a + b + c)
    }
  }
  const corpus = ["", "a", "b", " ", "😀", "😀a", "a😀", "😀 ", " 😀", "😀 😀", "?", "??", "😀?", "?😀"]
  for (const deny of patterns) {
    for (const allow of patterns) {
      if (!globCovers(deny, allow)) continue
      for (const path of corpus) {
        if (Wildcard.match(path, allow) && !Wildcard.match(path, deny)) {
          throw new Error(
            `globCovers(${JSON.stringify(deny)}, ${JSON.stringify(allow)}) contradicted by ${JSON.stringify(path)}`,
          )
        }
      }
    }
  }
})

test("disabled - Windows case folding hides a fully denied tool", () => {
  const rules = [
    { permission: "edit", pattern: "*", action: "deny" as const },
    { permission: "edit", pattern: "FOO", action: "allow" as const },
    { permission: "edit", pattern: "foo", action: "deny" as const },
  ]
  expect(Permission.disabled(["edit"], rules, { caseInsensitive: true }).has("edit")).toBe(true)
  expect(Permission.disabled(["edit"], rules, { caseInsensitive: false }).has("edit")).toBe(false)
})

test("globCovers - Windows case folding matches the regex i flag", () => {
  expect(globCovers("foo", "FOO", { caseInsensitive: true })).toBe(true)
  expect(globCovers("FOO", "foo", { caseInsensitive: true })).toBe(true)
  expect(globCovers("foo", "FOO", { caseInsensitive: false })).toBe(false)
})

test("globCovers - repeated case-insensitive calls keep pattern state local", () => {
  for (let index = 0; index < 1000; index++) {
    const suffix = String(index)
    expect(globCovers("foo" + suffix, "FOO" + suffix, { caseInsensitive: true })).toBe(true)
  }
})

test("globCovers - Windows-generated coverage never contradicts the si matcher", () => {
  const makeMatcher = (flags: string) => {
    const cache = new Map<string, RegExp>()
    return (input: string, pattern: string) => {
      let regex = cache.get(pattern)
      if (!regex) {
        let escaped = pattern
          .replaceAll("\\", "/")
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")
        if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
        regex = new RegExp("^" + escaped + "$", flags)
        cache.set(pattern, regex)
      }
      return regex.test(input.replaceAll("\\", "/"))
    }
  }
  const unmatched = makeMatcher("si")
  const atoms = ["A", "a", "F", "f", "s", "ſ", "Σ", "σ", "ς", "İ", "i", "?", "*", " "]
  const patterns = ["", ...atoms, ...atoms.flatMap((a) => atoms.map((b) => a + b))]
  patterns.push("a *", "A *", "s *", "ſ *", "😀 *", "? *")
  const corpus = ["", "a", "A", "f", "F", "s", "ſ", "Σ", "σ", "ς", "İ", "i", "😀", "😀A", "a ", " "]
  for (const deny of patterns) {
    for (const allow of patterns) {
      if (!globCovers(deny, allow, { caseInsensitive: true })) continue
      for (const path of corpus) {
        if (unmatched(path, allow) && !unmatched(path, deny)) {
          throw new Error(
            `globCovers(${JSON.stringify(deny)}, ${JSON.stringify(allow)}, Windows) contradicted by ${JSON.stringify(path)}`,
          )
        }
      }
    }
  }
})

test("globCovers - POSIX-generated coverage never contradicts the s matcher", () => {
  const makeMatcher = (flags: string) => {
    const cache = new Map<string, RegExp>()
    return (input: string, pattern: string) => {
      let regex = cache.get(pattern)
      if (!regex) {
        let escaped = pattern
          .replaceAll("\\", "/")
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")
        if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
        regex = new RegExp("^" + escaped + "$", flags)
        cache.set(pattern, regex)
      }
      return regex.test(input.replaceAll("\\", "/"))
    }
  }
  const unmatched = makeMatcher("s")
  const atoms = ["A", "a", "F", "f", "s", "ſ", "Σ", "σ", "ς", "İ", "i", "?", "*", " "]
  const patterns = ["", ...atoms, ...atoms.flatMap((a) => atoms.map((b) => a + b))]
  patterns.push("a *", "A *", "s *", "ſ *", "😀 *", "? *")
  const corpus = ["", "a", "A", "f", "F", "s", "ſ", "Σ", "σ", "ς", "İ", "i", "😀", "😀A", "a ", " "]
  for (const deny of patterns) {
    for (const allow of patterns) {
      if (!globCovers(deny, allow, { caseInsensitive: false })) continue
      for (const path of corpus) {
        if (unmatched(path, allow) && !unmatched(path, deny)) {
          throw new Error(
            `globCovers(${JSON.stringify(deny)}, ${JSON.stringify(allow)}, POSIX) contradicted by ${JSON.stringify(path)}`,
          )
        }
      }
    }
  }
})

test("disabledByPolicy - a covering glob deny removes a plan edit allow", () => {
  const native = Permission.fromConfig({
    edit: { "*": "deny", ".agents/plans/*.md": "allow" },
  })
  const configured = Permission.merge(native, Permission.fromConfig({ edit: { ".agents/plans/*": "deny" } }))
  const result = Permission.disabledByPolicy(["edit"], native, configured)
  expect(result.has("edit")).toBe(true)
})

test("disabledByPolicy - a noncovering glob deny keeps a plan edit allow", () => {
  const native = Permission.fromConfig({
    edit: { "*": "deny", ".agents/plans/*.md": "allow" },
  })
  const configured = Permission.merge(native, Permission.fromConfig({ edit: { ".agents/plans/private/*": "deny" } }))
  const result = Permission.disabledByPolicy(["edit"], native, configured)
  expect(result.has("edit")).toBe(false)
})

test("disabledByPolicy - native deny wins over a later configured allow", () => {
  const result = Permission.disabledByPolicy(
    ["edit", "read"],
    Permission.fromConfig({ "*": "deny" }),
    Permission.fromConfig({ "*": "allow", edit: "allow" }),
  )
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

test("disabledByPolicy - configured deny removes a tool that native allows", () => {
  const result = Permission.disabledByPolicy(
    ["edit", "read"],
    Permission.fromConfig({ "*": "allow" }),
    Permission.fromConfig({ "*": "deny", edit: "allow" }),
  )
  expect(result.has("edit")).toBe(false)
  expect(result.has("read")).toBe(true)
})

// ask tests

it.instance(
  "ask - resolves immediately when action is allow",
  () =>
    Effect.gen(function* () {
      const result = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "ask - throws DeniedError when action is deny",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(denied(err).message).toContain("The user has specified a rule")
    }),
  { git: true },
)

it.instance(
  "ask - names the role for a native role deny",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask(
          {
            sessionID: SessionID.make("session_test"),
            permission: "edit",
            patterns: ["README.md"],
            metadata: {},
            always: [],
            ruleset: [],
          },
          {
            role: "explore",
            resolveRuleset: () =>
              Effect.succeed({
                native: [{ permission: "*", pattern: "*", action: "deny" }],
                rules: [{ permission: "*", pattern: "*", action: "deny" }],
              }),
          },
        ),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(denied(err).reason).toBe("This tool is not available to the explore agent.")
      expect(denied(err).message).not.toContain("The user has specified a rule")
    }),
  { git: true },
)

it.instance(
  "ask - native role deny wins over a later user allow",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask(
          {
            sessionID: SessionID.make("session_test"),
            permission: "edit",
            patterns: ["README.md"],
            metadata: {},
            always: [],
            ruleset: [
              { permission: "*", pattern: "*", action: "deny" },
              { permission: "edit", pattern: "*", action: "allow" },
            ],
          },
          {
            role: "explore",
            resolveRuleset: () =>
              Effect.succeed({
                native: [{ permission: "*", pattern: "*", action: "deny" }],
                rules: [
                  { permission: "*", pattern: "*", action: "deny" },
                  { permission: "edit", pattern: "*", action: "allow" },
                ],
              }),
          },
        ),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(denied(err).reason).toBe("This tool is not available to the explore agent.")
    }),
  { git: true },
)

it.instance(
  "ask - names the role for a derived child-session deny",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask(
          {
            sessionID: SessionID.make("session_test"),
            permission: "todowrite",
            patterns: ["*"],
            metadata: {},
            always: [],
            ruleset: [{ permission: "todowrite", pattern: "*", action: "deny" }],
          },
          { role: "build", roleDefaultIndices: [0], sessionRuleCount: 1 },
        ),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(denied(err).reason).toBe("This tool is not available to the build agent.")
      expect(denied(err).message).not.toContain("The user has specified a rule")
    }),
  { git: true },
)

it.instance(
  "ask - keeps user wording when a later user rule wins over a role default",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask(
          {
            sessionID: SessionID.make("session_test"),
            permission: "todowrite",
            patterns: ["*"],
            metadata: {},
            always: [],
            ruleset: [
              { permission: "todowrite", pattern: "*", action: "deny" },
              { permission: "todowrite", pattern: "*", action: "deny" },
            ],
          },
          { role: "build", roleDefaultIndices: [0], sessionRuleCount: 2 },
        ),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(denied(err).reason).toBeUndefined()
      expect(denied(err).message).toContain("The user has specified a rule")
    }),
  { git: true },
)

it.instance(
  "ask - legacy trailing role defaults still use role wording",
  () =>
    Effect.gen(function* () {
      const legacy = [
        { permission: "bash", pattern: "*", action: "deny" as const },
        { permission: "todowrite", pattern: "*", action: "deny" as const },
        { permission: "task", pattern: "*", action: "deny" as const },
      ]
      const subagent: Agent.Info = {
        name: "build",
        mode: "subagent",
        options: {},
        permission: Permission.fromConfig({ "*": "allow" }),
      }
      const indices = subagentRoleDefaultRuleIndices(legacy, subagent)
      expect(indices).toEqual([1, 2])

      const err = yield* fail(
        ask(
          {
            sessionID: SessionID.make("session_test"),
            permission: "todowrite",
            patterns: ["*"],
            metadata: {},
            always: [],
            ruleset: legacy,
          },
          { role: subagent.name, roleDefaultIndices: indices, sessionRuleCount: legacy.length },
        ),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(denied(err).reason).toBe("This tool is not available to the build agent.")
    }),
  { git: true },
)

it.instance(
  "ask - ambiguous inherited deny stays on user wording",
  () =>
    Effect.gen(function* () {
      const ambiguous = [
        { permission: "todowrite", pattern: "*", action: "deny" as const },
        { permission: "task", pattern: "*", action: "deny" as const },
        { permission: "todowrite", pattern: "*", action: "deny" as const },
      ]
      const subagent: Agent.Info = {
        name: "build",
        mode: "subagent",
        options: {},
        permission: Permission.fromConfig({ "*": "allow" }),
      }
      expect(subagentRoleDefaultRuleIndices(ambiguous, subagent)).toEqual([])

      const err = yield* fail(
        ask(
          {
            sessionID: SessionID.make("session_test"),
            permission: "todowrite",
            patterns: ["*"],
            metadata: {},
            always: [],
            ruleset: ambiguous,
          },
          { role: subagent.name, roleDefaultIndices: [], sessionRuleCount: ambiguous.length },
        ),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(denied(err).reason).toBeUndefined()
      expect(denied(err).message).toContain("The user has specified a rule")
    }),
  { git: true },
)

it.instance(
  "ask - an inherited matching deny keeps user wording over role defaults",
  () =>
    Effect.gen(function* () {
      const subagent: Agent.Info = {
        name: "build",
        mode: "subagent",
        options: {},
        permission: Permission.fromConfig({ "*": "allow" }),
      }
      const derived = deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({ todowrite: "deny" }),
        subagent,
      })
      const err = yield* fail(
        ask(
          {
            sessionID: SessionID.make("session_test"),
            permission: "todowrite",
            patterns: ["*"],
            metadata: {},
            always: [],
            ruleset: derived,
          },
          {
            role: subagent.name,
            roleDefaultIndices: subagentRoleDefaultRuleIndices(derived, subagent),
            sessionRuleCount: derived.length,
          },
        ),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(denied(err).reason).toBeUndefined()
      expect(denied(err).message).toContain("The user has specified a rule")
    }),
  { git: true },
)

it.instance(
  "ask - keeps user-rule wording for a user-configured deny",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "todowrite",
          patterns: ["*"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "todowrite", pattern: "*", action: "deny" }],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(denied(err).reason).toBeUndefined()
      expect(denied(err).message).toContain("The user has specified a rule")
    }),
  { git: true },
)

it.instance(
  "ask - stays pending when action is ask",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

it.instance(
  "ask - adds request to pending list",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const items = yield* waitForPending(1)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
      })

      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

it.instance(
  "ask - publishes asked event",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const seen = yield* Deferred.make<PermissionV1.Request>()
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type)
          Deferred.doneUnsafe(seen, Effect.succeed(event.data as PermissionV1.Request))
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      expect(
        yield* Deferred.await(seen).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting for permission asked event")),
          }),
        ),
      ).toMatchObject({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
      })

      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

// reply tests

it.instance(
  "reply - once resolves the pending ask",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test1"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_test1"), reply: "once" })
      yield* Fiber.join(fiber)
    }),
  { git: true },
)

it.instance(
  "reply - reject throws RejectedError",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test2"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_test2"), reply: "reject" })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "reply - reject with message throws CorrectedError",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test2b"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({
        requestID: PermissionV1.ID.make("per_test2b"),
        reply: "reject",
        message: "Use a safer command",
      })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).toBeInstanceOf(PermissionV1.CorrectedError)
        expect(String(err)).toContain("Use a safer command")
      }
    }),
  { git: true },
)

it.instance(
  "reply - always persists approval and resolves",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test3"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_test3"), reply: "always" })
      yield* Fiber.join(fiber)

      const result = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(result).toBeUndefined()
      const other = yield* ask({
        sessionID: SessionID.make("session_test2"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const permissions = yield* Permission.Service
      const [pending] = yield* permissions.list()
      expect(pending?.sessionID).toBe(SessionID.make("session_test2"))
      if (pending) yield* reply({ requestID: pending.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.await(other))).toBe(true)
    }),
  { git: true },
)

it.instance(
  "reply - reject cancels all pending for same session",
  () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionV1.ID.make("per_test4a"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const b = yield* ask({
        id: PermissionV1.ID.make("per_test4b"),
        sessionID: SessionID.make("session_same"),
        permission: "edit",
        patterns: ["foo.ts"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionV1.ID.make("per_test4a"), reply: "reject" })

      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isFailure(ea)).toBe(true)
      expect(Exit.isFailure(eb)).toBe(true)
      if (Exit.isFailure(ea)) expect(Cause.squash(ea.cause)).toBeInstanceOf(PermissionV1.RejectedError)
      if (Exit.isFailure(eb)) expect(Cause.squash(eb.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "reply - always resolves matching pending requests in same session",
  () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionV1.ID.make("per_test5a"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const b = yield* ask({
        id: PermissionV1.ID.make("per_test5b"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionV1.ID.make("per_test5a"), reply: "always" })

      yield* Fiber.join(a)
      yield* Fiber.join(b)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "reply - always keeps other session pending",
  () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionV1.ID.make("per_test6a"),
        sessionID: SessionID.make("session_a"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const b = yield* ask({
        id: PermissionV1.ID.make("per_test6b"),
        sessionID: SessionID.make("session_b"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionV1.ID.make("per_test6a"), reply: "always" })

      yield* Fiber.join(a)
      expect((yield* list()).map((item) => item.id)).toEqual([PermissionV1.ID.make("per_test6b")])

      yield* rejectAll()
      yield* Fiber.await(b)
    }),
  { git: true },
)

it.instance(
  "reply - publishes replied event",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const seen = yield* Deferred.make<{
        sessionID: SessionID
        requestID: PermissionV1.ID
        reply: PermissionV1.Reply
      }>()

      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test7"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)

      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Replied.type)
          Deferred.doneUnsafe(
            seen,
            Effect.succeed(
              event.data as { sessionID: SessionID; requestID: PermissionV1.ID; reply: PermissionV1.Reply },
            ),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      yield* reply({ requestID: PermissionV1.ID.make("per_test7"), reply: "once" })
      yield* Fiber.join(fiber)
      expect(
        yield* Deferred.await(seen).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting for permission replied event")),
          }),
        ),
      ).toEqual({
        sessionID: SessionID.make("session_test"),
        requestID: PermissionV1.ID.make("per_test7"),
        reply: "once",
      })
    }),
  { git: true },
)

it.live("permission requests stay isolated by directory", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped({ git: true })
    const two = yield* tmpdirScoped({ git: true })
    const store = yield* InstanceStore.Service

    const a = yield* store
      .provide(
        { directory: one },
        ask({
          id: PermissionV1.ID.make("per_dir_a"),
          sessionID: SessionID.make("session_dir_a"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      )
      .pipe(Effect.forkScoped)

    const b = yield* store
      .provide(
        { directory: two },
        ask({
          id: PermissionV1.ID.make("per_dir_b"),
          sessionID: SessionID.make("session_dir_b"),
          permission: "bash",
          patterns: ["pwd"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      )
      .pipe(Effect.forkScoped)

    const onePending = yield* store.provide({ directory: one }, waitForPending(1))
    const twoPending = yield* store.provide({ directory: two }, waitForPending(1))

    expect(onePending).toHaveLength(1)
    expect(twoPending).toHaveLength(1)
    expect(onePending[0].id).toBe(PermissionV1.ID.make("per_dir_a"))
    expect(twoPending[0].id).toBe(PermissionV1.ID.make("per_dir_b"))

    yield* store.provide({ directory: one }, reply({ requestID: onePending[0].id, reply: "reject" }))
    yield* store.provide({ directory: two }, reply({ requestID: twoPending[0].id, reply: "reject" }))

    yield* Fiber.await(a)
    yield* Fiber.await(b)
  }),
)

it.instance(
  "pending permission rejects on instance dispose",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_dispose"),
        sessionID: SessionID.make("session_dispose"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      const ctx = yield* store.load({ directory: test.directory })
      yield* store.dispose(ctx)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "pending permission rejects on instance reload",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_reload"),
        sessionID: SessionID.make("session_reload"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* store.reload({ directory: test.directory })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "reply - fails for unknown requestID",
  () =>
    Effect.gen(function* () {
      const exit = yield* reply({ requestID: PermissionV1.ID.make("per_unknown"), reply: "once" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "Permission.NotFoundError", requestID: "per_unknown" })
      }
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "ask - checks all patterns and stops on first deny",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["echo hello", "rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)

it.instance(
  "ask - allows all patterns when all match allow rules",
  () =>
    Effect.gen(function* () {
      const result = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["echo hello", "ls -la", "pwd"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "ask - should deny even when an earlier pattern is ask",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["echo hello", "rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "echo *", action: "ask" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      )

      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "ask - abort should clear pending request",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service

      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_reload"),
        sessionID: SessionID.make("session_reload"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      expect(pending).toHaveLength(1)
      yield* store.reload({ directory: test.directory })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)
