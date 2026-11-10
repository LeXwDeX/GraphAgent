// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Effect } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { EngineProcess } from "../engine-process"
import { MessageV2 } from "../message-v2"
import { SessionID } from "../schema"
import { HistoryCache, invalidate, version as writeVersion, type Snapshot } from "./cache"
import { freeze, type FrozenHistory } from "./freeze"

export { freeze, type FrozenHistory }

/**
 * Reads the model-visible history without walking messages older than the
 * completed compaction boundary; see [`MessageV2.filterCompactedTail`]. This is
 * an uncached rebuild: callers that need the cached read use [`get`], which
 * carries the cross-connection freshness fence.
 */
export const tail = Effect.fn("SessionHistory.tail")(function* (sessionID: SessionID) {
  return yield* MessageV2.filterCompactedTail(sessionID)
})

/**
 * Cached read of the model-visible tail. A clean entry at the current process
 * write version costs no SQL; a cold or stale entry pages the retained tail
 * under the double write fence. Callers that must tolerate writes from another
 * connection (the prompt claim path) run [`checkExternal`] first, under the
 * same prompt lock, and then read again.
 */
export const get = Effect.fn("SessionHistory.get")(function* (sessionID: SessionID) {
  const database = yield* Database.Service
  const context = yield* InstanceRef
  if (context) EngineProcess.runtimes.own(sessionID, context.directory)
  return yield* HistoryCache.get(EngineProcess.runtimes.history, { database }, sessionID)
})

/** Cross-connection freshness fence; exactly one `PRAGMA data_version` per call. */
export const checkExternal = Effect.fn("SessionHistory.checkExternal")(function* (sessionID: SessionID) {
  const database = yield* Database.Service
  return yield* HistoryCache.checkExternal(EngineProcess.runtimes.history, { database }, sessionID)
})

/** Process write version for one session, for snapshot-to-commit comparisons. */
export const version = (sessionID: SessionID): number => writeVersion(EngineProcess.runtimes.history, sessionID)

/** Drop a session's cached entry without resetting its write version. */
export const invalidateCache = (sessionID: SessionID): void => invalidate(EngineProcess.runtimes.history, sessionID)

/** Prompts that create model work boundaries; markers and ignored parts do not. */
export function isOrdinaryUser(
  message: SessionV1.WithParts,
): message is SessionV1.WithParts & { info: SessionV1.User } {
  return (
    message.info.role === "user" &&
    !MessageV2.isIgnoredUser(message) &&
    !message.parts.some((part) => part.type === "compaction" || part.type === "subtask")
  )
}

export type { Snapshot }

export * as HistoryView from "./view"
