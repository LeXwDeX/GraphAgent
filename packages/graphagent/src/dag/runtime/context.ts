// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagLoopContext from "./context"

import type { Context as ServiceContext, Effect, Scope } from "effect"
import type { DagMessages } from "@graphagent/core/dag/messages"
import type { DagStore } from "@graphagent/core/dag/store"
import type { Agent } from "@/agent/agent"
import type { EventV2Bridge } from "@/event-v2-bridge"
import type { Permission } from "@/permission"
import type { InstanceContext } from "@/project/instance-context"
import type { AgentScheduler } from "@/session/agent-scheduler"
import type { SessionPrompt } from "@/session/prompt"
import type { Session } from "@/session/session"
import type { WorkflowEntry } from "./entry"

/**
 * What the modules split out of the DagLoop instance closure share (#1344): the
 * services the layer read, the instance's context and scope, the table of its
 * runtime entries, and the trigger of delivery. Every module takes the fields it
 * reads (`Pick<Context, ...>`), so its dependencies are on its signature. Each
 * field is the very object the closure held, so a module and the closure see
 * the same table and the same scope.
 *
 * Operations of the closure that a module calls (`spawnReady`, `abortChild`, the
 * reconciler's `reconcileAfter`) are not fields: they are bound where they are
 * defined and handed to the module that calls them.
 */
export interface Context {
  readonly events: ServiceContext.Service.Shape<typeof EventV2Bridge.Service>
  readonly store: DagStore.Interface
  readonly messageSvc: DagMessages.Interface | undefined
  readonly agentSvc: Agent.Interface
  readonly sessionSvc: Session.Interface
  readonly promptSvc: SessionPrompt.Interface
  readonly permissionSvc: Permission.Interface | undefined
  readonly scheduler: AgentScheduler.Interface
  /** The directory instance this loop state belongs to. */
  readonly ctx: InstanceContext
  /** The scope of the instance's state: work that must outlive one handler is forked in it. */
  readonly stateScope: Scope.Scope
  /** The instance's runtime entries, by workflow id. Shared by reference with the lease, the reconciler and delivery. */
  readonly runtimes: Map<string, WorkflowEntry>
  /** The trigger of a session's delivery: forked, so a handler never waits for one. */
  readonly nudge: (sessionID: string) => Effect.Effect<void>
}

/** One scheduling round of a workflow (`spawnReady` of the loop): the dispatch every event that can ready a node runs. */
export type SpawnReady = (dagID: string) => Effect.Effect<void, Error, Scope.Scope>
