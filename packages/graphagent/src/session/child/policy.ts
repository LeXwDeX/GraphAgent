// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import { Effect, Option } from "effect"
import { SessionID } from "../schema"
import { ChildRegistry as Registry } from "./registry"
import { ChildStore as Store } from "./store"
import type { ChildOwner, ChildPermissionPolicy } from "./types"

/**
 * Permission policy of a child run (Issue #1026, PR4).
 *
 * The run's policy is decided by its owner and mirrored in the process
 * registry; the permission hot path reads it here, synchronously, without a
 * database read. Only the task policy is dynamic: `root-dag-mode` reads the
 * parent session's `dag_mode` at the moment of the ask, so a mode switch
 * applies to the next request.
 */

export interface Subject {
  readonly owner: ChildOwner
  readonly permission: ChildPermissionPolicy
  readonly rootSessionID: SessionID
}

/** The active run of a child session, if this process has one. Synchronous and read-free. */
export function subjectOf(childSessionID: SessionID): Option.Option<Subject> {
  const found = Registry.subjectOf(childSessionID)
  return found === undefined
    ? Option.none()
    : Option.some({ ...found, rootSessionID: SessionID.make(found.rootSessionID) })
}

export type EffectiveAsk = "user" | "auto"

/**
 * The ask policy that governs one child session now. `user` for a session with
 * no active run of this process (the SDK, a finished child), so an ask always
 * reaches the user; `auto` only for a run that chose it (a DAG node) or whose
 * root session currently runs in DAG mode (a task child).
 *
 * `db` is optional: a build without a database (unit fixtures, harnesses)
 * resolves a dynamic policy conservatively to `user`.
 */
export const askOf =
  (db: Database.Interface["db"] | undefined) =>
  (childSessionID: SessionID): Effect.Effect<Option.Option<Subject & { readonly ask: EffectiveAsk }>> =>
    Effect.suspend(() => {
      const found = subjectOf(childSessionID)
      if (Option.isNone(found)) return Effect.succeed(Option.none())
      const subject = found.value
      const ask: Effect.Effect<EffectiveAsk> =
        subject.permission.ask === "root-dag-mode"
          ? db
            ? Store.dagModeOf(db, subject.rootSessionID).pipe(
                Effect.map((mode) => (mode === "on" ? "auto" : "user") as EffectiveAsk),
                Effect.orElseSucceed(() => "user" as const),
              )
            : Effect.succeed("user" as const)
          : Effect.succeed(subject.permission.ask)
      return ask.pipe(Effect.map((value) => Option.some({ ...subject, ask: value })))
    })

export * as ChildPolicy from "./policy"
