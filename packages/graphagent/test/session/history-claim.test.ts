// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { ToolBudget } from "@graphagent/core/session/tool-budget"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Effect } from "effect"
import { HistoryClaim } from "@/session/history/claim"
import { HistoryView } from "@/session/history/view"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Session as SessionNs } from "@/session/session"
import { historyEffect as it, withSession } from "./history-fixture"

const makeHarness = (input: {
  database: Database.Interface
  reader?: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts[]>
}) => {
  const updates: SessionV1.Info[] = []
  const state: { active?: ToolBudget.Budget; pending: Map<MessageID, ToolBudget.Budget> } = { pending: new Map() }
  const claim = HistoryClaim.makeClaim({
    database: input.database,
    sessions: {
      updateMessage: <T extends SessionV1.Info>(message: T) =>
        Effect.sync(() => {
          updates.push(message)
          return message
        }),
    },
    promptLocks: KeyedMutex.makeUnsafe<SessionID>(),
    budgetState: () => Effect.succeed(state),
    maxToolCalls: Effect.succeed(undefined),
    readHistoryView:
      input.reader ??
      ((sessionID) =>
        HistoryView.tail(sessionID).pipe(Effect.provideService(Database.Service, input.database))),
  })
  return { claim, updates, state }
}

const ids = (messages: readonly SessionV1.WithParts[]) => messages.map((message) => String(message.info.id))

const readTail = (database: Database.Interface, sessionID: SessionID) =>
  HistoryView.tail(sessionID).pipe(Effect.provideService(Database.Service, database))

describe("HistoryClaim", () => {
  it.instance("marks unconsumed prompts consumed without mutating the frozen view", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const first = yield* f.user("prompt", { consumed: 1 })
        const answer = yield* f.assistant(first, { finish: "stop" })
        const queued = yield* f.user("queued")
        const harness = makeHarness({ database })

        const claimed = yield* harness.claim(sessionID)

        expect(ids(claimed.messages)).toEqual([first, answer, queued].map(String))
        expect(Object.isFrozen(claimed.messages)).toBe(true)
        for (const message of claimed.messages) {
          expect(Object.isFrozen(message)).toBe(true)
          expect(Object.isFrozen(message.info)).toBe(true)
          expect(Object.isFrozen(message.info.time)).toBe(true)
          expect(Object.isFrozen(message.parts)).toBe(true)
        }
        expect(harness.updates).toHaveLength(1)
        const consumed = harness.updates[0]!
        if (consumed.role !== "user") throw new Error("expected a user message")
        expect(consumed.time.consumed).toBeNumber()
        const snapshotQueued = claimed.messages.find((message) => message.info.id === queued)!
        if (snapshotQueued.info.role !== "user") throw new Error("expected a user message")
        expect(snapshotQueued.info.time.consumed).toBeUndefined()
        expect(claimed.budget.max).toBe(ToolBudget.DEFAULT_MAX_TOOL_CALLS)
      }),
    ),
  )

  it.instance("keeps already-consumed prompts untouched", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* f.user("done", { consumed: 5 })
        const harness = makeHarness({ database })

        const claimed = yield* harness.claim(sessionID)

        expect(claimed.messages).toHaveLength(1)
        expect(harness.updates).toHaveLength(0)
      }),
    ),
  )

  it.instance("filters ignored presentation prompts out of the claimed view", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const first = yield* f.user("prompt", { consumed: 1 })
        const answer = yield* f.assistant(first, { finish: "stop" })
        const ignored = yield* f.user("hidden", { ignored: true })
        const harness = makeHarness({ database })

        const claimed = yield* harness.claim(sessionID)

        expect(ids(claimed.messages)).toEqual([first, answer].map(String))
        expect(ids(claimed.messages)).not.toContain(String(ignored))
        expect(harness.updates).toHaveLength(0)
      }),
    ),
  )

  it.instance("re-reads when a prompt is appended between the read and the lock", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const session = yield* SessionNs.Service
        const first = yield* f.user("prompt", { consumed: 1 })
        yield* f.assistant(first, { finish: "stop" })
        const queued = yield* f.user("queued")
        let calls = 0
        const harness = makeHarness({
          database,
          reader: (id) =>
            Effect.gen(function* () {
              const captured = yield* readTail(database, id)
              if (calls++ === 0)
                yield* f.user("late").pipe(Effect.provideService(SessionNs.Service, session))
              return captured
            }),
        })

        const claimed = yield* harness.claim(sessionID)

        expect(calls).toBe(2)
        expect(claimed.messages).toHaveLength(4)
        const latest = claimed.messages.at(-1)!
        expect(latest.info.role).toBe("user")
        expect(harness.updates.map((message) => String(message.id)).sort()).toEqual(
          [String(queued), String(latest.info.id)].sort(),
        )
      }),
    ),
  )

  it.instance("re-reads a queued prompt older than the newest page", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const session = yield* SessionNs.Service
        const queued = yield* f.user("queued")
        for (let index = 0; index < 60; index++) {
          const user = yield* f.user("old", { consumed: 1 })
          yield* f.assistant(user, { finish: "stop" })
        }
        let calls = 0
        const harness = makeHarness({
          database,
          reader: (id) =>
            Effect.gen(function* () {
              const captured = yield* readTail(database, id)
              if (calls++ === 0) {
                const parts = yield* MessageV2.parts(queued).pipe(
                  Effect.provideService(Database.Service, database),
                )
                const text = parts.find((part) => part.type === "text")!
                yield* session.updatePart({ ...text, text: "edited" })
              }
              return captured
            }),
        })

        const claimed = yield* harness.claim(sessionID)

        expect(calls).toBe(2)
        expect(claimed.messages).toHaveLength(121)
        const snapshot = claimed.messages.find((message) => message.info.id === queued)!
        const part = snapshot.parts.find((candidate) => candidate.type === "text")!
        expect(part.type === "text" && part.text).toBe("edited")
        expect(harness.updates.map((message) => String(message.id))).toEqual([String(queued)])
      }),
    ),
  )

  it.instance("falls back to a locked full read after repeated stale snapshots", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const session = yield* SessionNs.Service
        const first = yield* f.user("prompt", { consumed: 1 })
        yield* f.assistant(first, { finish: "stop" })
        yield* f.user("queued")
        let calls = 0
        const harness = makeHarness({
          database,
          reader: (id) =>
            Effect.gen(function* () {
              const captured = yield* readTail(database, id)
              yield* f.user(`late ${calls++}`).pipe(Effect.provideService(SessionNs.Service, session))
              return captured
            }),
        })

        const claimed = yield* harness.claim(sessionID)

        expect(calls).toBe(3)
        expect(claimed.messages).toHaveLength(6)
        const newest = claimed.messages.at(-1)!
        expect(newest.info.role).toBe("user")
        expect(harness.updates).toHaveLength(4)
        const lastUpdate = harness.updates.at(-1)!
        if (lastUpdate.role !== "user") throw new Error("expected a user message")
        expect(lastUpdate.time.consumed).toBeNumber()
      }),
    ),
  )

  it.instance("activates the newest pending budget and clears the queue", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const first = yield* f.user("prompt", { consumed: 1 })
        yield* f.assistant(first, { finish: "stop" })
        const queued = yield* f.user("queued")
        const harness = makeHarness({ database })
        const active = ToolBudget.create(1)
        const pending = ToolBudget.create(7)
        harness.state.active = active
        harness.state.pending.set(queued, pending)

        const claimed = yield* harness.claim(sessionID)

        expect(claimed.budget).toBe(pending)
        expect(harness.state.active).toBe(pending)
        expect(harness.state.pending.size).toBe(0)
      }),
    ),
  )

  it.instance("claims an empty session", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const harness = makeHarness({ database })

        const claimed = yield* harness.claim(sessionID)

        expect(claimed.messages).toHaveLength(0)
        expect(harness.updates).toHaveLength(0)
      }),
    ),
  )
})