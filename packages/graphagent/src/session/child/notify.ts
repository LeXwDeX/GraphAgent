// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Cause, Effect } from "effect"
import { EngineProcess } from "../engine-process"
import type { SessionID } from "../schema"

/**
 * Wakes the session inbox that owns a directory (Issue #1026, PR3a). Every
 * loaded instance's inbox registers a route in `EngineProcess.inbox.drains`
 * under the canonical directory of the instance, so a run that ends can nudge
 * its parent without importing the inbox: the nudge is the in-process half of
 * the result delivery, the inbox tick and the startup scan are its durable
 * backstop. No loaded instance owning the directory is not an error: the rows
 * the run left wait for whichever instance loads next.
 */
export const nudge = (canonicalDirectory: string, parentSessionID: SessionID): Effect.Effect<void> =>
  Effect.suspend(() =>
    Effect.forEach(
      [...EngineProcess.inbox.drains].filter((route) => route.directory === canonicalDirectory),
      (route) =>
        route
          .drain(parentSessionID)
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logWarning("child result nudge failed", { parentSessionID, cause: Cause.pretty(cause) }),
            ),
          ),
      { concurrency: "unbounded", discard: true },
    ),
  )

export * as ChildNotify from "./notify"
