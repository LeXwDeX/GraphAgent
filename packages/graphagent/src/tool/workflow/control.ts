// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Cause, Effect, Option, Result } from "effect"
import { Dag } from "@/dag/dag"
import { DagControl } from "@/dag/control"
import { DagValidation, type Diagnostic } from "@/dag/validation"
import { WorkflowAuthoring } from "@/dag/authoring"
import type { Tool } from "../tool"
import { EXTEND_TIMEOUT_COPY, WORKFLOW_RECOVERY, authoringWarnings } from "./render"
import { loadAuthoringSource } from "./files"
import type { ControlParams, Metadata } from "./schema"

type Authoring = ReturnType<typeof WorkflowAuthoring.make>

export const requireOwnedWorkflow = (dag: Dag.Interface, workflowID: Dag.ID, sessionID: string) =>
  Effect.gen(function* () {
    const workflow = yield* dag.store.getWorkflow(workflowID).pipe(Effect.orDie)
    if (!workflow || workflow.sessionId !== sessionID) {
      return yield* Effect.die(new Error(`Workflow not found: ${workflowID}`))
    }
    return workflow
  })

/** Render the durable park outcome shared by every rejected mutation. */
export const parkText = (outcome: DagControl.ParkOutcome, action: "extend" | "replan") => {
  const result = outcome.result
  if (result === "terminal-unchanged")
    return `Workflow state: ${outcome.status} (unchanged). Correct the fragment and retry ${action}.`
  if (result === "parked") return "Workflow state: paused (durably parked). A corrected mutation can resume it."
  if (result === "already-paused") return "Workflow state: paused (already parked). A corrected mutation can resume it."
  return `Workflow state: ${result.actualStatus}. Automatic pause failed; inspect workflow status before retrying or waiting. Pause failure: ${result.failed}`
}

/** User-visible message for a classified rejection. The ResumeGuard D12
 * guidance and terminal recovery guidance live here, not in the service:
 * they are tool copy tied to this call site. */
export const renderRejection = (
  rejection: DagControl.ControlConflict | DagControl.ControlInvalid,
  guidance?: string,
) => {
  if (rejection._tag === "Conflict" && rejection.kind === "resume-blocked")
    return `${rejection.message}. The workflow stays paused. Inspect workflow status for pause_reason, resolve the blocker, then retry control(resume) or control(step).`
  if (rejection._tag === "Conflict" && rejection.kind === "terminal" && guidance !== undefined)
    return `${rejection.message}. ${guidance}`
  return rejection.message
}

/** Non-mutation control ops surface a rejection as a defect. Resume and
 * step gain the D12 guidance; every other op keeps the original error
 * object so existing diagnostics stay unchanged. */
export const runControl = <A>(
  workflowID: Dag.ID,
  effect: Effect.Effect<A, DagControl.ControlRejection>,
): Effect.Effect<A> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt
      const defect = Cause.findDefect(cause)
      if (Result.isSuccess(defect)) return Effect.die(defect.success)
      const failure = Option.getOrThrow(Cause.findErrorOption(cause))
      if (failure instanceof DagControl.ControlNotFound) {
        return Effect.die(new Error(`Workflow not found: ${workflowID}`))
      }
      if (failure._tag === "Conflict" && failure.kind === "resume-blocked") {
        return Effect.die(new Error(renderRejection(failure)))
      }
      return Effect.die(failure.cause instanceof Error ? failure.cause : new Error(renderRejection(failure)))
    }),
  )

/**
 * Replan/extend mutations render a rejection and append the durable park
 * state plus the shared recovery instruction. An unclassified defect (for
 * example a runtime batch-write failure) still parks before dying, which
 * preserves the audit trail and the "never leave it running" contract.
 */
export const runMutation = <A>(
  control: DagControl.Interface,
  workflowID: Dag.ID,
  action: "extend" | "replan",
  sessionID: string,
  guidance: string,
  effect: Effect.Effect<A, DagControl.ControlRejection>,
): Effect.Effect<A> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt
      const defect = Cause.findDefect(cause)
      if (Result.isSuccess(defect)) {
        return Effect.gen(function* () {
          const parked = yield* control.parkRejected(workflowID, { sessionID }).pipe(Effect.option)
          const state = Option.isSome(parked) ? `\n${parkText(parked.value, action)}` : ""
          return yield* Effect.die(new Error(`${String(defect.success)}${state}\n${WORKFLOW_RECOVERY.instruction}`))
        })
      }
      const failure = Option.getOrThrow(Cause.findErrorOption(cause))
      if (failure instanceof DagControl.ControlNotFound) {
        return Effect.gen(function* () {
          const parked = yield* control.parkRejected(workflowID, { sessionID }).pipe(Effect.option)
          if (Option.isNone(parked)) return yield* Effect.die(new Error(`Workflow not found: ${workflowID}`))
          return yield* Effect.die(
            new Error(
              `Workflow not found: ${workflowID}\n${parkText(parked.value, action)}\n${WORKFLOW_RECOVERY.instruction}`,
            ),
          )
        })
      }
      const state = failure.parked ? `\n${parkText({ result: failure.parked, status: failure.status }, action)}` : ""
      return Effect.die(new Error(`${renderRejection(failure, guidance)}${state}\n${WORKFLOW_RECOVERY.instruction}`))
    }),
  )

export const rejectDiagnostics = (
  control: DagControl.Interface,
  diagnostics: Diagnostic[],
  context: string,
  parking?: { workflowID: Dag.ID; action: "extend" | "replan"; sessionID: string },
) => {
  // P1-F: a missing replan envelope is a deterministic, self-correcting
  // mistake. Emit a machine-readable retry signal alongside the prose so the
  // parent keys its next attempt off a stable error_code instead of reusing
  // a wrong conclusion or re-guessing the YAML shape.
  const structured = diagnostics.some((d) => d.code === DagValidation.DIAGNOSTIC_CODES.replanEnvelopeMissing)
    ? `\nStructured retry signal (fix these fields exactly; do not re-guess the format): ${JSON.stringify({
        error_code: "replan_envelope_missing",
        diagnostic_code: DagValidation.DIAGNOSTIC_CODES.replanEnvelopeMissing,
        retryable: true,
        required_root_key: "fragment",
      })}`
    : ""
  return Effect.gen(function* () {
    // A rejected mutation parks a live workflow durably. When the pause
    // fails, read back the actual state instead of claiming it is parked:
    // a terminal race or a storage defect needs a different recovery path.
    const parked = parking
      ? yield* control.parkRejected(parking.workflowID, { sessionID: parking.sessionID }).pipe(Effect.option)
      : Option.none()
    const workflowState = parking && Option.isSome(parked) ? `\n${parkText(parked.value, parking.action)}` : ""
    return yield* Effect.die(
      new Error(
        `${context} rejected by workflow validation:\n${diagnostics
          .map((d) => `- [${d.code}] ${d.path}: ${d.message}${d.hint ? ` (${d.hint})` : ""}`)
          .join("\n")}${structured}${workflowState ? `\n${workflowState}` : ""}\n${WORKFLOW_RECOVERY.instruction}`,
      ),
    )
  })
}

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
      const workflowConfig = Dag.parseWorkflowConfig(workflow.config)
      const workflowDefaults = workflowConfig?.node_defaults
      const knownDependencies = (yield* dag.store.getNodes(wfId).pipe(Effect.orDie)).map((node) => node.id)
      const source = yield* loadAuthoringSource(params.spec_path, session.directory, session.projectID, ctx).pipe(
        Effect.orDie,
      )
      const result = yield* authoring.prepare({
        action: "replan",
        source,
        profile: "environment",
        environment: { directory: session.directory, parent: session.model },
        executionWorkspace: workflowConfig?.workspace,
        known_dependencies: knownDependencies,
        node_defaults: workflowDefaults,
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
