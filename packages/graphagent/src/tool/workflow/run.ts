// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Option } from "effect"
import { Config } from "@/config/config"
import { Dag } from "@/dag/dag"
import { DagBudget } from "@/dag/budget"
import { DagControl } from "@/dag/control"
import { DagValidation } from "@/dag/validation"
import { DagWriteGuard } from "@/dag/write-guard"
import { WorkflowAuthoring } from "@/dag/authoring"
import { SessionID } from "@/session/schema"
import { createAdmissionRecord } from "@/dag/admission"
import type { Tool } from "../tool"
import { authoringWarnings, blockedMetadata, validationOutput } from "./render"
import { loadAuthoringSource } from "./files"
import { prepareMutation, priorRoundLoader } from "./prepare"
import { requireOwnedWorkflow, rejectDiagnostics, runMutation } from "./mutation"
import type { Metadata, RunParams } from "./schema"

type Authoring = ReturnType<typeof WorkflowAuthoring.make>

/** A start refused by a write-safety rule: nothing was created, and the model
 * gets a parseable reason like the budget gate's. */
const refusedStart = (title: string, errorCode: string, message: string, extra: Record<string, unknown> = {}) => ({
  title,
  output: JSON.stringify({ workflow_created: false, error_code: errorCode, ...extra, message }, null, 2),
  metadata: { blocked: true, diagnosticSummary: message },
})

/** The inputs a template start applied, in declaration order, so the parent sees
 * which ones fell back to their default. Nothing for a spec without inputs. */
const inputsLine = (template: { supplied: string[]; defaulted: string[] } | undefined) => {
  if (template === undefined) return ""
  const used = [...template.supplied, ...template.defaulted.map((name) => `${name} (default)`)]
  return used.length === 0 ? "" : `Inputs: ${used.join(", ")}.\n`
}

export interface RunContext {
  readonly dag: Dag.Interface
  readonly control: DagControl.Interface
  /** #1031 M5 budget gate; absent in harnesses without the service (fail-open). */
  readonly budget?: Pick<DagBudget.Interface, "check">
  readonly authoring: Authoring
  readonly sessionID: string
  readonly session: {
    readonly directory: string
    readonly projectID: string
    readonly model: { id: string; providerID: string } | undefined
    /** Session DAG mode; "on" fixes the workflow review gate to strict. */
    readonly dagMode?: "on" | "off"
  }
  readonly ctx: Tool.Context
}

export const runWorkflow = (context: RunContext, params: RunParams): Effect.Effect<Tool.ExecuteResult> =>
  Effect.gen(function* () {
    const { dag, control, authoring, sessionID, session, ctx } = context
    if (params.operation === "start") {
      // #1031 M5: the budget gate rejects a new workflow before authoring or
      // any durable row. The parent can still stop, inspect or ask; only the
      // user can raise the budget.
      if (context.budget) {
        const gate = yield* context.budget
          .check(SessionID.make(sessionID))
          .pipe(Effect.catchTag("BudgetExhausted", (failure) => Effect.succeed(failure)))
        if (gate instanceof DagBudget.BudgetExhaustedError) {
          return {
            title: "Workflow not started: DAG token budget exhausted",
            output: JSON.stringify(
              {
                workflow_created: false,
                error_code: "budget_exhausted",
                used: gate.used,
                budget: gate.budget,
                message: gate.message,
              },
              null,
              2,
            ),
            metadata: { blocked: true, diagnosticSummary: gate.message },
          }
        }
      }
      const source = yield* loadAuthoringSource(params.spec_path, session.directory, session.projectID, ctx).pipe(
        Effect.orDie,
      )
      const result = yield* authoring.prepare({
        action: "start",
        source,
        profile: "environment",
        environment: { directory: session.directory, parent: session.model },
        // The gate level is fixed at run.start: DAG mode on (or a deep spec,
        // handled inside authoring) upgrades it to strict and overrides an
        // authored standard. Later mode switches cannot change it.
        ...(session.dagMode === "on" ? { review_gate: "strict" as const } : {}),
        prior_rounds: priorRoundLoader(dag, sessionID),
        // #1073: a spec that declares inputs is filled from the call; a call
        // without inputs still reports the required ones as missing.
        template: { kind: "values" as const, values: params.inputs ?? {} },
      })
      const blocking = result.errors.filter(
        (diagnostic) => diagnostic.code !== DagValidation.DIAGNOSTIC_CODES.modelUnavailable,
      )
      if (blocking.length > 0) return yield* rejectDiagnostics(control, blocking, "Workflow start")
      const missingModels = result.errors
        .filter((diagnostic) => diagnostic.code === DagValidation.DIAGNOSTIC_CODES.modelUnavailable)
        .map((diagnostic) => /^nodes\[([^\]]+)\]$/.exec(diagnostic.path)?.[1])
        .filter((node): node is string => node !== undefined)
      if (missingModels.length > 0) {
        return {
          title: "Workflow not started: model required",
          output: JSON.stringify({ ...validationOutput(result), workflow_created: false }, null, 2),
          metadata: blockedMetadata(result.errors),
        }
      }
      if (result.prepared?.action !== "start") return yield* rejectDiagnostics(control, result.errors, "Workflow start")
      const prepared = result.prepared
      // #1031 M8: the write-safety gates run after authoring and before any
      // durable row. The plan agent may only start read-only workflows.
      const writers = DagWriteGuard.writerIDs(prepared.nodes)
      // #1324 §4: `dag.permission: "readonly"` holds every caller to the same
      // rule, ahead of and regardless of the plan-agent gate below; the tier
      // is read fresh (never cached) so a switch reaches the very next start.
      const globalConfig = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
      const permissionTier = globalConfig ? ((yield* globalConfig.dagGlobal()).permission ?? "allow") : "allow"
      if (permissionTier === "readonly" && writers.length > 0)
        return refusedStart(
          'Workflow not started: dag.permission is "readonly"',
          "permission_readonly",
          DagWriteGuard.readonlyRejection("start", writers),
          { writers },
        )
      if (ctx.agent === DagWriteGuard.PLAN_AGENT && writers.length > 0)
        return refusedStart(
          "Workflow not started: the plan agent is read-only",
          "plan_readonly",
          DagWriteGuard.planRejection("start", writers),
          { writers },
        )
      // A strict workflow with parallel writers defaults to a workflow worktree
      // when the checkout allows it; the notice says what happened either way.
      const isolation = DagWriteGuard.defaultIsolation({
        config: prepared.config,
        nodes: prepared.nodes,
        directory: session.directory,
      })
      const config =
        isolation.kind === "apply" ? { ...prepared.config, isolation: "worktree" as const } : prepared.config
      // Two unisolated writers must not share a workspace across live workflows.
      const placed = DagWriteGuard.unisolatedWriters(
        config.isolation === "worktree" ? [] : prepared.nodes,
        config.workspace ?? session.directory,
      )
      if (placed.length > 0) {
        const conflicts = DagWriteGuard.writeConflicts(yield* DagWriteGuard.liveWriters(dag.store), placed)
        if (conflicts.length > 0)
          return refusedStart(
            "Workflow not started: the workspace is being written by another workflow",
            "write_conflict",
            DagWriteGuard.writeConflictMessage("start", conflicts),
            {
              conflicts: conflicts.map((conflict) => ({
                workflow_id: conflict.workflowID,
                session_id: conflict.sessionID,
                workspace: conflict.directory,
                nodes: conflict.liveNodes,
              })),
            },
          )
      }
      const dagID = yield* dag
        .create({
          projectID: session.projectID,
          sessionID: SessionID.make(sessionID),
          title: prepared.title,
          config: {
            ...config,
            ...(prepared.admission ? { admission: createAdmissionRecord(prepared.admission) } : {}),
          },
        })
        .pipe(Effect.orDie)
      const mode = config.mode ?? "standard"
      const notice = isolation.kind === "none" ? "" : `${isolation.notice}\n`
      return {
        title: `Workflow started: ${config.name}`,
        output: `<workflow id="${dagID}" state="running" mode="${mode}">\n${prepared.nodes.length} nodes registered.\n${inputsLine(result.template)}${notice}${authoringWarnings(result)}Do not poll this workflow. It runs asynchronously and will wake the parent session when attention is required.\n</workflow>`,
        metadata: { workflowId: dagID } as Metadata,
      }
    }

    const workflow = yield* requireOwnedWorkflow(dag, params.workflow_id, sessionID)
    const result = yield* prepareMutation(dag, authoring, {
      action: "extend",
      workflow,
      specPath: params.spec_path,
      sessionID,
      session,
      ctx,
    })
    if (!result.valid || !result.prepared || result.prepared.action !== "extend")
      return yield* rejectDiagnostics(control, result.errors, "Workflow extend", {
        workflowID: params.workflow_id,
        action: "extend",
        sessionID,
      })
    const prepared = result.prepared
    const outcome = yield* runMutation(
      control,
      params.workflow_id,
      "extend",
      sessionID,
      "Terminal workflows are immutable except for the additive-extend reopen, which requires the workflow to have completed naturally at a wake-eligible reporting checkpoint (fragment adds new node ids; no early control(complete); no executed node beyond the checkpoint — condition-skipped dependents are fine). For failed workflows, use control(recover) with node_ids and expected_graph_rev from status. Cancelled workflows additionally require explicit resume_cancelled: true.",
      control.apply(params.workflow_id, { op: "extend", prepared }, { sessionID, agent: ctx.agent }),
    )
    const r = outcome.result
    // #381: extend shares replan's resume contract — a paused
    // workflow must resume for the added nodes to ever run (pause
    // admits nothing and no wake path prompts a resume), and the
    // extend intent is "the graph grew, proceed". The service owns
    // that resume; races are reported because the extend already
    // landed, so never die on them.
    const pauseNote =
      outcome.resume === "not-paused"
        ? ""
        : outcome.resume === "resumed"
          ? "\nWorkflow was paused and has been resumed — added nodes are now schedulable."
          : "\nWorkflow was paused; automatic resume raced with another control op — check status and issue control(resume) if still paused."
    return {
      title: `Workflow extended: ${r.add.length} nodes added`,
      output: `<workflow id="${params.workflow_id}" action="extend">\nAdded: ${r.add.join(", ")}${pauseNote}\n${authoringWarnings(result)}</workflow>`,
      metadata: { workflowId: params.workflow_id, added: r.add } as Metadata,
    }
  })
