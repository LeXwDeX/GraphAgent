// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { SessionAdmission } from "@graphagent/core/session/admission"
import type { Deferred, Effect } from "effect"
import { makeSessionRuntimes, type SessionRuntimes } from "./runtime"

/**
 * Process-wide engine state (Issue #1019, PR9).
 *
 * One process composes several ManagedRuntime layer graphs: `app-runtime.ts`,
 * `bootstrap-runtime.ts` and every runtime created by `run-service.ts`. Cancel
 * admission, cancellation epochs, abort reasons and the per-session caches
 * must be shared by all of them, so this module owns the only mutable
 * process-level registry. Other modules may not define module-level mutable
 * Maps or Sets; they read the state below instead.
 *
 * H2 adds the ExclusiveRegistry and AgentScheduler here; H3 adds the active
 * ChildRun table. The object is intentionally the single addition point.
 */

export interface CancellationOwner {
  readonly epoch: number
  readonly directory?: string
  readonly snapshot: () => Effect.Effect<void>
}

export interface CancellationSession {
  epoch: number
  requests: number
  aborts: number
  goalCancels: number
  goalReleased?: Deferred.Deferred<void>
  owners: Set<CancellationOwner>
  barrier?: Effect.Effect<void>
}

export interface CancellationState {
  readonly sessions: Map<string, CancellationSession>
  readonly epochs: Map<string, number>
  /** Publication is innermost: never wait for a cancel decision while holding it. */
  readonly publication: KeyedMutex.KeyedMutex<string>
  /** The admission registry must be shared by every layer graph in this process. */
  readonly admissions: ReturnType<typeof SessionAdmission.make>
}

/** Runtime-initiated abort reasons, remembered until the interrupted turn finalizes its durable error. */
export interface AbortReasonState {
  readonly pending: Map<string, { readonly reason: string; readonly actor: string }>
}

/**
 * One loaded instance's inbox drain (Issue #1021, PR1). The inbox registers a
 * route when the instance boots and removes it from the instance scope, so a
 * process-level nudge can reach the instance that owns a session's directory
 * even when the caller lives in another layer graph.
 */
export interface InboxDrainRoute {
  readonly directory: string
  readonly drain: (sessionID: string) => Effect.Effect<void>
}

/** Session-inbox routing shared by every layer graph in the process. */
export interface InboxRouting {
  readonly drains: Set<InboxDrainRoute>
}

export interface EngineProcess {
  readonly runtimes: SessionRuntimes
  readonly cancellation: CancellationState
  readonly abort: AbortReasonState
  /** Sessions opened by the in-process client, used only to end their local hooks on shutdown. */
  readonly clientSessions: Map<string, string>
  readonly inbox: InboxRouting
}

export const EngineProcess: EngineProcess = {
  runtimes: makeSessionRuntimes(),
  cancellation: {
    sessions: new Map(),
    epochs: new Map(),
    publication: KeyedMutex.makeUnsafe<string>(),
    admissions: SessionAdmission.make(),
  },
  abort: {
    pending: new Map(),
  },
  clientSessions: new Map<string, string>(),
  inbox: {
    drains: new Set(),
  },
}
