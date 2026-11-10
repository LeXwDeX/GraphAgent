// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Layer, Queue, Ref, Stream } from "effect"
import { DagMessages } from "@graphagent/core/dag/messages"
import { SessionID } from "@/session/schema"
import { AgentInputHint } from "@/session/turn/agent-input-hint"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const session = SessionID.make("ses_hint_recipient")
const other = SessionID.make("ses_hint_other")

const change = (recipient: SessionID, kind: DagMessages.Change["kind"], seq: number): DagMessages.Change => ({
  recipientSessionID: recipient,
  directory: "/tmp",
  kind,
  mailboxVersion: seq,
})

// The hint consumes its change stream on a daemon fiber, so publish is not a
// processing signal. Poll the public API until the expectation settles.
const eventually = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
  label: string,
): Effect.Effect<A, E | Error, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.yieldNow
    }
    throw new Error(`${label} did not settle`)
  })

describe("session.agent-input-hint", () => {
  it.effect("skips the freeze only after an authoritative read absorbed the current data version", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<DagMessages.Change>()
      const version = yield* Ref.make(1)
      const hint = yield* AgentInputHint.make({
        changed: Stream.fromQueue(changes),
        dataVersion: Ref.get(version),
      })

      // No baseline yet: the first turn must always run the authoritative read.
      const initial = yield* hint.hint(session)
      expect(initial).toEqual({ hint: true, version: 1 })

      yield* hint.checked(session, initial.version)
      expect(yield* hint.hint(session)).toEqual({ hint: false, version: 1 })

      // Another connection committed: the data version moved even though this
      // process saw no mailbox change event.
      yield* Ref.set(version, 2)
      expect(yield* hint.hint(session)).toEqual({ hint: true, version: 2 })

      yield* hint.checked(session, 2)
      expect((yield* hint.hint(session)).hint).toBe(false)
    }),
  )

  it.effect("keeps the hint true while a queued mailbox change is outstanding and clears it on delivery", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<DagMessages.Change>()
      const version = yield* Ref.make(7)
      const hint = yield* AgentInputHint.make({
        changed: Stream.fromQueue(changes),
        dataVersion: Ref.get(version),
      })

      const initial = yield* hint.hint(session)
      yield* hint.checked(session, initial.version)
      expect((yield* hint.hint(session)).hint).toBe(false)

      yield* Queue.offer(changes, change(session, "queued", 1))
      const queued = yield* eventually(hint.hint(session), (value) => value.hint, "queued mailbox change")
      // Absorbing the data version does not absorb an outstanding message.
      yield* hint.checked(session, queued.version)
      expect((yield* hint.hint(session)).hint).toBe(true)

      yield* Queue.offer(changes, change(session, "delivered", 2))
      yield* eventually(hint.hint(session), (value) => !value.hint, "delivered mailbox change")
    }),
  )

  it.effect("ignores changes for other sessions, floors at zero, and forgets deleted sessions", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<DagMessages.Change>()
      const version = yield* Ref.make(3)
      const hint = yield* AgentInputHint.make({
        changed: Stream.fromQueue(changes),
        dataVersion: Ref.get(version),
      })

      yield* hint.checked(session, (yield* hint.hint(session)).version)
      yield* Queue.offer(changes, change(other, "queued", 1))
      yield* eventually(hint.hint(other), (value) => value.hint, "queued change for the other session")
      expect((yield* hint.hint(session)).hint).toBe(false)

      // A retirement for a mailbox queued before this process subscribed must
      // not push the counter negative and mask a later queued change.
      yield* Queue.offer(changes, change(session, "delivered", 2))
      yield* Queue.offer(changes, change(session, "queued", 3))
      yield* eventually(hint.hint(session), (value) => value.hint, "queued change after an unmatched retirement")

      yield* hint.forget(session)
      expect(yield* hint.hint(session)).toEqual({ hint: true, version: 3 })
    }),
  )
})
