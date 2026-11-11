// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { makeRewriteBudget, type RewriteBudget } from "@graphagent/core/session/reasoning-distillation"
import type { ToolBudget } from "@graphagent/core/session/tool-budget"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import type { Tool } from "ai"
import { Effect, Exit, Fiber, Scope } from "effect"
import type { Agent } from "@/agent/agent"
import { registerDisposer } from "@/effect/instance-registry"
import type { TriggerResult } from "@/hook"
import type { Provider } from "@/provider/provider"
import { forgetSession, makeModelHistoryState, type ModelHistoryState } from "./history/model"
import { makeHistoryState, forgetEntry, type HistoryState } from "./history/state"
import { makeReasoningQueue } from "./reasoning-queue"
import type { RuntimeContext } from "./runtime-context"
import { RuntimeSlots } from "./runtime-slots"
import type { MessageID, SessionID } from "./schema"

/**
 * Process-wide session runtime caches (Issue #1019, PR9).
 *
 * One process can compose several ManagedRuntime layer graphs (app runtime,
 * bootstrap runtime, per-service runtimes). These caches used to live in
 * directory-scoped `InstanceState` entries, so every layer graph kept a
 * separate copy. They are now one copy per session for the whole process.
 *
 * Reclamation: ledgers never expire by size. Entries only disappear when the
 * session is deleted (`Session.Event.Deleted`) or when the instance directory
 * that first created them is disposed. `purgeDirectory` implements the latter:
 * it drops only the sessions owned by that directory, never the whole process
 * registry. H4 adds bounded, byte-sized history caches on top of this
 * registry; those may recycle independently, the fields below may not.
 */

export interface ModelSwitchRecord {
  readonly target: string
  readonly epoch: number
  readonly fiber: Fiber.Fiber<TriggerResult, never>
  unregister: () => void
}

export interface ToolBudgetState {
  active?: ToolBudget.Budget
  readonly pending: Map<MessageID, ToolBudget.Budget>
}

export interface ModelWriteState {
  epoch: number
  refs: number
}

export interface RewriteState {
  readonly budget: RewriteBudget
  readonly queue: Effect.Success<typeof makeReasoningQueue>
  readonly scope: Scope.Closeable
}

/**
 * The reusable prefix of the last prepared conversation request (Issue #1028,
 * PR5). Compaction can send its directive after the same system text and tool
 * set, so providers that cache prefixes serve most of the request from cache.
 *
 * Only the prefix is shared: the recorded system text and tools, not the
 * conversation messages. `prefixTokens` is the conservative estimate of that
 * prefix for the cost selector.
 */
export interface RequestPrefix {
  /** Instance directory that prepared the request; a session moved elsewhere cannot reuse it. */
  readonly directory: string
  /** Agent that prepared the request, so the agent prompt matches too. */
  readonly agent: Agent.Info
  readonly model: Pick<Provider.Model, "providerID" | "id">
  /** Final system text of the request, without the agent prompt that request preparation adds. */
  readonly system: readonly string[]
  /** Per-message system text that request preparation appends after `system`. */
  readonly userSystem?: string
  /** Already resolved tool record; the non-enumerable serialized fragment stays attached. */
  readonly tools: Record<string, Tool>
  readonly toolsJson?: string
  readonly toolChoice?: "auto" | "required" | "none"
  readonly permission?: PermissionV1.Ruleset
  readonly nativePermission?: PermissionV1.Ruleset
  /** Estimated tokens of `system` + `userSystem` + tools. */
  readonly prefixTokens: number
  readonly recordedAt: number
}

export interface SessionRuntimes {
  /** Pending PreModelSwitch/PostModelSwitch hook fibers, keyed by session. */
  readonly modelSwitches: Map<SessionID, ModelSwitchRecord>
  /** Hook origin of the agent that currently owns each session's scoped hooks. */
  readonly scopedAgents: Map<SessionID, string>
  /** Measured overhead of the previous prepared request, per session. */
  readonly requestOverheads: Map<SessionID, number>
  /** Serialized tool fragment of the last prepared request, per session (Issue #1022, PR5). */
  readonly requestTools: Map<SessionID, { readonly key: string; readonly json: string }>
  /** Prefix of the last conversation request, per session (Issue #1028, PR5). */
  readonly requestPrefixes: Map<SessionID, RequestPrefix>
  /** Runtime-context blocks already sent per session, so their positions stay stable. */
  readonly runtimeContexts: Map<SessionID, readonly RuntimeContext.Entry[]>
  /** State contributed by feature owners (for example DAG mode) in runtime-context slots. */
  readonly runtimeSlots: RuntimeSlots.Slots
  /** Tool budgets and their pending user-message budgets, per session. */
  readonly toolBudgets: Map<SessionID, ToolBudgetState>
  /** App-layer model-write epochs for sessions with a pending command. */
  readonly modelWrites: Map<SessionID, ModelWriteState>
  /** Budget and organizer queue for asynchronous reasoning rewrites, per directory. */
  readonly rewrites: Map<string, RewriteState>
  /** Write-through transcript cache state (Issue #1022, PR3). */
  readonly history: HistoryState
  /** Per-message model-conversion cache (Issue #1022, PR4). */
  readonly modelHistory: ModelHistoryState
  /** Directory that first created each session's cache entries. */
  readonly owners: Map<SessionID, string>
  /** Record the owning directory of a session the first time its cache is touched. */
  readonly own: (sessionID: SessionID, directory: string) => void
  /** Lazily create the directory-owned reasoning rewrite state. */
  readonly directory: (directory: string) => RewriteState
  /** Remember the serialized tools fragment for the materialization key it was built from. */
  readonly rememberToolsJson: (sessionID: SessionID, key: string, json: string) => void
  /** Drop the serialized tools fragment, used when a session moves between directories. */
  readonly forgetToolsJson: (sessionID: SessionID) => void
  /** Remember the reusable prefix of the last conversation request. */
  readonly rememberRequestPrefix: (sessionID: SessionID, prefix: RequestPrefix) => void
  /** Drop the reusable prefix after a successful compaction. */
  readonly forgetRequestPrefix: (sessionID: SessionID) => void
  /** Drop every cache entry for one session (Session.Event.Deleted). */
  readonly remove: (sessionID: SessionID) => Effect.Effect<void>
  /** Drop only the entries created by the disposed instance directory. */
  readonly purgeDirectory: (directory: string) => Promise<void>
}

/** A session reuses at most one fragment; oversized fragments skip the cache. */
const REQUEST_TOOLS_BYTES = 4 * 1024 * 1024

/**
 * Create the process-wide registry. `EngineProcess` instantiates exactly one;
 * keeping construction here lets the directory disposer close over the same
 * instance without importing `engine-process.ts` back.
 */
export function makeSessionRuntimes(): SessionRuntimes {
  const modelSwitches = new Map<SessionID, ModelSwitchRecord>()
  const scopedAgents = new Map<SessionID, string>()
  const requestOverheads = new Map<SessionID, number>()
  const requestTools = new Map<SessionID, { readonly key: string; readonly json: string }>()
  const requestPrefixes = new Map<SessionID, RequestPrefix>()
  const runtimeContexts = new Map<SessionID, readonly RuntimeContext.Entry[]>()
  const runtimeSlots = RuntimeSlots.make()
  const toolBudgets = new Map<SessionID, ToolBudgetState>()
  const modelWrites = new Map<SessionID, ModelWriteState>()
  const rewrites = new Map<string, RewriteState>()
  const owners = new Map<SessionID, string>()
  const history = makeHistoryState()
  const modelHistory = makeModelHistoryState()

  const forgetLocal = (sessionID: SessionID) => {
    const pending = modelSwitches.get(sessionID)
    if (pending) {
      pending.unregister()
      modelSwitches.delete(sessionID)
    }
    scopedAgents.delete(sessionID)
    requestOverheads.delete(sessionID)
    requestTools.delete(sessionID)
    requestPrefixes.delete(sessionID)
    runtimeContexts.delete(sessionID)
    runtimeSlots.forget(sessionID)
    toolBudgets.delete(sessionID)
    forgetEntry(history, sessionID)
    forgetSession(modelHistory, sessionID)
    // `modelWrites` is application-scoped (not directory state); a pending
    // command releases it through its refcount. Never drop it from here.
  }

  const runtimes: SessionRuntimes = {
    modelSwitches,
    scopedAgents,
    requestOverheads,
    requestTools,
    requestPrefixes,
    runtimeContexts,
    runtimeSlots,
    toolBudgets,
    modelWrites,
    rewrites,
    history,
    modelHistory,
    owners,
    own(sessionID, directory) {
      if (!owners.has(sessionID)) owners.set(sessionID, directory)
    },
    directory(directory) {
      const existing = rewrites.get(directory)
      if (existing) return existing
      const scope = Scope.makeUnsafe()
      const queue = Effect.runSync(Effect.provideService(makeReasoningQueue, Scope.Scope, scope))
      const created: RewriteState = { budget: makeRewriteBudget(), queue, scope }
      rewrites.set(directory, created)
      return created
    },
    rememberToolsJson(sessionID, key, json) {
      if (json.length > REQUEST_TOOLS_BYTES) return
      requestTools.set(sessionID, { key, json })
    },
    forgetToolsJson(sessionID) {
      requestTools.delete(sessionID)
    },
    rememberRequestPrefix(sessionID, prefix) {
      requestPrefixes.set(sessionID, prefix)
    },
    forgetRequestPrefix(sessionID) {
      requestPrefixes.delete(sessionID)
    },
    remove: (sessionID) =>
      Effect.gen(function* () {
        const pending = modelSwitches.get(sessionID)
        forgetLocal(sessionID)
        const owner = owners.get(sessionID)
        owners.delete(sessionID)
        if (pending) yield* Fiber.interrupt(pending.fiber).pipe(Effect.ignore)
        const rewrite = owner ? rewrites.get(owner) : undefined
        if (rewrite)
          yield* rewrite.queue
            .cancel(sessionID)
            .pipe(Effect.ensuring(Effect.sync(() => rewrite.budget.forget(sessionID))))
      }),
    async purgeDirectory(directory) {
      const doomed = [...owners].filter(([, owner]) => owner === directory).map(([sessionID]) => sessionID)
      for (const sessionID of doomed) {
        const pending = modelSwitches.get(sessionID)
        forgetLocal(sessionID)
        owners.delete(sessionID)
        if (pending) await Effect.runPromise(Fiber.interrupt(pending.fiber)).catch(() => undefined)
      }
      const rewrite = rewrites.get(directory)
      if (!rewrite) return
      rewrites.delete(directory)
      await Effect.runPromise(Scope.close(rewrite.scope, Exit.void)).catch(() => undefined)
    },
  }

  registerDisposer((directory) => runtimes.purgeDirectory(directory))

  return runtimes
}

export * as SessionRuntime from "./runtime"
