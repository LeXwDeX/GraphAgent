// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import { Dag } from "@/dag/dag"
import { DagControl } from "@/dag/control"
import { WorkflowAuthoring } from "@/dag/authoring"
import type { Tool } from "../tool"
import { EXTEND_TIMEOUT_COPY, authoringWarnings } from "./render"
import { prepareMutation } from "./prepare"
import { rejectDiagnostics, requireOwnedWorkflow, runControl, runMutation } from "./mutation"
import type { ControlParams, Metadata } from "./schema"

type Authoring = ReturnType<typeof WorkflowAuthoring.make>

export interface ControlContext {
  readonly dag: Dag.Interface
  readonly control: DagControl.Interface
  readonly authoring: Authoring
  readonly sessionID: string
  readonly session: {
    readonly directory: string
    readonly projectID: string
    readonly model: { id: string; providerID: string } | undefined
  }
  readonly ctx: Tool.Context
}

export const controlWorkflow = (context: ControlContext, params: ControlParams): Effect.Effect<Tool.ExecuteResult> =>
  Effect.gen(function* () {
    const { dag, control, authoring, sessionID, session, ctx } = context
    const wfId = params.workflow_id
    const workflow = yield* requireOwnedWorkflow(dag, wfId, sessionID)
    const caller = { sessionID }
    if (params.operation === "recover") {
      const outcome = yield* runControl(
        wfId,
        control.apply(
          wfId,
          {
            op: "recover",
            nodeIDs: params.node_ids,
            expectedGraphRev: params.expected_graph_rev,
            resumeCancelled: params.resume_cancelled,
          },
          caller,
        ),
      )
      const result = outcome.result
      return {
        title: `Workflow recovered: ${result.replacements.length} new attempts`,
        output: JSON.stringify(
          {
            workflow_id: wfId,
            action: "recover",
            status: "running",
            graph_rev: result.graphRev,
            replacements: result.replacements,
            reused: result.reused,
            preserved: result.preserved,
            superseded: result.superseded,
            note: "Prior attempts remain readable with workflow result. New attempts must inspect existing workspace changes and prior child sessions before repeating side effects.",
          },
          null,
          2,
        ),
        metadata: { workflowId: wfId, graphRev: result.graphRev } as Metadata,
      }
    }
    if (params.operation === "retarget") {
      const outcome = yield* runControl(
        wfId,
        control.apply(
          wfId,
          {
            op: "retarget",
            workspace: params.workspace,
            fingerprint: params.fingerprint,
            nodeIDs: params.node_ids,
            reason: params.reason,
          },
          caller,
        ),
      )
      const result = outcome.result
      return {
        title: `Workflow retargeted: ${result.nodes.length} node(s) restarted`,
        output: JSON.stringify(
          {
            workflow_id: wfId,
            action: "retarget",
            graph_rev: result.graphRev,
            nodes: result.nodes,
            ...(result.fromDirectory ? { from_directory: result.fromDirectory } : {}),
            ...(result.toDirectory ? { to_directory: result.toDirectory } : {}),
            ...(result.fromFingerprint ? { from_fingerprint: result.fromFingerprint } : {}),
            to_fingerprint: result.toFingerprint,
            ...(params.reason ? { reason: params.reason } : {}),
            note: "Restarted target-sensitive attempts drop their pre-retarget evidence; inspect workspace changes before repeating side effects.",
          },
          null,
          2,
        ),
        metadata: { workflowId: wfId, graphRev: result.graphRev, restart: result.nodes } as Metadata,
      }
    }
    if (params.operation === "replan") {
      const result = yield* prepareMutation(dag, authoring, {
        action: "replan",
        workflow,
        specPath: params.spec_path,
        session,
        ctx,
      })
      if (!result.valid || !result.prepared || result.prepared.action !== "replan")
        return yield* rejectDiagnostics(control, result.errors, "Workflow replan", {
          workflowID: wfId,
          action: "replan",
          sessionID,
        })
      const prepared = result.prepared
      // The graph raced to terminal while the fragment was being
      // composed (the pause-first protocol was skipped). Surface
      // the recovery options instead of a bare iron-law rejection.
      const outcome = yield* runMutation(
        control,
        wfId,
        "replan",
        sessionID,
        "The workflow reached a terminal status before the replan arrived. For a local retry of failed work, use control(recover) with current node_ids and expected_graph_rev; cancelled work also requires explicit resume_cancelled: true. Additive extend remains available after a qualifying naturally completed checkpoint. Pause live scheduling before composing a changed graph.",
        control.apply(wfId, { op: "replan", prepared }, caller),
      )
      const r = outcome.result
      // A paused workflow (explicit pause-first protocol, or the
      // runtime's gate pause after a checkpoint replan verdict) must
      // resume for the corrective nodes to run — the replan intent
      // is "the graph changed, proceed", so resume closes the loop.
      // The service owns that resume; races are reported because
      // the replan already landed, so never die on them.
      const ignored =
        r.ignore.length > 0
          ? `\nIgnored (terminal, immutable — add replacements under new ids to retry): ${r.ignore.join(", ")}`
          : ""
      const pauseNote =
        outcome.resume === "not-paused"
          ? ""
          : outcome.resume === "resumed"
            ? "\nWorkflow was paused and has been resumed — corrective nodes are now schedulable."
            : "\nWorkflow was paused; automatic resume raced with another control op — check status and issue control(resume) if still paused."
      return {
        title: `Workflow replanned: +${r.add.length} -${r.cancel.length} ↻${r.restart.length}`,
        output: `<workflow id="${wfId}" action="replan">\nAdded: ${r.add.join(", ")}\nCancelled: ${r.cancel.join(", ")}\nRestarted: ${r.restart.join(", ")}\nReplaced: ${r.replace.join(", ")}${ignored}${pauseNote}\n${authoringWarnings(result)}</workflow>`,
        metadata: { workflowId: wfId, ...r } as Metadata,
      }
    }
    if (params.operation === "extend_timeout") {
      const outcome = yield* runControl(
        wfId,
        control.apply(wfId, { op: "extend_timeout", nodeID: params.node_id, timeoutMs: params.timeout_ms }, caller),
      )
      const verdict = outcome.result
      const copy = EXTEND_TIMEOUT_COPY[verdict.status]
      const detail = verdict.status === "extended" ? ` deadline_ms="${verdict.deadlineMs}"` : ""
      return {
        title: `${copy.title}: ${params.node_id}`,
        output: `<workflow id="${wfId}" action="extend_timeout" node="${params.node_id}" status="${verdict.status}"${detail}/>\n${copy.body}`,
        metadata: { workflowId: wfId, nodeId: params.node_id } as Metadata,
      }
    }
    switch (params.operation) {
      case "pause":
        yield* runControl(wfId, control.apply(wfId, { op: "pause" }, caller))
        return {
          title: "Workflow paused",
          output: `<workflow id="${wfId}" state="paused"/>\nNote: pause stops new node spawns only — nodes already running continue to completion. To stop a running node, submit a replan spec marking it restart: true or cancel: true (replan is valid while paused, and a successful replan resumes the paused workflow so corrective nodes can run).`,
          metadata: { workflowId: wfId } as Metadata,
        }
      case "resume":
        yield* runControl(wfId, control.apply(wfId, { op: "resume" }, caller))
        return {
          title: "Workflow resumed",
          output: `<workflow id="${wfId}" state="running"/>`,
          metadata: { workflowId: wfId } as Metadata,
        }
      case "cancel":
        yield* runControl(wfId, control.apply(wfId, { op: "cancel" }, caller))
        return {
          title: "Workflow cancelled",
          output: `<workflow id="${wfId}" state="cancelled"/>`,
          metadata: { workflowId: wfId } as Metadata,
        }
      case "complete":
        yield* runControl(wfId, control.apply(wfId, { op: "complete" }, caller))
        return {
          title: "Workflow completed (early)",
          output: `<workflow id="${wfId}" state="completed"/>`,
          metadata: { workflowId: wfId } as Metadata,
        }
      case "step": {
        const outcome = yield* runControl(wfId, control.apply(wfId, { op: "step" }, caller))
        const r = outcome.result
        if (r.status === "no_ready_nodes") {
          return {
            title: "Workflow step: no ready nodes",
            output: `<workflow id="${wfId}" state="running" action="step" result="no_ready_nodes"/>`,
            metadata: { workflowId: wfId } as Metadata,
          }
        }
        return {
          title: `Workflow stepped: ${r.nodeID ?? "no node"}`,
          output: `<workflow id="${wfId}" state="stepping" action="step" node="${r.nodeID ?? ""}"/>`,
          metadata: { workflowId: wfId, ...r } as Metadata,
        }
      }
      case "cancel_node": {
        const node = yield* dag.store.getNode(wfId, params.node_id).pipe(Effect.orDie)
        yield* runControl(
          wfId,
          control.apply(wfId, { op: "cancel_node", nodeID: params.node_id, reason: params.reason }, caller),
        )
        const requiredWarning = node?.required
          ? "\nWarning: this node is required, so the workflow fails once the cancellation settles."
          : ""
        return {
          title: `Workflow node cancelled: ${params.node_id}`,
          output: `<workflow id="${wfId}" action="cancel_node" node="${params.node_id}"/>${requiredWarning}`,
          metadata: { workflowId: wfId, nodeId: params.node_id } as Metadata,
        }
      }
      default:
        return yield* Effect.die(new Error("unreachable workflow control operation"))
    }
  })
