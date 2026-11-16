// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Option } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { HookClientLifecycle } from "@/hook/client-lifecycle"
import { SessionAttention } from "@/notification/attention"
import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

/**
 * A local client (the TUI worker or `run`) detaches one session it opened.
 *
 * The session's own state goes first: the live status entry is cleared, which
 * cancels its pending idle-prompt timer, and so is the client attention record.
 * Then the session's local hooks end. The two clears used to sit inside
 * `HookClientLifecycle.endLocalSession`; they belong to the session domain, so
 * the hook module only ends hooks and never writes `SessionStatus` or
 * `SessionAttention` (Issue #1070).
 */
export const local = Effect.fn("ClientDetach.local")(function* (input: HookClientLifecycle.EndInput) {
  const instance = yield* (yield* InstanceStore.Service).load({ directory: input.directory })
  yield* Effect.gen(function* () {
    const status = Option.getOrUndefined(yield* Effect.serviceOption(SessionStatus.Service))
    const attention = Option.getOrUndefined(yield* Effect.serviceOption(SessionAttention.Service))
    if (status?.clear) yield* status.clear(SessionID.make(input.sessionID))
    if (attention) yield* attention.clear(input.sessionID)
  }).pipe(Effect.provideService(InstanceRef, instance))
  yield* HookClientLifecycle.endLocalSession(input)
})

export * as ClientDetach from "./client-detach"
