// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagWorkflowRecover from "./workflow-recover"

import { DateTime, Effect } from "effect"
import { DagEvent } from "@graphagent/schema/dag-event"
import type { BatchEvent } from "@graphagent/core/event"
import { isNodeTerminalStatus } from "@graphagent/core/dag/core/types"
import type { NodeStatus } from "@graphagent/core/dag/core/types"
import { targetSensitiveNode } from "./review-lifecycle"
import { DEFAULT_WORKFLOW_CONFIG, parseWorkflowConfig, reconcileDeliveryNode } from "./workflow-config"
import { ID, NodeID, readUserMaxTotalNodes, type DagCommandCore, type WorkflowLock } from "./command-core"
import { DagValidation, StructuralValidationError } from "./validation"
import { DagLocation } from "./location"
import { SessionID } from "@/session/schema"
import { planRecovery } from "./recovery-plan"
import { verifyOutputFileRef } from "./runtime/output-ref"
import type { Interface } from "./dag"

/**
 * The recovery commands: `recover` turns the unfinished work of a paused,
 * failed or cancelled workflow into fresh node attempts, and `retarget` moves a
 * workflow to another execution target and restarts its running
 * target-sensitive nodes. They run on the one `Core` the layer built, so they
 * see the same services and guards as every other command module.
 */
export const make = (environment: DagCommandCore.Core) =>
  Effect.gen(function* () {
    const { events, store, withMailbox, withWorkflowLock, transact, command, guardWorkflowNotTerminal } = environment
    const recover: Interface["recover"] = Effect.fn("Dag.recover")(function* (dagID, input) {
      const workflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      if (!Number.isSafeInteger(input.expectedGraphRev) || input.expectedGraphRev !== workflow.graphRev) {
        return yield* Effect.fail(
          new Error(`Recovery rejected: stale expected_graph_rev; current graph_rev is ${workflow.graphRev}`),
        )
      }
      if (workflow.status !== "paused" && workflow.status !== "failed" && workflow.status !== "cancelled") {
        return yield* Effect.fail(
          new Error(
            workflow.status === "completed"
              ? `Recovery requires a paused or failed workflow; ${workflow.status} cannot recover. It is terminal: if in-scope work remains, extend it when allowed or start a bounded successor workflow that reuses its valid outputs — no user approval is needed for work the original request already covers`
              : `Recovery requires a paused or failed workflow; ${workflow.status} cannot recover (pause live scheduling first)`,
          ),
        )
      }
      if (workflow.status === "cancelled" && !input.resumeCancelled) {
        return yield* Effect.fail(
          new Error("Recovery of a cancelled workflow requires explicit resume_cancelled: true"),
        )
      }
      const config = parseWorkflowConfig(workflow.config)
      if (!config) return yield* Effect.fail(new Error(`Recovery cannot read the workflow definition: ${dagID}`))
      const nodes = yield* store.getNodes(dagID)
      // #1344: read outside the workflow mutex and the transaction, like the
      // artifact hashing below; the sequence fences rechecked there cover it.
      const targetFingerprint = yield* DagLocation.fingerprintTarget(workflow.executionDirectory || workflow.directory)
      const plan = yield* Effect.try({
        try: () =>
          planRecovery(
            config,
            nodes,
            input.nodeIDs,
            workflow.graphRev + 1,
            config.max_node_replan_attempts ?? DEFAULT_WORKFLOW_CONFIG.maxNodeReplanAttempts,
            targetFingerprint,
          ),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      const selected = config.delivery_node
      const replacement = plan.replacements.find((node) => node.previous === selected)
      plan.config = reconcileDeliveryNode(
        { ...plan.config, ...(replacement ? { delivery_node: replacement.current } : {}) },
        config,
      )
      const addedIDs = new Set(plan.replacements.map((replacement) => replacement.current))
      const added = plan.config.nodes.filter((node) => addedIDs.has(node.id))
      // The persisted declaration is re-clamped against the user's CURRENT
      // global cap, as in _replan: recovery must neither reject a graph the
      // current ceiling admits nor produce one it forbids.
      const userMaxTotalNodes = yield* readUserMaxTotalNodes()
      const diagnostics = DagValidation.replanStructuralDiagnostics({
        fragmentNodes: added,
        rerunNodes: added,
        existingNodeIds: new Set(plan.preserved),
        existingNodeCount: nodes.length,
        addCount: added.length,
        merged: plan.config,
        terminalNodeIds: new Set(plan.reused),
        // Recovery authors no definitions: retries and termination collateral
        // are copies of stored nodes, so every gate keeps its accepted form.
        grandfatheredNodeIds: new Set(plan.config.nodes.map((node) => node.id)),
        action: "recover",
        config: {
          mode: config.mode,
          max_total_nodes: config.max_total_nodes,
          user_max_total_nodes: userMaxTotalNodes,
        },
        isolation: config.isolation,
      }).filter((diagnostic) => diagnostic.severity === "error")
      if (diagnostics.length > 0) return yield* Effect.fail(new StructuralValidationError({ diagnostics }))

      // Hashing is outside the workflow mutex and the transaction. The workflow
      // is re-read inside the transaction that publishes the batch, and both the
      // workflow and node sequence fences are rechecked in the durable batch
      // before any projection changes.
      for (const id of plan.reused) {
        const node = nodes.find((candidate) => candidate.id === id)!
        yield* verifyOutputFileRef(node.capturedOutput).pipe(
          Effect.mapError(
            (error) =>
              new Error(
                `Recovery cannot reuse artifact from node "${id}": ${error.message}; include this node in node_ids to recompute it`,
              ),
          ),
        )
      }
      return yield* command(dagID)((_lock) =>
        Effect.gen(function* () {
          const current = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
          if (!current || current.seq !== workflow.seq || current.graphRev !== input.expectedGraphRev) {
            return yield* Effect.fail(
              new Error("Recovery rejected: workflow changed during artifact verification; inspect status and retry"),
            )
          }
          const timestamp = yield* DateTime.now
          // This fenced event is first so its projector can validate the original
          // snapshot. publishMany commits all new attempts/config atomically.
          const batch: BatchEvent[] = [
            {
              definition: DagEvent.WorkflowReplanned,
              data: {
                dagID: ID.make(dagID),
                added: added.length,
                removed: plan.superseded.length,
                replaced: 0,
                restarted: 0,
                superseded: plan.superseded.map((id) => NodeID.make(id)),
                recovery: {
                  expectedGraphRev: input.expectedGraphRev,
                  expectedSeq: workflow.seq,
                  nodeSeqs: nodes.map((node) => ({ nodeID: NodeID.make(node.id), seq: node.seq })),
                  resumeCancelled: input.resumeCancelled === true,
                },
                timestamp,
              },
            },
          ]
          for (const id of plan.superseded) {
            const node = nodes.find((candidate) => candidate.id === id)!
            if (isNodeTerminalStatus(node.status as NodeStatus)) continue
            batch.push({
              definition: DagEvent.NodeCancelled,
              data: { dagID: ID.make(dagID), nodeID: NodeID.make(id), source: "replan", timestamp },
            })
          }
          for (const node of added) {
            batch.push({
              definition: DagEvent.NodeRegistered,
              data: {
                dagID: ID.make(dagID),
                nodeID: NodeID.make(node.id),
                name: node.name,
                workerType: node.worker_type,
                dependsOn: node.depends_on.map((id) => NodeID.make(id)),
                required: node.required ?? false,
                ...(node.model ? { model: node.model } : {}),
                timestamp,
              },
            })
          }
          batch.push({
            definition: DagEvent.WorkflowConfigUpdated,
            data: {
              dagID: ID.make(dagID),
              config: JSON.stringify(plan.config),
              timestamp,
            },
          })
          yield* withMailbox(dagID, undefined, events.publishMany(batch))
          const { config: _config, ...result } = plan
          return { ...result, graphRev: workflow.graphRev + 1 }
        }),
      )
    })

    const applyRetarget = Effect.fn("Dag.retarget")(function* (
      lock: WorkflowLock,
      dagID: string,
      input: { workspace?: string; fingerprint?: string; nodeIDs?: readonly string[]; reason?: string },
      target: DagLocation.TargetObservation | undefined,
    ) {
      const workflow = yield* guardWorkflowNotTerminal(dagID, "retarget")
      const config = parseWorkflowConfig(workflow.config)
      if (!config) return yield* Effect.fail(new Error(`Retarget rejected: workflow config is invalid: ${dagID}`))
      // #1030 D9-g: the workflow-level worktree is a create-time binding.
      // Retargeting would rebind the execution directory while the worktree
      // pointer in config still names the old tree; reject instead of leaving
      // two disagreeing targets.
      if (config.isolation === "worktree") {
        return yield* Effect.fail(
          new Error(
            "Retarget rejected: workflow-level worktree isolation cannot be retargeted; start a new workflow from the desired target",
          ),
        )
      }
      if (input.workspace === undefined && input.fingerprint === undefined) {
        return yield* Effect.fail(new Error("Retarget rejected: provide workspace or fingerprint"))
      }
      // #1344: the workspace resolution and the fingerprint wait for git, so
      // they were read before this transaction opened (ADR-0008 decision 3:
      // a transaction body takes database work only). They apply only while
      // the row still names the directories they were read against.
      if (!target || !DagLocation.observationHolds(target, workflow)) {
        return yield* Effect.fail(
          new Error("Retarget rejected: the workflow target changed while it was being read; inspect status and retry"),
        )
      }
      if (target._tag === "invalid") return yield* Effect.fail(new Error(`Retarget rejected: ${target.reason}`))
      // #945: the fingerprint is always computed from the bound tree. A caller
      // that supplies an expected value gets fail-closed validation, not a
      // writable field: durable fingerprints must remain runtime-derived.
      const { toDirectory, executionDirectory, fingerprint: toFingerprint } = target
      if (input.fingerprint !== undefined) {
        const actual = toFingerprint.kind === "git" ? toFingerprint.value : "none"
        if (input.fingerprint !== actual) {
          return yield* Effect.fail(
            new Error(`Retarget rejected: expected target fingerprint ${input.fingerprint}, but ${actual} is current`),
          )
        }
      }
      const nodes = yield* store.getNodes(dagID)
      const configByID = new Map(config.nodes.map((node) => [node.id, node]))
      const fromDirectory = workflow.executionDirectory ?? workflow.directory
      const fromFingerprint = workflow.targetFingerprint
      const targetChanged =
        DagLocation.canonicalDirectory(executionDirectory) !== DagLocation.canonicalDirectory(fromDirectory) ||
        !DagLocation.sameFingerprint(fromFingerprint, toFingerprint)
      const completed = targetChanged
        ? nodes.filter(
            (node) =>
              !node.superseded &&
              node.status === "completed" &&
              targetSensitiveNode(configByID.get(node.id), node.workerType),
          )
        : []
      if (completed.length > 0) {
        return yield* Effect.fail(
          new Error(
            `Retarget rejected: completed target-sensitive node(s) ${completed.map((node) => node.id).join(", ")}; recover them before retargeting, then re-run their evidence on the new target`,
          ),
        )
      }
      const sensitive = nodes.filter(
        (node) =>
          node.status === "running" &&
          targetSensitiveNode(configByID.get(node.id), node.workerType),
      )
      let selected = sensitive
      if (input.nodeIDs !== undefined) {
        if (input.nodeIDs.length === 0) {
          return yield* Effect.fail(new Error("Retarget rejected: node_ids must not be empty"))
        }
        const requested = new Set(input.nodeIDs)
        const rejected = [...requested].filter((id) => !sensitive.some((node) => node.id === id))
        if (rejected.length > 0) {
          return yield* Effect.fail(
            new Error(
              `Retarget rejected: node(s) are not running target-sensitive attempts: ${rejected.join(", ")}`,
            ),
          )
        }
        selected = sensitive.filter((node) => requested.has(node.id))
      }
      const timestamp = yield* DateTime.now
      const batch: BatchEvent[] = selected.map((node) => ({
        definition: DagEvent.NodeRestarted,
        data: {
          dagID: ID.make(dagID),
          nodeID: NodeID.make(node.id),
          childSessionID: SessionID.make(node.childSessionId ?? ""),
          timestamp,
        },
      }))
      if (toDirectory !== undefined) {
        batch.push({
          definition: DagEvent.WorkflowConfigUpdated,
          data: {
            dagID: ID.make(dagID),
            config: JSON.stringify({ ...config, workspace: toDirectory }),
            timestamp,
          },
        })
      }
      const restarted = selected.map((node) => NodeID.make(node.id))
      batch.push({
        definition: DagEvent.WorkflowReplanned,
        data: {
          dagID: ID.make(dagID),
          added: 0,
          removed: 0,
          replaced: 0,
          restarted: restarted.length,
          retarget: {
            fromDirectory,
            ...(toDirectory !== undefined ? { toDirectory } : {}),
            fromFingerprint,
            toFingerprint,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            nodes: restarted,
          },
          timestamp,
        },
      })
      yield* withMailbox(dagID, undefined, events.publishMany(batch))
      return {
        nodes: restarted,
        fromDirectory,
        toDirectory,
        fromFingerprint,
        toFingerprint,
        graphRev: workflow.graphRev + 1,
      }
    })

    // `command`, with the reads that wait for git (#1344) between the lock and
    // the transaction: ADR-0008 decision 3 keeps them out of the latter.
    const retarget: Interface["retarget"] = (dagID, input) =>
      withWorkflowLock(dagID)((lock) =>
        Effect.gen(function* () {
          const row = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
          const target = row ? yield* DagLocation.observeTarget(row, input.workspace) : undefined
          return yield* transact(dagID, withMailbox(dagID, undefined, applyRetarget(lock, dagID, input, target)))
        }),
      )

    return { recover, retarget }
  })
