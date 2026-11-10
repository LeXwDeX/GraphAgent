// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Effect, Layer, Ref, Stream } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = SessionStatus.defaultLayer.pipe(
  Layer.provideMerge(CrossSpawnSpawner.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
)
const it = testEffect(layer)
const sessionID = SessionID.make("ses_status_dedup")

/** Subscribe before the test publishes; the stream is scoped to the test body. */
const record = () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const statuses = yield* Ref.make<Array<SessionStatus.Info>>([])
    yield* events.subscribe(SessionStatus.Event.Status).pipe(
      Stream.runForEach((event) => Ref.update(statuses, (list) => [...list, event.data.status])),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Effect.yieldNow
    return statuses
  })

it.effect("does not publish a status equal to the current value", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const statuses = yield* record()

      // Idle is the absence of a stored entry; re-asserting it is not a transition.
      yield* status.set(sessionID, { type: "idle" })
      yield* status.set(sessionID, { type: "idle" })
      expect(yield* Ref.get(statuses)).toEqual([])

      // A bare busy repeated by the prompt loop publishes once.
      yield* status.set(sessionID, { type: "busy" })
      yield* status.set(sessionID, { type: "busy" })
      expect(yield* Ref.get(statuses)).toEqual([{ type: "busy" }])

      // busy -> idle -> idle publishes the transition once.
      yield* status.set(sessionID, { type: "idle" })
      yield* status.set(sessionID, { type: "idle" })
      expect(yield* Ref.get(statuses)).toEqual([{ type: "busy" }, { type: "idle" }])
      expect(yield* status.get(sessionID)).toEqual({ type: "idle" })
    }),
  ),
)

it.effect("dedupes equal retry and preparation statuses by value", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const statuses = yield* record()
      const retry = { type: "retry" as const, attempt: 1, message: "rate limited", next: 1_000 }

      yield* status.set(sessionID, retry)
      yield* status.set(sessionID, { ...retry })
      expect(yield* Ref.get(statuses)).toEqual([retry])

      // A changed attempt is a real transition.
      yield* status.set(sessionID, { ...retry, attempt: 2, next: 2_000 })
      expect(yield* Ref.get(statuses)).toEqual([retry, { ...retry, attempt: 2, next: 2_000 }])

      // Preparation carries the stage start time: a new start time is a transition.
      yield* status.set(sessionID, { type: "busy", preparation: { stage: "memory", startedAt: 1 } })
      yield* status.set(sessionID, { type: "busy", preparation: { stage: "memory", startedAt: 2 } })
      expect((yield* Ref.get(statuses)).slice(2)).toEqual([
        { type: "busy", preparation: { stage: "memory", startedAt: 1 } },
        { type: "busy", preparation: { stage: "memory", startedAt: 2 } },
      ])
    }),
  ),
)

it.effect("keeps the stored map in sync across deduped writes", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service

      yield* status.set(sessionID, { type: "busy" })
      yield* status.set(sessionID, { type: "busy" })
      expect(yield* status.list()).toEqual(new Map([[sessionID, { type: "busy" }]]))

      yield* status.set(sessionID, { type: "idle" })
      yield* status.set(sessionID, { type: "idle" })
      expect(yield* status.list()).toEqual(new Map())
    }),
  ),
)