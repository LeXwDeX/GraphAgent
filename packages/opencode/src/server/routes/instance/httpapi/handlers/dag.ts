// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, ConflictError, notFound } from "../errors"
import { Dag } from "@/dag/dag"
import { DagLocation } from "@/dag/location"
import { DagValidation } from "@/dag/validation"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagEnvironmentCatalogs } from "@/dag/environment-catalogs"
import { createAdmissionRecord } from "@/dag/admission"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { InvalidTransitionError, TerminalViolationError } from "@opencode-ai/core/dag/core/types"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { DagMessages } from "@opencode-ai/core/dag/messages"

/** Map a DAG control op's typed transition failure into a 409 Conflict, not a 500 defect. */
function mapTransitionConflict<Success>(effect: Effect.Effect<Success, Error>) {
  return effect.pipe(
    Effect.catch((error: unknown) => {
      if (
        error instanceof InvalidTransitionError
        || error instanceof TerminalViolationError
        || error instanceof Dag.ReviewGateError
      ) {
        return Effect.fail(new ConflictError({ message: error.message, resource: "workflow" }))
      }
      // Any other Error is re-thrown as a defect (truly unexpected — surfaces as 500).
      return Effect.die(error)
    }),
  )
}

/**
 * DAG HTTP handlers — read-only queries delegate to DagStore; control mutations
 * delegate to Dag.Service. Same code path as the agent tool surface.
 */
export const dagHandlers = HttpApiBuilder.group(InstanceHttpApi, "dag", (handlers) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const messages = yield* DagMessages.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const authoring = WorkflowAuthoring.make({
      loadEnvironment: DagEnvironmentCatalogs.makeCatalogLoader(agents, provider),
    })

    const wf = (r: DagStore.WorkflowRow) => ({
      id: r.id,
      project_id: r.projectId,
      session_id: r.sessionId,
      title: r.title,
      status: r.status,
      config: r.config,
      seq: r.seq,
      time_created: r.timeCreated,
      time_updated: r.timeUpdated,
      ...(r.startedAt !== null ? { started_at: r.startedAt } : {}),
      ...(r.completedAt !== null ? { completed_at: r.completedAt } : {}),
    })

    const node = (r: DagStore.NodeRow) => ({
      id: r.id,
      workflow_id: r.workflowId,
      name: r.name,
      worker_type: r.workerType,
      status: r.status,
      required: r.required,
      depends_on: r.dependsOn,
      ...(r.modelId !== null ? { model_id: r.modelId } : {}),
      ...(r.modelProviderId !== null ? { model_provider_id: r.modelProviderId } : {}),
      ...(r.childSessionId !== null ? { child_session_id: r.childSessionId } : {}),
      // #949: per-attempt execution location. Optional so legacy rows and
      // pre-#949 clients decode exactly as before.
      ...DagLocation.nodeLocationView(r),
      ...(r.output !== null || r.status === "completed" ? { output: r.output } : {}),
      ...(r.errorReason !== null ? { error_reason: r.errorReason } : {}),
      ...(r.errorClass !== null ? { error_class: r.errorClass } : {}),
      ...(r.deadlineMs !== null ? { deadline_ms: r.deadlineMs } : {}),
      replan_attempts: r.replanAttempts,
      ...(r.startedAt !== null ? { started_at: r.startedAt } : {}),
      ...(r.completedAt !== null ? { completed_at: r.completedAt } : {}),
    })

    const observedNode = Effect.fn("DagHttpApi.observedNode")(function* (row: DagStore.NodeRow, ownerSessionID: string) {
      const instance = yield* InstanceState.context
      const metadata = yield* messages.metadata({
        projectID: instance.project.id,
        directory: instance.directory,
        sessionID: ownerSessionID,
      }, row.workflowId, row.id)
      return {
        ...node(row),
        ...(metadata.ok ? {
          attempt_id: metadata.value.endpoint.attemptID,
          accepted_input_revision: metadata.value.accepted,
          snapshot_revision: metadata.value.snapshot,
          agent_messages: {
            queued: metadata.value.queued,
            delivered: metadata.value.delivered,
            undeliverable: metadata.value.undeliverable,
            closed_reason: metadata.value.closedReason,
          },
        } : {}),
      }
    })

    const workflowInProject = Effect.fn("DagHttpApi.workflowInProject")(function* (dagID: string) {
      const row = yield* dag.store.getWorkflow(dagID).pipe(Effect.orDie)
      if (row?.projectId !== (yield* InstanceState.context).project.id) return undefined
      return row
    })

    const requireWorkflow = Effect.fn("DagHttpApi.requireWorkflow")(function* (dagID: string) {
      const row = yield* workflowInProject(dagID)
      if (!row) return yield* Effect.fail(notFound(`Workflow not found: ${dagID}`))
      return row
    })

    const requireSession = Effect.fn("DagHttpApi.requireSession")(function* (sessionID: string) {
      const session = yield* sessions.get(SessionID.make(sessionID)).pipe(
        Effect.catch(() => Effect.fail(notFound(`Session not found: ${sessionID}`))),
      )
      if (session.projectID !== (yield* InstanceState.context).project.id) {
        return yield* Effect.fail(notFound(`Session not found: ${sessionID}`))
      }
      return session
    })

    const list = Effect.fn("DagHttpApi.list")(function* () {
      const rows = yield* dag.store.listWorkflows().pipe(Effect.orDie)
      const projectID = (yield* InstanceState.context).project.id
      return rows.filter((row) => row.projectId === projectID).map(wf)
    })

    const bySession = Effect.fn("DagHttpApi.bySession")(function* (ctx: { params: { sessionID: string } }) {
      yield* requireSession(ctx.params.sessionID)
      const rows = yield* dag.store.listBySession(ctx.params.sessionID).pipe(Effect.orDie)
      return rows.map(wf)
    })

    const summary = Effect.fn("DagHttpApi.summary")(function* (ctx: { params: { sessionID: string } }) {
      yield* requireSession(ctx.params.sessionID)
      const summaries = yield* dag.store.getWorkflowSummaries(ctx.params.sessionID).pipe(Effect.orDie)
      return summaries.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        graphRev: s.graphRev,
        nodeCount: s.nodeCount,
        completedNodes: s.completedNodes,
        runningNodes: s.runningNodes,
        failedNodes: s.failedNodes,
        skippedNodes: s.skippedNodes,
        queuedNodes: s.queuedNodes,
        escalatedNodes: s.escalatedNodes,
      }))
    })

    const detail = Effect.fn("DagHttpApi.detail")(function* (ctx: { params: { dagID: string } }) {
      return wf(yield* requireWorkflow(ctx.params.dagID))
    })

    const nodes = Effect.fn("DagHttpApi.nodes")(function* (ctx: { params: { dagID: string } }) {
      const workflow = yield* requireWorkflow(ctx.params.dagID)
      // Rev-view (v1.0.15 Train A): the TUI node list is a view seam — it
      // renders the CURRENT graph revision only (zero TUI changes: the
      // server filters). nodeDetail below keeps the unfiltered read so a
      // superseded node's durable state stays auditable by id.
      const rows = yield* dag.store.getCurrentNodes(ctx.params.dagID).pipe(Effect.orDie)
      return yield* Effect.forEach(rows, (row) => observedNode(row, workflow.sessionId))
    })

    const nodeDetail = Effect.fn("DagHttpApi.nodeDetail")(function* (ctx: { params: { dagID: string; nodeID: string } }) {
      const workflow = yield* requireWorkflow(ctx.params.dagID)
      const row = yield* dag.store.getNode(ctx.params.dagID, ctx.params.nodeID).pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(notFound(`Node not found: ${ctx.params.nodeID}`))
      return yield* observedNode(row, workflow.sessionId)
    })

    const start = Effect.fn("DagHttpApi.start")(function* (ctx: { payload: { session_id: string; title?: string; config: unknown } }) {
      const config = ctx.payload.config
      if (!config || typeof config !== "object" || !Array.isArray((config as Record<string, unknown>).nodes)) {
        return yield* Effect.fail(new InvalidRequestError({ message: "start requires 'config' with a 'nodes' array" }))
      }
      const session = yield* requireSession(ctx.payload.session_id)
      // #344: same authority as the workflow tool's start action — every start
      // passes Workflow Authoring (environment profile): checkpoint gating,
      // output_schema obligations on gated checkpoints, worker/model/prompt
      // asset resolution, and server-side minting of the deep-mode admission
      // record. dag.create alone runs only structural checks, which is safe
      // only when authoring has already vetted the graph.
      const result = yield* authoring.prepare({
        action: "start",
        source: {
          kind: "inline",
          value: { title: ctx.payload.title, config },
          source: "httpapi:dag.start",
        },
        profile: "environment",
        environment: { directory: session.directory, parent: session.model ?? undefined },
      })
      // Parity with the workflow tool's start action: model resolution is
      // advisory over HTTP — the tool asks a question (no model configured
      // yet), an API caller has no such interaction; the spawn path fails
      // loudly (failWithoutFiber) at execution time if a model never
      // resolves. Every other diagnostic class stays blocking, and a graph
      // that did not COMPILE (prepared === undefined) is always blocking
      // regardless of diagnostic classes.
      const blocking = result.errors.filter(
        (diagnostic) => diagnostic.code !== DagValidation.DIAGNOSTIC_CODES.modelUnavailable,
      )
      if (result.prepared?.action !== "start" || blocking.length > 0) {
        const diagnostics = blocking
          .map((diagnostic) => `- [${diagnostic.code}] ${diagnostic.path}: ${diagnostic.message}${diagnostic.hint ? ` (${diagnostic.hint})` : ""}`)
          .join("\n")
        return yield* Effect.fail(
          new InvalidRequestError({ message: `start rejected by workflow validation:\n${diagnostics || "no prepared graph"}` }),
        )
      }
      const prepared = result.prepared
      const dagID = yield* dag
        .create({
          projectID: session.projectID,
          sessionID: session.id,
          title: ctx.payload.title ?? prepared.title,
          config: {
            ...prepared.config,
            ...(prepared.admission ? { admission: createAdmissionRecord(prepared.admission) } : {}),
          },
        })
        .pipe(
          Effect.catch((error) => Effect.fail(new InvalidRequestError({ message: error.message }))),
        )
      const row = yield* dag.store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error(`created workflow missing from store: ${dagID}`))
      return wf(row)
    })

    // Same authority as the workflow tool's replan/extend actions: a fragment
    // passes Workflow Authoring (environment profile) before it reaches
    // Dag.replan/extend, which only run structural checks. Strict decoding
    // rejects controller-owned fields (model, recovery); environment checks
    // resolve worker types, prompt assets and models; gated checkpoints must
    // declare output_schema. Only prepared nodes reach the runtime mutation.
    const prepareFragment = Effect.fn("DagHttpApi.prepareFragment")(function* (
      workflow: DagStore.WorkflowRow,
      action: "replan" | "extend",
      fragment: Record<string, unknown>,
    ) {
      const config = Dag.parseWorkflowConfig(workflow.config)
      const owner = yield* sessions.get(SessionID.make(workflow.sessionId)).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      const knownDependencies = (yield* dag.store.getNodes(workflow.id).pipe(Effect.orDie)).map((node) => node.id)
      // The HTTP replan fragment has always been a bare `{ nodes }`; the
      // authoring replan envelope requires a graph name, so supply the
      // workflow's own name when the caller omits it.
      const value =
        action === "replan"
          ? { fragment: { ...(fragment.name === undefined ? { name: config?.name ?? workflow.title } : {}), ...fragment } }
          : fragment
      const result = yield* authoring.prepare({
        action,
        source: { kind: "inline", value, source: `httpapi:dag.${action}` },
        profile: "environment",
        environment: {
          directory: owner?.directory ?? (yield* InstanceState.context).directory,
          parent: owner?.model ?? undefined,
        },
        known_dependencies: knownDependencies,
        node_defaults: config?.node_defaults,
      })
      if (!result.valid || result.prepared?.action !== action) {
        const diagnostics = result.errors
          .map((diagnostic) => `- [${diagnostic.code}] ${diagnostic.path}: ${diagnostic.message}${diagnostic.hint ? ` (${diagnostic.hint})` : ""}`)
          .join("\n")
        return yield* Effect.fail(
          new InvalidRequestError({ message: `${action} rejected by workflow validation:\n${diagnostics || "no prepared graph"}` }),
        )
      }
      return result.prepared.nodes
    })

    /** Structural rejections from the runtime mutation seam (merged-graph
     * checks authoring cannot see) are request errors, not defects. */
    function mapFragmentRejection<Success>(effect: Effect.Effect<Success, Error>) {
      return effect.pipe(
        Effect.catch((error: Error): Effect.Effect<never, InvalidRequestError | ConflictError> =>
          error instanceof Dag.StructuralValidationError
            ? Effect.fail(new InvalidRequestError({ message: error.message }))
            : mapTransitionConflict(Effect.fail(error)),
        ),
      )
    }

    const control = Effect.fn("DagHttpApi.control")(function* (ctx: { params: { dagID: string }; payload: { operation: string; fragment?: unknown } }) {
      const { dagID } = ctx.params
      const op = ctx.payload.operation

      // Pre-check existence so non-existent workflows return 404, not a 500 defect.
      const workflow = yield* requireWorkflow(dagID)

      // Control ops may fail with InvalidTransitionError/TerminalViolationError for
      // semantically invalid operations (e.g. pause on a completed workflow). Map those
      // to 409 Conflict instead of letting .orDie promote them to 500 defects.
      if (op === "pause") {
        yield* mapTransitionConflict(dag.pause(dagID))
        return { status: "ok" }
      }
      if (op === "step") {
        yield* mapTransitionConflict(dag.step(dagID))
        return { status: "ok" }
      }
      if (op === "resume") {
        yield* mapTransitionConflict(dag.resume(dagID))
        return { status: "ok" }
      }
      if (op === "cancel") {
        yield* mapTransitionConflict(dag.cancel(dagID))
        return { status: "ok" }
      }
      if (op === "complete") {
        yield* mapTransitionConflict(dag.complete(dagID))
        return { status: "ok" }
      }
      if (op === "replan") {
        const fragment = ctx.payload.fragment
        if (!fragment || typeof fragment !== "object" || !Array.isArray((fragment as Record<string, unknown>).nodes)) {
          return yield* Effect.fail(new InvalidRequestError({ message: "replan requires 'fragment' with a 'nodes' array" }))
        }
        const nodes = yield* prepareFragment(workflow, "replan", fragment as Record<string, unknown>)
        const result = yield* mapFragmentRejection(dag.replan(dagID, { nodes }))
        return { status: "ok", ...result }
      }
      if (op === "extend") {
        const fragment = ctx.payload.fragment
        if (!fragment || typeof fragment !== "object" || !Array.isArray((fragment as Record<string, unknown>).nodes)) {
          return yield* Effect.fail(new InvalidRequestError({ message: "extend requires 'fragment' with a 'nodes' array" }))
        }
        const nodes = yield* prepareFragment(workflow, "extend", fragment as Record<string, unknown>)
        const result = yield* mapFragmentRejection(dag.extend(dagID, nodes))
        return { status: "ok", ...result }
      }
      return yield* Effect.fail(new InvalidRequestError({ message: `Unknown operation: ${op}` }))
    })

    return handlers
      .handle("list", list)
      .handle("start", start)
      .handle("bySession", bySession)
      .handle("summary", summary)
      .handle("detail", detail)
      .handle("nodes", nodes)
      .handle("nodeDetail", nodeDetail)
      .handle("control", control)
  }),
)
