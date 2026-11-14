// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"
import { Dag } from "@/dag/dag"
import { DagNodeView } from "@/dag/node-view"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import type { DagStore } from "@graphagent/core/dag/store"
import { DagMessages } from "@graphagent/core/dag/messages"

/**
 * DAG HTTP handlers — read-only queries delegate to DagStore. Mutations are
 * intentionally not exposed here; control goes through the workflow tool.
 */
export const dagHandlers = HttpApiBuilder.group(InstanceHttpApi, "dag", (handlers) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const messages = yield* DagMessages.Service
    const sessions = yield* Session.Service

    const wf = (r: DagStore.WorkflowRow) => ({
      id: r.id,
      project_id: r.projectId,
      session_id: r.sessionId,
      title: r.title,
      status: r.status,
      ...(r.pauseReason !== null ? { pause_reason: r.pauseReason } : {}),
      config: r.config,
      seq: r.seq,
      time_created: r.timeCreated,
      time_updated: r.timeUpdated,
      ...(r.startedAt !== null ? { started_at: r.startedAt } : {}),
      ...(r.completedAt !== null ? { completed_at: r.completedAt } : {}),
    })

    const node = DagNodeView.base

    // One batch read for the whole list: four constant-cost statements instead
    // of four per node (D4).
    const observedNodes = Effect.fn("DagHttpApi.observedNodes")(function* (
      rows: ReadonlyArray<DagStore.NodeRow>,
      ownerSessionID: string,
    ) {
      const first = rows[0]
      if (first === undefined) return []
      const instance = yield* InstanceState.context
      const metadata = yield* messages.metadataForWorkflow(
        {
          projectID: instance.project.id,
          directory: instance.directory,
          sessionID: ownerSessionID,
        },
        first.workflowId,
        rows.map((row) => row.id),
        // The rows are already current: skip the batch reader's own node read.
        rows.map((row) => ({
          id: row.id,
          workflow_id: row.workflowId,
          child_session_id: row.childSessionId,
          replan_attempts: row.replanAttempts,
        })),
      )
      const byNode: ReadonlyMap<string, DagMessages.Metadata> = metadata.ok ? metadata.value : new Map()
      return rows.map((row) => DagNodeView.observed(node(row), byNode.get(row.id)))
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
      const session = yield* sessions
        .get(SessionID.make(sessionID))
        .pipe(Effect.catch(() => Effect.fail(notFound(`Session not found: ${sessionID}`))))
      if (session.projectID !== (yield* InstanceState.context).project.id) {
        return yield* Effect.fail(notFound(`Session not found: ${sessionID}`))
      }
      return session
    })

    const list = Effect.fn("DagHttpApi.list")(function* () {
      const projectID = (yield* InstanceState.context).project.id
      // Project-scoped read: never materialize other projects' workflows.
      const rows = yield* dag.store.listByProject(projectID).pipe(Effect.orDie)
      return rows.map(wf)
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
        abortedNodes: s.abortedNodes,
        queuedNodes: s.queuedNodes,
        escalatedNodes: s.escalatedNodes,
        tokens: s.tokens,
        tokensCacheRead: s.tokensCacheRead,
        checkpointPending: s.checkpointPending,
        // D6b owns the real values; fixed here so HTTP and the publisher
        // event expose the same shape.
        coverageCount: 0,
        quality: null,
      }))
    })

    const nodes = Effect.fn("DagHttpApi.nodes")(function* (ctx: { params: { dagID: string } }) {
      const workflow = yield* requireWorkflow(ctx.params.dagID)
      // Rev-view (v1.0.15 Train A): the TUI node list is a view seam — it
      // renders the CURRENT graph revision only (zero TUI changes: the
      // server filters).
      const rows = yield* dag.store.getCurrentNodes(ctx.params.dagID).pipe(Effect.orDie)
      return yield* observedNodes(rows, workflow.sessionId)
    })

    return handlers
      .handle("list", list)
      .handle("bySession", bySession)
      .handle("summary", summary)
      .handle("nodes", nodes)
  }),
)
