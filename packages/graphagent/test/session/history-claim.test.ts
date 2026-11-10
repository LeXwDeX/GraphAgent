// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { ToolBudget } from "@graphagent/core/session/tool-budget"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Effect } from "effect"
import { HistoryCache } from "@/session/history/cache"
import { HistoryClaim } from "@/session/history/claim"
import { makeHistoryState } from "@/session/history/state"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Session as SessionNs } from "@/session/session"
import { historyEffect as it, withSession } from "./history-fixture"

/**
 * Builds the claim with an isolated history state. The first lock-free `get`
 * optionally runs a write hook and then drops the cached entry, modelling a
 * process write landing after that snapshot was taken: the claim must read the
 * entry again under the prompt lock instead of committing the stale snapshot.
 */
const makeHarness = (input: {
  database: Database.Interface
  dataVersion?: HistoryCache.CacheDeps["dataVersion"]
  afterInitialGet?: (sessionID: SessionID) => Effect.Effect<void>
}) => {
  const state = makeHistoryState()
  const deps: HistoryCache.CacheDeps = {
    database: input.database,
    ...(input.dataVersion ? { dataVersion: input.dataVersion } : {}),
  }
  let gets = 0
  const history: HistoryClaim.HistoryPort = {
    get: (sessionID) =>
      Effect.gen(function* () {
        const snapshot = yield* HistoryCache.get(state, deps, sessionID)
        if (gets++ === 0 && input.afterInitialGet) {
          yield* input.afterInitialGet(sessionID)
          HistoryCache.invalidate(state, sessionID)
        }
        return snapshot
      }),
    checkExternal: (sessionID) => HistoryCache.checkExternal(state, deps, sessionID),
    version: (sessionID) => HistoryCache.version(state, sessionID),
  }
  const updates: SessionV1.Info[] = []
  const budget: { active?: ToolBudget.Budget; pending: Map<MessageID, ToolBudget.Budget> } = { pending: new Map() }
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
    budgetState: () => Effect.succeed(budget),
    maxToolCalls: Effect.succeed(undefined),
    history,
  })
  return { claim, updates, budget }
}

const ids = (messages: readonly SessionV1.WithParts[]) => messages.map((message) => String(message.info.id))

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

  it.instance("re-reads under the lock when a prompt lands after the lock-free snapshot", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const session = yield* SessionNs.Service
        const first = yield* f.user("prompt", { consumed: 1 })
        yield* f.assistant(first, { finish: "stop" })
        const queued = yield* f.user("queued")
        const harness = makeHarness({
          database,
          afterInitialGet: () => f.user("late").pipe(Effect.provideService(SessionNs.Service, session)),
        })

        const claimed = yield* harness.claim(sessionID)

        expect(claimed.messages).toHaveLength(4)
        const latest = claimed.messages.at(-1)!
        expect(latest.info.role).toBe("user")
        expect(harness.updates.map((message) => String(message.id)).sort()).toEqual(
          [String(queued), String(latest.info.id)].sort(),
        )
      }),
    ),
  )

  it.instance("re-reads a queued prompt after an edit lands behind the lock-free snapshot", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const session = yield* SessionNs.Service
        const queued = yield* f.user("queued")
        for (let index = 0; index < 60; index++) {
          const user = yield* f.user("old", { consumed: 1 })
          yield* f.assistant(user, { finish: "stop" })
        }
        const harness = makeHarness({
          database,
          afterInitialGet: () =>
            Effect.gen(function* () {
              const parts = yield* MessageV2.parts(queued).pipe(Effect.provideService(Database.Service, database))
              const text = parts.find((part) => part.type === "text")!
              yield* session.updatePart({ ...text, text: "edited" })
            }),
        })

        const claimed = yield* harness.claim(sessionID)

        expect(claimed.messages).toHaveLength(121)
        const snapshot = claimed.messages.find((message) => message.info.id === queued)!
        const part = snapshot.parts.find((candidate) => candidate.type === "text")!
        expect(part.type === "text" && part.text).toBe("edited")
        expect(harness.updates.map((message) => String(message.id))).toEqual([String(queued)])
      }),
    ),
  )

  it.instance("falls back to a locked full read when reloads never settle", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const first = yield* f.user("prompt", { consumed: 1 })
        yield* f.assistant(first, { finish: "stop" })
        yield* f.user("queued")
        // Every double-fenced reload observes a moved counter, so the cache can
        // never produce a stable entry and each attempt is discarded.
        let counter = 0
        const harness = makeHarness({ database, dataVersion: () => Effect.sync(() => counter++) })

        const claimed = yield* harness.claim(sessionID)

        expect(claimed.messages).toHaveLength(3)
        const newest = claimed.messages.at(-1)!
        expect(newest.info.role).toBe("user")
        expect(harness.updates).toHaveLength(1)
        const update = harness.updates[0]!
        if (update.role !== "user") throw new Error("expected a user message")
        expect(update.time.consumed).toBeNumber()
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
        harness.budget.active = active
        harness.budget.pending.set(queued, pending)

        const claimed = yield* harness.claim(sessionID)

        expect(claimed.budget).toBe(pending)
        expect(harness.budget.active).toBe(pending)
        expect(harness.budget.pending.size).toBe(0)
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
