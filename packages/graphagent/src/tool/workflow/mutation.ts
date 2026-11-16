// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Cause, Effect, Option, Result } from "effect"
import { Dag } from "@/dag/dag"
import { DagControl } from "@/dag/control"
import { DagValidation, type Diagnostic } from "@/dag/validation"
import { WORKFLOW_RECOVERY } from "./render"

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

/** A grouped checkpoint-gate diagnostic: one reporting checkpoint whose
 * dependents are not gated on its output. */
const isCheckpointGate = (diagnostic: Diagnostic) =>
  diagnostic.code === DagValidation.DIAGNOSTIC_CODES.dagInvalid &&
  /^nodes\[[^\]]+\]$/.test(diagnostic.path) &&
  diagnostic.message.startsWith("reporting checkpoint")

/**
 * The retry signal of a checkpoint-gate rejection (#1073): the same fact the
 * prose states, in a form the parent can act on without re-deriving the rule.
 * `suggested_fragment` merges the patches of every gate diagnostic by node id;
 * it is present only when each of them has a mechanical repair, so applying it
 * as written leaves nothing unfixed. Anything else names no fragment, and the
 * hint's options stay the way forward.
 */
export const checkpointRetrySignal = (diagnostics: readonly Diagnostic[]) => {
  const gates = diagnostics.filter(isCheckpointGate)
  if (gates.length === 0) return ""
  const patches = new Map<string, Record<string, unknown>>()
  for (const diagnostic of diagnostics)
    for (const patch of diagnostic.suggested_fragment?.nodes ?? [])
      patches.set(String(patch.id), { ...patches.get(String(patch.id)), ...patch })
  const complete = gates.every((gate) => gate.suggested_fragment !== undefined) && patches.size > 0
  const signal = {
    error_code: "checkpoint_ungated",
    diagnostic_code: DagValidation.DIAGNOSTIC_CODES.dagInvalid,
    retryable: true,
    ...(complete ? { suggested_fragment: { nodes: [...patches.values()] } } : {}),
  }
  return complete
    ? `\nStructured retry signal (merge each suggested_fragment node into the node with the same id; nothing else changes; do not re-guess): ${JSON.stringify(signal)}`
    : `\nStructured retry signal (no mechanical fix applies; choose one of the listed options): ${JSON.stringify(signal)}`
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
  // The runtime seam's own gate rejection carries the same repair.
  if (rejection._tag === "Invalid") return `${rejection.message}${checkpointRetrySignal(rejection.diagnostics)}`
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
  const checkpoint = checkpointRetrySignal(diagnostics)
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
          .join(
            "\n",
          )}${structured}${checkpoint}${workflowState ? `\n${workflowState}` : ""}\n${WORKFLOW_RECOVERY.instruction}`,
      ),
    )
  })
}
