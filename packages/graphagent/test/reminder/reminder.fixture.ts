// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the recording admission stub narrows a hand-built message and an unstarted turn handle into the service contract

import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { ReminderTable } from "@graphagent/core/lifecycle/reminder.sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { LifecycleEvent } from "@graphagent/schema/lifecycle-event"
import { eq } from "drizzle-orm"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Context, Deferred, Effect, Layer, Ref, Scope, Stream } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Lifecycle } from "@/lifecycle/service"
import { ReminderClock } from "@/reminder/clock"
import { ReminderSource } from "@/reminder/source"
import { SessionCancellation } from "@/session/cancellation"
import { EngineProcess } from "@/session/engine-process"
import type { InboxSource } from "@/session/inbox"
import type { Interface as PromptInterface, PromptInput } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { AdmissionPersistFailed } from "@/session/turn/prepare"
import type { AdmissionExtras, AdmissionOptions, TurnStart } from "@/session/turns"

/**
 * Shared fixtures of the #1072 reminder tests: a real in-memory database with
 * foreign keys on, the real lifecycle service on the real event bus, and the
 * helpers every file needs to seed sessions and rows, watch lifecycle edges,
 * and build one clock per test in its own scope.
 */

export const DIRECTORY = "/tmp/reminder-tests"

export const database = Database.layerFromPath(":memory:")
export const events = EventV2.layer.pipe(Layer.provide(database))
export const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
export const lifecycle = Lifecycle.layer.pipe(Layer.provide(bridge))
export const base = Layer.mergeAll(database, events, bridge, lifecycle)

export const unique = (name: string) => `${name}_${Math.random().toString(36).slice(2)}`

export const seedSession = (id: string, directory = DIRECTORY) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionID.make(id),
        project_id: Project.ID.global,
        slug: id,
        directory: AbsolutePath.make(directory),
        title: id,
        agent: "build",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    return SessionID.make(id)
  })

/** Inserts a reminder row as an earlier process, or the clock, would have left it. */
export const insertReminder = (row: Partial<typeof ReminderTable.$inferInsert> & { id: string; session_id: string }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ReminderTable)
      .values({
        text: "check the L5 smoke test",
        fire_at: 1_000,
        status: "scheduled",
        created_at: 0,
        updated_at: 0,
        ...row,
      })
      .run()
      .pipe(Effect.orDie)
  })

export const readReminder = (id: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.select().from(ReminderTable).where(eq(ReminderTable.id, id)).get().pipe(Effect.orDie)
  })

/** Collects the reminder-domain lifecycle edges published from here on. */
export const watchLifecycle = Effect.fnUntraced(function* () {
  const service = yield* EventV2.Service
  const seen = yield* Ref.make<EventV2.Payload<typeof LifecycleEvent.Transitioned>[]>([])
  yield* service.all().pipe(
    Stream.filter((event) => event.type === LifecycleEvent.Transitioned.type),
    Stream.runForEach((event) =>
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- filter narrowed the event type but not the payload generic.
      Ref.update(seen, (list) => [...list, event as EventV2.Payload<typeof LifecycleEvent.Transitioned>]),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
  return seen
})

export const edges = (seen: Ref.Ref<EventV2.Payload<typeof LifecycleEvent.Transitioned>[]>, id: string) =>
  Ref.get(seen).pipe(Effect.map((list) => list.map((event) => event.data).filter((data) => data.stateID === id)))

/** Yield until a forked fiber has produced the state under test. */
export const eventually = <A, E, R>(self: Effect.Effect<A | undefined, E, R>, label: string): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let i = 0; i < 2_000; i++) {
      const value = yield* self
      if (value !== undefined) return value
      yield* Effect.yieldNow
    }
    throw new Error(`timed out waiting for ${label}`)
  })

/** Let TestClock-resumed and forked fibers run. */
export const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true })

/** One clock in its own scope: the layer's finalizers run when `use` ends. */
export const withClock = <A, E, R>(use: (clock: ReminderClock.Interface) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(ReminderClock.layer)
      return yield* use(Context.get(context, ReminderClock.Service))
    }),
  )

/** Records the inbox nudges of this process while the test runs; restores the hook after. */
export const recordNudges = Effect.acquireRelease(
  Effect.sync(() => {
    const previous = EngineProcess.inbox.nudge
    const nudged: string[] = []
    EngineProcess.inbox.nudge = (sessionID) =>
      Effect.sync(() => {
        nudged.push(sessionID)
      })
    return { previous, nudged }
  }),
  ({ previous }) =>
    Effect.sync(() => {
      EngineProcess.inbox.nudge = previous
    }),
)

/**
 * Replaces the inbox nudge hook of this process while the test runs, and restores
 * it after. `handler` decides what a nudge for a session does: record it, fail,
 * hang, or forward to the real inbox. Resolves to the hook it replaced.
 */
export const stubNudge = (handler: (sessionID: SessionID) => Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = EngineProcess.inbox.nudge
      EngineProcess.inbox.nudge = handler
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        EngineProcess.inbox.nudge = previous
      }),
  )

/** The process-level reminder state is shared by every test file: start each test clean. */
export const resetLive = Effect.sync(() => {
  EngineProcess.reminder.due.clear()
})

interface AdmissionRecord {
  readonly input: PromptInput
  readonly options?: AdmissionOptions
  readonly extras?: AdmissionExtras
}

/**
 * The recording admission port. `persistAdmission` runs inside one immediate
 * transaction, like the real one, so the delivery mark commits or rolls back
 * with the message.
 */
export const recordingPrompts = (
  db: Database.Interface["db"],
  options: {
    readonly barrier?: number
    readonly failAfterMark?: boolean
    /** True when a turn is running at the admission, given how many notices were admitted so far. */
    readonly busy?: (admitted: number) => boolean
  } = {},
) =>
  Effect.gen(function* () {
    const admitted: AdmissionRecord[] = []
    let arrived = 0
    const released = Deferred.makeUnsafe<void>()
    const prompts: Pick<PromptInterface, "admit"> = {
      admit: (input, admissionOptions, persistAdmission, extras) =>
        Effect.gen(function* () {
          // A turn that started between the claim and the admission: nothing commits.
          if (options.busy?.(admitted.length) === true)
            return {
              admission: { kind: "skipped_busy" },
              message: undefined,
              wait: Effect.die("no turn"),
            } as unknown as TurnStart
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

/** The text of the first part of an admitted notice. */
export const noticeText = (record: AdmissionRecord | undefined): string => {
  const part = record?.input.parts[0]
  return part?.type === "text" ? part.text : ""
}

/** The source over the same database with a stub inbox that records registration and startup drains. */
export const sourceHarness = (
  directory: string,
  prompts: Pick<PromptInterface, "admit">,
  lifecycleStub?: ReminderSource.Deps["lifecycle"],
) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope
    let source: InboxSource | undefined
    const drains: SessionID[] = []
    yield* ReminderSource.make({
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
      ...(lifecycleStub ? { lifecycle: lifecycleStub } : {}),
      directory,
      scope,
    })
    const claim = (sessionID: SessionID, claimEpoch?: number) => {
      if (!source) throw new Error("the reminder source was not registered")
      return source.claim(sessionID, { directory, claimEpoch: claimEpoch ?? SessionCancellation.epoch(sessionID) })
    }
    return { db, drains, claim, source: () => source }
  })
