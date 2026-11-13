// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the admission stub hands back an unstarted turn handle and a hand-built message

import { Database } from "@graphagent/core/database/database"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Deferred, Effect, Scope } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionCancellation } from "@/session/cancellation"
import { ChildResults } from "@/session/child/result-source"
import type { InboxSource, Interface as InboxInterface } from "@/session/inbox"
import type { Interface as PromptInterface, PromptInput } from "@/session/prompt"
import { MessageID, type SessionID } from "@/session/schema"
import { AdmissionPersistFailed } from "@/session/turn/prepare"
import type { AdmissionExtras, AdmissionOptions, TurnStart } from "@/session/turns"

/** One admission the `child.result` source made into a parent session. */
export interface Admitted {
  readonly input: PromptInput
  readonly options: AdmissionOptions | undefined
  readonly extras: AdmissionExtras | undefined
  /** The admission had no `noReply`: the source meant the parent to start or join a turn. */
  readonly turn: boolean
}

/**
 * The `child.result` source over the test database with a recording admission
 * port (Issue #1026, PR3a), so a test can deliver what a finished run owes the
 * way an inbox drain does, deterministically and without a model.
 *
 * The port commits like the real one: `persistAdmission` runs inside one
 * immediate transaction and its failure surfaces as `AdmissionPersistFailed`,
 * so a delivery that loses the ledger mark leaves nothing behind. It does not
 * write a message; the transcript is the model's business, the ledger is not.
 *
 * `directory` is the one the parent sessions were created in; it defaults to
 * the ambient instance's. `failAfterMark` makes the port fail inside the
 * transaction after the ledger mark ran, the way a message write that does not
 * commit would, so a test can see the mark roll back with it. `barrier` holds
 * every admission at the port until that many have arrived, so concurrent
 * claims all read their owed rows before any of them commits. `inbox` is a real
 * inbox to register the source with; by default a stub records the
 * registration and the startup drains, and the test claims the source itself.
 */
export const resultDelivery = (
  options: {
    readonly directory?: string
    readonly failAfterMark?: boolean
    readonly barrier?: number
    readonly inbox?: Pick<InboxInterface, "register" | "drain">
  } = {},
) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope
    const directory = options.directory ?? (yield* InstanceState.directory)
    const admitted: Admitted[] = []
    let source: InboxSource | undefined
    const drains: SessionID[] = []
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
          admitted.push({ input, options: admissionOptions, extras, turn: input.noReply !== true })
          const message = {
            info: { id: MessageID.ascending(), sessionID: input.sessionID, role: "user", time: { created: 0 } },
            parts: [],
          } as unknown as SessionV1.WithParts
          return {
            admission:
              input.noReply === true
                ? ({ kind: "not_started", reason: "admission_declined" } as const)
                : ({ kind: "started", turn: undefined as never } as const),
            message,
            wait: Effect.succeed(message),
          } satisfies TurnStart
        }),
    }
    yield* ChildResults.make({
      db,
      inbox: options.inbox ?? {
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
    const registered = (): InboxSource => {
      if (!source) throw new Error("the child.result source was not registered")
      return source
    }
    /**
     * One inbox claim for `sessionID`, as the drain makes it. `claimEpoch` defaults to the epoch observed now;
     * pass an earlier one to stand for an ESC that landed after the claim began.
     */
    const claim = (sessionID: SessionID, claimEpoch?: number) =>
      registered().claim(sessionID, { directory, claimEpoch: claimEpoch ?? SessionCancellation.epoch(sessionID) })
    return { admitted, drains, source: registered, claim, directory }
  })
