// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { AskAdjudicator, type DecideInput, type Decision } from "@/permission/ask-adjudicator"
import { ChildRegistry } from "@/session/child/registry"
import type { ChildOwner, ChildPermissionPolicy } from "@/session/child/types"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

/**
 * Issue #1026, PR4: the unattended-ask seam. No adjudicator is registered in
 * production until E4 (#1031); this file proves the hook shape and that a
 * registered adjudicator is consulted only for an `auto` child run, after deny
 * rules, and that its denial becomes a tool error carrying the safety rule.
 */

const decisions: DecideInput[] = []
let decision: Decision = "allow"
const adjudicator = Layer.succeed(
  AskAdjudicator.Service,
  AskAdjudicator.Service.of({
    decide: (input) =>
      Effect.sync(() => {
        decisions.push(input)
        return decision
      }),
  }),
)
const env = Layer.mergeAll(
  Permission.layer.pipe(
    Layer.provide(Database.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    // The layer reads optional services at build time; providing it here is
    // what makes `Permission.ask` see the adjudicator at all.
    Layer.provide(adjudicator),
  ),
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
)
const it = testEffect(env)

const rootSessionID = SessionID.make("ses_adjudicator_root")

/** One registered run of this process; unique per test so no prior test's entry can collide. */
const makeRun = (
  label: string,
  options: {
    readonly owner?: ChildOwner
    readonly permission?: ChildPermissionPolicy
    readonly parentSessionID?: SessionID
  } = {},
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const childSessionID = SessionID.make(`ses_adjudicator_${label}`)
      const owner = options.owner ?? { kind: "dag_node" as const, workflowID: "wf", nodeID: "n01", attempt: 0 }
      const entry = ChildRegistry.create({
        id: `crun_adjudicator_${label}`,
        childSessionID,
        parentSessionID: options.parentSessionID ?? rootSessionID,
        ownerKind: owner.kind,
        ownerKey: owner,
        permission: options.permission ?? { ask: "auto" },
        detached: false,
        directory: undefined,
        owner: {},
      })
      expect(ChildRegistry.register(entry)).toBe(true)
      return { entry, childSessionID }
    }),
    ({ entry }) =>
      Effect.sync(() => {
        ChildRegistry.end(entry, { type: "completed" })
        ChildRegistry.release(entry)
      }),
  )

const ask = (
  childSessionID: SessionID,
  ruleset: Parameters<Permission.Interface["ask"]>[0]["ruleset"] = [],
  force = false,
) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(
      {
        sessionID: childSessionID,
        permission: "bash",
        patterns: ["rm -rf /tmp/adjudicator"],
        always: [],
        metadata: {},
        ruleset,
      },
      force ? { force: true } : undefined,
    )
  })

/** The root session row the task policy reads at ask time. */
const setRootDagMode = (mode: "on" | "off") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_adjudicator"), worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: rootSessionID,
        project_id: Project.ID.make("prj_adjudicator"),
        slug: "adjudicator",
        directory: AbsolutePath.make("/tmp"),
        title: "adjudicator root",
        version: "0",
        dag_mode: mode,
      })
      .onConflictDoUpdate({ target: SessionTable.id, set: { dag_mode: mode } })
      .run()
      .pipe(Effect.orDie)
  })

it.instance(
  "a deny rule wins before the adjudicator is consulted",
  () =>
    Effect.gen(function* () {
      decisions.length = 0
      const { childSessionID } = yield* makeRun("deny-rule")
      const exit = yield* ask(childSessionID, [{ permission: "bash", pattern: "*", action: "deny" }]).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(decisions).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "an auto DAG run resolves an ask without a user prompt and without a pending request",
  () =>
    Effect.gen(function* () {
      decisions.length = 0
      const { childSessionID } = yield* makeRun("allow")
      const permission = yield* Permission.Service
      yield* ask(childSessionID)
      expect(decisions).toHaveLength(1)
      expect(decisions[0]).toMatchObject({
        pattern: "rm -rf /tmp/adjudicator",
        rule: { action: "ask", explicit: false },
        owner: { kind: "dag_node", workflowID: "wf", nodeID: "n01" },
        rootSessionID,
      })
      expect(yield* permission.list()).toEqual([])
    }),
  { git: true },
)

it.instance(
  "a task run keeps the ask with the user while the root is not in DAG mode",
  () =>
    Effect.gen(function* () {
      yield* setRootDagMode("off")
      decisions.length = 0
      const { childSessionID } = yield* makeRun("task-user", {
        owner: { kind: "task", toolCallID: "call_user" },
        permission: { ask: "root-dag-mode" },
      })
      const permission = yield* Permission.Service
      const pending = yield* ask(childSessionID).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect(decisions).toHaveLength(0)
      expect((yield* permission.list()).length).toBe(1)
      yield* Fiber.interrupt(pending)
    }),
  { git: true },
)

it.instance(
  "a task run is auto-adjudicated once its root switches to DAG mode",
  () =>
    Effect.gen(function* () {
      yield* setRootDagMode("on")
      decisions.length = 0
      const { childSessionID } = yield* makeRun("task-auto", {
        owner: { kind: "task", toolCallID: "call_auto" },
        permission: { ask: "root-dag-mode" },
      })
      yield* ask(childSessionID)
      expect(decisions).toHaveLength(1)
      expect(decisions[0]?.owner).toMatchObject({ kind: "task", toolCallID: "call_auto" })
    }),
  { git: true },
)

it.instance(
  "an adjudicator denial becomes a tool error carrying the safety rule",
  () =>
    Effect.gen(function* () {
      const { childSessionID } = yield* makeRun("deny")
      decision = { deny: { ruleID: "SF-3", reason: "destructive command" } }
      const exit = yield* ask(childSessionID).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("dag_safety:SF-3")
      decision = "allow"
    }),
  { git: true },
)

it.instance(
  "a user-written allow reaches the adjudicator as an explicit rule, and a forced ask is adjudicated too",
  () =>
    Effect.gen(function* () {
      decisions.length = 0
      const { childSessionID } = yield* makeRun("explicit")
      yield* ask(childSessionID, [{ permission: "bash", pattern: "*", action: "allow" }], true)
      expect(decisions.at(-1)).toMatchObject({ rule: { action: "allow", explicit: true } })
    }),
  { git: true },
)

it.instance(
  "the adjudicator is only consulted for a child run, never for a top-level session",
  () =>
    Effect.gen(function* () {
      decisions.length = 0
      const permission = yield* Permission.Service
      const pending = yield* permission
        .ask({
          sessionID: SessionID.make("ses_top_level"),
          permission: "bash",
          patterns: ["echo hi"],
          always: [],
          metadata: {},
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      // No adjudicator subject: the ask stays pending for the user.
      yield* Effect.yieldNow
      expect(decisions).toHaveLength(0)
      expect((yield* permission.list()).length).toBe(1)
      yield* Fiber.interrupt(pending)
    }),
  { git: true },
)
