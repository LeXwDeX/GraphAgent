// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { PermissionV1 } from "@graphagent/core/v1/permission"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Database } from "@graphagent/core/database/database"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { SettingsHook } from "../../src/hook"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"

/**
 * #1459: an MCP tool whose key was shortened or made unique keeps the deny and ask rules written for the key it had
 * before (its `alias`), and the stricter of the two keys decides. An allow written for the old key does not carry over.
 */

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

const OLD = "srv_call"
const NEW = "srv_call_1a2b3c4d"
const rule = (permission: string, action: PermissionV1.Rule["action"], pattern = "*"): PermissionV1.Rule => ({
  permission,
  pattern,
  action,
})

const request = (permission: string, sessionID = SessionID.make("session_alias")) => ({
  sessionID,
  permission,
  patterns: ["*"],
  metadata: {},
  always: ["*"],
})

// What one ask comes to: nothing (settled without a question), a question for the user, or the error that ended it.
const outcome = (
  ruleset: PermissionV1.Ruleset,
  options: NonNullable<Parameters<Permission.Interface["ask"]>[1]>,
  permission = NEW,
  sessionID = SessionID.make("session_alias"),
) =>
  Effect.gen(function* () {
    const service = yield* Permission.Service
    const done: { exit?: Exit.Exit<unknown, unknown> } = {}
    const fiber = yield* service.ask({ ...request(permission, sessionID), ruleset }, options).pipe(
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => (done.exit = exit))),
      Effect.forkScoped,
    )
    const settled = yield* pollWithTimeout(
      service.list().pipe(
        Effect.map((list) => {
          const pending = list.filter((item) => item.sessionID === sessionID)
          return pending.length > 0 ? pending : done.exit ? [] : undefined
        }),
      ),
      "the ask neither settled nor asked the user",
    )
    for (const item of settled) yield* service.reply({ requestID: item.id, reply: "reject" })
    const exit = yield* Fiber.join(fiber)
    if (settled.length > 0) return "asked" as const
    if (Exit.isSuccess(exit)) return "allowed" as const
    return Cause.squash(exit.cause) instanceof PermissionV1.DeniedError ? ("denied" as const) : ("failed" as const)
  })

describe("Permission.ask with the key a rewritten MCP tool had before", () => {
  it.instance("a deny written for the old key refuses the call although the new key is allowed", () =>
    Effect.gen(function* () {
      const rules = [rule("*", "allow"), rule(OLD, "deny")]
      expect(yield* outcome(rules, { alias: OLD })).toBe("denied")
      // Without the old key, nothing names the tool: the same rules allow it.
      expect(yield* outcome(rules, {})).toBe("allowed")
      // A tool that merely has another key is not touched.
      expect(yield* outcome(rules, { alias: "srv_other" })).toBe("allowed")
    }),
  )

  it.instance("an ask written for the old key still asks although the new key is allowed", () =>
    Effect.gen(function* () {
      const rules = [rule("*", "allow"), rule(OLD, "ask")]
      expect(yield* outcome(rules, { alias: OLD })).toBe("asked")
      expect(yield* outcome(rules, {})).toBe("allowed")
    }),
  )

  it.instance("a hook allow does not skip the question the old key's ask raises", () =>
    Effect.gen(function* () {
      const rules = [rule("*", "allow"), rule(OLD, "ask")]
      expect(yield* outcome(rules, { alias: OLD, hookAllowed: true })).toBe("asked")
      // Nothing asks without that rule, so the hook's allow changes nothing.
      expect(yield* outcome([rule("*", "allow")], { alias: OLD, hookAllowed: true })).toBe("allowed")
    }),
  )

  it.instance("an ask for the old key never lifts a deny of the new key", () =>
    Effect.gen(function* () {
      expect(yield* outcome([rule("*", "allow"), rule(OLD, "ask"), rule(NEW, "deny")], { alias: OLD })).toBe("denied")
    }),
  )

  it.instance("the stricter of the two decides, whichever rule comes later", () =>
    Effect.gen(function* () {
      // The old key's deny wins over a later allow of the new key.
      expect(yield* outcome([rule("*", "allow"), rule(OLD, "deny"), rule(NEW, "allow")], { alias: OLD })).toBe("denied")
      // The new key's deny wins over a later allow of the old key.
      expect(yield* outcome([rule("*", "allow"), rule(NEW, "deny"), rule(OLD, "allow")], { alias: OLD })).toBe("denied")
    }),
  )

  it.instance("an allow written for the old key does not carry over", () =>
    Effect.gen(function* () {
      // No rule allows the new key: the old key's allow is not enough.
      expect(yield* outcome([rule(OLD, "allow")], { alias: OLD })).toBe("asked")
      expect(yield* outcome([rule("*", "ask"), rule(OLD, "allow")], { alias: OLD })).toBe("asked")
      expect(yield* outcome([rule("*", "deny"), rule(OLD, "allow")], { alias: OLD })).toBe("denied")
    }),
  )

  it.instance("a rule that also names the new key, or a later catch-all, decides as it always did", () =>
    Effect.gen(function* () {
      // The old key's deny is overridden by the later catch-all, for both keys.
      expect(yield* outcome([rule(OLD, "deny"), rule("*", "allow")], { alias: OLD })).toBe("allowed")
      // A server wildcard names both keys: it is the new key's rule already.
      expect(yield* outcome([rule("*", "allow"), rule("srv_*", "deny")], { alias: OLD })).toBe("denied")
      // The new key allowed by name after everything was denied.
      expect(yield* outcome([rule("*", "deny"), rule(NEW, "allow")], { alias: OLD })).toBe("allowed")
    }),
  )

  it.instance("a rule with a concrete pattern is copied with that pattern, for the patterns it matches", () =>
    Effect.gen(function* () {
      const service = yield* Permission.Service
      const rules = [rule("*", "allow"), rule(OLD, "deny", "danger*")]
      const ask = (pattern: string) =>
        service.ask({ ...request(NEW), patterns: [pattern], ruleset: rules }, { alias: OLD }).pipe(
          Effect.exit,
          Effect.map((exit) => (Exit.isSuccess(exit) ? "allowed" : "denied")),
        )
      expect(yield* ask("danger-zone")).toBe("denied")
      expect(yield* ask("harmless")).toBe("allowed")
    }),
  )

  it.instance("a native deny of the old key refuses the call too", () =>
    Effect.gen(function* () {
      const service = yield* Permission.Service
      const exit = yield* service
        .ask(
          { ...request(NEW), ruleset: [] },
          {
            alias: OLD,
            resolveRuleset: () => Effect.succeed({ native: [rule(OLD, "deny")], rules: [rule("*", "allow")] }),
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof PermissionV1.DeniedError).toBe(true)
    }),
  )

  it.instance("an always reply to the question settles that key and not another rewritten key of the old name", () =>
    Effect.gen(function* () {
      const service = yield* Permission.Service
      const session = SessionID.make("session_alias_always")
      const rules = [rule("*", "allow"), rule(OLD, "ask")]
      const asking = yield* service
        .ask({ ...request(NEW, session), ruleset: rules }, { alias: OLD })
        .pipe(Effect.forkScoped)
      const [pending] = yield* pollWithTimeout(
        service.list().pipe(Effect.map((list) => (list.length > 0 ? list : undefined))),
        "the call did not ask the user",
      )
      expect(pending.permission).toBe(NEW)
      yield* service.reply({ requestID: pending.id, reply: "always" })
      yield* Fiber.join(asking)

      // The same tool is not asked again...
      expect(yield* outcome(rules, { alias: OLD }, NEW, session)).toBe("allowed")
      // ...but another tool that was `srv_call` too is.
      expect(yield* outcome(rules, { alias: OLD }, "srv_call_5e6f7a8b", session)).toBe("asked")
    }),
  )
})

describe("Permission.disabledTools", () => {
  const tools = [{ id: NEW, alias: OLD }, { id: "srv_plain" }]

  test("hides a rewritten key by a deny of either key and nothing else", () => {
    expect([...Permission.disabledTools(tools, [], [rule("*", "allow"), rule(OLD, "deny")])]).toEqual([NEW])
    expect([...Permission.disabledTools(tools, [], [rule("*", "allow"), rule(NEW, "deny")])]).toEqual([NEW])
    expect([...Permission.disabledTools(tools, [rule(OLD, "deny")], [rule("*", "allow")])]).toEqual([NEW])
    expect([...Permission.disabledTools(tools, [], [rule("*", "allow"), rule("srv_plain", "deny")])]).toEqual([
      "srv_plain",
    ])
  })

  test("an ask or an allow of the old key hides nothing, and a later allow lifts the deny", () => {
    expect(Permission.disabledTools(tools, [], [rule("*", "allow"), rule(OLD, "ask")]).size).toBe(0)
    expect(Permission.disabledTools(tools, [], [rule("*", "allow"), rule(OLD, "allow")]).size).toBe(0)
    expect(Permission.disabledTools(tools, [], [rule(OLD, "deny"), rule(OLD, "allow")]).size).toBe(0)
    expect(Permission.disabledTools(tools, [], [rule(OLD, "deny"), rule("*", "allow")]).size).toBe(0)
  })

  test("a catch-all deny hides the tools, unless the new key is allowed by name", () => {
    expect([...Permission.disabledTools(tools, [], [rule("*", "deny")])].toSorted()).toEqual([NEW, "srv_plain"])
    expect([...Permission.disabledTools(tools, [], [rule("*", "deny"), rule(NEW, "allow")])]).toEqual(["srv_plain"])
    expect([...Permission.disabledTools(tools, [], [rule("*", "deny"), rule(OLD, "allow")])].toSorted()).toEqual([
      NEW,
      "srv_plain",
    ])
  })

  test("without a key to look up it is disabledByPolicy", () => {
    const ids = ["read", "srv_plain", "srv_other", "edit", "write"]
    for (const rules of [
      [],
      [rule("*", "allow"), rule("srv_plain", "deny")],
      [rule("*", "deny"), rule("read", "allow")],
      [rule("edit", "deny")],
      [rule("srv_*", "ask")],
    ])
      expect(
        Permission.disabledTools(
          ids.map((id) => ({ id })),
          [],
          rules,
        ),
      ).toEqual(Permission.disabledByPolicy(ids, [], rules))
  })
})
