// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { EngineProcess } from "./engine-process"

export * as ClientSessions from "./client-sessions"

/**
 * Sessions opened by the in-process client (TUI worker or `run`).
 *
 * The registry exists only so client shutdown can end those sessions' local
 * hooks. It is not consulted for authorization: `run` keeps its own
 * `localSessionIDs` set because authorization is decided before a request
 * reaches the handler that records the session here.
 *
 * The map lives on `EngineProcess` so the process-level mutable state has a
 * single owner (Issue #1019, PR9), matching the cancellation and abort state.
 */

export type Entry = {
  readonly sessionID: string
  readonly directory: string
}

export function touch(input: Entry): void {
  EngineProcess.clientSessions.set(input.sessionID, input.directory)
}

export function move(input: Entry): void {
  EngineProcess.clientSessions.set(input.sessionID, input.directory)
}

export function list(): Entry[] {
  return [...EngineProcess.clientSessions].map(([sessionID, directory]) => ({ sessionID, directory }))
}

export function clear(): void {
  EngineProcess.clientSessions.clear()
}
