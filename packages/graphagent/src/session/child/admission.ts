// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Schema } from "effect"
import type { SessionID } from "../schema"
import { ChildRegistry as Registry } from "./registry"
import type { ChildRunCredential } from "./types"

/** The origin fields the guard reads; structurally satisfied by `TurnOrigin`. */
export interface Origin {
  readonly kind: string
  readonly source?: string
}

/**
 * What admission finds of the credential a driver presented for a child
 * session (Issue #1026).
 *
 * - `none`: the driver presented nothing.
 * - `live`: the credential of the session's active run.
 * - `stale`: it names this session but its run ended, or another run has the
 *   session now.
 * - `foreign`: it was issued for another child session.
 */
export type Verdict = "none" | "live" | "stale" | "foreign"

export function verdictOf(sessionID: string, credential: ChildRunCredential | undefined): Verdict {
  if (!credential) return "none"
  if (credential.childSessionID !== sessionID) return "foreign"
  return Registry.live(credential) ? "live" : "stale"
}

/**
 * The two places the credential is looked at: `admit` is the prompt admission
 * (once the session is read), `loop` is the start of the turn it admitted.
 */
export type Junction = "admit" | "loop"

/**
 * A child session's admission refused because it did not carry the live
 * credential of its active run.
 *
 * PR5 enables the guard that PR3b/PR4 only observed. The driver error is
 * typed at the admission junction (before anything is committed); at the turn
 * loop it is a defect (`Effect.orDie` in the callers), because a driver that
 * lost its run between admission and the loop start is a bug.
 */
export class Refused extends Schema.TaggedError<Refused>()("ChildAdmissionRefused", {
  sessionID: Schema.String,
  junction: Schema.Literals(["admit", "loop"]),
  verdict: Schema.Literals(["none", "stale", "foreign"]),
}) {
  override get message() {
    return `Session ${this.sessionID} refused its ${this.junction} without the live credential of its child run (${this.verdict})`
  }
}

/**
 * Origins that may drive a child session without a run credential. The shape
 * is the Issue's `ChildOriginAllowed`: DAG mailbox steps are delivered by the
 * engine to the child (the sender is guaranteed to be the main session),
 * configured hook re-entries belong to the session's own hook chain, and a
 * child result is the transcript-only report of a task the session started —
 * the receiving run may already have ended, and the result still belongs in
 * its transcript.
 */
const allowedWithoutCredential = (origin: Origin | undefined): boolean =>
  origin?.kind === "hook" ||
  (origin?.kind === "inbox" && (origin.source === "dag.mailbox.step" || origin.source === "child.result"))

/**
 * Enforces the engine guard. `admit` knows the session (and therefore
 * `parentID`); `loop` does not, so it enforces what a zero-read junction can:
 * a declared delegation (`child_run`) must carry a live credential, and a
 * carried credential must still be live. A user/inbox/hook loop start without
 * a credential is not a delegation claim and stays allowed; the admission
 * junction already refused the child prompt without one.
 *
 * A run that ended cancelled interrupts the admission/turn instead of failing
 * it: a cancellation that lands between admission and the loop start is the
 * normal task/DAG stop path, not a driver bug.
 */
export const observe = (
  junction: Junction,
  session: { readonly id: SessionID; readonly parentID?: SessionID },
  credential: ChildRunCredential | undefined,
  origin?: Origin,
): Effect.Effect<void, Refused> =>
  Effect.suspend(() => {
    const verdict = verdictOf(session.id, credential)
    const fields = { junction, sessionID: session.id, ...(credential ? { runID: credential.runID } : {}), verdict }
    if (verdict === "live") return Effect.logDebug("child run credential presented", fields)
    if (Registry.activeFor(session.id)?.outcome?.type === "cancelled") return Effect.interrupt
    if (junction === "admit") {
      if (session.parentID === undefined) return Effect.void
      if (verdict === "none" && allowedWithoutCredential(origin))
        return Effect.logDebug("child session admitted under an allowed internal origin", {
          ...fields,
          origin: origin?.kind,
        })
      return Effect.fail(new Refused({ sessionID: session.id, junction, verdict }))
    }
    // The loop junction: stale/foreign never starts a turn; a declared
    // delegation must carry a live credential even without a parentID (the
    // zero-read path `prompt.loop` uses); another origin is refused only when
    // the caller carried the session's parentID.
    if (verdict !== "none") return Effect.fail(new Refused({ sessionID: session.id, junction, verdict }))
    if (allowedWithoutCredential(origin)) return Effect.void
    if (origin?.kind === "child_run" || session.parentID !== undefined)
      return Effect.fail(new Refused({ sessionID: session.id, junction, verdict }))
    return Effect.void
  })

export * as ChildAdmission from "./admission"
