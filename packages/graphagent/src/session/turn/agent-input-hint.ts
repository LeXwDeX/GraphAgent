// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { DagMessages } from "@graphagent/core/dag/messages"
import { Effect, Ref, Scope, Stream } from "effect"
import type { SessionID } from "../schema"

/**
 * H2 seam for the DAG mailbox freeze (Issue #1022, HS6).
 *
 * `hint` may return `false` only when this process has seen no queued change
 * for the session and no other connection committed since the last
 * authoritative freeze read. False positives are harmless: the freeze still
 * runs and governs delivery. The hint never replaces the turn-exit
 * `revisions` query.
 *
 * `version` is the `PRAGMA data_version` sample the decision was based on.
 * The caller must pass it back through `checked` after the freeze commit, so a
 * write that lands during the freeze cannot be absorbed into the baseline and
 * delay the next step's read.
 */
export interface Hint {
  readonly hint: (sessionID: SessionID) => Effect.Effect<{ readonly hint: boolean; readonly version: number }>
  readonly checked: (sessionID: SessionID, version: number) => Effect.Effect<void>
  readonly forget: (sessionID: SessionID) => Effect.Effect<void>
}

export interface Deps {
  readonly changed: Stream.Stream<DagMessages.Change>
  /** Test seam; production passes one `PRAGMA data_version` read. */
  readonly dataVersion: Effect.Effect<number>
}

const applyChange = (map: Map<string, number>, change: DagMessages.Change) => {
  const current = map.get(change.recipientSessionID) ?? 0
  if (change.kind === "queued") {
    map.set(change.recipientSessionID, current + 1)
    return
  }
  // delivered/undeliverable/closed retire a queued message. The counter floors
  // at zero for messages queued before this process subscribed.
  if (current <= 1) map.delete(change.recipientSessionID)
  else map.set(change.recipientSessionID, current - 1)
}

export const make = (deps: Deps): Effect.Effect<Hint, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pending = yield* Ref.make(new Map<string, number>())
    const baselines = yield* Ref.make(new Map<string, number>())
    yield* deps.changed.pipe(
      Stream.runForEach((change) =>
        Ref.update(pending, (map) => {
          const next = new Map(map)
          applyChange(next, change)
          return next
        }),
      ),
      Effect.forkScoped,
      Effect.asVoid,
    )
    return {
      hint: Effect.fnUntraced(function* (sessionID: SessionID) {
        const version = yield* deps.dataVersion
        const count = (yield* Ref.get(pending)).get(sessionID) ?? 0
        const baseline = (yield* Ref.get(baselines)).get(sessionID as string)
        return { hint: count > 0 || baseline === undefined || baseline !== version, version }
      }),
      checked: (sessionID, version) =>
        Ref.update(baselines, (map) => new Map(map).set(sessionID as string, version)).pipe(Effect.asVoid),
      forget: (sessionID) =>
        Effect.all(
          [
            Ref.update(pending, (map) => {
              const next = new Map(map)
              next.delete(sessionID as string)
              return next
            }),
            Ref.update(baselines, (map) => {
              const next = new Map(map)
              next.delete(sessionID as string)
              return next
            }),
          ],
          { discard: true },
        ),
    }
  })

export * as AgentInputHint from "./agent-input-hint"
