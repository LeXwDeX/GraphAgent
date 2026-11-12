// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Branded DB rows and narrow service mocks exercise the turn bookkeeping surface, not the full session runtime.

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { SessionTurnTable } from "@graphagent/core/session/turn.sql"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Fiber, Option, Scope } from "effect"
import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { Runner } from "@/effect/runner"
import { SessionCancellation } from "@/session/cancellation"
import { makeSessionLocks } from "@/session/locks"
import type { PromptInput } from "@/session/prompt"
import type { SessionRunState } from "@/session/run-state"
import { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import {
  dropReverted,
  lastOutcomeOf,
  makeTurns,
  originFor,
  recover,
  runnerAlive,
  type Admission,
  type TurnExecution,
  type TurnOutcome,
  type TurnSettled,
} from "@/session/turns"
import { testEffect, pollWithTimeout } from "../lib/effect"

/**
 * Issue #1019 PR8: session turn rows, orphan recovery, revert/fork visibility
 * and the admission classifier. The durable helpers run against a real
 * in-memory database; the loop machine and provider calls are stubbed because
 * this file owns turn bookkeeping, not the machine itself.
 */

const it = testEffect(Database.layerFromPath(":memory:"))

const sessions = new Map<SessionID, { info: Session.Info; messages: SessionV1.WithParts[] }>()

function mockSessions(): Session.Interface {
  return {
    get: (id: SessionID) => {
      const entry = sessions.get(id)
      return entry ? Effect.succeed(entry.info) : Effect.fail(new Error(`missing session ${id}`))
    },
    messages: (input: { sessionID: SessionID }) => Effect.succeed(sessions.get(input.sessionID)?.messages ?? []),
    getMessageInfos: (input: { sessionID: SessionID; messageIDs: ReadonlyArray<string> }) => {
      const wanted = new Set(input.messageIDs.map(String))
      const result = new Map<string, SessionV1.Info>()
      for (const message of sessions.get(input.sessionID)?.messages ?? [])
        if (wanted.has(String(message.info.id))) result.set(String(message.info.id), message.info)
      return Effect.succeed(result)
    },
  } as unknown as Session.Interface
}

let created = 1_000

function userMessage(sessionID: SessionID, id = MessageID.ascending()): SessionV1.WithParts {
  created += 1
  return {
    info: {
      id,
      sessionID,
      time: { created },
      role: "user",
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    },
    parts: [],
  }
}

function assistantMessage(sessionID: SessionID, parentID: MessageID): SessionV1.WithParts {
  created += 1
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      parentID,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      time: { created },
      role: "assistant",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
    },
    parts: [],
  }
}

function sessionInfo(id: SessionID, revert?: { messageID: MessageID }): Session.Info {
  return {
    id,
    slug: "turns-test",
    projectID: "prj_test",
    directory: "/tmp",
    title: "turns test",
    version: "0",
    time: { created: 0, updated: 0 },
    ...(revert ? { revert } : {}),
  } as unknown as Session.Info
}

function completed(message: SessionV1.WithParts, user: SessionV1.WithParts, steps = 1): TurnExecution {
  return {
    message,
    outcome: { type: "completed" },
    steps,
    userMessageID: user.info.id,
    lastAssistantID: message.info.id,
  }
}

function makeHarness(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()
    const runnerFor = (sessionID: SessionID) => {
      const existing = runners.get(sessionID)
      if (existing) return existing
      const created = Runner.make<SessionV1.WithParts>(scope)
      runners.set(sessionID, created)
      return created
    }
    let admit: (input: PromptInput) => Effect.Effect<Admission> = (input) =>
      Effect.succeed({ message: userMessage(input.sessionID), run: true })
    let run: (sessionID: SessionID) => Effect.Effect<TurnExecution> = (sessionID) => {
      const user = userMessage(sessionID)
      return Effect.succeed(completed(assistantMessage(sessionID, user.info.id), user))
    }
    let fence = true
    const settled: TurnSettled[] = []

    const state = {
      startIfIdle: (
        sessionID: SessionID,
        _onInterrupt: Effect.Effect<SessionV1.WithParts>,
        work: Effect.Effect<SessionV1.WithParts>,
      ) => runnerFor(sessionID).startIfIdle(work),
      ensureRunningHandleClassified: (
        sessionID: SessionID,
        _onInterrupt: Effect.Effect<SessionV1.WithParts>,
        work: Effect.Effect<SessionV1.WithParts>,
      ) => runnerFor(sessionID).ensureRunningHandleClassified(work),
      cancel: (sessionID: SessionID) => runnerFor(sessionID).cancel,
    } as unknown as SessionRunState.Interface

    const locks = makeSessionLocks(KeyedMutex.makeUnsafe<SessionID>())
    // Keep one admitted request per session for the whole test: the real
    // run-state layer registers an owner that outlives the callback, which the
    // stub state above does not model. Passing it as an admitted request skips
    // the release in `withRunRequest`.
    const admitted = new Map<SessionID, ReturnType<typeof SessionCancellation.request>>()
    const admittedFor = (sessionID: SessionID) => {
      const existing = admitted.get(sessionID)
      if (existing) return existing
      const created = SessionCancellation.request(sessionID)
      admitted.set(sessionID, created)
      return created
    }

    const turns = makeTurns({
      db,
      sessions: mockSessions(),
      state,
      scope,
      withRunRequest: (sessionID, use) => locks.withRunRequest(sessionID, use, admittedFor(sessionID)),
      withPromptLock: locks.withPromptLock,
      goal: undefined,
      settingsHook: undefined,
      onSettled: (value) =>
        Effect.sync(() => {
          settled.push(value)
        }),
      admitPrompt: (input) => admit(input),
      fenceRewake: () => Effect.succeed(fence),
      runLoop: (sessionID) => run(sessionID),
      lastAssistant: (sessionID) => Effect.succeed(assistantMessage(sessionID, MessageID.ascending())),
      cancel: (sessionID) => runnerFor(sessionID).cancel,
    })

    return {
      turns,
      runnerFor,
      settled,
      setAdmit: (next: (input: PromptInput) => Effect.Effect<Admission>) => {
        admit = next
      },
      setRun: (next: (sessionID: SessionID) => Effect.Effect<TurnExecution>) => {
        run = next
      },
      setFence: (next: boolean) => {
        fence = next
      },
    }
  })
}

function startInput(sessionID: SessionID): PromptInput {
  return { sessionID, parts: [] }
}

const turnRows = (db: Database.Interface["db"], sessionID: SessionID) =>
  db.select().from(SessionTurnTable).where(eq(SessionTurnTable.session_id, sessionID)).all().pipe(Effect.orDie)

/** Parent rows required by the session_turn foreign keys. */
function ensureSession(db: Database.Interface["db"], sessionID: SessionID) {
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: "prj_turns_test" as never, worktree: "/tmp" as never, sandboxes: ["/tmp"] as never })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: "prj_turns_test" as never,
        slug: "turns-test",
        directory: "/tmp" as never,
        title: "turns test",
        version: "0",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
}

describe("turn origin mapping", () => {
  it.effect("maps delegation, rewake and plain prompts onto the origin vocabulary", () =>
    Effect.sync(() => {
      expect(originFor({ internalDelegation: true })).toEqual({ kind: "child_run" })
      expect(originFor({ rewakeToken: {} as never })).toEqual({ kind: "hook", via: "rewake" })
      expect(originFor(undefined)).toEqual({ kind: "user", via: "prompt" })
      expect(originFor({})).toEqual({ kind: "user", via: "prompt" })
    }),
  )
})

describe("orphan recovery", () => {
  it.effect("settles a running row whose runner died and keeps live or ended rows", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(`ses_recover_${Date.now()}`)
      yield* ensureSession(db, sessionID)
      const now = Date.now()
      yield* db
        .insert(SessionTurnTable)
        .values([
          {
            id: "turn-dead",
            session_id: sessionID,
            origin: JSON.stringify({ kind: "user", via: "prompt" }),
            state: "running",
            runner_id: "2147483647",
            time_started: now,
          },
          {
            id: "turn-live",
            session_id: sessionID,
            origin: JSON.stringify({ kind: "user", via: "prompt" }),
            state: "running",
            runner_id: String(process.pid),
            time_started: now,
          },
          {
            id: "turn-ended",
            session_id: sessionID,
            origin: JSON.stringify({ kind: "user", via: "prompt" }),
            state: "ended",
            outcome: { type: "completed" },
            runner_id: String(process.pid),
            time_started: now,
            time_ended: now,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      yield* recover({ db } as Database.Interface)

      const rows = yield* turnRows(db, sessionID)
      const byID = new Map(rows.map((row) => [row.id, row]))
      expect(byID.get("turn-dead")?.state).toBe("ended")
      expect(byID.get("turn-dead")?.outcome).toEqual({ type: "interrupted" })
      expect(byID.get("turn-dead")?.time_ended).not.toBeNull()
      expect(byID.get("turn-live")?.state).toBe("running")
      expect(byID.get("turn-ended")?.outcome).toEqual({ type: "completed" })
    }),
  )

  it.effect("treats missing, malformed and far-out PIDs as dead", () =>
    Effect.sync(() => {
      expect(runnerAlive(undefined)).toBe(false)
      expect(runnerAlive(null)).toBe(false)
      expect(runnerAlive("")).toBe(false)
      expect(runnerAlive("abc")).toBe(false)
      expect(runnerAlive("0")).toBe(false)
      expect(runnerAlive("2147483647")).toBe(false)
      expect(runnerAlive(String(process.pid))).toBe(true)
    }),
  )
})

describe("lastOutcome", () => {
  it.effect("returns the latest ended turn that still anchors live history", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(`ses_outcome_${Date.now()}`)
      yield* ensureSession(db, sessionID)
      const first = userMessage(sessionID)
      const second = userMessage(sessionID)
      sessions.set(sessionID, { info: sessionInfo(sessionID), messages: [first, second] })
      yield* db
        .insert(SessionTurnTable)
        .values([
          {
            id: "turn-old",
            session_id: sessionID,
            origin: JSON.stringify({ kind: "user", via: "prompt" }),
            state: "ended",
            outcome: { type: "completed" },
            user_message_id: first.info.id,
            steps: 2,
            runner_id: "1",
            time_started: 10,
            time_ended: 11,
          },
          // Newest row, but its anchor message is gone: the scan must skip it
          // instead of reporting this error.
          {
            id: "turn-missing-message",
            session_id: sessionID,
            origin: JSON.stringify({ kind: "user", via: "prompt" }),
            state: "ended",
            outcome: { type: "error", code: "boom", retryable: false },
            user_message_id: "msg_deleted",
            steps: 1,
            runner_id: "1",
            time_started: 40,
            time_ended: 41,
          },
          // Two valid rows with different outcomes: the newest valid row wins
          // (a replay bug that returned the first row would report completed).
          {
            id: "turn-new",
            session_id: sessionID,
            origin: JSON.stringify({ kind: "user", via: "prompt" }),
            state: "ended",
            outcome: { type: "error", code: "late", retryable: true },
            user_message_id: second.info.id,
            steps: 1,
            runner_id: "1",
            time_started: 30,
            time_ended: 31,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const outcome = yield* lastOutcomeOf({ db, sessions: mockSessions() }, sessionID)
      expect(Option.getOrUndefined(outcome)).toEqual({ type: "error", code: "late", retryable: true })
    }),
  )

  it.effect("skips a turn whose user message sits inside the pending revert range", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(`ses_outcome_revert_${Date.now()}`)
      yield* ensureSession(db, sessionID)
      const older = userMessage(sessionID)
      const reverted = userMessage(sessionID)
      sessions.set(sessionID, {
        info: sessionInfo(sessionID, { messageID: reverted.info.id }),
        messages: [older, reverted],
      })
      yield* db
        .insert(SessionTurnTable)
        .values([
          {
            id: "turn-kept",
            session_id: sessionID,
            origin: JSON.stringify({ kind: "user", via: "prompt" }),
            state: "ended",
            outcome: { type: "completed" },
            user_message_id: older.info.id,
            steps: 1,
            runner_id: "1",
            time_started: 10,
            time_ended: 11,
          },
          {
            id: "turn-reverted",
            session_id: sessionID,
            origin: JSON.stringify({ kind: "user", via: "prompt" }),
            state: "ended",
            outcome: { type: "cancelled" },
            user_message_id: reverted.info.id,
            steps: 1,
            runner_id: "1",
            time_started: 20,
            time_ended: 21,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const outcome = yield* lastOutcomeOf({ db, sessions: mockSessions() }, sessionID)
      expect(Option.getOrUndefined(outcome)).toEqual({ type: "completed" })
    }),
  )

  it.effect("does not leak rows into a forked session whose messages were copied", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const original = SessionID.make(`ses_fork_src_${Date.now()}`)
      yield* ensureSession(db, original)
      const fork = SessionID.make(`ses_fork_dst_${Date.now()}`)
      yield* ensureSession(db, fork)
      const user = userMessage(original)
      sessions.set(original, { info: sessionInfo(original), messages: [user] })
      sessions.set(fork, { info: sessionInfo(fork), messages: [userMessage(fork)] })
      yield* db
        .insert(SessionTurnTable)
        .values({
          id: "turn-original",
          session_id: original,
          origin: JSON.stringify({ kind: "user", via: "prompt" }),
          state: "ended",
          outcome: { type: "completed" },
          user_message_id: user.info.id,
          steps: 1,
          runner_id: "1",
          time_started: 10,
          time_ended: 11,
        })
        .run()
        .pipe(Effect.orDie)

      expect(Option.getOrUndefined(yield* lastOutcomeOf({ db, sessions: mockSessions() }, original))).toEqual({
        type: "completed",
      })
      expect(Option.isNone(yield* lastOutcomeOf({ db, sessions: mockSessions() }, fork))).toBe(true)
    }),
  )
})

describe("dropReverted", () => {
  it.effect("deletes rows at or after the revert boundary and keeps earlier turns", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(`ses_drop_${Date.now()}`)
      yield* ensureSession(db, sessionID)
      const before = userMessage(sessionID)
      const boundary = userMessage(sessionID)
      const after = userMessage(sessionID)
      sessions.set(sessionID, {
        info: sessionInfo(sessionID, { messageID: boundary.info.id }),
        messages: [before, boundary, after],
      })
      yield* db
        .insert(SessionTurnTable)
        .values([
          {
            id: "turn-before",
            session_id: sessionID,
            state: "ended",
            outcome: { type: "completed" },
            user_message_id: before.info.id,
          },
          {
            id: "turn-boundary",
            session_id: sessionID,
            state: "ended",
            outcome: { type: "completed" },
            user_message_id: boundary.info.id,
          },
          {
            id: "turn-after",
            session_id: sessionID,
            state: "ended",
            outcome: { type: "completed" },
            user_message_id: after.info.id,
          },
          {
            id: "turn-missing",
            session_id: sessionID,
            state: "ended",
            outcome: { type: "completed" },
            user_message_id: "msg_gone",
          },
        ])
        .run()
        .pipe(Effect.orDie)

      yield* dropReverted({ db, sessions: mockSessions() }, sessions.get(sessionID)!.info)

      const rows = yield* turnRows(db, sessionID)
      expect(rows.map((row) => row.id)).toEqual(["turn-before"])
    }),
  )
})

describe("admission", () => {
  it.effect("started writes one row and settles it with the execution outcome", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(`ses_started_${Date.now()}`)
      yield* ensureSession(db, sessionID)
      const harness = yield* makeHarness(db)
      const user = userMessage(sessionID)
      const assistant = assistantMessage(sessionID, user.info.id)
      harness.setAdmit(() => Effect.succeed({ message: user, run: true }))
      harness.setRun(() => Effect.succeed(completed(assistant, user, 2)))

      const started = yield* harness.turns.start(startInput(sessionID), {
        origin: { kind: "user", via: "prompt" },
        when: "now",
      })
      expect(started.admission.kind).toBe("started")
      expect((yield* started.wait).info.id).toBe(assistant.info.id)

      const rows = yield* turnRows(db, sessionID)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        state: "ended",
        outcome: { type: "completed" },
        user_message_id: user.info.id,
        last_assistant_id: assistant.info.id,
        steps: 2,
        runner_id: String(process.pid),
      })
      expect(rows[0]?.time_ended).not.toBeNull()
      const timeEnded = rows[0].time_ended!
      expect(harness.settled).toHaveLength(1)
      expect(harness.settled[0]).toEqual({
        sessionID,
        turnID: rows[0]?.id,
        outcome: { type: "completed" },
        steps: 2,
        timeEnded,
      })
    }),
  )

  it.effect("joined waits on the running turn without writing a second row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(`ses_joined_${Date.now()}`)
      yield* ensureSession(db, sessionID)
      const harness = yield* makeHarness(db)
      const firstUser = userMessage(sessionID)
      const secondUser = userMessage(sessionID)
      const gate = Deferred.makeUnsafe<void>()
      let admission = 0
      harness.setAdmit(() => Effect.succeed({ message: admission++ === 0 ? firstUser : secondUser, run: true }))
      harness.setRun(() =>
        Deferred.await(gate).pipe(Effect.as(completed(assistantMessage(sessionID, firstUser.info.id), firstUser))),
      )

      const first = yield* harness.turns.start(startInput(sessionID), {
        origin: { kind: "user", via: "prompt" },
        when: "now",
      })
      expect(first.admission.kind).toBe("started")
      const second = yield* harness.turns.start(startInput(sessionID), {
        origin: { kind: "user", via: "prompt" },
        when: "now",
      })
      expect(second.admission.kind).toBe("joined")
      if (second.admission.kind === "joined") expect(second.admission.messageID).toBe(secondUser.info.id)

      yield* Deferred.succeed(gate, undefined)
      yield* first.wait
      yield* second.wait
      const rows = yield* turnRows(db, sessionID)
      expect(rows).toHaveLength(1)
    }),
  )

  // Live clock: the shell and the queued work run on real fibers.
  it.live("a prompt queued behind a shell is started and owns the turn row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(`ses_shell_queued_${Date.now()}`)
      yield* ensureSession(db, sessionID)
      const harness = yield* makeHarness(db)
      const shell = Deferred.makeUnsafe<void>()
      const user = userMessage(sessionID)
      const assistant = assistantMessage(sessionID, user.info.id)
      harness.setAdmit(() => Effect.succeed({ message: user, run: true }))
      harness.setRun(() => Effect.succeed(completed(assistant, user)))

      const runner = harness.runnerFor(sessionID)
      // Reserve the runner before forking: `startShellHandle` publishes the
      // `Shell` state atomically, so the admission below deterministically
      // queues instead of racing an idle runner.
      const shellResult = yield* runner.startShellHandle(
        Deferred.await(shell).pipe(Effect.as(assistantMessage(sessionID, user.info.id))),
      )
      const shellFiber = yield* shellResult.pipe(Effect.forkChild)

      // Joining a shell queue must report the admission as `started`: the
      // queued work will run `track` and insert this request's own row.
      const started = yield* harness.turns.start(startInput(sessionID), {
        origin: { kind: "user", via: "prompt" },
        when: "now",
      })
      expect(started.admission.kind).toBe("started")
      // The queued work has not started while the shell still owns the runner.
      expect(yield* turnRows(db, sessionID)).toHaveLength(0)

      yield* Deferred.succeed(shell, undefined)
      yield* started.wait
      yield* Fiber.await(shellFiber)
      const rows = yield* turnRows(db, sessionID)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ state: "ended", outcome: { type: "completed" } })
    }),
  )

  // Live clock: cancellation is delivered to real fibers, and the watcher
  // settles the handle from the dropped queued work.
  it.live("cancelling a shell-queued admission before track settles the handle as cancelled", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(`ses_shell_cancel_${Date.now()}`)
      yield* ensureSession(db, sessionID)
      const harness = yield* makeHarness(db)
      const shell = Deferred.makeUnsafe<void>()
      const user = userMessage(sessionID)
      let ran = false
      harness.setAdmit(() => Effect.succeed({ message: user, run: true }))
      harness.setRun(() => {
        ran = true
        return Effect.succeed(completed(assistantMessage(sessionID, user.info.id), user))
      })

      const runner = harness.runnerFor(sessionID)
      // See the sibling test: reserve the runner atomically so the admission
      // cannot observe an idle runner and start the work itself.
      const shellResult = yield* runner.startShellHandle(
        Deferred.await(shell).pipe(Effect.as(assistantMessage(sessionID, user.info.id))),
      )
      const shellFiber = yield* shellResult.pipe(Effect.forkChild)

      const started = yield* harness.turns.start(startInput(sessionID), {
        origin: { kind: "user", via: "prompt" },
        when: "now",
      })
      if (started.admission.kind !== "started") throw new Error(`unexpected ${started.admission.kind}`)
      const turn = started.admission.turn
      expect(yield* turn.status).toBe("running")

      // ESC while the admission still waits behind the shell: the runner drops
      // the queued work without ever entering `track`.
      yield* runner.cancel
      const outcome = yield* turn.result
      expect(outcome).toMatchObject({ type: "cancelled" })
      expect(yield* turn.status).toBe("ended")
      expect(yield* turnRows(db, sessionID)).toHaveLength(0)
      expect(harness.settled).toHaveLength(0)
      expect(ran).toBe(false)

      yield* Deferred.succeed(shell, undefined)
      yield* Fiber.await(shellFiber)
    }),
  )

  it.effect("idle admission activates the prepared turn and settles exactly one row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(`ses_prepare_${Date.now()}`)
      yield* ensureSession(db, sessionID)
      const harness = yield* makeHarness(db)
      const user = userMessage(sessionID)
      const assistant = assistantMessage(sessionID, user.info.id)
      harness.setAdmit(() => Effect.succeed({ message: user, run: true }))
      harness.setRun(() => Effect.succeed(completed(assistant, user, 1)))

      // `when: "idle"` is the DAG-wake / goal-continuation admission path:
      // reserve the runner, commit the message, activate the work.
      const started = yield* harness.turns.start(startInput(sessionID), {
        origin: { kind: "user", via: "prompt" },
        when: "idle",
      })
      expect(started.admission.kind).toBe("started")
      expect((yield* started.wait).info.id).toBe(assistant.info.id)

      const rows = yield* turnRows(db, sessionID)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        state: "ended",
        outcome: { type: "completed" },
        user_message_id: user.info.id,
        last_assistant_id: assistant.info.id,
      })
    }),
  )

  it.effect("idle admission reports skipped_busy when a turn is running", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(`ses_busy_${Date.now()}`)
      yield* ensureSession(db, sessionID)
      const harness = yield* makeHarness(db)
      const gate = Deferred.makeUnsafe<void>()
      const user = userMessage(sessionID)
      harness.setAdmit(() => Effect.succeed({ message: user, run: true }))
      harness.setRun(() =>
        Deferred.await(gate).pipe(Effect.as(completed(assistantMessage(sessionID, user.info.id), user))),
      )

      const first = yield* harness.turns.start(startInput(sessionID), {
        origin: { kind: "user", via: "prompt" },
        when: "now",
      })
      expect(first.admission.kind).toBe("started")

      let admitted = false
      harness.setAdmit(() => {
        admitted = true
        return Effect.succeed({ message: userMessage(sessionID), run: true })
      })
      const idle = yield* harness.turns.start(startInput(sessionID), {
        origin: { kind: "user", via: "prompt" },
        when: "idle",
      })
      expect(idle.admission.kind).toBe("skipped_busy")
      // Busy admission is decided before the message is committed.
      expect(admitted).toBe(false)

      yield* Deferred.succeed(gate, undefined)
      yield* first.wait
      expect(yield* turnRows(db, sessionID)).toHaveLength(1)
    }),
  )

  it.effect("a declined admission is not_started and writes no row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(`ses_declined_${Date.now()}`)
      yield* ensureSession(db, sessionID)
      const harness = yield* makeHarness(db)
      const user = userMessage(sessionID)
      harness.setAdmit(() => Effect.succeed({ message: user, run: false }))

      const started = yield* harness.turns.start(startInput(sessionID), {
        origin: { kind: "user", via: "prompt" },
        when: "now",
      })
      expect(started.admission.kind).toBe("not_started")
      expect((yield* started.wait).info.id).toBe(user.info.id)
      expect(yield* turnRows(db, sessionID)).toHaveLength(0)
    }),
  )

  it.effect("a refused Stop rewake still writes and settles its row as blocked", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(`ses_blocked_${Date.now()}`)
      yield* ensureSession(db, sessionID)
      const harness = yield* makeHarness(db)
      const user = userMessage(sessionID)
      let ran = false
      harness.setAdmit(() => Effect.succeed({ message: user, run: true }))
      harness.setFence(false)
      harness.setRun(() => {
        ran = true
        return Effect.succeed(completed(assistantMessage(sessionID, user.info.id), user))
      })

      const started = yield* harness.turns.start(startInput(sessionID), {
        origin: { kind: "hook", via: "rewake" },
        when: "now",
        admissionOptions: { rewakeToken: {} as never },
      })
      expect(started.admission.kind).toBe("started")
      expect((yield* started.wait).info.id).toBe(user.info.id)
      expect(ran).toBe(false)

      const rows = yield* turnRows(db, sessionID)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        state: "ended",
        outcome: { type: "blocked", by: "hook", code: "stale_rewake" },
        origin_ref: "rewake",
      })
    }),
  )

  // Uses the live clock: the row is written by the forked work fiber, and
  // pollWithTimeout's sleep must actually advance to observe it.
  it.live("an interrupted turn settles its row as cancelled", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionID.make(`ses_cancel_${Date.now()}`)
      yield* ensureSession(db, sessionID)
      const harness = yield* makeHarness(db)
      const user = userMessage(sessionID)
      harness.setAdmit(() => Effect.succeed({ message: user, run: true }))
      harness.setRun(() => Effect.never)

      const started = yield* harness.turns.start(startInput(sessionID), {
        origin: { kind: "user", via: "prompt" },
        when: "now",
      })
      if (started.admission.kind !== "started") throw new Error(`unexpected ${started.admission.kind}`)
      const turn = started.admission.turn
      // The row is inserted by the work fiber; cancel only after it starts.
      yield* pollWithTimeout(
        turnRows(db, sessionID).pipe(Effect.map((rows) => (rows.length > 0 ? rows : undefined))),
        "turn row was never inserted",
      )
      const outcome: TurnOutcome = yield* turn.cancel().pipe(Effect.andThen(turn.result))
      expect(outcome.type).toBe("cancelled")

      const rows = yield* turnRows(db, sessionID)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.state).toBe("ended")
      expect(rows[0]?.outcome).toMatchObject({ type: "cancelled" })
    }),
  )
})
