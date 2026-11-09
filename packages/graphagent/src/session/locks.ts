// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { Effect } from "effect"
import { SessionCancellation } from "./cancellation"
import type { SessionID } from "./schema"

/**
 * Lock witnesses (Issue #1019, PR9).
 *
 * Lock order: run request ⊃ prompt lock ⊃ publication. An inner lock may only
 * be acquired with the witness returned by its enclosing lock, so acquiring
 * them in reverse order is not expressible in the type system. The witnesses
 * are branded by one module-private symbol; no other module can forge one.
 *
 * `withRunRequest` registers the cancel request before it waits for the prompt
 * lock (invariant 1). `withPublication` is the innermost lock and callers must
 * never wait for a cancel decision while holding it.
 */

const lockWitnessKey: unique symbol = Symbol("graphagent/session-lock-witness")

export type Request = ReturnType<typeof SessionCancellation.request>

export interface RunRequestWitness extends Request {
  readonly [lockWitnessKey]: "runRequest"
}

export interface PromptLockWitness {
  readonly [lockWitnessKey]: "promptLock"
}

export interface PublicationWitness {
  readonly [lockWitnessKey]: "publication"
}

export interface SessionLocks {
  /** The raw prompt mutex, for admission paths that do not run a request. */
  readonly promptLocks: KeyedMutex.KeyedMutex<SessionID>
  readonly withRunRequest: <A, E, R>(
    sessionID: SessionID,
    use: (request: Request, witness: RunRequestWitness) => Effect.Effect<A, E, R>,
    admitted?: Request,
  ) => Effect.Effect<A, E, R>
  readonly withPromptLock: <A, E, R>(
    witness: RunRequestWitness,
    sessionID: SessionID,
    use: (witness: PromptLockWitness) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly withPublication: <A, E, R>(
    witness: PromptLockWitness,
    sessionID: SessionID,
    use: (witness: PublicationWitness) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export function makeSessionLocks(promptLocks: KeyedMutex.KeyedMutex<SessionID>): SessionLocks {
  const runWitness = (request: Request): RunRequestWitness =>
    Object.assign({}, request, { [lockWitnessKey]: "runRequest" as const }) as RunRequestWitness

  return {
    promptLocks,
    withRunRequest: (sessionID, use, admitted) =>
      Effect.suspend(() => {
        // Callers that already registered an owner reuse its identity instead
        // of opening a second request.
        if (admitted) return use(admitted, runWitness(admitted))
        const request = SessionCancellation.request(sessionID)
        return request.wait.pipe(
          Effect.andThen(Effect.suspend(() => use(request, runWitness(request)))),
          Effect.ensuring(Effect.sync(() => request.release())),
        )
      }),
    withPromptLock: (witness, sessionID, use) =>
      Effect.suspend(() => {
        void witness[lockWitnessKey]
        return promptLocks.withLock(sessionID)(use({ [lockWitnessKey]: "promptLock" as const }))
      }),
    withPublication: (witness, sessionID, use) =>
      Effect.suspend(() => {
        void witness[lockWitnessKey]
        return SessionCancellation.publication.withLock(sessionID)(use({ [lockWitnessKey]: "publication" as const }))
      }),
  }
}
