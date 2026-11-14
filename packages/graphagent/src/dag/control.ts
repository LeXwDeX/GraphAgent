// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared workflow control service.
 *
 * Every live-workflow control request — the five simple ops, prepared replan
 * and extend mutations, recovery, timeout extension, and retargeting — enters
 * through this service. It owns the owner check, the paused-only ResumeGuard
 * precheck, rejection classification, the durable parking protocol after a
 * rejected replan/extend, and the automatic resume that follows a landed
 * replan/extend.
 *
 * It does not own authoring (`WorkflowAuthoring` decodes sources), the state
 * machine or the per-workflow lock (`Dag`), or parent-session and permission
 * gating (the workflow tool). A request only describes an operation; prepared
 * graphs are authoring's output, passed through unchanged.
 *
 * Workflow-level worktree isolation (#1030 D9-g) is a create-time binding:
 * `Dag.retarget` and the additive reopen of a completed isolated workflow are
 * rejected by `Dag` and surface through the normal rejection/park protocol.
 * Terminal settlement (commit/patch/remove-or-keep) is owned by `DagLoop`'s
 * terminal handler; E1b (#1029) reuses the same `settleWorkflowWorktree` seam.
 *
 * Lock discipline: `Dag` commands acquire the non-reentrant per-workflow
 * KeyedMutex themselves. This service never calls `Dag` while a mutation is
 * still in flight; the parking readback and the post-mutation resume run only
 * after the failed/settled command released its lock.
 */
export * as DagControl from "./control"

import { Cause, Context, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import {
  InvalidTransitionError,
  StaleNodeAttemptError,
  TerminalViolationError,
  isTerminalWorkflowStatusValue,
} from "@graphagent/core/dag/core/types"
import { isRecord } from "@/util/record"
import { Dag } from "./dag"
import { ResumeBlockedError, ResumeGuard } from "./resume-guard"
import { DagValidation, StructuralValidationError } from "./validation"
import type { PreparedExtend, PreparedReplan } from "./authoring"

// ============================================================================
// Park protocol
// ============================================================================

/**
 * Durable outcome of parking a workflow after a rejected mutation. `status`
 * is the actual persisted workflow status observed (or `missing`/`unknown`
 * when the readback itself failed); the four-state result stays pure so the
 * rendering layer owns all user-visible copy.
 */
export const ParkResultSchema = Schema.Union([
  Schema.Literal("parked"),
  Schema.Literal("already-paused"),
  Schema.Literal("terminal-unchanged"),
  Schema.Struct({ failed: Schema.String, actualStatus: Schema.String }),
])
export type ParkResult = typeof ParkResultSchema.Type

export interface ParkOutcome {
  readonly result: ParkResult
  readonly status: string
}

// ============================================================================
// Typed rejections
// ============================================================================

export const ControlRejectionKindSchema = Schema.Literals([
  "terminal",
  "transition",
  "stale-attempt",
  "review-gate",
  "completion-gate",
  "resume-blocked",
  "other",
])
export type ControlRejectionKind = typeof ControlRejectionKindSchema.Type

/** The workflow is absent or owned by a different caller session. */
export class ControlNotFound extends Schema.TaggedError<ControlNotFound>()("NotFound", {}) {}

/**
 * A recognized state-machine or gate refusal. `status` is the actual persisted
 * workflow status at rejection time, never the requested target status. `kind`
 * selects the user-visible guidance branch; it never substitutes for state.
 */
export class ControlConflict extends Schema.TaggedError<ControlConflict>()("Conflict", {
  status: Schema.String,
  message: Schema.String,
  kind: ControlRejectionKindSchema,
  pauseReason: Schema.optional(Schema.String),
  parked: Schema.optional(ParkResultSchema),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** A recognized caller-input refusal, carrying validation diagnostics when available. */
export class ControlInvalid extends Schema.TaggedError<ControlInvalid>()("Invalid", {
  status: Schema.String,
  message: Schema.String,
  diagnostics: Schema.mutable(Schema.Array(DagValidation.DiagnosticSchema)),
  parked: Schema.optional(ParkResultSchema),
  cause: Schema.optional(Schema.Defect()),
}) {}

export type ControlRejection = ControlNotFound | ControlConflict | ControlInvalid

// ============================================================================
// Requests and outcomes
// ============================================================================

/**
 * A single live-workflow control request. `pause` deliberately exposes no
 * reason and `complete` no options: the tool never supplied them, and widening
 * them here would create a second policy surface. `replan`/`extend` carry the
 * prepared graph so the compiler pairs each op with its authoring action.
 */
export type ControlRequest =
  | { readonly op: "pause" | "resume" | "step" | "cancel" | "complete" }
  | { readonly op: "cancel_node"; readonly nodeID: string; readonly reason?: string }
  | { readonly op: "replan"; readonly prepared: PreparedReplan }
  | { readonly op: "extend"; readonly prepared: PreparedExtend }
  | {
      readonly op: "recover"
      readonly nodeIDs: readonly string[]
      readonly expectedGraphRev: number
      readonly resumeCancelled?: boolean
    }
  | { readonly op: "extend_timeout"; readonly nodeID: string; readonly timeoutMs: number }
  | {
      readonly op: "retarget"
      readonly workspace?: string
      readonly fingerprint?: string
      readonly nodeIDs?: readonly string[]
      readonly reason?: string
    }

/** The success payload of a `Dag.Interface` method. */
type DagSuccess<K extends keyof Dag.Interface> = Dag.Interface[K] extends (
  ...args: never[]
) => Effect.Effect<infer A, infer _E, infer _R>
  ? A
  : never

/** Whether an automatic resume followed a landed replan/extend. */
export type ResumeOutcome = "not-paused" | "resumed" | "resume-failed"

export type ControlOutcome =
  | { readonly op: "pause"; readonly workflowID: string }
  | { readonly op: "resume"; readonly workflowID: string }
  | { readonly op: "step"; readonly workflowID: string; readonly result: DagSuccess<"step"> }
  | { readonly op: "cancel"; readonly workflowID: string }
  | { readonly op: "complete"; readonly workflowID: string }
  | { readonly op: "cancel_node"; readonly workflowID: string; readonly nodeID: string }
  | {
      readonly op: "replan"
      readonly workflowID: string
      readonly result: DagSuccess<"replan">
      readonly resume: ResumeOutcome
    }
  | {
      readonly op: "extend"
      readonly workflowID: string
      readonly result: DagSuccess<"extend">
      readonly resume: ResumeOutcome
    }
  | { readonly op: "recover"; readonly workflowID: string; readonly result: DagSuccess<"recover"> }
  | {
      readonly op: "extend_timeout"
      readonly workflowID: string
      readonly nodeID: string
      readonly result: DagSuccess<"extendTimeout">
    }
  | { readonly op: "retarget"; readonly workflowID: string; readonly result: DagSuccess<"retarget"> }

/** The calling session; used only for the workflow owner check. */
export interface Caller {
  readonly sessionID: string
}

export interface Interface {
  readonly apply: <R extends ControlRequest>(
    dagID: string,
    request: R,
    caller: Caller,
  ) => Effect.Effect<Extract<ControlOutcome, { op: R["op"] }>, ControlRejection>
  readonly parkRejected: (dagID: string, caller: Caller) => Effect.Effect<ParkOutcome, ControlNotFound>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/DagControl") {}

// ============================================================================
// Implementation
// ============================================================================

/** Ops whose paused workflow must consult the resume policy before mutation. */
const PRECHECKED_OPS: ReadonlySet<ControlRequest["op"]> = new Set(["extend", "replan", "recover", "extend_timeout"])

const contextString = (error: unknown, key: string): string | undefined => {
  if (!isRecord(error)) return undefined
  const context = error["context"]
  if (!isRecord(context)) return undefined
  const value = context[key]
  return typeof value === "string" ? value : undefined
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isPlainMessage = (error: unknown, prefix: string): boolean => messageOf(error).startsWith(prefix)

const withParked = (
  rejection: ControlConflict | ControlInvalid,
  outcome: ParkOutcome,
): ControlConflict | ControlInvalid =>
  rejection._tag === "Conflict"
    ? new ControlConflict({
        // The park readback is later than classification, so its status is the
        // actual persisted state after the rejected mutation (for example
        // `paused` after a successful parking pause).
        status: outcome.status,
        message: rejection.message,
        kind: rejection.kind,
        pauseReason: rejection.pauseReason,
        parked: outcome.result,
        cause: rejection.cause,
      })
    : new ControlInvalid({
        status: outcome.status,
        message: rejection.message,
        diagnostics: rejection.diagnostics,
        parked: outcome.result,
        cause: rejection.cause,
      })

const make = Effect.gen(function* () {
  const dag = yield* Dag.Service

  /** Read the persisted workflow status tolerantly: a failed read maps to
   * `unknown` (interrupts still propagate), an absent row to `missing`. */
  const persistedStatus = (dagID: string) =>
    Effect.gen(function* () {
      const read = yield* dag.store.getWorkflow(dagID).pipe(Effect.exit)
      if (Exit.isFailure(read)) {
        if (Cause.hasInterrupts(read.cause)) return yield* Effect.interrupt
        return "unknown"
      }
      return read.value?.status ?? "missing"
    })

  /**
   * Park a workflow whose mutation was rejected. The four result states keep
   * the historical behavior: a terminal workflow is left untouched, a live
   * workflow is paused durably, a pause that loses a race is reported as
   * already parked, and anything else reports the read-back status plus the
   * pause failure. Interrupts propagate; a failed readback degrades to
   * `missing`/`unknown` instead of masking the parking failure.
   */
  const parkRejected: Interface["parkRejected"] = Effect.fn("DagControl.parkRejected")(function* (
    dagID: string,
    caller: Caller,
  ) {
    const currentExit = yield* dag.store.getWorkflow(dagID).pipe(Effect.exit)
    if (Exit.isFailure(currentExit) && Cause.hasInterrupts(currentExit.cause)) return yield* Effect.interrupt
    const current = Exit.isSuccess(currentExit) ? currentExit.value : undefined
    // Ownership is only enforced when the row is readable; a read defect must
    // not prevent parking a workflow that may still be live.
    if (current && current.sessionId !== caller.sessionID) return yield* Effect.fail(new ControlNotFound())
    const currentStatus = current?.status
    if (currentStatus && isTerminalWorkflowStatusValue(currentStatus)) {
      return { result: "terminal-unchanged" as const, status: currentStatus }
    }
    const pauseExit = yield* dag.pause(dagID).pipe(Effect.exit)
    if (Exit.isFailure(pauseExit) && Cause.hasInterrupts(pauseExit.cause)) return yield* Effect.interrupt
    if (Exit.isSuccess(pauseExit)) return { result: "parked" as const, status: "paused" }
    const readExit = yield* dag.store.getWorkflow(dagID).pipe(Effect.exit)
    if (Exit.isFailure(readExit) && Cause.hasInterrupts(readExit.cause)) return yield* Effect.interrupt
    const actualStatus = Exit.isSuccess(readExit) ? (readExit.value?.status ?? "missing") : "unknown"
    return actualStatus === "paused"
      ? { result: "already-paused" as const, status: actualStatus }
      : { result: { failed: String(Cause.squash(pauseExit.cause)), actualStatus }, status: actualStatus }
  })

  /**
   * Classify a recognized failure into the shared rejection vocabulary.
   * Unknown plain errors die unchanged: they indicate a runtime, store, or
   * data defect, not a refusable caller request.
   */
  const classify = (error: unknown, dagID: string): Effect.Effect<ControlRejection> =>
    Effect.gen(function* () {
      if (error instanceof InvalidTransitionError) {
        const status = contextString(error, "entityId") === dagID ? contextString(error, "fromStatus") : undefined
        return new ControlConflict({
          kind: "transition",
          status: status ?? (yield* persistedStatus(dagID)),
          message: String(error),
          cause: error,
        })
      }
      if (error instanceof TerminalViolationError) {
        const status = contextString(error, "entityId") === dagID ? contextString(error, "terminalStatus") : undefined
        return new ControlConflict({
          kind: "terminal",
          status: status ?? (yield* persistedStatus(dagID)),
          message: error.message,
          cause: error,
        })
      }
      if (error instanceof StaleNodeAttemptError) {
        return new ControlConflict({
          kind: "stale-attempt",
          status: yield* persistedStatus(dagID),
          message: String(error),
          cause: error,
        })
      }
      if (error instanceof Dag.ReviewGateError) {
        return new ControlConflict({
          kind: "review-gate",
          status: yield* persistedStatus(dagID),
          message: String(error),
          cause: error,
        })
      }
      if (error instanceof Dag.CompletionGateError) {
        return new ControlConflict({
          kind: "completion-gate",
          status: yield* persistedStatus(dagID),
          message: String(error),
          cause: error,
        })
      }
      if (error instanceof ResumeBlockedError) {
        return new ControlConflict({
          kind: "resume-blocked",
          // A policy veto can fire on a running workflow (for example a step
          // request), so report the actual persisted status, not a guess.
          status: yield* persistedStatus(dagID),
          pauseReason: error.pauseReason,
          message: error.message,
          cause: error,
        })
      }
      if (error instanceof StructuralValidationError) {
        return new ControlInvalid({
          status: yield* persistedStatus(dagID),
          message: String(error),
          diagnostics: error.diagnostics,
          cause: error,
        })
      }

      if (isPlainMessage(error, "Workflow not found:")) return new ControlNotFound()

      if (isPlainMessage(error, "Node still in-flight:"))
        return new ControlConflict({
          kind: "transition",
          status: yield* persistedStatus(dagID),
          message: String(error),
          cause: error,
        })

      if (
        isPlainMessage(error, "Recovery rejected: stale expected_graph_rev") ||
        isPlainMessage(error, "Recovery rejected: workflow changed during artifact verification") ||
        isPlainMessage(error, "Recovery requires a paused or failed workflow") ||
        isPlainMessage(error, "Retarget rejected: expected target fingerprint") ||
        isPlainMessage(error, "Retarget rejected: completed target-sensitive node(s)") ||
        isPlainMessage(error, "Retarget rejected: node(s) are not running target-sensitive attempts")
      ) {
        return new ControlConflict({
          kind: "transition",
          status: yield* persistedStatus(dagID),
          message: String(error),
          cause: error,
        })
      }

      // A corrupt persisted config is a data defect, not caller input: the
      // caller cannot fix it by editing the fragment, so let it bubble as a
      // defect instead of matching the generic `Replan rejected:` prefix below.
      if (isPlainMessage(error, "Replan rejected: current workflow config is invalid:")) {
        return yield* Effect.die(error)
      }

      if (
        isPlainMessage(error, "Node not found:") ||
        isPlainMessage(error, "Replan rejected:") ||
        isPlainMessage(error, "Recovery of a cancelled workflow requires explicit resume_cancelled") ||
        isPlainMessage(error, "Recovery cannot reuse artifact from node") ||
        isPlainMessage(error, "Recovery requires at least one node_id") ||
        isPlainMessage(error, "Recovery node_ids must be unique") ||
        isPlainMessage(error, "Recovery node is not in the current graph:") ||
        isPlainMessage(error, "Recovery cannot read the execution definition for node:") ||
        isPlainMessage(error, "Recovery cannot map input source") ||
        isPlainMessage(error, "Recovery attempt ceiling exceeded") ||
        isPlainMessage(error, "Recovery attempt ID already exists:") ||
        isPlainMessage(error, "Retarget rejected:")
      ) {
        return new ControlInvalid({
          status: yield* persistedStatus(dagID),
          message: String(error),
          diagnostics: [],
          cause: error,
        })
      }

      // Unrecognized: a store/runtime/data defect (for example an unparseable
      // persisted config) must bubble as a defect, never masquerade as input.
      return yield* Effect.die(error)
    })

  /**
   * Resume a workflow that a landed replan/extend left paused. This block must
   * never turn a settled mutation into a rejection: every non-interrupt
   * failure becomes `resume-failed`, which the tool renders as a status check
   * rather than parking a mutation that already landed.
   */
  const resumeAfterMutation = (dagID: string, action: "replan" | "extend"): Effect.Effect<ResumeOutcome> =>
    Effect.gen(function* () {
      const read = yield* dag.store.getWorkflow(dagID).pipe(Effect.exit)
      if (Exit.isFailure(read)) {
        if (Cause.hasInterrupts(read.cause)) return yield* Effect.interrupt
        yield* Effect.logWarning(`Workflow resume after ${action} skipped: status read failed`, {
          wfId: dagID,
          cause: read.cause,
        })
        return "resume-failed" as const
      }
      if (read.value?.status !== "paused") return "not-paused" as const
      const resumed = yield* dag.resume(dagID).pipe(Effect.exit)
      if (Exit.isSuccess(resumed)) return "resumed" as const
      if (Cause.hasInterrupts(resumed.cause)) return yield* Effect.interrupt
      yield* Effect.logWarning(`Workflow resume after ${action} failed`, { wfId: dagID, cause: resumed.cause })
      return "resume-failed" as const
    })

  const invalidPrepared = (dagID: string, status: string, expected: "replan" | "extend", actual: string) =>
    new ControlInvalid({
      status,
      message: `${expected === "replan" ? "Replan" : "Extend"} rejected: prepared graph action is "${actual}", expected "${expected}" (workflow ${dagID})`,
      diagnostics: [],
    })

  const applyInternal = (
    dagID: string,
    request: ControlRequest,
    caller: Caller,
  ): Effect.Effect<ControlOutcome, ControlRejection> =>
    Effect.gen(function* () {
      const workflow = yield* dag.store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!workflow || workflow.sessionId !== caller.sessionID) {
        return yield* Effect.fail(new ControlNotFound())
      }

      // D12: a paused workflow may refuse mutations that would wake scheduling.
      // The check runs before any mutation and never parks: a veto means
      // nothing was attempted. resume/step rely on Dag's in-lock guard instead
      // of duplicating the policy call.
      if (PRECHECKED_OPS.has(request.op) && workflow.status === "paused") {
        const checked = yield* ResumeGuard.check(workflow).pipe(Effect.exit)
        if (Exit.isFailure(checked)) {
          if (Cause.hasInterrupts(checked.cause)) return yield* Effect.interrupt
          const veto = Cause.findErrorOption(checked.cause)
          if (Option.isSome(veto) && veto.value instanceof ResumeBlockedError) {
            return yield* Effect.fail(
              new ControlConflict({
                kind: "resume-blocked",
                status: workflow.status,
                pauseReason: veto.value.pauseReason,
                message: veto.value.message,
                cause: veto.value,
              }),
            )
          }
          const defect = Cause.findDefect(checked.cause)
          if (Result.isSuccess(defect)) return yield* Effect.die(defect.success)
          // A policy that fails with an untyped error violates its contract.
          // Fail closed: the mutation must not proceed, and the failure is a
          // defect rather than a caller-visible rejection.
          return yield* Effect.die(Cause.squash(checked.cause))
        }
      }

      if (request.op === "replan" && request.prepared.action !== "replan") {
        return yield* Effect.fail(invalidPrepared(dagID, workflow.status, "replan", request.prepared.action))
      }
      if (request.op === "extend" && request.prepared.action !== "extend") {
        return yield* Effect.fail(invalidPrepared(dagID, workflow.status, "extend", request.prepared.action))
      }

      const mutation: Effect.Effect<ControlOutcome, Error> = Effect.gen(function* () {
        switch (request.op) {
          case "pause": {
            yield* dag.pause(dagID)
            return { op: "pause", workflowID: dagID }
          }
          case "resume": {
            yield* dag.resume(dagID)
            return { op: "resume", workflowID: dagID }
          }
          case "step": {
            const result = yield* dag.step(dagID)
            return { op: "step", workflowID: dagID, result }
          }
          case "cancel": {
            yield* dag.cancel(dagID)
            return { op: "cancel", workflowID: dagID }
          }
          case "complete": {
            yield* dag.complete(dagID)
            return { op: "complete", workflowID: dagID }
          }
          case "cancel_node": {
            yield* dag.nodeCancelled(dagID, request.nodeID, request.reason)
            return { op: "cancel_node", workflowID: dagID, nodeID: request.nodeID }
          }
          case "replan": {
            const result = yield* dag.replan(dagID, { nodes: request.prepared.nodes })
            const resume = yield* resumeAfterMutation(dagID, "replan")
            return { op: "replan", workflowID: dagID, result, resume }
          }
          case "extend": {
            const result = yield* dag.extend(dagID, request.prepared.nodes)
            const resume = yield* resumeAfterMutation(dagID, "extend")
            return { op: "extend", workflowID: dagID, result, resume }
          }
          case "recover": {
            const result = yield* dag.recover(dagID, {
              nodeIDs: request.nodeIDs,
              expectedGraphRev: request.expectedGraphRev,
              resumeCancelled: request.resumeCancelled,
            })
            return { op: "recover", workflowID: dagID, result }
          }
          case "extend_timeout": {
            const result = yield* dag.extendTimeout(dagID, request.nodeID, request.timeoutMs)
            return { op: "extend_timeout", workflowID: dagID, nodeID: request.nodeID, result }
          }
          case "retarget": {
            const result = yield* dag.retarget(dagID, {
              workspace: request.workspace,
              fingerprint: request.fingerprint,
              nodeIDs: request.nodeIDs,
              reason: request.reason,
            })
            return { op: "retarget", workflowID: dagID, result }
          }
          default:
            return yield* Effect.die(new Error("unreachable control request"))
        }
      })

      return yield* mutation.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt
          const defect = Cause.findDefect(cause)
          if (Result.isSuccess(defect)) return Effect.die(defect.success)
          const failure = Option.getOrThrow(Cause.findErrorOption(cause))
          return Effect.gen(function* () {
            const rejection = yield* classify(failure, dagID)
            if (rejection._tag === "NotFound") return yield* Effect.fail(rejection)
            if (request.op !== "extend" && request.op !== "replan") return yield* Effect.fail(rejection)
            // The mutation already released its workflow lock, so parking can
            // acquire it again. A concurrent delete loses the owner check;
            // report the original rejection un-parked rather than masking it.
            const parked = yield* parkRejected(dagID, caller).pipe(Effect.option)
            return yield* Effect.fail(Option.isSome(parked) ? withParked(rejection, parked.value) : rejection)
          })
        }),
      )
    })

  const apply: Interface["apply"] = (dagID, request, caller) =>
    applyInternal(dagID, request, caller) as Effect.Effect<
      Extract<ControlOutcome, { op: (typeof request)["op"] }>,
      ControlRejection
    >

  return Service.of({ apply, parkRejected })
})

export const layer = Layer.effect(Service, make)
export const defaultLayer = layer.pipe(Layer.provide(Dag.defaultLayer))
export const node = LayerNode.make(layer, [Dag.node])
