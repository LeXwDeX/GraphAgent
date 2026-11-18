// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import { SessionInbox, type InboxSource, type StepSource } from "@/session/inbox"
import type { SessionID } from "@/session/schema"

/**
 * An inbox that drives nothing, for tests that call `DagDelivery.deliver`
 * themselves: delivery registers its sources with it and nudges it, and
 * nothing runs behind either. `events` is the ordered log of both
 * (`register <id>`, `registerStep <id>`, `nudge <sessionID>`), so a test can
 * assert what delivery asked for and in which order.
 */
export function recordingInbox() {
  const sources: InboxSource[] = []
  const steps: StepSource[] = []
  const nudged: string[] = []
  const events: string[] = []
  const inbox = {
    init: () => Effect.void,
    register: (source: InboxSource) =>
      Effect.sync(() => {
        sources.push(source)
        events.push(`register ${source.id}`)
      }),
    registerStep: (source: StepSource) =>
      Effect.sync(() => {
        steps.push(source)
        events.push(`registerStep ${source.id}`)
      }),
    drain: () => Effect.void,
    nudge: (sessionID: SessionID) =>
      Effect.sync(() => {
        nudged.push(sessionID)
        events.push(`nudge ${sessionID}`)
      }),
    pullForStep: () => Effect.succeed(true),
    submit: () => Effect.fail(new SessionInbox.InboxNotWired({ source: "goal.continue" })),
  } satisfies SessionInbox.Interface
  return { inbox, sources, steps, nudged, events }
}
