// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the recording admission stub narrows a hand-built message and an unstarted turn handle into the service contract

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { PrWatchTable } from "@graphagent/core/lifecycle/pr-watch.sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { PrWatchSource } from "@/pr-watch/source"
import { SessionCancellation } from "@/session/cancellation"
import { EngineProcess } from "@/session/engine-process"
import { SessionInbox, type InboxSource } from "@/session/inbox"
import type { Interface as PromptInterface, PromptInput } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { AdmissionPersistFailed } from "@/session/turn/prepare"
import type { AdmissionExtras, AdmissionOptions, TurnStart } from "@/session/turns"
import type { InstanceContext } from "@/project/instance-context"
import { testEffect } from "../lib/effect"

/**
 * #1071 PR3: the `pr_watch` inbox source. The rows are real (in-memory
 * database, foreign keys on); the admission port is a recording stub that
 * commits the delivery mark in a real transaction. Direct claims cover the
 * ledger; the last test drives the real inbox so the `turn_boundary` gate is
 * the production one.
 */

type Db = Database.Interface["db"]

const DIRECTORY = "/tmp/pr-watch-source"
const OTHER_DIRECTORY = "/tmp/pr-watch-source-other"

const unique = (name: string) => `${name}_${Math.random().toString(36).slice(2)}`

const seedSession = (db: Db, id: SessionID, directory = DIRECTORY) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_pr_watch_source"), worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.make("prj_pr_watch_source"),
        slug: "pr-watch-source",
        directory: AbsolutePath.make(directory),
        title: "pr watch source",
        agent: "build",
        version: "0",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const insertWatch = (db: Db, values: Partial<typeof PrWatchTable.$inferInsert> & { id: string; session_id: string }) =>
  db
    .insert(PrWatchTable)
    .values({
      forge: "github",
      host: "github.com",
      url: "https://github.com/acme/widgets/pull/42",
      repo: "acme/widgets",
      number: 42,
      head: "abc",
      baseline_review: "NONE",
      phase: "delivering",
      next_poll_at: null,
      deadline_at: 9_000_000_000_000,
      outcome: "success",
      delivery: null,
      process_id: null,
      created_at: 0,
      updated_at: 0,
      ...values,
    })
    .run()
    .pipe(Effect.orDie)

const rowOf = (db: Db, id: string) =>
  db.select().from(PrWatchTable).where(eq(PrWatchTable.id, id)).get().pipe(Effect.orDie)

interface AdmissionRecord {
  readonly input: PromptInput
  readonly options?: AdmissionOptions
  readonly extras?: AdmissionExtras
}

/** The recording admission port; `persistAdmission` runs inside one immediate transaction, like the real one. */
const recordingPrompts = (db: Db, options: { readonly barrier?: number; readonly failAfterMark?: boolean } = {}) =>
  Effect.gen(function* () {
    const admitted: AdmissionRecord[] = []
    let arrived = 0
    const released = Deferred.makeUnsafe<void>()
    const prompts: Pick<PromptInterface, "admit"> = {
      admit: (input, admissionOptions, persistAdmission, extras) =>
        Effect.gen(function* () {
          if (options.barrier !== undefined) {
            arrived += 1
            if (arrived >= options.barrier) Deferred.doneUnsafe(released, Effect.void)
            yield* Deferred.await(released)
          }
          if (persistAdmission)
            yield* db
              .transaction(
                () =>
                  options.failAfterMark
                    ? persistAdmission.pipe(Effect.andThen(Effect.fail(new Error("the message did not commit"))))
                    : persistAdmission,
                { behavior: "immediate" },
              )
              .pipe(Effect.mapError((cause) => new AdmissionPersistFailed({ cause: String(cause) })))
          admitted.push({ input, options: admissionOptions, extras })
          const message = {
            info: { id: MessageID.ascending(), sessionID: input.sessionID, role: "user", time: { created: 0 } },
            parts: [],
          } as unknown as SessionV1.WithParts
          return {
            admission: { kind: "started", turn: undefined as never },
            message,
            wait: Effect.succeed(message),
          } satisfies TurnStart
        }),
    }
    return { admitted, prompts }
  })

/** The source over the same database with a stub inbox that records registration and startup drains. */
const harness = (directory: string, prompts: Pick<PromptInterface, "admit">) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope
    let source: InboxSource | undefined
    const drains: SessionID[] = []
    yield* PrWatchSource.make({
      db,
      inbox: {
        register: (registered) =>
          Effect.sync(() => {
            source = registered
          }),
        drain: (sessionID) =>
          Effect.sync(() => {
            drains.push(sessionID)
          }),
      },
      prompts,
      directory,
      scope,
    })
    const claim = (sessionID: SessionID, claimEpoch?: number) => {
      if (!source) throw new Error("the pr_watch source was not registered")
      return source.claim(sessionID, { directory, claimEpoch: claimEpoch ?? SessionCancellation.epoch(sessionID) })
    }
    return { db, drains, claim, source: () => source }
  })

describe("pr_watch source", () => {
  const it = testEffect(Database.layerFromPath(":memory:"))

  it.effect("delivers one owed notice at the idle boundary, marks the row and never repeats", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(unique("ses_prw_deliver"))
      yield* seedSession(db, sessionID)
      yield* insertWatch(db, { id: "watch_success", session_id: sessionID })
      const recording = yield* recordingPrompts(db)
      const source = yield* harness(DIRECTORY, recording.prompts)

      expect(yield* source.claim(sessionID)).toBe(true)
      expect(recording.admitted).toHaveLength(1)
      const admitted = recording.admitted[0]
      expect(admitted.input.parts).toMatchObject([{ type: "text", synthetic: true }])
      expect(admitted.input.parts[0].type === "text" ? admitted.input.parts[0].text : "").toContain(
        "watch_pr checks passed for https://github.com/acme/widgets/pull/42",
      )
      // A notice never joins a running turn: the admission asks for the idle
      // boundary under the claim-time cancellation fence.
      expect(admitted.extras).toMatchObject({
        when: "idle",
        origin: { kind: "inbox", source: "pr_watch", key: "watch_success:success:abc" },
      })
      expect(admitted.options).toEqual({ continueToolBudget: true })
      expect((yield* rowOf(db, "watch_success"))?.delivery).toBe("watch_success:success:abc")

      // The durable mark is the delivery's identity: a second claim writes nothing.
      expect(yield* source.claim(sessionID)).toBe(false)
      expect(recording.admitted).toHaveLength(1)
    }),
  )

  it.effect("a startup scan finds an owed row and drains its session", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(unique("ses_prw_restart"))
      yield* seedSession(db, sessionID)
      // The row survived a crash: nobody delivered it, and the process that
      // observed it is gone.
      yield* insertWatch(db, { id: "watch_restart", session_id: sessionID })
      const recording = yield* recordingPrompts(db)
      const source = yield* harness(DIRECTORY, recording.prompts)

      expect(source.drains).toEqual([sessionID])
      expect(yield* source.claim(sessionID)).toBe(true)
      expect(recording.admitted).toHaveLength(1)
      expect((yield* rowOf(db, "watch_restart"))?.delivery).toBe("watch_restart:success:abc")
    }),
  )

  it.effect("two claims racing for one owed row keep exactly one message", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(unique("ses_prw_race"))
      yield* seedSession(db, sessionID)
      yield* insertWatch(db, { id: "watch_race", session_id: sessionID })
      const recording = yield* recordingPrompts(db, { barrier: 2 })
      const source = yield* harness(DIRECTORY, recording.prompts)

      const results = yield* Effect.forEach([1, 2], () => source.claim(sessionID), { concurrency: "unbounded" })
      expect(results.filter((won) => won)).toHaveLength(1)
      expect(results.filter((won) => !won)).toHaveLength(1)
      expect(recording.admitted).toHaveLength(1)
      expect((yield* rowOf(db, "watch_race"))?.delivery).toBe("watch_race:success:abc")
    }),
  )

  it.effect("ignores rows that belong to another directory or are not deliverable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(unique("ses_prw_filter"))
      const foreign = SessionID.make(unique("ses_prw_foreign"))
      yield* seedSession(db, sessionID, OTHER_DIRECTORY)
      yield* seedSession(db, foreign, DIRECTORY)
      // Owned by another instance: not delivered here.
      yield* insertWatch(db, { id: "watch_foreign", session_id: sessionID })
      const recording = yield* recordingPrompts(db)
      const source = yield* harness(DIRECTORY, recording.prompts)

      expect(yield* source.claim(sessionID)).toBe(false)
      expect(recording.admitted).toHaveLength(0)

      // A watching row is still polling; only `delivering` is owed.
      yield* insertWatch(db, { id: "watch_watching", session_id: foreign, phase: "watching", outcome: null })
      expect(yield* source.claim(foreign)).toBe(false)
      expect(recording.admitted).toHaveLength(0)
    }),
  )

  it.effect("a failed message write leaves the row owed for the next claim", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(unique("ses_prw_fail"))
      yield* seedSession(db, sessionID)
      yield* insertWatch(db, { id: "watch_fail", session_id: sessionID })
      const recording = yield* recordingPrompts(db, { failAfterMark: true })
      const source = yield* harness(DIRECTORY, recording.prompts)

      const failure = yield* Effect.flip(source.claim(sessionID))
      expect(failure).toBeDefined()
      // The mark rolled back with the message: the notice is still owed.
      expect((yield* rowOf(db, "watch_fail"))?.delivery).toBeNull()
    }),
  )
})

describe("pr_watch delivery boundary", () => {
  // The real inbox owns the idle subscription and the turn_boundary gate; the
  // source is the production one, with the recording admission port.
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const inboxLayer = SessionInbox.layer.pipe(Layer.provideMerge(bridge), Layer.provideMerge(status))
  const it = testEffect(Layer.mergeAll(database, inboxLayer))

  // `it.effect` runs under TestClock (the tick needs it) and has no ambient
  // instance, so the test supplies one.
  const boundaryContext: InstanceContext = {
    directory: DIRECTORY,
    worktree: DIRECTORY,
    root: DIRECTORY,
    project: {
      id: Project.ID.global,
      worktree: DIRECTORY,
      time: { created: 0, updated: 0 },
      sandboxes: [],
    },
  }

  /** Let TestClock-resumed and forked fibers run. */
  const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true })

  const until = (done: Effect.Effect<boolean>, message: string) =>
    Effect.gen(function* () {
      for (let turns = 0; turns < 500; turns++) {
        if (yield* done) return
        yield* Effect.yieldNow
      }
      yield* Effect.fail(new Error(message))
    })

  it.effect("a notice produced mid-turn is delivered once, at the turn's end", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const sessionStatus = yield* SessionStatus.Service
      const { db } = yield* Database.Service
      const directory = DIRECTORY
      const sessionID = SessionID.descending()
      yield* seedSession(db, sessionID, directory)
      const recording = yield* recordingPrompts(db)
      yield* PrWatchSource.make({ db, inbox, prompts: recording.prompts, directory, scope: yield* Scope.Scope })
      yield* inbox.init()

      // The poller observes an outcome mid-turn: the durable row plus the live
      // marker it leaves behind.
      yield* sessionStatus.set(sessionID, { type: "busy" })
      yield* insertWatch(db, { id: "watch_turn", session_id: sessionID })
      EngineProcess.prWatch.watches.set("watch_turn", { phase: "delivering", sessionID, observedAt: 0 })

      // Neither a nudge-driven drain nor the forced tick injects into the turn.
      yield* inbox.drain(sessionID)
      yield* TestClock.adjust("30 seconds")
      yield* settle
      expect(recording.admitted).toHaveLength(0)

      // The turn ends: the idle event is the delivery boundary.
      yield* sessionStatus.set(sessionID, { type: "idle" })
      yield* until(
        Effect.sync(() => recording.admitted.length === 1),
        "the idle boundary did not deliver the notice",
      )
      expect(recording.admitted).toHaveLength(1)
      expect((yield* rowOf(db, "watch_turn"))?.delivery).toBe("watch_turn:success:abc")
      expect(EngineProcess.prWatch.watches.has("watch_turn")).toBe(false)

      // Exactly once: a later drain and tick find nothing owed.
      yield* inbox.drain(sessionID)
      yield* TestClock.adjust("30 seconds")
      yield* settle
      expect(recording.admitted).toHaveLength(1)
    }).pipe(Effect.provideService(InstanceRef, boundaryContext)),
  )
})