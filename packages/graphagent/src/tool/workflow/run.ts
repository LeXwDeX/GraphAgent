// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import { Dag } from "@/dag/dag"
import { DagControl } from "@/dag/control"
import { DagValidation } from "@/dag/validation"
import { WorkflowAuthoring } from "@/dag/authoring"
import { SessionID } from "@/session/schema"
import { createAdmissionRecord } from "@/dag/admission"
import type { Tool } from "../tool"
import { authoringWarnings, blockedMetadata, validationOutput } from "./render"
import { loadAuthoringSource } from "./files"
import { requireOwnedWorkflow, rejectDiagnostics, runMutation } from "./control"
import type { Metadata, RunParams } from "./schema"

type Authoring = ReturnType<typeof WorkflowAuthoring.make>

export interface RunContext {
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

export const runWorkflow = (context: RunContext, params: RunParams): Effect.Effect<Tool.ExecuteResult> =>
  Effect.gen(function* () {
    const { dag, control, authoring, sessionID, session, ctx } = context
    if (params.operation === "start") {
      const source = yield* loadAuthoringSource(params.spec_path, session.directory, session.projectID, ctx).pipe(
        Effect.orDie,
      )
      const result = yield* authoring.prepare({
        action: "start",
        source,
        profile: "environment",
        environment: { directory: session.directory, parent: session.model },
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
      const dagID = yield* dag
        .create({
          projectID: session.projectID,
          sessionID: SessionID.make(sessionID),
          title: prepared.title,
          config: {
            ...prepared.config,
            ...(prepared.admission ? { admission: createAdmissionRecord(prepared.admission) } : {}),
          },
        })
        .pipe(Effect.orDie)
      const mode = prepared.config.mode ?? "standard"
      return {
        title: `Workflow started: ${prepared.config.name}`,
        output: `<workflow id="${dagID}" state="running" mode="${mode}">\n${result.prepared.nodes.length} nodes registered.\n${authoringWarnings(result)}Do not poll this workflow. It runs asynchronously and will wake the parent session when attention is required.\n</workflow>`,
        metadata: { workflowId: dagID } as Metadata,
      }
    }

    const workflow = yield* requireOwnedWorkflow(dag, params.workflow_id, sessionID)
    const workflowConfig = Dag.parseWorkflowConfig(workflow.config)
    const workflowDefaults = workflowConfig?.node_defaults
    const knownDependencies = (yield* dag.store.getNodes(params.workflow_id).pipe(Effect.orDie)).map((node) => node.id)
    const source = yield* loadAuthoringSource(params.spec_path, session.directory, session.projectID, ctx).pipe(
      Effect.orDie,
    )
    const result = yield* authoring.prepare({
      action: "extend",
      source,
      profile: "environment",
      environment: { directory: session.directory, parent: session.model },
      executionWorkspace: workflowConfig?.workspace,
      known_dependencies: knownDependencies,
      node_defaults: workflowDefaults,
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
      control.apply(params.workflow_id, { op: "extend", prepared }, { sessionID }),
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
