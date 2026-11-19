// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable loop state (#1329): the model of one loop, and the only code that
 * writes it.
 *
 * A loop replaces the goal: one per root session, started from the user's own
 * words, advanced round by round, each round prompted from a background
 * analysis (#1328). This module is the state layer of that. It does not drive
 * anything: no idle handling, no dispatch, no stop decisions. The runtime that
 * does is built on top of it and is not wired in yet; the goal system still
 * runs unchanged beside it.
 *
 * Alive loops (`active`, `waiting`, `stopped`) sit in `loop_state`, one row per
 * session. A loop that ends (`completed`, `cancelled`) leaves a terminal
 * snapshot in `loop_outcome` and its row is deleted in the same transaction.
 * Committed analyses are appended to `loop_analysis`.
 *
 * `transition` is the single write entrance and the only function here that
 * touches the tables, in the shape ADR-0001 gives the goal system: one immediate
 * transaction reads the row, decides from it and writes or deletes before the
 * write lock is released, and every event is published after the commit inside
 * the same uninterruptible region, so durable state always leads what clients
 * see. The operations of `Interface` are the decisions; `admit` is what the
 * entrance enforces on every save whatever the decision: each write advances
 * `revision` by exactly one, `origin` (the user's first description, and the
 * first analysis once committed) never changes, and a live loop is replaced
 * only together with its own terminal snapshot, so no loop vanishes without an
 * outcome.
 *
 * Operations take the identity the caller observed (`Expected`). A write whose
 * identity no longer matches is a no-op that returns `undefined` and publishes
 * nothing, which is what keeps a delayed analysis or dispatch from touching a
 * loop that was stopped, replaced or advanced in the meantime. `undefined` in
 * place of an identity applies to whatever loop is current, for user commands.
 *
 * Not here yet, by design: lifecycle mirroring and the exclusive-automation
 * registration join with the switch-over, when the lifecycle vocabulary and the
 * runtime change.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { asc, desc, eq, max } from "drizzle-orm"
import { isDeepEqual } from "remeda"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { LoopAnalysisTable, LoopOutcomeTable, LoopStateTable } from "@graphagent/core/loop/sql"
import { LoopIntent, LoopProgress, LoopVerdict } from "@graphagent/schema/loop"
import type { LoopAnalysisResult } from "@graphagent/schema/loop"
import { NonNegativeInt, PositiveInt } from "@graphagent/schema/schema"
import { SessionLoop } from "@graphagent/schema/session-loop"
import type { Stop } from "@graphagent/schema/stop-reason"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { SessionID } from "@/session/schema"

/** Round limit of a loop whose creator gave none. */
export const DEFAULT_MAX_ROUNDS = 20

export const Status = SessionLoop.Status
export type Status = typeof Status.Type

/** The states a `loop_state` row can hold. */
export const AliveStatus = Schema.Literals(["active", "waiting", "stopped"])
export type AliveStatus = typeof AliveStatus.Type

/** The states of a terminal snapshot in `loop_outcome`. */
export const TerminalStatus = SessionLoop.TerminalStatus
export type TerminalStatus = typeof TerminalStatus.Type

export const WaitSource = SessionLoop.WaitSource
export type WaitSource = typeof WaitSource.Type

/**
 * The identity of the awaited object (#1069 P7). `pr_watch` names a durable PR
 * or MR watch, `job` a background job.
 */
export const WaitRef = Schema.Struct({
  domain: Schema.Literals(["job", "pr_watch"]),
  id: Schema.String,
})
export type WaitRef = typeof WaitRef.Type

/** The external object the loop waits for (#1067, #1069), plus whether the review that follows its expiry already ran. */
export const Wait = Schema.Struct({
  source: WaitSource,
  wait_id: Schema.String,
  ref: Schema.optional(WaitRef),
  deadline: Schema.Number,
  max_wakes: NonNegativeInt,
  wakes: NonNegativeInt,
  payload: Schema.optional(Schema.String),
  /** The review round that follows an expired wait has been dispatched (#1067). */
  reviewed: Schema.Boolean,
})
export type Wait = typeof Wait.Type

/**
 * What the agent declared in the turn of the current boundary. The awaited
 * object of an `await` is the top-level `wait`. The declaration is valid on that
 * one boundary only: whoever finishes the boundary clears it.
 */
export const Declaration = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("await") }),
  Schema.Struct({ kind: Schema.Literal("done"), evidence: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("blocked"), reason: Schema.String }),
])
export type Declaration = typeof Declaration.Type

/** Where the loop came from. Frozen once written: the first description, and the first analysis once committed. */
export const Origin = Schema.Struct({
  /** The user's own words, verbatim. */
  prompt: Schema.String,
  /** The human message that started the loop. Absent for a migrated loop. */
  message_id: Schema.optional(Schema.String),
  created_at: Schema.Number,
  /** The first committed analysis, frozen. */
  analysis: Schema.optional(LoopIntent),
  analysis_at: Schema.optional(Schema.Number),
})
export type Origin = typeof Origin.Type

/** A background analysis is in flight for this boundary. */
export const Analyzing = Schema.Struct({
  boundary: Schema.String,
  started_at: Schema.Number,
})
export type Analyzing = typeof Analyzing.Type

/**
 * The failure chain being healed (#892, #1327). The counts are the
 * `StopCondition.Chain` the next decision is made with: `attempts` retry
 * dispatches, `reset` reasoning-state resets, `probes` delayed probes.
 * `probe_at` is the due time of the pending probe; a waiting loop that has it
 * and no `wait` is waiting for a provider to come back.
 */
export const Recovery = Schema.Struct({
  attempts: NonNegativeInt,
  reset: NonNegativeInt,
  probes: NonNegativeInt,
  probe_at: Schema.optional(Schema.Number),
  /** The assistant message the chain started at (diagnostics and audit). */
  boundary: Schema.String,
})
export type Recovery = typeof Recovery.Type

export const StopRecord = SessionLoop.StopRecord
export type StopRecord = typeof StopRecord.Type

export class Info extends Schema.Class<Info>("LoopState")({
  loop_id: Schema.String,
  /** Starts at 0 and advances by exactly one on every write. */
  revision: NonNegativeInt,
  status: Status,
  origin: Origin,
  /** The latest committed intent. */
  intent: Schema.optional(LoopIntent),
  /** 0 before the first analysis, 1 once it is committed, plus one per later change. */
  intent_revision: NonNegativeInt,
  progress: Schema.optional(LoopProgress),
  /** The prompt the next round is built from. Present only while a `continue` analysis awaits dispatch. */
  next_prompt: Schema.optional(Schema.String),
  /** Counted from 1: the first round is the user's own message. */
  round: PositiveInt,
  max_rounds: PositiveInt,
  /** Consecutive analyses after a counted round that found no progress. */
  no_progress_streak: NonNegativeInt,
  declaration: Schema.optional(Declaration),
  wait: Schema.optional(Wait),
  analyzing: Schema.optional(Analyzing),
  /** The assistant message of the boundary the last committed analysis ran at. */
  last_analyzed_msg: Schema.optional(Schema.String),
  last_verdict: Schema.optional(LoopVerdict),
  last_reason: Schema.optional(Schema.String),
  recovery: Schema.optional(Recovery),
  stop: Schema.optional(StopRecord),
}) {}

/** A state change: any field but identity and revision, which `advance` owns. */
export type Patch = Partial<Omit<Info, "loop_id" | "revision">>

/** What `update` may change: not `origin`, and only live states (an end goes through `end`). */
export type UpdatePatch = Omit<Patch, "origin" | "status"> & { readonly status?: AliveStatus }

export const isAlive = (status: Status): status is AliveStatus => status !== "completed" && status !== "cancelled"

export const isTerminal = (status: Status): status is TerminalStatus => !isAlive(status)

/** The next revision of `state` with `patch` applied. Identity and revision are never taken from the patch. */
export function advance(state: Info, patch: Patch) {
  // oxlint-disable-next-line typescript-eslint/no-misused-spread -- Info is fields only: no methods or private state to lose.
  return new Info({ ...state, ...patch, loop_id: state.loop_id, revision: state.revision + 1 })
}

/** The identity a delayed decision was made against. */
export interface Expected {
  readonly loopID: string
  readonly revision: number
}

export const expected = (state: Info): Expected => ({ loopID: state.loop_id, revision: state.revision })

const matches = (state: Info, fence: Expected | undefined) =>
  fence === undefined || (state.loop_id === fence.loopID && state.revision === fence.revision)

/** A stop decision with its clock stamped, ready to persist (`StopCondition` does not own a clock). */
export function stopRecord(stop: Stop, at: number = Date.now()): StopRecord {
  return { ...stop, at }
}

export interface CreateInput {
  /** The user's own words, stored verbatim (not trimmed). */
  readonly prompt: string
  /** The human message that started the loop. */
  readonly messageID?: string
  /** Defaults to `DEFAULT_MAX_ROUNDS`. */
  readonly maxRounds?: number
}

/** A new loop: active, round 1, revision 0. */
export function initial(input: CreateInput, now: number = Date.now()) {
  return new Info({
    loop_id: Bun.randomUUIDv7(),
    revision: 0,
    status: "active",
    origin: {
      prompt: input.prompt,
      ...(input.messageID !== undefined ? { message_id: input.messageID } : {}),
      created_at: now,
    },
    intent_revision: 0,
    round: 1,
    max_rounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS,
    no_progress_streak: 0,
  })
}

/** The state as events and the read endpoint carry it. */
export function toPublic(state: Info): SessionLoop.Info {
  return {
    loopID: state.loop_id,
    status: state.status,
    round: state.round,
    maxRounds: state.max_rounds,
    prompt: state.origin.prompt,
    ...(state.intent !== undefined ? { objective: state.intent.objective } : {}),
    analyzing: state.analyzing !== undefined,
    ...(state.recovery?.probe_at !== undefined ? { probeAt: state.recovery.probe_at } : {}),
    ...(state.wait !== undefined ? { wait: { source: state.wait.source, deadline: state.wait.deadline } } : {}),
    intentRevision: state.intent_revision,
    ...(state.last_verdict !== undefined ? { lastVerdict: state.last_verdict } : {}),
    ...(state.last_reason !== undefined ? { lastReason: state.last_reason } : {}),
    ...(state.stop !== undefined ? { stop: state.stop } : {}),
  }
}

export interface Created {
  readonly state: Info
  /** The terminal snapshot of the live loop this one replaced, when there was one. */
  readonly replaced?: Info
}

/** One committed analysis. */
export interface Commit {
  /** The assistant message the analysis ran at; becomes `last_analyzed_msg`. */
  readonly boundary: string
  readonly result: LoopAnalysisResult
  readonly usage: { readonly input: number; readonly output: number; readonly reasoning: number }
  readonly elapsedMs: number
  /** The streak after this commit; the stored one stays when omitted. */
  readonly noProgressStreak?: number
}

export interface End {
  readonly status: TerminalStatus
  /** Defaults to the record the loop already carries; a loop without one needs this. */
  readonly stop?: StopRecord
}

/** A row of `loop_analysis`. */
export type AnalysisRow = typeof LoopAnalysisTable.$inferSelect

type NewAnalysis = Omit<AnalysisRow, "seq">

export interface Interface {
  readonly load: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  /** The snapshot of the most recently ended loop of the session. */
  readonly lastOutcome: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  /** The committed analyses of a loop, oldest first. */
  readonly analyses: (loopID: string) => Effect.Effect<ReadonlyArray<AnalysisRow>>
  /**
   * Starts a loop. A live loop of the session, `stopped` included, ends as
   * `cancelled` with the stop reason `goal_changed` (`explicit`) in the same
   * transaction and is returned as `replaced`.
   */
  readonly create: (sessionID: SessionID, input: CreateInput) => Effect.Effect<Created>
  /** Applies `patch` to the live loop; resolves to the new state, or `undefined` when there is no match. */
  readonly update: (
    sessionID: SessionID,
    expected: Expected | undefined,
    patch: UpdatePatch,
  ) => Effect.Effect<Info | undefined>
  /**
   * Commits a background analysis: the intent, progress, next prompt and verdict
   * land in the state, `analyzing` is cleared, and one `loop_analysis` row is
   * appended, all in one transaction. The first commit also freezes
   * `origin.analysis`. `intent_revision` becomes 1 on the first commit and grows
   * by one whenever the analysis reports an intent change.
   */
  readonly commitAnalysis: (sessionID: SessionID, expected: Expected, commit: Commit) => Effect.Effect<Info | undefined>
  /**
   * Ends the loop: writes the terminal snapshot to `loop_outcome` and deletes
   * the `loop_state` row in one transaction, then publishes `loop.updated` with
   * the terminal state followed by `loop.cleared`. Resolves to the snapshot.
   */
  readonly end: (sessionID: SessionID, expected: Expected | undefined, input: End) => Effect.Effect<Info | undefined>
  /** Session removal: drops the row, every outcome and every analysis of the session. */
  readonly purgeSession: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/LoopState") {}

type Transition<A> =
  | { readonly tag: "noop"; readonly value: A }
  | {
      readonly tag: "save"
      readonly state: Info
      /** Appended to `loop_analysis` in the same transaction. */
      readonly analysis?: NewAnalysis
      /** The live loop this write replaces, as a terminal snapshot for `loop_outcome`. */
      readonly ended?: Info
      readonly value: A
    }
  | {
      readonly tag: "delete"
      readonly terminal?: Info
      /** Also drop every outcome and analysis of the session (session removal, not an end). */
      readonly purge?: boolean
      readonly value: A
    }

/**
 * The invariants the writer enforces on every save, as a pure check: `previous`
 * is the live row being written over, `state` the row to write, `ended` the
 * terminal snapshot of the loop it replaces. Throws when one is broken, which
 * rolls the transaction back.
 *
 * - `loop_state` holds live loops only.
 * - A loop's next write has the next revision, and `origin` stays as it was:
 *   the first description always, the first analysis once it is committed.
 * - A new loop starts at revision 0, and a live loop is replaced only together
 *   with the terminal snapshot of that loop, stop record included.
 */
export function admit(previous: Info | undefined, state: Info, ended?: Info) {
  if (!isAlive(state.status)) throw new Error(`loop_state holds live loops only, not ${state.status}`)
  if (previous?.loop_id === state.loop_id) {
    if (ended) throw new Error("a continuing loop is not ended in the same write")
    if (state.revision !== previous.revision + 1)
      throw new Error(`loop revision must advance by one, ${previous.revision} to ${state.revision}`)
    const was = previous.origin
    const now = state.origin
    if (
      was.prompt !== now.prompt ||
      was.message_id !== now.message_id ||
      was.created_at !== now.created_at ||
      (was.analysis !== undefined && (!isDeepEqual(was.analysis, now.analysis) || was.analysis_at !== now.analysis_at))
    )
      throw new Error("loop origin is frozen once written")
    return
  }
  if (state.revision !== 0) throw new Error(`a new loop starts at revision 0, not ${state.revision}`)
  if (!previous) {
    if (ended) throw new Error("there is no live loop to end")
    return
  }
  if (!ended || ended.loop_id !== previous.loop_id || !isTerminal(ended.status) || ended.stop === undefined)
    throw new Error("replacing a live loop needs the terminal snapshot of the old one, with its stop record")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service
    type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

    const publish = (sessionID: SessionID, state: Info) =>
      events.publish(SessionLoop.Event.Updated, { sessionID, loop: toPublic(state) })

    const publishCleared = (sessionID: SessionID, terminal?: Info) =>
      events.publish(SessionLoop.Event.Cleared, {
        sessionID,
        ...(terminal !== undefined && isTerminal(terminal.status) ? { status: terminal.status } : {}),
        ...(terminal?.stop !== undefined ? { stop: terminal.stop } : {}),
      })

    const encode = (state: Info) => JSON.stringify(Schema.encodeSync(Info)(state))

    // An undecodable loop_state row (corruption, or a payload from a newer
    // build) must not make every reader die: a delete treats it as "no loop" and
    // logs, any other mutation fails rather than overwrite what this build
    // cannot read. `load` stays strict.
    const decodePayload = (payload: string) => {
      try {
        return { ok: true as const, state: Schema.decodeUnknownSync(Info)(JSON.parse(payload)) }
      } catch (error) {
        return { ok: false as const, error }
      }
    }

    const writeOutcome = (tx: Tx, sessionID: SessionID, terminal: Info) => {
      const payload = encode(terminal)
      const completed_at = Date.now()
      return tx
        .insert(LoopOutcomeTable)
        .values({ loop_id: terminal.loop_id, session_id: sessionID, payload, completed_at })
        .onConflictDoUpdate({ target: LoopOutcomeTable.loop_id, set: { payload, completed_at } })
        .run()
    }

    // The only durable loop mutation seam. The immediate transaction makes the
    // read, the decision and the write or delete one serializable transition, so
    // a stale decision cannot overwrite a concurrent stop or resurrect a row
    // that an end removed. Events are published after the commit inside the same
    // uninterruptible region: durable state always leads presentation state.
    const transition = <A>(sessionID: SessionID, decide: (state: Info | undefined) => Transition<A>) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          // A delete on a session with no row is a no-op and must not publish
          // loop.cleared: that event is the contract for a real removal.
          let deletedRow = false
          const result = yield* db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  const row = yield* tx
                    .select()
                    .from(LoopStateTable)
                    .where(eq(LoopStateTable.session_id, sessionID))
                    .get()
                  const decoded = row ? decodePayload(row.payload) : undefined
                  const next = decide(decoded?.ok ? decoded.state : undefined)
                  if (decoded && !decoded.ok) {
                    if (next.tag !== "delete") throw decoded.error
                    yield* Effect.logWarning(`loop transition deleting undecodable loop_state row for ${sessionID}`, {
                      error: String(decoded.error),
                    })
                  }
                  if (next.tag === "save") {
                    admit(decoded?.ok ? decoded.state : undefined, next.state, next.ended)
                    if (next.ended) yield* writeOutcome(tx, sessionID, next.ended)
                    const payload = encode(next.state)
                    if (row) {
                      yield* tx
                        .update(LoopStateTable)
                        .set({ payload, updated_at: Math.max(Date.now(), row.updated_at + 1) })
                        .where(eq(LoopStateTable.session_id, sessionID))
                        .run()
                    } else {
                      yield* tx
                        .insert(LoopStateTable)
                        .values({ session_id: sessionID, payload, updated_at: Date.now() })
                        .run()
                    }
                    if (next.analysis) {
                      const last = yield* tx
                        .select({ seq: max(LoopAnalysisTable.seq) })
                        .from(LoopAnalysisTable)
                        .where(eq(LoopAnalysisTable.loop_id, next.analysis.loop_id))
                        .get()
                      yield* tx
                        .insert(LoopAnalysisTable)
                        .values({ ...next.analysis, seq: (last?.seq ?? 0) + 1 })
                        .run()
                    }
                  }
                  if (next.tag === "delete" && row) {
                    deletedRow = true
                    if (next.terminal) yield* writeOutcome(tx, sessionID, next.terminal)
                    yield* tx.delete(LoopStateTable).where(eq(LoopStateTable.session_id, sessionID)).run()
                  }
                  if (next.tag === "delete" && next.purge) {
                    yield* tx.delete(LoopOutcomeTable).where(eq(LoopOutcomeTable.session_id, sessionID)).run()
                    yield* tx.delete(LoopAnalysisTable).where(eq(LoopAnalysisTable.session_id, sessionID)).run()
                  }
                  return next
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
          if (result.tag === "save") {
            if (result.ended) {
              yield* publish(sessionID, result.ended)
              yield* publishCleared(sessionID, result.ended)
            }
            yield* publish(sessionID, result.state)
          }
          if (result.tag === "delete" && deletedRow) {
            if (result.terminal) yield* publish(sessionID, result.terminal)
            yield* publishCleared(sessionID, result.terminal)
          }
          return result.value
        }),
      )

    const load = Effect.fn("LoopState.load")(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(LoopStateTable)
        .where(eq(LoopStateTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row ? Schema.decodeUnknownSync(Info)(JSON.parse(row.payload)) : undefined
    })

    const lastOutcome = Effect.fn("LoopState.lastOutcome")(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(LoopOutcomeTable)
        .where(eq(LoopOutcomeTable.session_id, sessionID))
        .orderBy(desc(LoopOutcomeTable.completed_at))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return row ? Schema.decodeUnknownSync(Info)(JSON.parse(row.payload)) : undefined
    })

    const analyses = Effect.fn("LoopState.analyses")(function* (loopID: string) {
      return yield* db
        .select()
        .from(LoopAnalysisTable)
        .where(eq(LoopAnalysisTable.loop_id, loopID))
        .orderBy(asc(LoopAnalysisTable.seq))
        .all()
        .pipe(Effect.orDie)
    })

    const create = Effect.fn("LoopState.create")(function* (sessionID: SessionID, input: CreateInput) {
      const now = Date.now()
      const state = initial(input, now)
      return yield* transition<Created>(sessionID, (previous) => {
        if (!previous) return { tag: "save", state, value: { state } }
        const replaced = advance(previous, {
          status: "cancelled",
          analyzing: undefined,
          stop: stopRecord({ reason: "goal_changed", detail: { code: "explicit" } }, now),
        })
        return { tag: "save", state, ended: replaced, value: { state, replaced } }
      })
    })

    const update = Effect.fn("LoopState.update")(function* (
      sessionID: SessionID,
      fence: Expected | undefined,
      patch: UpdatePatch,
    ) {
      return yield* transition<Info | undefined>(sessionID, (state) => {
        if (!state || !matches(state, fence)) return { tag: "noop", value: undefined }
        const next = advance(state, patch)
        return { tag: "save", state: next, value: next }
      })
    })

    const commitAnalysis = Effect.fn("LoopState.commitAnalysis")(function* (
      sessionID: SessionID,
      fence: Expected,
      commit: Commit,
    ) {
      return yield* transition<Info | undefined>(sessionID, (state) => {
        if (!state || !matches(state, fence)) return { tag: "noop", value: undefined }
        const now = Date.now()
        const { result, usage } = commit
        const first = state.origin.analysis === undefined
        const intent_revision =
          first || result.intent_change.changed ? state.intent_revision + 1 : state.intent_revision
        const next = advance(state, {
          origin: first ? { ...state.origin, analysis: result.intent, analysis_at: now } : state.origin,
          intent: result.intent,
          intent_revision,
          progress: result.progress,
          next_prompt: result.next_prompt,
          last_verdict: result.verdict,
          last_reason: result.reason,
          last_analyzed_msg: commit.boundary,
          analyzing: undefined,
          ...(commit.noProgressStreak !== undefined ? { no_progress_streak: commit.noProgressStreak } : {}),
        })
        return {
          tag: "save",
          state: next,
          analysis: {
            loop_id: state.loop_id,
            session_id: sessionID,
            round: state.round,
            boundary: commit.boundary,
            verdict: result.verdict,
            reason: result.reason,
            intent_revision,
            change_summary: result.intent_change.summary ?? null,
            change_basis_message_id: result.intent_change.basis_message_id ?? null,
            prompt: result.next_prompt ?? null,
            input_tokens: usage.input,
            output_tokens: usage.output,
            reasoning_tokens: usage.reasoning,
            elapsed_ms: commit.elapsedMs,
            created_at: now,
          },
          value: next,
        }
      })
    })

    const end = Effect.fn("LoopState.end")(function* (sessionID: SessionID, fence: Expected | undefined, input: End) {
      return yield* transition<Info | undefined>(sessionID, (state) => {
        if (!state || !matches(state, fence)) return { tag: "noop", value: undefined }
        const stop = input.stop ?? state.stop
        if (stop === undefined) throw new Error("a loop that ends needs a stop record")
        const terminal = advance(state, { status: input.status, stop, analyzing: undefined })
        return { tag: "delete", terminal, value: terminal }
      })
    })

    const purgeSession = Effect.fn("LoopState.purgeSession")(function* (sessionID: SessionID) {
      yield* transition<void>(sessionID, () => ({ tag: "delete", purge: true, value: undefined }))
    })

    return Service.of({ load, lastOutcome, analyses, create, update, commitAnalysis, end, purgeSession })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [EventV2Bridge.node, Database.node])

export * as LoopState from "./state"
