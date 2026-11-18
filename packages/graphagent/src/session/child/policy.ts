// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import type { ConfigV1 } from "@graphagent/core/v1/config/config"
import { Effect, Option } from "effect"
import type { SessionID } from "../schema"
import { ChildRegistry as Registry } from "./registry"
import { ChildStore as Store } from "./store"
import type { ChildOwner, ChildPermissionPolicy } from "./types"

/**
 * Permission policy of a child run (Issue #1026, PR4).
 *
 * The run's policy is decided by its owner and mirrored in the process
 * registry; the permission hot path reads it here, synchronously, without a
 * database read. Only the task policy is dynamic: `root-dag-mode` reads the
 * root session's `dag_mode` at the moment of the ask, so a mode switch
 * applies to the next request.
 */

export interface Subject {
  readonly owner: ChildOwner
  readonly permission: ChildPermissionPolicy
  /** The session that started the run: its direct parent. */
  readonly parentSessionID: SessionID
  /**
   * The root of the conversation the run belongs to (`SessionRole.rootOf`):
   * where its DAG mode and budget live, and what an ask is attributed to. It is
   * the same session as the parent while a root starts the run, which is the
   * only layout today (Issue #1288).
   */
  readonly rootSessionID: SessionID
}

/** The active run of a child session, if this process has one. Synchronous and read-free. */
export function subjectOf(childSessionID: SessionID): Option.Option<Subject> {
  return Option.fromNullishOr(Registry.subjectOf(childSessionID))
}

export type EffectiveAsk = "user" | "auto"

/** The user's `dag.permission` tier (#1324), read by the caller from the global configuration at ask time. */
export type DagPermission = ConfigV1.DagPermission

/** The DAG mode of a root session, read when a task child's policy is `root-dag-mode`. */
export type RootDagMode = (rootSessionID: SessionID) => Effect.Effect<"on" | "off">

/**
 * What decides one ask of a child session, in two steps (#1324 §1).
 *
 * Step one, `unattended`: nobody answers this session's asks by default. True
 * for a run that chose `auto` (a DAG node) and for a run whose root session
 * currently runs in DAG mode (a task child). Step two, `ask`: who answers. A
 * session that is not unattended asks `user`; an unattended one is settled
 * automatically (`auto`) unless the tier is `ask`, which hands the question to
 * the user. `mode` is the tier this verdict was made under and only means
 * something while `unattended`.
 */
export interface AskPolicy extends Subject {
  readonly unattended: boolean
  readonly mode: DagPermission
  readonly ask: EffectiveAsk
}

/**
 * The ask policy that governs one child session now. No value for a session
 * with no active run of this process (the SDK, a finished child): its asks
 * always reach the user. Everything else follows `AskPolicy`.
 *
 * `rootMode` reads the root session's DAG mode; without one (unit fixtures,
 * harnesses with no database) a dynamic policy resolves conservatively to
 * attended. The tier is a parameter, not read here: the caller owns the
 * configuration and reads it at the moment of the ask.
 */
export const askWith =
  (rootMode: RootDagMode | undefined) =>
  (childSessionID: SessionID, mode: DagPermission = "allow"): Effect.Effect<Option.Option<AskPolicy>> =>
    Effect.suspend(() => {
      const found = subjectOf(childSessionID)
      if (Option.isNone(found)) return Effect.succeed(Option.none())
      const subject = found.value
      const unattended: Effect.Effect<boolean> =
        subject.permission.ask === "root-dag-mode"
          ? rootMode
            ? rootMode(subject.rootSessionID).pipe(Effect.map((root) => root === "on"))
            : Effect.succeed(false)
          : Effect.succeed(subject.permission.ask === "auto")
      return unattended.pipe(
        Effect.map((value): Option.Option<AskPolicy> => {
          const ask: EffectiveAsk = value && mode !== "ask" ? "auto" : "user"
          return Option.some({ ...subject, unattended: value, mode, ask })
        }),
      )
    })

/** `askWith` over the root session's row in the child-run database; `db` is optional for builds without one. */
export const askOf = (db: Database.Interface["db"] | undefined) =>
  askWith(db ? (rootSessionID) => Store.dagModeOf(db, rootSessionID) : undefined)

export * as ChildPolicy from "./policy"
