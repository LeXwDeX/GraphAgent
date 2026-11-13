// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import { Cause, Clock, Effect, Option, type Scope } from "effect"
import { DagLocation } from "@/dag/location"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionCancellation } from "../cancellation"
import type { InboxSource, Interface as InboxInterface } from "../inbox"
import type { Interface as PromptInterface } from "../prompt"
import { SessionID } from "../schema"
import { admitNowUnderFence } from "../turn/admit"
import type { AdmissionOptions, TurnOrigin } from "../turns"
import { ChildNotice } from "./notice"
import { ChildRegistry as Registry } from "./registry"
import { ChildStore as Store } from "./store"
import type { ChildRunOutcome } from "./types"

/**
 * The `child.result` inbox source (Issue #1026, PR3a): the result ledger of
 * detached child runs.
 *
 * The ledger is the `child_run` table. A detached run that ended on its own
 * leaves its row `ended`, with its result in `outcome` and `reported_at`
 * empty; this source tells the parent session about it exactly once and
 * writes `reported_at` in the same transaction as the transcript message.
 *
 * Only task runs are this ledger's: the result of a DAG node (PR4) is delivered
 * by the DAG, so its rows are never owed here.
 *
 * Three things bring a row to the source, none of them exclusive:
 * - the nudge: the run's ending wakes the inbox of the parent's instance at
 *   once (`ChildNotify`), so a fresh result does not wait for the tick;
 * - the tick: one directory-filtered scan every 30 seconds (`Store.unreportedParents`);
 * - the startup scan: rows an earlier process left owed, including runs it
 *   lost (`interrupted`), are delivered when the instance loads.
 *
 * How a result enters the parent depends on whether it is fresh:
 * - A result that ended in this process and met no ESC since is delivered
 *   `join_or_start`: it joins the running turn's next input, or starts a turn
 *   when the parent is idle. The ESC fence (`admitNowUnderFence`) covers an
 *   ESC that lands between the claim and the admission.
 * - Any other result (an ESC came in between, or it is left over from before a
 *   restart, or its run was lost with its process) is only written to the
 *   transcript: the parent hears of it at its next turn, and no turn starts
 *   that nobody asked for.
 */

export interface Deps {
  readonly db: Database.Interface["db"]
  /** The inbox of the instance this source serves; `drain` is its in-instance nudge. */
  readonly inbox: Pick<InboxInterface, "register" | "drain">
  /** The admission port. */
  readonly prompts: Pick<PromptInterface, "admit">
  /** Directory of the instance this source serves; only the parents it owns are delivered. */
  readonly directory: string
  /** Owns the startup deliveries (one fiber per session with owed results). */
  readonly scope: Scope.Scope
}

/**
 * After the DAG wake (5), which claims a boundary first, and before goal
 * continuation (10): a goal evaluation must not start a turn of its own while a
 * child result is about to.
 */
const PRIORITY = 8

// A report back to a parent keeps the turn's tool budget, like every internal follow-up.
const OPTIONS: AdmissionOptions = { continueToolBudget: true }

const originOf = (runID: string): TurnOrigin => ({ kind: "inbox", source: "child.result", key: runID })

const outcomeOf = (row: Store.RunRow): ChildRunOutcome =>
  Store.parseOutcome(row.outcome) ?? { type: "interrupted", reason: "unknown" }

const softly = (label: string, fields: Record<string, unknown>) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.logWarning(label, { ...fields, cause: Cause.pretty(cause) }),
  )

interface Ctx extends Deps {
  /** Canonical directory of the instance: what a parent session's directory must equal. */
  readonly here: string
}

/**
 * Delivers one owed result. True when this call wrote it; false when another
 * delivery already had (the mark found the row reported). Fresh results try
 * the fenced `join_or_start` admission first and fall back to a transcript
 * write when an ESC overtook it.
 */
const deliver = (ctx: Ctx, parent: Store.ParentSession, row: Store.RunRow, claimEpoch: number) =>
  Effect.gen(function* () {
    const parentSessionID = SessionID.make(row.parent_session_id)
    const outcome = outcomeOf(row)
    const report = Registry.reportOf(row.id)
    // Fresh: it ended in this process and no ESC has come in since. A result of a lost run is never fresh:
    // nobody is waiting for it, and the process that could have started a turn for it is gone.
    const fresh =
      outcome.type !== "interrupted" &&
      report !== undefined &&
      report.epoch === SessionCancellation.epoch(parentSessionID)
    const now = yield* Clock.currentTimeMillis
    // The mark rides the transaction that commits the message: of two deliveries racing for one row, the
    // second finds it reported, fails here and rolls its message back.
    const mark = Effect.suspend(() => Store.markReported(ctx.db, row.id, now)).pipe(
      Effect.flatMap((won) => (won ? Effect.void : Effect.fail(new Error(`child run ${row.id} is already reported`)))),
    )
    const input = {
      sessionID: parentSessionID,
      ...(parent.agent ? { agent: parent.agent } : {}),
      parts: [
        {
          type: "text" as const,
          synthetic: true,
          text: ChildNotice.resultNotice({
            childSessionID: SessionID.make(row.child_session_id),
            outcome,
            report: Store.parseReport(row.outcome),
          }),
        },
      ],
    }
    const origin = originOf(row.id)
    // The recipient may itself be a child session (a subagent's background
    // task reports back to it); carry its live credential so the admission
    // guard does not refuse a legitimate result delivery.
    const credential = Registry.credentialOf(parentSessionID)
    if (fresh) {
      const fenced = yield* admitNowUnderFence(ctx.prompts, input, OPTIONS, mark, claimEpoch, origin, credential)
      if (fenced.tag === "admitted") return true
      // An ESC landed after the claim. Nothing was committed; the result still belongs in the transcript.
    }
    yield* ctx.prompts.admit({ ...input, noReply: true }, OPTIONS, mark, { origin, ...(credential ? { credential } : {}) })
    return true
  }).pipe(
    // The mark found the row reported (or the transaction failed for another reason): the row decides.
    Effect.catchTag("SessionPromptAdmissionPersistFailed", (failure) =>
      Store.runOf(ctx.db, row.id).pipe(
        Effect.flatMap((current) =>
          Option.isNone(current) || current.value.reported_at !== null ? Effect.succeed(false) : Effect.fail(failure),
        ),
      ),
    ),
  )

/**
 * Builds and registers the source in this instance's inbox, then delivers what
 * earlier processes left owed. Returns nothing: the source lives with the
 * instance's inbox, and the startup deliveries with `deps.scope`.
 */
export const make = Effect.fn("ChildResults.make")(function* (deps: Deps) {
  const here = DagLocation.canonicalDirectory(deps.directory)
  const ctx: Ctx = { ...deps, here }
  // Sessions a scan found owed. After a restart no report exists in memory, so the hint would say no.
  const pending = new Set<SessionID>()

  const claim: InboxSource["claim"] = (sessionID, claimCtx) =>
    Effect.gen(function* () {
      pending.delete(sessionID)
      // Idle events are store-global: only the instance whose directory owns the session delivers into it.
      const parent = yield* Store.parentOf(ctx.db, sessionID)
      if (!parent || DagLocation.canonicalDirectory(parent.directory) !== ctx.here) return false
      let delivered = false
      for (const row of yield* Store.unreportedOf(ctx.db, sessionID)) {
        const wrote = yield* deliver(ctx, parent, row, claimCtx.claimEpoch)
        Registry.dropReport(row.id)
        delivered = wrote || delivered
      }
      return delivered
    })

  yield* deps.inbox.register({
    id: "child.result",
    priority: PRIORITY,
    mode: "join_or_start",
    // In memory and exact enough: a fresh result of this instance, or a session a scan found owed. Anything
    // else waits for the tick, which forces the claim.
    hint: (sessionID) => pending.has(sessionID) || Registry.hasReport(sessionID, here),
    scan: (scanCtx) => Store.unreportedParents(ctx.db, scanCtx.directory),
    claim,
  })

  const owed = yield* Store.unreportedParents(ctx.db, deps.directory).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning("child result startup scan failed", {
            directory: deps.directory,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as<SessionID[]>([])),
    ),
  )
  for (const sessionID of owed) {
    pending.add(sessionID)
    yield* deps.inbox
      .drain(sessionID)
      .pipe(
        softly("child result startup delivery failed", { sessionID }),
        Effect.forkIn(deps.scope, { startImmediately: true }),
        Effect.asVoid,
      )
  }
})

/**
 * Per-instance wiring, called from instance bootstrap after child-run
 * recovery: resolves the admission port from the app layer (it is not a
 * dependency of the bootstrap layer, like the goal loop) and registers the
 * source. Skipped where the app layer is absent (standalone graphs).
 */
export const init = Effect.fn("ChildResults.init")(function* (input: {
  readonly inbox: Deps["inbox"]
  readonly database: Database.Interface
  readonly scope: Scope.Scope
}) {
  const instance = yield* InstanceRef
  if (!instance) return
  // Lazy for the same reason the inbox's `submit` is: `prompt.ts` pulls the whole engine.
  const { SessionPrompt } = yield* Effect.promise(() => import("../prompt"))
  const prompts = Option.getOrUndefined(yield* Effect.serviceOption(SessionPrompt.Service))
  if (!prompts) return
  yield* make({
    db: input.database.db,
    inbox: input.inbox,
    prompts,
    directory: instance.directory,
    scope: input.scope,
  })
})

export * as ChildResults from "./result-source"
