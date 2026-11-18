// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import { SessionRole as RoleSchema } from "@graphagent/schema/session-role"
import { Effect, Schema } from "effect"
import { ChildRegistry as Registry } from "./child/registry"
import { ChildStore as Store } from "./child/store"
import type { ChildOwnerKind } from "./child/types"
import type { SessionID } from "./schema"

/**
 * What a session is to the conversation it belongs to (Issue #1288).
 *
 * `root` is the conversation the user drives. Every other session is delegated
 * work: `task_child` is the subagent of a task tool call, `dag_node` the worker
 * of one DAG node. A session row's `parentID` only tells a root from a child.
 * What kind of child it is, who its parent is and where its conversation is
 * rooted come from the child's binding (`child_binding`: `owner_kind`,
 * `parent_session_id`), and from the active run of this process while there is
 * one.
 *
 * Code that decides by who a session is asks this module instead of testing
 * `parentID` itself: `isRoot` and `isChild` for the row-only questions every
 * hot path asks, `liveRoleOf` and `liveRootOf` for what this process knows
 * without a read, `roleOf`, `parentOf` and `rootOf` for the full answer.
 * Reading `parentID` to show or walk the relation (a listing, a recursive
 * delete) stays where it is; `test/policy/session-role-scan.test.ts` keeps the
 * decisions from coming back.
 */
export const Role = RoleSchema
export type Role = Schema.Schema.Type<typeof Role>

/** What every answer starts from: the session and the parent its own row records. */
export interface Ref {
  readonly id: SessionID
  readonly parentID?: SessionID | undefined
}

/** Anything that carries a session row's parent: a `Session.Info`, a bare column read, a request's session hint. */
export interface Parented {
  readonly parentID?: string | null | undefined
}

/**
 * Whether the session is a root: its row records no parent. This needs nothing
 * but the row, so it costs no read and holds before any child run is
 * registered. It is the one definition of the root test.
 */
export const isRoot = (session: Parented): boolean => !session.parentID

/** The complement of `isRoot`: delegated work, of whatever kind. */
export const isChild = (session: Parented): boolean => !isRoot(session)

/** A child's role from its binding's owner kind; no binding is `task_child`, the role with no capability to spare. */
const ofKind = (kind: ChildOwnerKind | null | undefined): Role => (kind === "dag_node" ? "dag_node" : "task_child")

/**
 * The role of a session row that was read together with its binding's owner
 * kind (the LEFT JOIN of `Session.get`, `list` and `children`), so it needs no
 * lookup: a row with no parent is a root, a child is `dag_node` when its binding
 * says a DAG node owns it and `task_child` otherwise. A child with no binding
 * (`ownerKind` null) is `task_child` as in `roleOf`; `reportUnbound` is where
 * the read paths log it.
 */
export const roleOfRow = (row: Parented, ownerKind: ChildOwnerKind | null | undefined): Role =>
  isRoot(row) ? "root" : ofKind(ownerKind)

/**
 * The role this process can name without a read: a root by its row, a child by
 * the run that drives it. No value for a child with no active run here (a
 * finished run, another process's row), which only the database can place.
 */
export function liveRoleOf(session: Ref): Role | undefined {
  if (isRoot(session)) return "root"
  const entry = Registry.activeFor(session.id)
  return entry === undefined ? undefined : ofKind(entry.ownerKind)
}

/**
 * The root of the conversation a session belongs to, as this process's
 * registry knows it, without a read: the root recorded with the session's
 * active run, otherwise the session itself. That is the root for every session
 * that starts runs, because a running child is a run of this process; see
 * `ChildRegistry.rootOf`. A child with no live run needs `rootOf`.
 */
export function liveRootOf(sessionID: SessionID): SessionID {
  return Registry.rootOf(sessionID)
}

type Db = Database.Interface["db"]

/** One session's place in its conversation: its role and its direct parent. */
interface Link {
  readonly role: Role
  readonly parent: SessionID | undefined
}

const warnUnbound = (sessionID: SessionID, parentID: SessionID) =>
  Effect.logWarning("child session has no child_binding; treated as task_child", { sessionID, parentID })

/**
 * The place of one session: the active run of this process first, then the
 * durable binding. A child with a recorded parent and no binding is a
 * `task_child` and logs a warning: #1026 invariant 3 gives every child session
 * exactly one binding, so a missing one is an anomaly, and it never earns the
 * session any capability of a root. A session with no row is placed by the
 * caller's own copy of its parent, if it has one.
 */
const link = Effect.fn("SessionRole.link")(function* (db: Db, session: Ref): Effect.fn.Return<Link> {
  const live = Registry.activeFor(session.id)
  if (live !== undefined) return { role: ofKind(live.ownerKind), parent: live.parentSessionID }
  const lineage = yield* Store.lineageOf(db, session.id)
  if (lineage?.binding !== undefined)
    return { role: ofKind(lineage.binding.ownerKind), parent: lineage.binding.parentSessionID }
  const recorded = lineage === undefined ? session.parentID : lineage.recordedParent
  if (recorded === undefined) return { role: "root", parent: undefined }
  yield* warnUnbound(session.id, recorded)
  return { role: "task_child", parent: recorded }
})

/** Sessions already reported by `reportUnbound`, so a read that repeats does not repeat the warning. */
const reported = new Set<string>()
const REPORTED_LIMIT = 1024

/**
 * The warning for children whose row was read with no binding behind it, for the
 * read paths (`Session.get`, `list`, `children`) that place a session by the
 * joined owner kind. One warning per session and process: a list is read again
 * and again, and `get` is a hot read, so a child that lacks its binding must not
 * flood the log. `roleOf` and `rootOf` warn on every resolution through `link`.
 * A child read between its creation and the write of its binding (see
 * `Session.create`) is reported the same once, and is placed correctly by the
 * next read.
 */
export const reportUnbound = (children: ReadonlyArray<{ readonly id: SessionID; readonly parentID: SessionID }>) =>
  Effect.forEach(
    children,
    (child) => {
      if (reported.has(child.id)) return Effect.void
      // A bounded memory for an anomaly that should not occur: past the limit it starts over.
      if (reported.size >= REPORTED_LIMIT) reported.clear()
      reported.add(child.id)
      return warnUnbound(child.id, child.parentID)
    },
    { discard: true },
  )

/** The role of a session: the live run first, then its binding. A row without a parent is a root and costs no read. */
export const roleOf = (db: Db, session: Ref): Effect.Effect<Role> =>
  isRoot(session) ? Effect.succeed("root") : link(db, session).pipe(Effect.map((found) => found.role))

/** The direct parent of a session; none for a root. */
export const parentOf = (db: Db, session: Ref): Effect.Effect<SessionID | undefined> =>
  isRoot(session) ? Effect.succeed(undefined) : link(db, session).pipe(Effect.map((found) => found.parent))

/**
 * The root of the conversation a session belongs to: the session itself for a
 * root, otherwise the top of its chain of parents. The chain is followed run
 * by run while this process drives it (each live run records its root) and by
 * binding after that. A chain that loops back on itself is corrupt data; the
 * walk stops where it closes.
 */
export const rootOf = (db: Db, session: Ref): Effect.Effect<SessionID> =>
  Effect.gen(function* () {
    if (isRoot(session)) return session.id
    const live = Registry.activeFor(session.id)
    if (live !== undefined) return live.rootSessionID
    const seen = new Set<string>([session.id])
    let node = session.id
    let step = yield* link(db, session)
    while (step.parent !== undefined) {
      const parent = step.parent
      if (seen.has(parent)) {
        yield* Effect.logWarning("session parent chain loops; its root is where the walk closed", {
          sessionID: session.id,
          at: parent,
        })
        return node
      }
      seen.add(parent)
      node = parent
      const above = Registry.activeFor(parent)
      if (above !== undefined) return above.rootSessionID
      step = yield* link(db, { id: parent })
    }
    return node
  })

export * as SessionRole from "./role"
