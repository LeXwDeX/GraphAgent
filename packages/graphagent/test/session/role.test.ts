// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { ChildBindingTable, type ChildOwnerKind } from "@graphagent/core/session/child.sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { Effect, Logger, Option, Scope } from "effect"
import { ChildPolicy } from "@/session/child/policy"
import { ChildRegistry } from "@/session/child/registry"
import { makeChildRuns } from "@/session/child/run"
import type { ActiveChildRun } from "@/session/engine-process"
import { SessionRole } from "@/session/role"
import { SessionID } from "@/session/schema"
import { countingDatabaseLayer, reset, snapshot } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"

/**
 * Issue #1288: what a session is. `roleOf`, `parentOf` and `rootOf` answer from
 * the active run of this process first and from `child_binding` after that;
 * the row-only tests (`isRoot`, `isChild`) need nothing. The database is real
 * (in-memory, foreign keys on) and counts its reads, so the order of the lookup
 * is pinned by what it costs.
 */

const it = testEffect(countingDatabaseLayer)

type Db = Database.Interface["db"]

const id = (name: string) => SessionID.make(`ses_role_${name}_${Math.random().toString(36).slice(2)}`)

const seed = (db: Db, sessionID: SessionID, parentID?: SessionID) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_session_role"), worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.make("prj_session_role"),
        slug: "session-role",
        directory: AbsolutePath.make("/tmp"),
        title: "session role",
        version: "0",
        ...(parentID ? { parent_id: parentID } : {}),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

/** A session row, and the binding `ChildRuns.start` would have written for it. */
const seedChild = (db: Db, sessionID: SessionID, parentID: SessionID, ownerKind: ChildOwnerKind | undefined) =>
  Effect.gen(function* () {
    yield* seed(db, sessionID, parentID)
    if (ownerKind === undefined) return
    yield* db
      .insert(ChildBindingTable)
      .values({
        child_session_id: sessionID,
        parent_session_id: parentID,
        owner_kind: ownerKind,
        owner_ref: ownerKind === "task" ? "call_1" : "wf_1/node_1",
      })
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

const registered: ActiveChildRun[] = []

/** A run in this process's registry with no database row behind it. */
const register = (input: { readonly child: SessionID; readonly parent: SessionID; readonly kind: ChildOwnerKind }) => {
  const entry = ChildRegistry.create({
    id: `crun_role_${input.child}`,
    childSessionID: input.child,
    parentSessionID: input.parent,
    ownerKind: input.kind,
    ownerKey:
      input.kind === "task" ? { kind: "task" } : { kind: "dag_node", workflowID: "wf_1", nodeID: "node_1", attempt: 1 },
    permission: { ask: "user" },
    detached: false,
    directory: undefined,
    owner: {},
  })
  expect(ChildRegistry.register(entry)).toBe(true)
  registered.push(entry)
  return entry
}

afterEach(() => {
  for (const entry of registered.splice(0)) {
    ChildRegistry.end(entry, { type: "completed" })
    ChildRegistry.driverStopped(entry)
    ChildRegistry.persisted(entry)
  }
})

describe("SessionRole row tests", () => {
  it.effect("a row without a parent is a root, a row with one is a child", () =>
    Effect.sync(() => {
      const root: SessionRole.Ref = { id: id("row-root") }
      const child: SessionRole.Ref = { id: id("row-child"), parentID: id("row-parent") }
      expect(SessionRole.isRoot(root)).toBe(true)
      expect(SessionRole.isChild(root)).toBe(false)
      expect(SessionRole.isRoot(child)).toBe(false)
      expect(SessionRole.isChild(child)).toBe(true)
      // A bare column read yields null for a root; the SDK omits the field.
      expect(SessionRole.isRoot({ parentID: null })).toBe(true)
      expect(SessionRole.isRoot({})).toBe(true)
    }),
  )
})

describe("SessionRole.roleOfRow", () => {
  it.effect("places a row by the owner kind read with it, and a root by nothing", () =>
    Effect.sync(() => {
      const child = { parentID: id("row-owner-parent") }
      expect(SessionRole.roleOfRow({}, undefined)).toBe("root")
      // A root never looks at a binding, whatever a join handed back.
      expect(SessionRole.roleOfRow({ parentID: null }, "dag_node")).toBe("root")
      expect(SessionRole.roleOfRow(child, "task")).toBe("task_child")
      expect(SessionRole.roleOfRow(child, "dag_node")).toBe("dag_node")
      // No binding: the least a child can be.
      expect(SessionRole.roleOfRow(child, null)).toBe("task_child")
      expect(SessionRole.roleOfRow(child, undefined)).toBe("task_child")
    }),
  )

  it.effect("reports a child that was read with no binding once per session, however often it is read", () =>
    Effect.gen(function* () {
      const first = { id: id("report-first"), parentID: id("report-parent") }
      const second = { id: id("report-second"), parentID: id("report-parent") }

      const { warnings } = yield* withWarnings(
        Effect.gen(function* () {
          yield* SessionRole.reportUnbound([first, second])
          yield* SessionRole.reportUnbound([first])
          yield* SessionRole.reportUnbound([second, first])
        }),
      )

      expect(warnings).toHaveLength(2)
      expect(warnings.every((message) => message.includes("child session has no child_binding"))).toBe(true)
    }),
  )
})

describe("SessionRole.roleOf", () => {
  it.effect("is root for a row without a parent, at no cost", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const root = id("root")
      yield* seed(db, root)

      reset()
      expect(yield* SessionRole.roleOf(db, { id: root })).toBe("root")
      expect(snapshot()["sql.read"]).toBe(0)
    }),
  )

  it.effect("is task_child for a child whose binding names a task owner", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const root = id("task-root")
      const child = id("task-child")
      yield* seed(db, root)
      yield* seedChild(db, child, root, "task")

      const { value, warnings } = yield* withWarnings(SessionRole.roleOf(db, { id: child, parentID: root }))

      expect(value).toBe("task_child")
      expect(warnings).toEqual([])
    }),
  )

  it.effect("is dag_node for a child whose binding names a DAG node owner", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const root = id("dag-root")
      const node = id("dag-node")
      yield* seed(db, root)
      yield* seedChild(db, node, root, "dag_node")

      const { value, warnings } = yield* withWarnings(SessionRole.roleOf(db, { id: node, parentID: root }))

      expect(value).toBe("dag_node")
      expect(warnings).toEqual([])
    }),
  )

  it.effect("asks the active run of this process before the database", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const root = id("live-root")
      const node = id("live-node")
      // The run is registered; its binding row is not written yet (the window between
      // `Registry.register` and the insert), and the row names no owner at all.
      yield* seed(db, root)
      yield* seed(db, node, root)
      register({ child: node, parent: root, kind: "dag_node" })

      reset()
      const { value, warnings } = yield* withWarnings(SessionRole.roleOf(db, { id: node, parentID: root }))

      expect(value).toBe("dag_node")
      expect(warnings).toEqual([])
      expect(snapshot()["sql.read"]).toBe(0)
      expect(SessionRole.liveRoleOf({ id: node, parentID: root })).toBe("dag_node")
    }),
  )

  it.effect("treats a child without a binding as task_child and logs exactly one warning", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const root = id("orphan-root")
      const orphan = id("orphan-child")
      yield* seed(db, root)
      yield* seedChild(db, orphan, root, undefined)

      const { value, warnings } = yield* withWarnings(SessionRole.roleOf(db, { id: orphan, parentID: root }))

      expect(value).toBe("task_child")
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("child session has no child_binding")
    }),
  )

  it.effect("a child without a binding keeps its parent and gains nothing of a root", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const root = id("kept-root")
      const orphan = id("kept-child")
      yield* seed(db, root)
      yield* seedChild(db, orphan, root, undefined)
      const ref = { id: orphan, parentID: root }

      const { value } = yield* withWarnings(
        Effect.all({ parent: SessionRole.parentOf(db, ref), root: SessionRole.rootOf(db, ref) }),
      )

      expect(value.parent).toBe(root)
      expect(value.root).toBe(root)
      expect(SessionRole.isRoot(ref)).toBe(false)
    }),
  )
})

describe("SessionRole.parentOf and rootOf", () => {
  it.effect("a root has no parent and is its own root", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const root = id("self")
      yield* seed(db, root)

      expect(yield* SessionRole.parentOf(db, { id: root })).toBeUndefined()
      expect(yield* SessionRole.rootOf(db, { id: root })).toBe(root)
    }),
  )

  it.effect("root, child and grandchild rows: the grandchild's root is the root and its parent the child", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const root = id("tree-root")
      const child = id("tree-child")
      const grandchild = id("tree-grandchild")
      yield* seed(db, root)
      yield* seedChild(db, child, root, "dag_node")
      yield* seedChild(db, grandchild, child, "task")

      const ref = { id: grandchild, parentID: child }
      const { value, warnings } = yield* withWarnings(
        Effect.all({
          parent: SessionRole.parentOf(db, ref),
          root: SessionRole.rootOf(db, ref),
          role: SessionRole.roleOf(db, ref),
          childParent: SessionRole.parentOf(db, { id: child, parentID: root }),
          childRoot: SessionRole.rootOf(db, { id: child, parentID: root }),
        }),
      )

      expect(value.parent).toBe(child)
      expect(value.root).toBe(root)
      expect(value.role).toBe("task_child")
      expect(value.childParent).toBe(root)
      expect(value.childRoot).toBe(root)
      expect(warnings).toEqual([])
    }),
  )

  it.effect("one level down, the root is the direct parent", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const root = id("flat-root")
      const child = id("flat-child")
      yield* seed(db, root)
      yield* seedChild(db, child, root, "task")

      const ref = { id: child, parentID: root }
      expect(yield* SessionRole.parentOf(db, ref)).toBe(root)
      expect(yield* SessionRole.rootOf(db, ref)).toBe(root)
    }),
  )

  it.effect("a link without a binding falls back to the parent its row records, with a warning", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const root = id("gap-root")
      const middle = id("gap-middle")
      const leaf = id("gap-leaf")
      yield* seed(db, root)
      yield* seedChild(db, middle, root, undefined)
      yield* seedChild(db, leaf, middle, "task")

      const { value, warnings } = yield* withWarnings(SessionRole.rootOf(db, { id: leaf, parentID: middle }))

      expect(value).toBe(root)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("child session has no child_binding")
    }),
  )

  it.effect("follows live runs without reading, up to the root they record", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const root = id("live-tree-root")
      const child = id("live-tree-child")
      const grandchild = id("live-tree-grandchild")
      register({ child, parent: root, kind: "task" })
      register({ child: grandchild, parent: child, kind: "dag_node" })

      reset()
      expect(yield* SessionRole.rootOf(db, { id: grandchild, parentID: child })).toBe(root)
      expect(yield* SessionRole.parentOf(db, { id: grandchild, parentID: child })).toBe(child)
      expect(snapshot()["sql.read"]).toBe(0)
      expect(SessionRole.liveRootOf(grandchild)).toBe(root)
      expect(SessionRole.liveRootOf(root)).toBe(root)
    }),
  )

  it.effect("stops where a corrupt chain closes on itself", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      // Two sessions bound as each other's child: not a layout the engine writes.
      const x = id("loop-x")
      const y = id("loop-y")
      yield* seed(db, x)
      yield* seed(db, y)
      yield* db
        .insert(ChildBindingTable)
        .values([
          { child_session_id: x, parent_session_id: y, owner_kind: "task" },
          { child_session_id: y, parent_session_id: x, owner_kind: "task" },
        ])
        .run()
        .pipe(Effect.orDie)

      const { value, warnings } = yield* withWarnings(SessionRole.rootOf(db, { id: x, parentID: y }))

      expect([x, y]).toContain(value)
      expect(warnings.some((line) => line.includes("loops"))).toBe(true)
    }),
  )
})

describe("the run's subject", () => {
  it.effect("splits the direct parent from the root, and a child run of a child run keeps the root", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const scope = yield* Scope.Scope
      const children = yield* makeChildRuns({ db, scope, cancelSession: () => Effect.void })
      const root = id("subject-root")
      const child = id("subject-child")
      const grandchild = id("subject-grandchild")
      yield* seed(db, root)
      yield* seed(db, child, root)
      yield* seed(db, grandchild, child)

      const first = yield* children.forParent(root).start({
        childSessionID: child,
        owner: { kind: "task", toolCallID: "call_1" },
        detached: false,
      })
      const second = yield* children.forParent(child).start({
        childSessionID: grandchild,
        owner: { kind: "dag_node", workflowID: "wf_1", nodeID: "node_1", attempt: 1 },
        detached: false,
      })

      const outer = Option.getOrThrow(ChildPolicy.subjectOf(child))
      expect(outer.parentSessionID).toBe(root)
      expect(outer.rootSessionID).toBe(root)
      const inner = Option.getOrThrow(ChildPolicy.subjectOf(grandchild))
      expect(inner.parentSessionID).toBe(child)
      expect(inner.rootSessionID).toBe(root)
      expect(SessionRole.liveRoleOf({ id: grandchild, parentID: child })).toBe("dag_node")

      yield* second.settle({ type: "completed" })
      yield* first.settle({ type: "completed" })
    }),
  )

  it.effect("a root that starts the run is both the parent and the root", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const scope = yield* Scope.Scope
      const children = yield* makeChildRuns({ db, scope, cancelSession: () => Effect.void })
      const root = id("flat-subject-root")
      const child = id("flat-subject-child")
      yield* seed(db, root)
      yield* seed(db, child, root)

      const run = yield* children.forParent(root).start({
        childSessionID: child,
        owner: { kind: "task" },
        detached: false,
      })

      const subject = Option.getOrThrow(ChildPolicy.subjectOf(child))
      expect(subject.parentSessionID).toBe(root)
      expect(subject.rootSessionID).toBe(root)
      yield* run.settle({ type: "completed" })
    }),
  )
})
