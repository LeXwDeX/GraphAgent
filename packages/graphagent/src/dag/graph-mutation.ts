// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagGraphMutation from "./graph-mutation"

import { DateTime, Effect } from "effect"
import { DagEvent } from "@graphagent/schema/dag-event"
import type { BatchEvent } from "@graphagent/core/event"
import { planReplan } from "@graphagent/core/dag/core/replan"
import {
  isWorkflowTerminalStatus,
  isNodeTerminalStatus,
  StaleNodeAttemptError,
  TerminalViolationError,
  WorkflowStatus,
  NodeStatus,
} from "@graphagent/core/dag/core/types"
import { ReplanDefinition } from "./replan-definition"
import {
  DEFAULT_WORKFLOW_CONFIG,
  computeMergedConfig,
  normalizeFragmentNode,
  normalizeNodeConfig,
  normalizeNodeDefaults,
  parseWorkflowConfig,
  persistedGateNodeIds,
  pinNodeWorkspaces,
  withoutSkipOk,
} from "./workflow-config"
import { readUserMaxTotalNodes, type DagCommandCore, type ID, type WorkflowLock } from "./command-core"
import { DagValidation, StructuralValidationError } from "./validation"
import type { NodeConfig, NodeExecutionAttempt } from "./dag"

/**
 * The graph mutations: `_replan` reshapes a workflow's graph from a fragment of
 * node definitions, and `_extend` is its additive form, which carries the
 * pending nodes forward and may reopen a naturally completed workflow. They run
 * on the one `Core` the layer built, so they see the same services and guards as
 * every other command module.
 */
export const make = (environment: DagCommandCore.Core) =>
  Effect.gen(function* () {
    const { events, store, withMailbox, guardNodeAttempt } = environment
    const _replan = Effect.fn("Dag._replan")(function* (
      lock: WorkflowLock,
      dagID: string,
      fragment: { nodes: NodeConfig[]; blockCompiled?: boolean },
      reopenCompleted = false,
      action: "extend" | "replan" = "replan",
    ) {
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      if (
        isWorkflowTerminalStatus(workflow.status as WorkflowStatus) &&
        !(reopenCompleted && workflow.status === WorkflowStatus.COMPLETED)
      ) {
        return yield* Effect.fail(new TerminalViolationError(dagID, workflow.status, "replan"))
      }
      const wfConfig = parseWorkflowConfig(workflow.config)
      if (!wfConfig) {
        return yield* Effect.fail(new Error(`Replan rejected: current workflow config is invalid: ${dagID}`))
      }
      // The persisted declaration is re-clamped against the user's CURRENT
      // global cap: lowering `dag.max_total_nodes` also bounds later growth.
      const userMaxTotalNodes = yield* readUserMaxTotalNodes()
      // #1030 D9-g: completed settlement removes the workflow worktree while
      // keeping its branch. Reopening the graph would spawn into a missing
      // execution directory (workspace_missing) with no live worktree to
      // restore. Failed/cancelled workflows keep their worktree, so recovery
      // remains valid. Reject the reopen explicitly instead of failing later.
      if (reopenCompleted && wfConfig.isolation === "worktree") {
        return yield* Effect.fail(
          new Error(
            `Reopen rejected: workflow ${dagID} used workflow-level worktree isolation; completion settled its worktree and removed the directory (branch "${wfConfig.worktree?.branch ?? "<unknown>"}" is kept). Start a bounded successor workflow from the desired target instead`,
          ),
        )
      }
      const defaults = normalizeNodeDefaults(wfConfig.node_defaults)
      const cfgById = new Map(wfConfig.nodes.map((n) => [n.id, n]))
      // #943: direct Dag service callers bypass the authoring boundary. Pin
      // node workspaces to canonical realpaths before the definition reaches
      // the merged config; invalid values are an ordinary Effect failure.
      const fragmentNodes = yield* Effect.try({
        try: () => pinNodeWorkspaces(fragment.nodes, workflow.directory ?? ""),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      const normalizedFragment = {
        nodes: fragmentNodes.map((node) =>
          normalizeFragmentNode(node, cfgById.get(node.id), defaults),
        ),
      }
      const nodes = yield* store.getNodes(dagID)
      const plan = planReplan(
        {
          nodes: nodes.map((n) => ({
            id: n.id,
            status: n.status as never,
            depends_on: n.dependsOn,
            superseded: n.superseded,
          })),
        },
        {
          nodes: normalizedFragment.nodes.map((n) => ({
            id: n.id,
            depends_on: n.depends_on,
            restart: n.restart,
            cancel: n.cancel,
          })),
        },
      )
      if (plan.errors.length > 0) return yield* Effect.fail(new Error(`Replan rejected: ${plan.errors.join("; ")}`))

      const nodeStatusById = new Map(nodes.map((n) => [n.id, n.status]))
      const definitionErrors: string[] = []
      // #1158: `expand` and `join` are the engine's marks on a compose node, and no definition a caller writes in can
      // carry them, so restating such a node drops them. A pending node is replaced by its restatement and a running
      // one is redefined by a restart, which is where a mark would be lost and the node would go on as an ordinary
      // one (a slot spawned as authored, a join node no longer checked). A running or queued node that is neither is
      // held by the admitted-field guard below, and a terminal one keeps its definition.
      for (const next of normalizedFragment.nodes) {
        const status = nodeStatusById.get(next.id)
        if (next.cancel || !(status === NodeStatus.PENDING || (status === NodeStatus.RUNNING && next.restart))) continue
        const current = cfgById.get(next.id)
        if (!current) continue
        const marks = ReplanDefinition.changedEngineOwnedFields(current, next)
        if (marks.length === 0) continue
        definitionErrors.push(
          `Node "${next.id}" carries ${marks.join(", ")}, which belongs to the engine's compose expansion; a replan cannot change or clear it. Cancel the node (cancel: true) and add a replacement under a new id`,
        )
      }
      for (const next of normalizedFragment.nodes) {
        if (next.cancel || next.restart) continue
        const status = nodeStatusById.get(next.id)
        if (status !== NodeStatus.RUNNING && status !== NodeStatus.QUEUED) continue
        const current = cfgById.get(next.id)
        if (!current) {
          definitionErrors.push(
            `Node "${next.id}" is ${status}, but its current execution definition is unavailable and cannot be safely replaced`,
          )
          continue
        }
        const fields = ReplanDefinition.changedAdmittedNodeFields(
          withoutSkipOk(normalizeNodeConfig(current, defaults)),
          withoutSkipOk(next),
          { allowTimeoutUpdate: status === NodeStatus.RUNNING },
        )
        if (fields.length === 0) continue
        definitionErrors.push(
          status === NodeStatus.RUNNING
            ? `Node "${next.id}" is running and changes admitted execution fields without restart: ${fields.join(", ")}; set restart: true to apply the new definition`
            : `Node "${next.id}" is ${status} and changes already captured execution fields: ${fields.join(", ")}; ${status} nodes cannot restart, so cancel it and add a replacement node under a new id`,
        )
      }
      if (definitionErrors.length > 0) {
        return yield* Effect.fail(new Error(`Replan rejected: ${definitionErrors.join("; ")}`))
      }

      // Fragment nodes that will actually (re)run must satisfy the same
      // condition-reference rule as create. Terminal nodes in the fragment are
      // ignored by the plan and keep their immutable definitions; cancelled
      // nodes never evaluate a condition again.
      const rerunNodes = normalizedFragment.nodes.filter((n) => {
        if (n.cancel) return false
        const status = nodeStatusById.get(n.id)
        return status === undefined || !isNodeTerminalStatus(status as NodeStatus)
      })

      // Structural validation through the SAME authority as create — condition,
      // binding, dangling-dep, ceiling, review-lifecycle, and topology checks
      // all run through DagValidation.replanStructuralDiagnostics (which reuses
      // the exact same helper functions as structuralDiagnostics). This is the
      // create/replan parity the spec requires: one authority, two entry points
      // that differ only in scoping (fragment + rerun-only vs whole-graph).
      const maxReplanAttempts = wfConfig.max_node_replan_attempts ?? DEFAULT_WORKFLOW_CONFIG.maxNodeReplanAttempts
      const terminalNodeIds = new Set(
        nodes.filter((n) => isNodeTerminalStatus(n.status as NodeStatus)).map((n) => n.id),
      )
      const merged = computeMergedConfig(wfConfig, normalizedFragment, plan)
      const replanDiagnostics = DagValidation.replanStructuralDiagnostics({
        fragmentNodes: normalizedFragment.nodes,
        rerunNodes,
        existingNodeIds: new Set(nodes.map((n) => n.id)),
        existingNodeCount: nodes.length,
        addCount: plan.add.length,
        merged,
        action,
        config: {
          mode: wfConfig.mode,
          max_total_nodes: wfConfig.max_total_nodes,
          user_max_total_nodes: userMaxTotalNodes,
        },
        isolation: wfConfig.isolation,
        terminalNodeIds,
        grandfatheredNodeIds: persistedGateNodeIds(merged.nodes, cfgById),
        ...(fragment.blockCompiled === true ? { compiler_owns_skip_ok: true } : {}),
      })
      const replanErrors = DagValidation.sortDiagnostics(replanDiagnostics.filter((d) => d.severity === "error"))
      for (const warning of replanDiagnostics.filter((d) => d.severity === "warning")) {
        yield* Effect.logWarning("DAG structural validation diagnostic", { diagnostic: warning })
      }
      if (replanErrors.length > 0) {
        return yield* Effect.fail(new StructuralValidationError({ diagnostics: replanErrors }))
      }

      const nodeById = new Map(nodes.map((n) => [n.id, n]))
      const ceilingBreached: string[] = []
      const batch: BatchEvent[] = []
      for (const id of plan.restart) {
        const existing = nodeById.get(id)
        if (existing && existing.replanAttempts >= maxReplanAttempts) {
          batch.push({
            definition: DagEvent.NodeFailed,
            data: {
              dagID: DagEvent.DagID.make(dagID),
              nodeID: DagEvent.NodeID.make(id),
              reason: "replan attempt ceiling exceeded",
              trigger: "exec_failed",
              timestamp: yield* DateTime.now,
            },
          })
          ceilingBreached.push(id)
        }
      }
      const effectiveRestart = plan.restart.filter((id) => !ceilingBreached.includes(id))

      const fragmentById = new Map(normalizedFragment.nodes.map((n) => [n.id, n]))
      for (const id of plan.add) {
        const node = fragmentById.get(id)!
        batch.push({
          definition: DagEvent.NodeRegistered,
          data: {
            dagID: dagID as ID,
            nodeID: id as never,
            name: node.name,
            workerType: node.worker_type,
            dependsOn: node.depends_on.map((d) => d as never),
            required: node.required,
            model: node.model as never,
            timestamp: yield* DateTime.now,
          },
        })
      }
      // Replaced nodes: re-publish NodeRegistered so the projector upserts the
      // new definition (worker_type, model, depends_on) into the read-model row.
      for (const id of plan.replace) {
        const node = fragmentById.get(id)
        if (!node) continue
        batch.push({
          definition: DagEvent.NodeRegistered,
          data: {
            dagID: dagID as ID,
            nodeID: id as never,
            name: node.name,
            workerType: node.worker_type,
            dependsOn: node.depends_on.map((d) => d as never),
            required: node.required,
            model: node.model as never,
            timestamp: yield* DateTime.now,
          },
        })
      }
      for (const id of plan.cancel) {
        batch.push({
          definition: DagEvent.NodeCancelled,
          data: {
            dagID: dagID as ID,
            nodeID: id as never,
            source: "replan",
            timestamp: yield* DateTime.now,
          },
        })
      }
      for (const id of effectiveRestart) {
        // A restart re-spawns with the fragment's definition — the new
        // depends_on must reach the durable row BEFORE the runtime rebuilds
        // its graph from store.getNodes (WorkflowReplanned handler), or the
        // restarted node keeps its stale edges and is re-ready under them.
        // Mirrors the replace bucket's NodeRegistered re-publish.
        const node = fragmentById.get(id)
        if (node) {
          batch.push({
            definition: DagEvent.NodeRegistered,
            data: {
              dagID: dagID as ID,
              nodeID: id as never,
              name: node.name,
              workerType: node.worker_type,
              dependsOn: node.depends_on.map((d) => d as never),
              required: node.required,
              model: node.model as never,
              timestamp: yield* DateTime.now,
            },
          })
        }
        batch.push({
          definition: DagEvent.NodeRestarted,
          data: {
            dagID: dagID as ID,
            nodeID: id as never,
            childSessionID: (nodeById.get(id)?.childSessionId ?? "") as never,
            timestamp: yield* DateTime.now,
          },
        })
      }

      // #6: build effective plan that excludes ceiling-breached restarts
      const effectivePlan = { ...plan, restart: effectiveRestart }
      // A failed row leaves the current revision only when the merged graph
      // routes around it. While a node that can still execute depends on it,
      // superseding would drop that edge from the rebuilt graph and run the
      // dependent as a root despite its failed upstream.
      const cancelled = new Set(effectivePlan.cancel)
      const liveDependencies = new Set([
        ...nodes
          .filter((n) => !terminalNodeIds.has(n.id) && !cancelled.has(n.id) && !ceilingBreached.includes(n.id))
          .flatMap((n) => fragmentById.get(n.id)?.depends_on ?? n.dependsOn),
        ...effectivePlan.add.flatMap((id) => fragmentById.get(id)?.depends_on ?? []),
      ])

      // Persist the merged config using the effective plan (without ceiling-breached restarts)
      const mergedConfig = computeMergedConfig(wfConfig, normalizedFragment, effectivePlan)
      batch.push({
        definition: DagEvent.WorkflowConfigUpdated,
        data: {
          dagID: dagID as ID,
          config: JSON.stringify(mergedConfig),
          timestamp: yield* DateTime.now,
        },
      })

      // #7: max_total_nodes check is non-atomic (read-then-publish). This is
      // acceptable because the ceiling is a fail-safe, not a correctness
      // invariant — concurrent replans slightly exceeding the limit is better
      // than serializing all replans. The projector's INSERT ON CONFLICT
      // ensures no duplicate node IDs.
      batch.push({
        definition: DagEvent.WorkflowReplanned,
        data: {
          dagID: dagID as ID,
          added: effectivePlan.add.length as never,
          removed: effectivePlan.cancel.length as never,
          replaced: effectivePlan.replace.length as never,
          restarted: effectivePlan.restart.length as never,
          // Rev-view (v1.0.15 Train A): the terminal-FAILED rows at replan time
          // are the segment the new revision replaces — left in the rebuild
          // input they re-seed as required-unsatisfied and weld the workflow to
          // failure (the wake-up bug this train breaks). plan.cancel rows are
          // marked superseded by the NodeCancelled projection instead; this
          // list carries the genuine failures the fragment bypasses, which the
          // engine never cancels. Durable rows stay untouched. A failure that a
          // surviving node still depends on stays current (see liveDependencies).
          superseded: nodes
            .filter((n) => n.status === "failed" && !liveDependencies.has(n.id))
            .map((n) => DagEvent.NodeID.make(n.id)),
          timestamp: yield* DateTime.now,
        },
      })
      yield* withMailbox(dagID, undefined, events.publishMany(batch))
      return {
        cancel: effectivePlan.cancel,
        restart: effectivePlan.restart,
        replace: effectivePlan.replace,
        add: effectivePlan.add,
        ignore: effectivePlan.ignore,
      }
    })

    const _extend = Effect.fn("Dag._extend")(function* (
      lock: WorkflowLock,
      dagID: string,
      newNodes: NodeConfig[],
      fence?: { nodeID: string; attempt: NodeExecutionAttempt },
      options?: { blockCompiled?: boolean },
    ) {
      const wf = yield* store.getWorkflow(dagID)
      if (!wf) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      const nodes = yield* store.getNodes(dagID)
      if (fence) {
        // Checked under the same lock that applies the mutation: a parent
        // replan or cancel between the scheduling snapshot and here wins.
        const fenced = nodes.find((node) => node.id === fence.nodeID)
        if (!fenced) return yield* Effect.fail(new Error(`Node not found: ${fence.nodeID}`))
        yield* guardNodeAttempt(fenced, wf.graphRev, fence.attempt)
        // Only a still-pending writer may be reshaped; anything else is a
        // stale attempt even when the caller supplied no node sequence.
        if (fenced.status !== "pending") {
          return yield* Effect.fail(
            new StaleNodeAttemptError(fence.nodeID, fence.attempt, {
              replanAttempts: fenced.replanAttempts,
              nodeSeq: fenced.seq,
              childSessionID: fenced.childSessionId,
              graphRev: wf.graphRev,
            }),
          )
        }
      }
      const config = parseWorkflowConfig(wf.config)
      const cfgById = new Map((config?.nodes ?? []).map((n) => [n.id, n]))
      const newIds = new Set(newNodes.map((n) => n.id))
      // extend is additive: carry forward pending/queued nodes (with their
      // existing config definition) so replan treats them as "replace" (preserved)
      // rather than "supersede" (cancelled). Running nodes are intentionally
      // excluded — the merged config (computeMergedConfig: surviving = every
      // non-cancel node) already keeps a running node's definition whether or
      // not the fragment mentions it, so there is nothing to carry forward.
      // Note (§3.7): the WorkflowReplanned handler re-times a running survivor
      // only when the replan carries a NEW worker_config.timeout_ms for it
      // (deadline = now + new timeout). Unchanged/omitted timeout keeps the
      // current deadline and the extension count is never reset by an extend.
      // Terminal nodes are immutable and need no preservation.
      const toPreserve = nodes.filter(
        (n) =>
          !newIds.has(n.id) &&
          (n.status === NodeStatus.PENDING || n.status === NodeStatus.QUEUED),
      )
      if (toPreserve.length > 0 && !config) {
        return yield* Effect.fail(
          new Error(
            `Cannot extend: workflow config is unparseable — would silently cancel ${toPreserve.length} pending node(s)`,
          ),
        )
      }
      const preserved = toPreserve.map((n) => cfgById.get(n.id)).filter((n): n is NodeConfig => n !== undefined)
      const configuredNodes = config?.nodes ?? []
      // Leaf qualification runs on the RUNTIME topology, not the static config:
      // a dependent that was skipped (condition_false / orphan_cascade) never
      // executed, so the graph effectively ended at the checkpoint and the
      // naturally-completed workflow may still be reopened by additive extend.
      // Dependents that completed or failed continued the graph past the
      // checkpoint and block the exception. Row statuses are compared as
      // plain strings (loop.ts convention) — enum casts on read-model rows
      // trip the lint ratchet.
      const executedDependents = (nodeID: string) =>
        nodes.filter(
          (candidate) =>
            candidate.dependsOn.includes(nodeID) && (candidate.status === "completed" || candidate.status === "failed"),
        )
      const checkpointCandidates = nodes.filter(
        (node) =>
          node.status === "completed" &&
          node.wakeEligible &&
          configuredNodes.some((candidate) => candidate.id === node.id),
      )
      const hasReportingLeafCheckpoint = checkpointCandidates.some((node) => executedDependents(node.id).length === 0)
      const addsNewNode = newNodes.some((node) => !nodes.some((existing) => existing.id === node.id))
      const earlyCompleted = nodes.some((node) => node.errorReason === "agent_complete")
      const reopenCompleted = wf.status === "completed" && addsNewNode && hasReportingLeafCheckpoint && !earlyCompleted
      function reopenDenial(workflowStatus: string): string | undefined {
        if (workflowStatus !== "completed")
          return "only a naturally completed workflow can be reopened — failed and cancelled workflows are immutable; start a new workflow reusing their completed outputs as static input"
        if (!addsNewNode) return "the fragment adds no new node ids — an additive reopen requires at least one new node"
        if (earlyCompleted)
          return "the workflow was completed early via control(complete); early completion stays terminal"
        if (checkpointCandidates.length === 0)
          return "no wake-eligible reporting checkpoint completed the graph — only a naturally completed reporting-leaf checkpoint may be reopened"
        const blockers = [
          ...new Set(
            checkpointCandidates.flatMap((node) => executedDependents(node.id).map((dependent) => dependent.id)),
          ),
        ]
        return `reporting checkpoint(s) ${checkpointCandidates.map((node) => `"${node.id}"`).join(", ")} are followed by executed dependent(s) ${blockers.map((id) => `"${id}"`).join(", ")} — the graph continued past the checkpoint`
      }
      // A terminal atomic wake may ask the parent to add the next bounded wave.
      // Keep the exception private to naturally completed additive extension;
      // an early control(complete) leaves an agent_complete marker and remains
      // terminal, as do public replan and non-additive terminal mutations.
      const wfTerminal =
        wf.status === "completed" || wf.status === "failed" || wf.status === "cancelled"
      if (wfTerminal && !reopenCompleted) {
        return yield* Effect.fail(new TerminalViolationError(dagID, wf.status, "extend", reopenDenial(wf.status)))
      }
      // Internal call to _replan — shares the caller's lock holding period,
      // does NOT re-acquire the per-workflow lock or go through Service.of.
      return yield* _replan(
        lock,
        dagID,
        { nodes: [...preserved, ...newNodes], ...(options?.blockCompiled === true ? { blockCompiled: true } : {}) },
        reopenCompleted,
        "extend",
      )
    })

    return {
      _replan,
      _extend,
    }
  })
