// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { ChildBindingTable, type ChildOwnerKind } from "@graphagent/core/session/child.sql"
import { SessionProjector } from "@graphagent/core/session/projector"
import { Cause, Deferred, Effect, Exit, Layer, Logger } from "effect"
import { Dag } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Goal } from "@/goal/goal"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { ExclusiveRegistry } from "@/session/engine-process"
import { Session as SessionNs } from "@/session/session"
import { Storage } from "@/storage/storage"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * Issue #1288, second part: `Session.Info.role`. The role is derived on read
 * from the parent and the child binding (no column), so the three reads that
 * hand an `Info` on (`get`, `list`, `children`) must agree with it, and the
 * `session.created` event, which is published before the binding is written,
 * already carries the role its creator named.
 */

const it = testEffect(
  Layer.mergeAll(
    SessionNs.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
      Layer.provide(Goal.defaultLayer),
      Layer.provide(ExclusiveRegistry.defaultLayer),
      Layer.provide(Dag.defaultLayer),
    ),
    Database.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

/** The binding `ChildRuns.start` writes for a child session, which is written after the session itself. */
const bind = (child: SessionNs.Info, ownerKind: ChildOwnerKind) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const parent = child.parentID ?? (yield* Effect.die(new Error("bind needs a child session")))
    yield* db
      .insert(ChildBindingTable)
      .values({ child_session_id: child.id, parent_session_id: parent, owner_kind: ownerKind })
      .run()
      .pipe(Effect.orDie)
  })

/** Warnings logged while `effect` runs. */
const withWarnings = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const warnings: string[] = []
    const collector = Logger.make((entry) => {
      if (entry.logLevel === "Warn") warnings.push(String(entry.message))
    })
    const value = yield* effect.pipe(Effect.provide(Logger.layer([collector])))
    return { value, warnings }
  })

/** The id and role of the `info` a session event carries. */
const infoOf = (data: unknown) => {
  if (typeof data !== "object" || data === null || !("info" in data)) return undefined
  const info = data.info
  if (typeof info !== "object" || info === null || !("id" in info) || !("role" in info)) return undefined
  return typeof info.id === "string" && typeof info.role === "string" ? { id: info.id, role: info.role } : undefined
}

const awaitEvent = <T>(deferred: Deferred.Deferred<T>) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error("timed out waiting for the event")))),
  )

describe("Session.Info.role", () => {
  it.instance("get, list and children give a root, a task child and a DAG node their role", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const root = yield* session.create({ title: "role-root" })
      const task = yield* session.create({ parentID: root.id, role: "task_child", title: "role-task" })
      const node = yield* session.create({ parentID: root.id, role: "dag_node", title: "role-node" })
      yield* bind(task, "task")
      yield* bind(node, "dag_node")

      // `create` answers with the role it published; the reads answer from the binding.
      expect([root.role, task.role, node.role]).toEqual(["root", "task_child", "dag_node"])
      expect((yield* session.get(root.id)).role).toBe("root")
      expect((yield* session.get(task.id)).role).toBe("task_child")
      expect((yield* session.get(node.id)).role).toBe("dag_node")

      const kids = yield* session.children(root.id)
      expect(kids).toHaveLength(2)
      expect(kids.find((child) => child.id === task.id)?.role).toBe("task_child")
      expect(kids.find((child) => child.id === node.id)?.role).toBe("dag_node")

      const listed = yield* session.list({})
      const roleOf = (id: string) => listed.find((item) => item.id === id)?.role
      expect([roleOf(root.id), roleOf(task.id), roleOf(node.id)]).toEqual(["root", "task_child", "dag_node"])
      const roots = yield* session.list({ roots: true })
      expect(roots.map((item) => item.role)).toEqual(["root"])
    }),
  )

  it.instance("a child with no binding is a task_child, reported once for the process", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const root = yield* session.create({ title: "role-unbound-root" })
      const child = yield* session.create({ parentID: root.id, role: "dag_node", title: "role-unbound-child" })

      const { value, warnings } = yield* withWarnings(
        Effect.gen(function* () {
          const first = yield* session.get(child.id)
          yield* session.get(child.id)
          yield* session.children(root.id)
          const listed = yield* session.list({})
          return { first, listed }
        }),
      )

      // The row alone cannot say a DAG node owns it; with no binding the session is the least a child can be.
      expect(value.first.role).toBe("task_child")
      expect(value.listed.find((item) => item.id === child.id)?.role).toBe("task_child")
      expect(warnings.filter((message) => message.includes("no child_binding"))).toHaveLength(1)

      // The binding, once written, places the same row.
      yield* bind(child, "dag_node")
      expect((yield* session.get(child.id)).role).toBe("dag_node")
    }),
  )

  it.instance("session.created and session.updated carry the role from the first event", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const created = new Map<string, string>()
      const updated = yield* Deferred.make<string>()
      const unsubscribe = yield* source.listen((event) => {
        const info = infoOf(event.data)
        if (event.type === SessionNs.Event.Created.type && info) created.set(info.id, info.role)
        if (event.type === SessionNs.Event.Updated.type && info)
          Deferred.doneUnsafe(updated, Effect.succeed(`${info.id}:${info.role}`))
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const root = yield* session.create({ title: "role-event-root" })
      const task = yield* session.create({ parentID: root.id, role: "task_child", title: "role-event-task" })
      const node = yield* session.create({ parentID: root.id, role: "dag_node", title: "role-event-node" })
      // The creation events precede every binding: the role is the creator's, not a read.
      expect(created.get(root.id)).toBe("root")
      expect(created.get(task.id)).toBe("task_child")
      expect(created.get(node.id)).toBe("dag_node")

      // Once the binding exists an update of the child reads it back.
      yield* bind(node, "dag_node")
      yield* session.setTitle({ sessionID: node.id, title: "role-event-node-renamed" })
      expect(yield* awaitEvent(updated)).toBe(`${node.id}:dag_node`)
    }),
  )

  it.instance("a role needs a parent; a child with no role is a task_child and warns", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const orphan = yield* Effect.exit(session.create({ role: "dag_node" }))
      expect(Exit.isFailure(orphan) && Cause.hasDies(orphan.cause)).toBe(true)
      expect(Exit.isFailure(orphan) && Cause.pretty(orphan.cause)).toContain("needs a parentID")

      const root = yield* session.create({ title: "role-create-root" })
      const { value, warnings } = yield* withWarnings(session.create({ parentID: root.id, title: "role-create-child" }))
      expect(value.role).toBe("task_child")
      expect(warnings.filter((message) => message.includes("without a role"))).toHaveLength(1)
    }),
  )
})
