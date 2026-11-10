// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Effect } from "effect"
import { HistoryCache } from "@/session/history/cache"
import { applyCommitted, makeHistoryState, versionOf } from "@/session/history/state"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import { Session as SessionNs } from "@/session/session"
import { historyEffect as it, makeFixture, withSession } from "./history-fixture"

/**
 * Builds the cache with counters around both fences and the paged read. The
 * default external counter is constant so every cold reload settles; tests that
 * model another connection move it explicitly.
 */
const makeCache = (input: {
  database: Database.Interface
  dataVersion?: () => number
  budgetBytes?: number
  onCollect?: () => Effect.Effect<void>
}) => {
  const state = makeHistoryState()
  const calls = { collect: 0, dataVersion: 0 }
  const deps: HistoryCache.CacheDeps = {
    database: input.database,
    dataVersion: () =>
      Effect.sync(() => {
        calls.dataVersion++
        return input.dataVersion ? input.dataVersion() : 10
      }),
    collect: (sessionID) =>
      Effect.gen(function* () {
        calls.collect++
        if (input.onCollect) yield* input.onCollect()
        return yield* MessageV2.collectCompactedTail(sessionID).pipe(
          Effect.provideService(Database.Service, input.database),
        )
      }),
    ...(input.budgetBytes === undefined ? {} : { budgetBytes: input.budgetBytes }),
  }
  return { state, calls, deps }
}

const readInfo = (database: Database.Interface, sessionID: SessionID, messageID: SessionV1.Info["id"]) =>
  MessageV2.get({ sessionID, messageID }).pipe(Effect.provideService(Database.Service, database))

describe("HistoryCache", () => {
  it.instance("serves a clean entry without any SQL", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* f.user("one")
        const cache = makeCache({ database })

        const first = yield* HistoryCache.get(cache.state, cache.deps, sessionID)
        expect(first.stable).toBe(true)
        expect(first.history).toHaveLength(1)
        expect(cache.calls).toEqual({ collect: 1, dataVersion: 2 })

        const second = yield* HistoryCache.get(cache.state, cache.deps, sessionID)
        expect(second.stable).toBe(true)
        expect(second.history).toBe(first.history)
        expect(cache.calls).toEqual({ collect: 1, dataVersion: 2 })
      }),
    ),
  )

  it.instance("applies a committed event without a reload", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const first = yield* f.user("one")
        const cache = makeCache({ database })
        yield* HistoryCache.get(cache.state, cache.deps, sessionID)

        const second = yield* f.user("two")
        const info = (yield* readInfo(database, sessionID, second)).info
        applyCommitted(cache.state, {
          type: SessionV1.Event.MessageUpdated.type,
          data: { sessionID, info },
          durable: { aggregateID: sessionID, seq: 0 },
        })

        const updated = yield* HistoryCache.get(cache.state, cache.deps, sessionID)
        expect(updated.stable).toBe(true)
        expect(updated.history.map((message) => message.info.id)).toEqual([first, second])
        expect(cache.calls).toEqual({ collect: 1, dataVersion: 2 })
      }),
    ),
  )

  it.instance("checkExternal costs exactly one data-version read", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* f.user("one")
        const cache = makeCache({ database })
        yield* HistoryCache.get(cache.state, cache.deps, sessionID)

        const result = yield* HistoryCache.checkExternal(cache.state, cache.deps, sessionID)

        expect(result).toBe("same")
        expect(cache.calls).toEqual({ collect: 1, dataVersion: 3 })
      }),
    ),
  )

  it.instance("reloads when another connection committed", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* f.user("one")
        let external = 10
        const cache = makeCache({ database, dataVersion: () => external })
        yield* HistoryCache.get(cache.state, cache.deps, sessionID)

        yield* f.user("external")
        external = 11
        const reloaded = yield* HistoryCache.checkExternal(cache.state, cache.deps, sessionID)
        expect(reloaded).toBe("reloaded")
        expect(cache.calls.collect).toBe(2)

        const snapshot = yield* HistoryCache.get(cache.state, cache.deps, sessionID)
        expect(snapshot.history).toHaveLength(2)
        expect(snapshot.stable).toBe(true)

        const same = yield* HistoryCache.checkExternal(cache.state, cache.deps, sessionID)
        expect(same).toBe("same")
      }),
    ),
  )

  it.instance("flags a reload that observes a moved external counter", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* f.user("one")
        let external = 10
        const cache = makeCache({
          database,
          dataVersion: () => external,
          onCollect: () => Effect.sync(() => external++),
        })

        const snapshot = yield* HistoryCache.get(cache.state, cache.deps, sessionID)

        expect(snapshot.stable).toBe(false)
        expect(cache.state.entries.has(sessionID)).toBe(false)
        expect(cache.calls.collect).toBe(1)
      }),
    ),
  )

  it.instance("flags a reload that observes a process event", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const first = yield* f.user("one")
        let armed: (() => void) | undefined
        const cache = makeCache({ database, onCollect: () => Effect.sync(() => armed?.()) })
        yield* HistoryCache.get(cache.state, cache.deps, sessionID)

        const second = yield* f.user("two")
        const info = (yield* readInfo(database, sessionID, second)).info
        const event = {
          type: SessionV1.Event.MessageUpdated.type,
          data: { sessionID, info },
          durable: { aggregateID: sessionID, seq: 0 },
        }
        applyCommitted(cache.state, event)
        applyCommitted(cache.state, {
          type: SessionV1.Event.MessageRemoved.type,
          data: { sessionID, messageID: first },
          durable: { aggregateID: sessionID, seq: 1 },
        })
        expect(cache.state.entries.get(sessionID)!.dirty).toBe(true)

        armed = () => applyCommitted(cache.state, { ...event, durable: { aggregateID: sessionID, seq: 2 } })
        const snapshot = yield* HistoryCache.get(cache.state, cache.deps, sessionID)

        expect(snapshot.stable).toBe(false)
        expect(cache.state.entries.get(sessionID)!.dirty).toBe(true)
        expect(versionOf(cache.state, sessionID)).toBe(3)
        expect(cache.calls.collect).toBe(2)
      }),
    ),
  )

  it.instance("rebuilds a dirty entry from the next stable reload", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const first = yield* f.user("one")
        const cache = makeCache({ database })
        yield* HistoryCache.get(cache.state, cache.deps, sessionID)

        applyCommitted(cache.state, {
          type: SessionV1.Event.MessageRemoved.type,
          data: { sessionID, messageID: first },
          durable: { aggregateID: sessionID, seq: 0 },
        })
        expect(cache.state.entries.get(sessionID)!.dirty).toBe(true)

        const snapshot = yield* HistoryCache.get(cache.state, cache.deps, sessionID)

        expect(snapshot.stable).toBe(true)
        expect(snapshot.history).toHaveLength(1)
        expect(cache.state.entries.get(sessionID)!.dirty).toBe(false)
        expect(cache.calls.collect).toBe(2)
      }),
    ),
  )

  it.instance("evicts the least recently used entry over budget", () =>
    withSession(({ sessionID, f }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const session = yield* SessionNs.Service
        yield* f.user("one")
        const other = yield* session.create({})
        yield* makeFixture(other.id).user("other")
        const cache = makeCache({ database, budgetBytes: 1 })

        yield* HistoryCache.get(cache.state, cache.deps, sessionID)
        expect(cache.state.entries.has(sessionID)).toBe(true)

        yield* HistoryCache.get(cache.state, cache.deps, other.id)
        expect(cache.state.entries.has(other.id)).toBe(true)
        expect(cache.state.entries.has(sessionID)).toBe(false)

        yield* session.remove(other.id).pipe(Effect.ignore)
      }),
    ),
  )
})
