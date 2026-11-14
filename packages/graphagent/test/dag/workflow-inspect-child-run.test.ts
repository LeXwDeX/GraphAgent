// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- narrow dag store fixture and branded params

/**
 * Issue #1030 D9-h: `inspect.status` reports each node's child-run state read
 * through `ChildRuns.inspect`, not assembled from separate reads. The fixture
 * compares the rendered field with the same run's durable row, so the tool and
 * the engine cannot drift.
 */
import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Effect, Option, Scope } from "effect"
import { Dag } from "@/dag/dag"
import { makeChildRuns } from "@/session/child/run"
import { ChildStore } from "@/session/child/store"
import { SessionID } from "@/session/schema"
import { inspectWorkflow } from "@/tool/workflow/inspect"
import { testEffect } from "../lib/effect"
import { makeNodeRow, makeWorkflowRow } from "./fixtures"

const it = testEffect(Database.layerFromPath(":memory:"))

const seedSession = (db: Database.Interface["db"], id: SessionID) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_inspect"), worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.make("prj_inspect"),
        slug: `inspect-${id}`,
        directory: AbsolutePath.make("/tmp"),
        title: "inspect",
        version: "0",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

describe("workflow inspect status child runs (#1030 D9-h)", () => {
  it.effect("renders the node's run from the durable row read through ChildRuns.inspect", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const scope = yield* Scope.Scope
      const parentID = SessionID.make(`ses_inspect_parent_${crypto.randomUUID()}`)
      const childID = SessionID.make(`ses_inspect_child_${crypto.randomUUID()}`)
      const dagID = `wf-inspect-${crypto.randomUUID()}`
      yield* seedSession(db, parentID)
      yield* seedSession(db, childID)

      const children = yield* makeChildRuns({ db, scope, cancelSession: () => Effect.void })
      const run = yield* children.forParent(parentID).start({
        childSessionID: childID,
        owner: { kind: "dag_node", workflowID: dagID, nodeID: "n1", attempt: 0 },
        detached: false,
        permission: { ask: "auto" },
      })
      expect(yield* run.markRunning).toBe(true)

      const workflow = makeWorkflowRow({
        id: dagID,
        sessionId: parentID,
        config: JSON.stringify({
          name: "inspect-child-run",
          nodes: [{ id: "n1", name: "N1", worker_type: "build", depends_on: [], prompt_template: { inline: "x" } }],
        }),
      })
      const node = makeNodeRow({
        id: "n1",
        workflowId: dagID,
        status: "running",
        childSessionId: childID,
        replanAttempts: 0,
      })
      const dag = {
        store: {
          getWorkflow: () => Effect.succeed(workflow),
          getCurrentNodes: () => Effect.succeed([node]),
          getNodes: () => Effect.succeed([node]),
        },
      } as unknown as Dag.Interface

      const result = yield* inspectWorkflow(
        { dag, sessionID: parentID, children: children.forParent(parentID) },
        { action: "inspect", operation: "status", workflow_id: dagID } as never,
      )
      const view = JSON.parse(result.output)
      const rendered = view.nodes.find((entry: { id: string }) => entry.id === "n1")?.child_run

      // The same run read directly from the durable row: the status view and
      // the engine must agree.
      const direct = Option.getOrThrow(
        Option.map(yield* ChildStore.runOf(db, run.id), (row) => ChildStore.viewOf(row)),
      )
      expect(rendered).toEqual({
        id: direct.id,
        state: direct.state,
        attempt: direct.attempt,
      })
      expect(rendered.state).toBe("running")
    }),
  )

  it.effect("omits the child run when the node has no run yet", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const scope = yield* Scope.Scope
      const parentID = SessionID.make(`ses_inspect_parent_${crypto.randomUUID()}`)
      const dagID = `wf-inspect-${crypto.randomUUID()}`
      yield* seedSession(db, parentID)
      const children = yield* makeChildRuns({ db, scope, cancelSession: () => Effect.void })

      const workflow = makeWorkflowRow({
        id: dagID,
        sessionId: parentID,
        config: JSON.stringify({ name: "inspect-child-run", nodes: [] }),
      })
      const node = makeNodeRow({ id: "n1", workflowId: dagID, status: "queued", childSessionId: null })
      const dag = {
        store: {
          getWorkflow: () => Effect.succeed(workflow),
          getCurrentNodes: () => Effect.succeed([node]),
          getNodes: () => Effect.succeed([node]),
        },
      } as unknown as Dag.Interface

      const result = yield* inspectWorkflow(
        { dag, sessionID: parentID, children: children.forParent(parentID) },
        { action: "inspect", operation: "status", workflow_id: dagID } as never,
      )
      const view = JSON.parse(result.output)
      expect(view.nodes[0].child_run).toBeUndefined()
    }),
  )
})