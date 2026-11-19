// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Cause, Effect } from "effect"
import { SessionAbortReason } from "./abort-reason"
import type { Session } from "./session"
import type { SessionID } from "./schema"

export interface RemoveSessionDeps {
  readonly sessions: Pick<Session.Interface, "get" | "children" | "remove">
  /** `SessionPrompt.cancel`: the path abort takes. It returns once the runs it stopped have settled. */
  readonly cancel: (
    sessionID: SessionID,
    options?: { readonly reason?: SessionAbortReason.Info },
  ) => Effect.Effect<void>
}

/**
 * Deleting a session stops the prompt runs that still write into it first (#1558).
 *
 * `Session.remove` cancels background jobs only. A run left in flight kept
 * streaming and spending tokens (HTTP), or failed its next write against the
 * missing row once the connection pool dropped the socket (WebSocket). `Session`
 * cannot depend on `SessionPrompt`, so the orchestration lives here and every
 * delete entry point (the HTTP route, workspace removal, `session delete`) goes
 * through `SessionPrompt.removeSession`.
 *
 * The tree is stopped top-down, one level at a time. A parent's turn winds its
 * own subtask runs down through the tool abort signal, so the children listed
 * after that settles are the sessions `Session.remove` is about to cascade
 * over. A session with no run makes `cancel` a cheap no-op. A cancel that fails
 * is logged and does not block the removal, which has to work for broken
 * sessions too; only an interrupt is propagated. The turns record why they
 * stopped (`session-deleted`), as every runtime-initiated cancel does.
 *
 * A DAG node session, and everything below it, is left alone: the workflow owns
 * it. `Session.remove` cancels the workflow and the DAG loop aborts its nodes
 * under its own reasons. Stopping a node here would fail it ahead of that and
 * let its outcome reach the parent that is being deleted.
 */
export function makeRemoveSession(deps: RemoveSessionDeps) {
  const { sessions, cancel } = deps

  const stop = (sessionID: SessionID) =>
    cancel(sessionID, { reason: SessionAbortReason.make("session-deleted", "session-removal") }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("session cancel failed before removal", { sessionID, cause }),
      ),
    )

  return Effect.fn("SessionPrompt.removeSession")(function* (sessionID: SessionID) {
    // A missing session still fails here, as it does in `Session.remove`, before any cancel bumps its epoch.
    yield* sessions.get(sessionID)
    const seen = new Set<SessionID>([sessionID])
    let level: readonly SessionID[] = [sessionID]
    while (level.length > 0) {
      yield* Effect.forEach(level, stop, { concurrency: "unbounded", discard: true })
      const listed = yield* Effect.forEach(level, (id) => sessions.children(id), { concurrency: "unbounded" })
      level = listed
        .flat()
        .flatMap((child) => (child.role === "dag_node" || seen.has(child.id) ? [] : (seen.add(child.id), [child.id])))
    }
    yield* sessions.remove(sessionID)
  })
}
