import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Permission } from "../../src/permission"
import { Notification } from "../../src/notification"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { SessionID } from "../../src/session/schema"
import { SettingsHook, type HookPayload, type TriggerContext } from "../../src/hook/settings"

// Captures every hook payload so the tests can assert the envelope inputs.
const triggered: Array<{ payload: HookPayload; ctx: TriggerContext }> = []
// Decision a PermissionRequest hook returns; reset by each test that sets it.
let permissionRequestDecision: "allow" | "deny" | undefined
const captureHook = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: (payload, ctx) =>
      Effect.sync(() => {
        triggered.push({ payload, ctx })
        return payload.event === "PermissionRequest" && permissionRequestDecision
          ? { additionalContexts: [], systemMessages: [], permissionDecision: permissionRequestDecision }
          : { additionalContexts: [], systemMessages: [] }
      }),
    list: () => Effect.succeed([]),
  }),
)
const events = EventV2Bridge.defaultLayer
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(events), Layer.provide(captureHook)),
  captureHook,
  Notification.defaultLayer,
  events,
  CrossSpawnSpawner.defaultLayer,
  InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
)
const it = testEffect(env)

const sessionID = SessionID.make("ses_hook_ask")

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* pollWithTimeout(
      permission.list().pipe(Effect.map((list) => (list.length === count ? list : undefined))),
      `timed out waiting for ${count} pending permission request(s)`,
    )
  })

// Mirrors the session/tools.ts PreToolUse `permissionDecision:"ask"` call.
const hookAsk = (ruleset: PermissionV1.Rule[] = []) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(
      {
        sessionID,
        permission: "edit",
        patterns: ["edit"],
        always: [],
        metadata: { hookAsk: true, reason: "migration file: confirm" },
        tool: { messageID: "msg_hook_ask", callID: "call_hook_ask" },
        ruleset,
      },
      // `patterns` collides with a legacy permission field: the legacy value wins.
      { force: true, toolInput: { filePath: "db/migration.sql", patterns: "tool-arg" } },
    )
  })

const approveAlways = Effect.gen(function* () {
  const permission = yield* Permission.Service
  const first = yield* permission
    .ask({
      id: PermissionV1.ID.make("per_hook_ask_edit"),
      sessionID,
      permission: "edit",
      patterns: ["src/a.ts"],
      metadata: {},
      always: ["*"],
      ruleset: [],
    })
    .pipe(Effect.forkScoped)
  yield* waitForPending(1)
  yield* permission.reply({ requestID: PermissionV1.ID.make("per_hook_ask_edit"), reply: "always" })
  yield* Fiber.join(first)
})

it.instance(
  "hook permissionDecision ask still prompts after an 'always' approval",
  () =>
    Effect.gen(function* () {
      yield* approveAlways
      const fiber = yield* hookAsk().pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      expect(pending[0].metadata).toMatchObject({ hookAsk: true })
      yield* Fiber.interrupt(fiber)
    }),
  { git: true },
)

it.instance(
  "hook permissionDecision ask is not skipped by an allow rule and not settled by another 'always' reply",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const fiber = yield* hookAsk([{ permission: "edit", pattern: "*", action: "allow" }]).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const other = yield* permission
        .ask({
          id: PermissionV1.ID.make("per_hook_ask_other"),
          sessionID,
          permission: "edit",
          patterns: ["src/b.ts"],
          metadata: {},
          always: ["*"],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(2)
      yield* permission.reply({ requestID: PermissionV1.ID.make("per_hook_ask_other"), reply: "always" })
      yield* Fiber.join(other)
      const remaining = yield* waitForPending(1)
      expect(remaining[0].metadata).toMatchObject({ hookAsk: true })
      yield* permission.reply({ requestID: remaining[0].id, reply: "once" })
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
    }),
  { git: true },
)

it.instance(
  "hook permissionDecision ask still loses to a deny rule",
  () =>
    Effect.gen(function* () {
      const exit = yield* hookAsk([{ permission: "edit", pattern: "*", action: "deny" }]).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* Permission.Service.use((p) => p.list())).length).toBe(0)
    }),
  { git: true },
)

it.instance(
  "permission hooks receive the tool arguments, tool_use_id and session id",
  () =>
    Effect.gen(function* () {
      triggered.length = 0
      const permission = yield* Permission.Service
      const fiber = yield* hookAsk().pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      yield* permission.reply({ requestID: pending[0].id, reply: "once" })
      yield* Fiber.join(fiber)
      yield* hookAsk([{ permission: "edit", pattern: "*", action: "deny" }]).pipe(Effect.exit)

      const request = triggered.find((t) => t.payload.event === "PermissionRequest")
      expect(request?.payload).toMatchObject({
        toolName: "edit",
        toolUseID: "call_hook_ask",
      })
      // Legacy fields stay (existing hooks read tool_input.patterns) next to the tool args.
      expect(request?.payload).toHaveProperty("toolInput", {
        filePath: "db/migration.sql",
        permission: "edit",
        patterns: ["edit"],
        metadata: { hookAsk: true, reason: "migration file: confirm" },
        always: [],
      })
      expect(triggered.find((t) => t.payload.event === "PermissionDenied")).toBeUndefined()
      expect(triggered.find((t) => t.payload.event === "Notification")).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "a PermissionRequest hook allow does not answer a forced hook ask, but its deny still applies",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      permissionRequestDecision = "allow"
      // An ordinary ask is still auto-approved by the PermissionRequest hook.
      yield* permission.ask({
        sessionID,
        permission: "edit",
        patterns: ["src/c.ts"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect((yield* permission.list()).length).toBe(0)

      const fiber = yield* hookAsk().pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      expect(pending[0].metadata).toMatchObject({ hookAsk: true })
      yield* Fiber.interrupt(fiber)

      permissionRequestDecision = "deny"
      const exit = yield* hookAsk().pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          permissionRequestDecision = undefined
        }),
      ),
    ),
  { git: true },
)

it.instance(
  "a call confirmed through a forced ask settles ask rules without a dialog, but deny still applies",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const request = (ruleset: PermissionV1.Rule[]) => ({
        sessionID,
        permission: "edit",
        patterns: ["src/d.ts"],
        metadata: {},
        always: ["*"],
        tool: { messageID: "msg_hook_ask", callID: "call_hook_ask" },
        ruleset,
      })
      const before = triggered.length
      yield* permission.ask(request([{ permission: "edit", pattern: "*", action: "ask" }]), { confirmed: true })
      expect((yield* permission.list()).length).toBe(0)
      expect(triggered.slice(before).some((entry) => entry.payload.event === "PermissionRequest")).toBe(false)

      const denied = yield* permission
        .ask(request([{ permission: "edit", pattern: "*", action: "deny" }]), { confirmed: true })
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)

      // `confirmed` never answers a forced ask itself.
      const fiber = yield* permission.ask(request([]), { confirmed: true, force: true }).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
    }),
  { git: true },
)
