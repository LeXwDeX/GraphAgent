// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * One read of the DAG mode surface (Issue #1013 C1 / #1031 M1).
 *
 * `GET /session/:id/dag-mode` and the `/dag-mode` command receipt need the same
 * facts: availability degradation, budget usage, configured limits, and how
 * many DAG slots are live. Keeping the read here stops the HTTP wire shape and
 * the command receipt from drifting apart.
 */
import { DEFAULT_WORKFLOW_CONFIG } from "@/dag/dag"
import { Permission } from "@/permission"
import { SessionID } from "@/session/schema"
import { WorkflowStatus } from "@graphagent/core/dag/core/types"
import type { DagStore } from "@graphagent/core/dag/store"
import type { ModelV2 } from "@graphagent/core/model"
import type { ProviderV2 } from "@graphagent/core/provider"
import { Effect } from "effect"
import type { Agent } from "@/agent/agent"
import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import type { AgentScheduler } from "@/session/agent-scheduler"
import type { Session } from "@/session/session"
import { DagMode } from "./mode"
import { DagModeStatus } from "./mode-status"

export interface Deps {
  readonly sessions: Pick<Session.Interface, "get">
  readonly agents: Pick<Agent.Interface, "defaultInfo" | "get" | "list" | "permissionPolicy">
  readonly providers: Pick<Provider.Interface, "defaultModel" | "getModel">
  readonly config: Pick<Config.Interface, "dagGlobal" | "get">
  readonly dagStore: Pick<DagStore.Interface, "getWorkflowSummaries" | "listBySession">
  readonly scheduler: Pick<AgentScheduler.Interface, "capacity">
}

export interface Snapshot {
  readonly status: DagModeStatus.Status
  /** Workflows of this session that keep running after the mode is turned off. */
  readonly runningWorkflows: number
  /** DAG-wide running child slots, shared by every workflow in the process. */
  readonly running: number
  /** Effective cap of those slots (`dag.concurrency` bounded by the child pool). */
  readonly cap: number
}

/**
 * The mode the durable row currently holds. The request builder reconciles the
 * runtime slot from this instead of the session snapshot a turn loop read
 * before the loop started: a local `/dag-mode` command may land inside that
 * turn (#1031 M1).
 */
export const durableMode = Effect.fn("DagModeReader.durableMode")(function* (
  sessions: Pick<Session.Interface, "get">,
  sessionID: SessionID,
) {
  return DagMode.get(yield* sessions.get(sessionID))
})

export const read = Effect.fn("DagModeReader.read")(function* (deps: Deps, info: Session.Info) {
  const [dag, merged, capacity] = yield* Effect.all([
    deps.config.dagGlobal(),
    deps.config.get(),
    deps.scheduler.capacity(),
  ])

  const agentInfo = info.agent
    ? yield* deps.agents.get(info.agent)
    : yield* deps.agents.defaultInfo().pipe(Effect.catch(() => Effect.succeed(undefined)))
  const policy = agentInfo ? yield* deps.agents.permissionPolicy(agentInfo.name) : undefined
  const startDenied = policy
    ? Permission.disabledByPolicy(
        ["workflow"],
        policy.native,
        Permission.merge(policy.rules, info.permission ?? []),
      ).has("workflow")
    : false

  let modelRef: { providerID: ProviderV2.ID; modelID: ModelV2.ID } | undefined
  if (info.model) modelRef = { providerID: info.model.providerID, modelID: info.model.id }
  else if (agentInfo?.model) modelRef = { providerID: agentInfo.model.providerID, modelID: agentInfo.model.modelID }
  else modelRef = yield* deps.providers.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
  const model = modelRef
    ? yield* deps.providers
        .getModel(modelRef.providerID, modelRef.modelID)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
    : undefined

  const workerCatalog = yield* deps.agents.list().pipe(Effect.catch(() => Effect.succeed([])))
  const unavailableReason = DagModeStatus.unavailableReason({
    workflowToolDisabled: merged.tools?.workflow === false,
    startDenied,
    modelToolCalling: model?.capabilities.toolcall,
    hasWorker: workerCatalog.some((agent) => agent.mode === "subagent" || agent.mode === "all"),
  })

  const workflows = yield* deps.dagStore.listBySession(info.id)
  // #1031 M5 accounting: the durable attempt ledger, not the node row's
  // latest child session. getWorkflowSummaries already sums every attempt
  // (input + cache write + output + reasoning) and reports cache reads
  // separately, so a retried or budget-requeued node counts every attempt and
  // task children never leak into the budget.
  const summaries = yield* deps.dagStore.getWorkflowSummaries(info.id)
  let used = 0
  let usedCacheRead = 0
  for (const summary of summaries) {
    used += summary.tokens ?? 0
    usedCacheRead += summary.tokensCacheRead ?? 0
  }

  const runningWorkflows = workflows.filter(
    (workflow) => workflow.status === WorkflowStatus.RUNNING || workflow.status === WorkflowStatus.STEPPING,
  ).length

  return {
    status: {
      mode: info.dagMode ?? "off",
      defaultMode: dag.mode ?? "off",
      availability: unavailableReason ? ("unavailable" as const) : ("available" as const),
      unavailableReason,
      budget: {
        // #1031 M1: an explicit `budget off` means unlimited, not "inherit the
        // global `dag.budget.tokens`" — the flag keeps the two apart.
        tokens: info.dagBudgetUnlimited ? null : (info.dagBudgetTokens ?? dag.budget?.tokens ?? null),
        used,
        usedCacheRead,
        warnRatio: dag.budget?.warn_ratio ?? DagModeStatus.DEFAULT_BUDGET_WARN_RATIO,
      },
      limits: {
        concurrency: dag.concurrency ?? DEFAULT_WORKFLOW_CONFIG.maxConcurrency,
        maxTotalNodes: dag.max_total_nodes ?? DEFAULT_WORKFLOW_CONFIG.maxTotalNodes,
        running: capacity.children.dagRunning,
      },
      quality: null,
    },
    runningWorkflows,
    running: capacity.children.dagRunning,
    cap: capacity.children.dagCap,
  } satisfies Snapshot
})

export * as DagModeReader from "./mode-read"