// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowTable } from "@opencode-ai/core/dag/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Dag, type NodeConfig } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const persistence = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
)
const it = testEffect(Layer.provideMerge(Dag.layer, persistence))

function node(id: string, extra: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
    ...extra,
  }
}

function setup(sessionID: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionID.make(sessionID),
        project_id: Project.ID.global,
        slug: sessionID,
        directory: AbsolutePath.make("/project"),
        title: sessionID,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function create(dag: Dag.Interface, sessionID: string, nodes: NodeConfig[]) {
  return dag.create({
    projectID: Project.ID.global,
    sessionID,
    title: sessionID,
    config: { name: sessionID, nodes },
  })
}

function start(dag: Dag.Interface, dagID: string, nodeID: string) {
  return Effect.gen(function* () {
    yield* dag.nodeQueued(dagID, nodeID, Date.now() + 60_000)
    yield* dag.nodeStarted(dagID, nodeID, `ses_${nodeID}`, Date.now() + 60_000)
  })
}

function completeFailure(dag: Dag.Interface, dagID: string) {
  return dag.complete(dagID).pipe(
    Effect.as(undefined),
    Effect.catch((error) => Effect.succeed(error)),
  )
}

describe("explicit completion gate", () => {
  it.effect("rejects a pending required node without changing state", () =>
    Effect.gen(function* () {
      const sessionID = "ses_complete_pending"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("required")])

      const failure = yield* completeFailure(dag, dagID)
      expect(failure).toBeInstanceOf(Dag.CompletionGateError)
      if (!(failure instanceof Error)) throw new Error("completion unexpectedly succeeded")
      expect(failure.message).toContain("required (pending)")
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("running")
      expect((yield* dag.store.getNode(dagID, "required"))?.status).toBe("pending")
    }),
  )

  it.effect("rejects a running required node without terminating it", () =>
    Effect.gen(function* () {
      const sessionID = "ses_complete_running"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("required")])
      yield* start(dag, dagID, "required")

      const failure = yield* completeFailure(dag, dagID)
      expect(failure).toBeInstanceOf(Dag.CompletionGateError)
      if (!(failure instanceof Error)) throw new Error("completion unexpectedly succeeded")
      expect(failure.message).toContain("required (running)")
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("running")
      expect((yield* dag.store.getNode(dagID, "required"))?.status).toBe("running")
    }),
  )

  it.effect("rejects a failed required node", () =>
    Effect.gen(function* () {
      const sessionID = "ses_complete_failed"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("required")])
      yield* start(dag, dagID, "required")
      yield* dag.nodeFailed(dagID, "required", "boom", "exec_failed")

      const failure = yield* completeFailure(dag, dagID)
      expect(failure).toBeInstanceOf(Dag.CompletionGateError)
      if (!(failure instanceof Error)) throw new Error("completion unexpectedly succeeded")
      expect(failure.message).toContain("required (failed)")
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("running")
      expect((yield* dag.store.getNode(dagID, "required"))?.status).toBe("failed")
    }),
  )

  it.effect("rejects an unaccepted skipped required node", () =>
    Effect.gen(function* () {
      const sessionID = "ses_complete_skipped"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [
        node("gate"),
        node("required", { depends_on: ["gate"], condition: 'gate.output == "YES"', skip_ok: false }),
      ])
      yield* start(dag, dagID, "gate")
      yield* dag.nodeCompleted(dagID, "gate", "NO")
      yield* dag.nodeSkipped(dagID, "required", "condition_false")

      const failure = yield* completeFailure(dag, dagID)
      expect(failure).toBeInstanceOf(Dag.CompletionGateError)
      if (!(failure instanceof Error)) throw new Error("completion unexpectedly succeeded")
      expect(failure.message).toContain("required (skipped: condition_false)")
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("running")
      expect((yield* dag.store.getNode(dagID, "required"))?.status).toBe("skipped")
    }),
  )

  it.effect("allows completion after an opted-in required skip and terminates optional nodes", () =>
    Effect.gen(function* () {
      const sessionID = "ses_complete_skip_ok"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [
        node("gate"),
        node("required", { depends_on: ["gate"], condition: 'gate.output == "YES"', skip_ok: true }),
        node("optional", { required: false }),
      ])
      yield* start(dag, dagID, "gate")
      yield* dag.nodeCompleted(dagID, "gate", "NO")
      yield* dag.nodeSkipped(dagID, "required", "condition_false")

      yield* dag.complete(dagID)
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("completed")
      expect((yield* dag.store.getNode(dagID, "required"))?.status).toBe("skipped")
      const optional = yield* dag.store.getNode(dagID, "optional")
      expect(optional?.status).toBe("skipped")
      expect(optional?.errorReason).toBe("agent_complete")
    }),
  )

  it.effect("allows completion when required nodes completed and terminates optional work", () =>
    Effect.gen(function* () {
      const sessionID = "ses_complete_required_done"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("required"), node("optional", { required: false })])
      yield* start(dag, dagID, "required")
      yield* dag.nodeCompleted(dagID, "required", "done")
      yield* start(dag, dagID, "optional")

      yield* dag.complete(dagID)
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("completed")
      expect((yield* dag.store.getNode(dagID, "required"))?.status).toBe("completed")
      const optional = yield* dag.store.getNode(dagID, "optional")
      expect(optional?.status).toBe("aborted")
      expect(optional?.errorReason).toBe("agent_complete")
    }),
  )

  it.effect("defaults every new required node to strict skip semantics", () =>
    Effect.gen(function* () {
      const sessionID = "ses_complete_default_strict"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [
        node("gate"),
        node("required", { depends_on: ["gate"], condition: 'gate.output == "YES"' }),
        node("cascade", { depends_on: ["required"] }),
        node("optional", { required: false }),
      ])

      const config = Dag.parseWorkflowConfig((yield* dag.store.getWorkflow(dagID))!.config)
      expect(config?.nodes.find((candidate) => candidate.id === "required")?.skip_ok).toBe(false)
      expect(config?.nodes.find((candidate) => candidate.id === "cascade")?.skip_ok).toBe(false)
      expect(config?.nodes.find((candidate) => candidate.id === "optional")?.skip_ok).toBeUndefined()
    }),
  )

  it.effect("preserves legacy definitions across extend and unchanged replan", () =>
    Effect.gen(function* () {
      const sessionID = "ses_complete_legacy_definitions"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const { db } = yield* Database.Service
      const dagID = yield* create(dag, sessionID, [node("legacy")])

      // Model a pre-#950 persisted row: create normalizes it, so strip the
      // field before exercising mutations against the legacy definition.
      const workflow = (yield* dag.store.getWorkflow(dagID))!
      const legacyConfig = Dag.parseWorkflowConfig(workflow.config)!
      const withoutSkip = {
        ...legacyConfig,
        nodes: legacyConfig.nodes.map(({ skip_ok: _skipOk, ...definition }) => definition),
      }
      yield* db
        .update(WorkflowTable)
        .set({ config: JSON.stringify(withoutSkip) })
        .where(eq(WorkflowTable.id, dagID))
        .run()

      yield* dag.extend(dagID, [node("added")])
      const extended = Dag.parseWorkflowConfig((yield* dag.store.getWorkflow(dagID))!.config)!
      expect(extended.nodes.find((candidate) => candidate.id === "legacy")?.skip_ok).toBeUndefined()
      expect(extended.nodes.find((candidate) => candidate.id === "added")?.skip_ok).toBe(false)

      const legacy = extended.nodes.find((candidate) => candidate.id === "legacy")!
      const added = extended.nodes.find((candidate) => candidate.id === "added")!
      yield* dag.replan(dagID, { nodes: [legacy, added] })
      const unchanged = Dag.parseWorkflowConfig((yield* dag.store.getWorkflow(dagID))!.config)!
      expect(unchanged.nodes.find((candidate) => candidate.id === "legacy")?.skip_ok).toBeUndefined()

      yield* dag.replan(dagID, {
        nodes: [{ ...legacy, worker_config: { ...legacy.worker_config, timeout_ms: 9_000 } }, added],
      })
      const changed = Dag.parseWorkflowConfig((yield* dag.store.getWorkflow(dagID))!.config)!
      expect(changed.nodes.find((candidate) => candidate.id === "legacy")?.skip_ok).toBe(false)
    }),
  )

  it.effect("fails a required node failure even while dependents are still pending", () =>
    Effect.gen(function* () {
      const sessionID = "ses_complete_required_failed_dependent"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("required"), node("dependent", { depends_on: ["required"] })])
      yield* start(dag, dagID, "required")
      yield* dag.nodeFailed(dagID, "required", "boom", "exec_failed")

      const settled = yield* dag.settleCompletion(dagID, { allowAcceptedSkips: true, skipReviewGate: true })
      expect(settled.status).toBe("failed")
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("failed")
      expect((yield* dag.store.getNode(dagID, "dependent"))?.status).toBe("skipped")
      expect((yield* dag.store.getNode(dagID, "dependent"))?.errorReason).toBe("workflow_failed")
    }),
  )

  it.effect("fences stale completion evidence behind the observed graph revision", () =>
    Effect.gen(function* () {
      const sessionID = "ses_complete_stale_revision"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [
        {
          ...node("verify"),
          output_schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
        },
      ])
      yield* start(dag, dagID, "verify")
      yield* dag.nodeCompleted(dagID, "verify", { verdict: "FAIL" })
      const observed = (yield* dag.store.getWorkflow(dagID))!

      yield* dag.extend(dagID, [node("added")])
      const extended = (yield* dag.store.getWorkflow(dagID))!
      expect(extended.graphRev).toBe(observed.graphRev + 1)
      const stale = yield* dag.settleCompletion(dagID, {
        expectedGraphRev: observed.graphRev,
        allowAcceptedSkips: true,
        skipReviewGate: true,
      })
      expect(stale.status).toBe("stale")
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("running")

      yield* start(dag, dagID, "added")
      yield* dag.nodeCompleted(dagID, "added", "done")
      const settled = yield* dag.settleCompletion(dagID, {
        expectedGraphRev: extended.graphRev,
        allowAcceptedSkips: true,
        skipReviewGate: true,
      })
      expect(settled.status).toBe("failed")
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("failed")
    }),
  )

  it.effect("does not reinterpret ordinary scalar task output as a verdict", () =>
    Effect.gen(function* () {
      const sessionID = "ses_complete_ordinary_scalar"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("data", { output_schema: { type: "string" } })])
      yield* start(dag, dagID, "data")
      yield* dag.nodeCompleted(dagID, "data", '{"verdict":"FAIL"}')
      const settled = yield* dag.settleCompletion(dagID, { allowAcceptedSkips: true, skipReviewGate: true })
      expect(settled.status).toBe("completed")
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("completed")
    }),
  )

  it.effect("fails a completed design review with a failing verdict", () =>
    Effect.gen(function* () {
      const sessionID = "ses_complete_design_review"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [
        {
          ...node("design"),
          review: { phase: "design" },
          output_schema: {
            type: "object",
            properties: { verdict: { type: "string" } },
            required: ["verdict"],
          },
        },
      ])
      yield* start(dag, dagID, "design")
      yield* dag.nodeCompleted(dagID, "design", { verdict: "FAIL" })
      const settled = yield* dag.settleCompletion(dagID, { allowAcceptedSkips: true, skipReviewGate: true })
      expect(settled.status).toBe("failed")
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("failed")
    }),
  )

  it.effect("ignores a workflow moved to another directory after the ownership precheck", () =>
    Effect.gen(function* () {
      const sessionID = "ses_settle_moved"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("required")])
      yield* start(dag, dagID, "required")
      yield* dag.nodeCompleted(dagID, "required", { verdict: "ACCEPT" })

      // The caller prechecked ownership in /project; SessionEvent.Moved commits
      // its re-stamp before settlement reaches the fence.
      const { db } = yield* Database.Service
      yield* db.update(WorkflowTable).set({ directory: "/moved" }).where(eq(WorkflowTable.id, dagID)).run()

      const settled = yield* dag.settleCompletion(dagID, {
        owner: { projectID: Project.ID.global, directory: "/project" },
      })
      expect(settled.status).toBe("ignored")
      expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("running")
    }),
  )
})
