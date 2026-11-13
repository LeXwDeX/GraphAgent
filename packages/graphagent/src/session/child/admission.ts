// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import type { SessionID } from "../schema"
import { ChildRegistry as Registry } from "./registry"
import type { ChildRunCredential } from "./types"

/**
 * What admission finds of the credential a driver presented for a child
 * session (Issue #1026, PR3b).
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
 * PR3b lays the credential down and only records what it finds at the two
 * junctions: it refuses nothing. A credential that names another session or
 * another run is a driver's bug, so it is logged as one; a child session
 * admitted with none (the DAG until PR4, the SDK) is not, because it is
 * expected. PR5 turns this into the refusal.
 *
 * `parentID` is known at `admit` only; a session without one is never owed a
 * credential.
 */
export const observe = (
  junction: Junction,
  session: { readonly id: SessionID; readonly parentID?: SessionID },
  credential: ChildRunCredential | undefined,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const verdict = verdictOf(session.id, credential)
    const fields = { junction, sessionID: session.id, ...(credential ? { runID: credential.runID } : {}), verdict }
    if (verdict === "live") return Effect.logDebug("child run credential presented", fields)
    if (verdict === "none")
      return session.parentID === undefined
        ? Effect.void
        : Effect.logDebug("child session admitted without a run credential", fields)
    return Effect.logWarning("child run credential does not belong to the session's active run", fields)
  })

export * as ChildAdmission from "./admission"
