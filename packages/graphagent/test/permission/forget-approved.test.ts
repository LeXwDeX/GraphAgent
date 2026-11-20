// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1678: an "always allow" outranks an `ask` rule of the configuration, so a permission edit that makes a key
// stricter has to make the sessions forget what they approved under the looser rule. `Permission.forgetApproved` is
// that step: per permission key (a wildcard key covers the keys it matches), in every session of every loaded
// directory, without touching the requests still waiting for the user.
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Effect, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { SettingsHook } from "../../src/hook"
import { provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

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

const it = testEffect(
  Layer.mergeAll(
    Permission.layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(events), Layer.provide(noopSettingsHook)),
    events,
    CrossSpawnSpawner.defaultLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
  ),
)

const asks = (permission: string): PermissionV1.Ruleset => [{ permission, pattern: "*", action: "ask" }]

/** The request a tool of `session` makes under a rule that asks. */
const request = (session: string, permission: string, rules: PermissionV1.Ruleset = asks(permission)) => ({
  sessionID: SessionID.make(session),
  permission,
  patterns: ["target"],
  metadata: {},
  always: ["*"],
  ruleset: rules,
})

const waitForPending = (count: number) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const list = yield* permission.list()
      return list.length === count ? list : undefined
    }),
    () => `timed out waiting for ${count} pending permission request(s)`,
    "3 seconds",
  )

/** The user answers the request that is waiting with "always allow". */
const approveAlways = (session: string, permission: string) =>
  Effect.gen(function* () {
    const service = yield* Permission.Service
    const fiber = yield* service.ask(request(session, permission)).pipe(Effect.forkScoped)
    const [pending] = yield* waitForPending(1)
    if (!pending) throw new Error("no request is waiting")
    yield* service.reply({ requestID: pending.id, reply: "always" })
    yield* Fiber.join(fiber)
  })

/** Whether a call of `session` is let through without asking, under a rule that asks. */
const passes = (session: string, permission: string) =>
  Effect.gen(function* () {
    const service = yield* Permission.Service
    const fiber = yield* service.ask(request(session, permission)).pipe(Effect.forkScoped)
    // A call the user must answer shows up in the pending list; one that is let through finishes without it.
    const seen = yield* pollWithTimeout(
      Effect.gen(function* () {
        if (fiber.pollUnsafe() !== undefined) return "passed" as const
        return (yield* service.list()).length > 0 ? ("asked" as const) : undefined
      }),
      "the call neither passed nor asked",
      "3 seconds",
    )
    if (seen === "asked") {
      const [pending] = yield* service.list()
      if (pending) yield* service.reply({ requestID: pending.id, reply: "reject" })
      yield* Fiber.await(fiber)
    }
    return seen === "passed"
  })

describe("Permission.forgetApproved", () => {
  it.instance(
    "forgets the always-allow of the named key and leaves the other keys' alone",
    () =>
      Effect.gen(function* () {
        const service = yield* Permission.Service
        yield* approveAlways("session_a", "edit")
        yield* approveAlways("session_a", "bash")
        expect(yield* passes("session_a", "edit")).toBe(true)
        expect(yield* passes("session_a", "bash")).toBe(true)

        yield* service.forgetApproved(["edit"])
        expect(yield* passes("session_a", "edit")).toBe(false)
        expect(yield* passes("session_a", "bash")).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "forgets it in every session",
    () =>
      Effect.gen(function* () {
        const service = yield* Permission.Service
        yield* approveAlways("session_a", "edit")
        yield* approveAlways("session_b", "edit")

        yield* service.forgetApproved(["edit"])
        expect(yield* passes("session_a", "edit")).toBe(false)
        expect(yield* passes("session_b", "edit")).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "forgets it in every loaded directory, not only the one the caller is in",
    () =>
      Effect.gen(function* () {
        const service = yield* Permission.Service
        const other = yield* tmpdirScoped({ git: true })
        yield* approveAlways("session_here", "edit")
        yield* approveAlways("session_there", "edit").pipe(provideInstanceEffect(other))
        expect(yield* passes("session_there", "edit").pipe(provideInstanceEffect(other))).toBe(true)

        yield* service.forgetApproved(["edit"])
        expect(yield* passes("session_here", "edit")).toBe(false)
        expect(yield* passes("session_there", "edit").pipe(provideInstanceEffect(other))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "a wildcard key covers the keys it matches, and `*` covers all of them",
    () =>
      Effect.gen(function* () {
        const service = yield* Permission.Service
        yield* approveAlways("session_a", "mcp__srv__tool")
        yield* approveAlways("session_a", "bash")

        yield* service.forgetApproved(["mcp__*"])
        expect(yield* passes("session_a", "mcp__srv__tool")).toBe(false)
        expect(yield* passes("session_a", "bash")).toBe(true)

        yield* service.forgetApproved(["*"])
        expect(yield* passes("session_a", "bash")).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "no key, or a key nothing was approved for, changes nothing",
    () =>
      Effect.gen(function* () {
        const service = yield* Permission.Service
        yield* approveAlways("session_a", "edit")

        yield* service.forgetApproved([])
        yield* service.forgetApproved(["webfetch"])
        expect(yield* passes("session_a", "edit")).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "a request still waiting for the user is left waiting, and its answer is still honoured",
    () =>
      Effect.gen(function* () {
        const service = yield* Permission.Service
        const fiber = yield* service
          .ask({ ...request("session_a", "edit"), id: PermissionV1.ID.make("per_forget_waiting") })
          .pipe(Effect.forkScoped)
        yield* waitForPending(1)

        yield* service.forgetApproved(["edit", "*"])
        expect((yield* service.list()).map((item) => item.id)).toEqual([PermissionV1.ID.make("per_forget_waiting")])

        yield* service.reply({ requestID: PermissionV1.ID.make("per_forget_waiting"), reply: "once" })
        yield* Fiber.join(fiber)
        expect(yield* service.list()).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "a rule that denies is unaffected: forgetting only removes what outranked an ask",
    () =>
      Effect.gen(function* () {
        const service = yield* Permission.Service
        yield* approveAlways("session_a", "edit")
        yield* service.forgetApproved(["edit"])

        const denied = yield* service
          .ask(request("session_a", "edit", [{ permission: "edit", pattern: "*", action: "deny" }]))
          .pipe(Effect.flip)
        expect(denied).toBeInstanceOf(PermissionV1.DeniedError)
      }),
    { git: true },
  )
})
