// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * One reader for the session identities a background job records (#1069 P9).
 *
 * Job metadata and persisted tool-part metadata now write `sessionID` /
 * `parentSessionID`. Jobs and parts written before the rename still carry
 * `sessionId` / `parentSessionId` (they are durable message metadata), so
 * every reader goes through these helpers: the new key wins and the legacy
 * key is only a compatibility fallback. Writers use the new key exclusively.
 *
 * The registry itself reads the identities through this module when it emits
 * transitions, so the durable `runtime_job` row and `lifecycle.transitioned`
 * agree with the keys the writers use.
 */

export const sessionIDOf = (metadata: Record<string, unknown> | undefined): string | undefined => {
  if (typeof metadata?.sessionID === "string") return metadata.sessionID
  const legacy = metadata?.sessionId
  return typeof legacy === "string" ? legacy : undefined
}

export const parentSessionIDOf = (metadata: Record<string, unknown> | undefined): string | undefined => {
  if (typeof metadata?.parentSessionID === "string") return metadata.parentSessionID
  const legacy = metadata?.parentSessionId
  return typeof legacy === "string" ? legacy : undefined
}
