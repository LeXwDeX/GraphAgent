// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { $ } from "bun"
import { DateTime, Effect, Layer } from "effect"
import path from "node:path"
import { writeFileSync } from "node:fs"
import { Database } from "@graphagent/core/database/database"
import { InvalidTransitionError, StaleNodeAttemptError } from "@graphagent/core/dag/core/types"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { Session } from "@graphagent/schema/session"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Dag, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
import { DagLocation } from "@/dag/location"
import { planRecovery, staleUpstreamNodes, staleUpstreamNote } from "@/dag/recovery-plan"
import { EventV2Bridge } from "@/event-v2-bridge"
import { tmpdir } from "../fixture/fixture"

const projectID = Project.ID.make("project-retarget")
const sessionID = Session.ID.make("ses_retarget_parent")

function retargetLayer() {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  return Layer.mergeAll(database, events, bridge, store, projector, dag)
}

function seed(directory: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: "retarget",
        directory,
        title: "Retarget",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
}

function node(id: string, workerType = "build", overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id,
    name: id,
    worker_type: workerType,
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
    ...overrides,
  }
}

const config: WorkflowConfig = {
  name: "retarget",
  nodes: [node("review", "review"), node("build")],
}

function start(directory: string) {
  return Effect.gen(function* () {
    yield* seed(directory)
    const dag = yield* Dag.Service
    const dagID = yield* dag.create({ projectID, sessionID, title: "retarget", config })
    const fingerprint = DagLocation.fingerprintTarget(directory)
    yield* dag.nodeStarted(
      dagID,
      "review",
      "ses_review",
      undefined,
      true,
      undefined,
      directory,
      DagLocation.gitHead(directory),
      fingerprint,
    )
    yield* dag.nodeStarted(dagID, "build", "ses_build")
    return { dag, dagID, fingerprint }
  })
}

const fingerprintArg = (fingerprint: DagEvent.TargetFingerprint) => (fingerprint.kind === "git" ? fingerprint.value : "none")

describe("recovery context target evidence", () => {
  const config: WorkflowConfig = {
    name: "recovery-context",
    nodes: [node("upstream"), node("retry", "build", { depends_on: ["upstream"] })],
  }
  const upstream = (fingerprint?: DagEvent.TargetFingerprint): DagStore.NodeRow => ({
    id: "upstream",
    workflowId: "dag_retry",
    name: "upstream",
    workerType: "build",
    status: "completed",
    required: true,
    dependsOn: [],
    modelId: null,
    modelProviderId: null,
    childSessionId: "ses_upstream",
    output: "old evidence",
    capturedOutput: null,
    errorReason: null,
    errorClass: null,
    deadlineMs: null,
    wakeEligible: false,
    wakeReported: false,
    replanAttempts: 0,
    timeoutExtensions: 0,
    escalationPending: false,
    superseded: false,
    seq: 1,
    startedAt: 1,
    completedAt: 2,
    ...(fingerprint ? { targetFingerprint: fingerprint } : {}),
  })
  const retry = (childSessionId: string | null): DagStore.NodeRow => ({
    id: "retry",
    workflowId: "dag_retry",
    name: "retry",
    workerType: "build",
    status: "skipped",
    required: true,
    dependsOn: ["upstream"],
    modelId: null,
    modelProviderId: null,
    childSessionId,
    output: null,
    capturedOutput: null,
    errorReason: "workflow_failed",
    errorClass: null,
    deadlineMs: null,
    wakeEligible: false,
    wakeReported: false,
    replanAttempts: 0,
    timeoutExtensions: 0,
    escalationPending: false,
    superseded: false,
    seq: 2,
    startedAt: null,
    completedAt: null,
  })
  const fingerprint: DagEvent.TargetFingerprint = {
    kind: "git",
    head: "0123456789abcdef",
    diff: "clean",
    untracked: "clean",
    value: "current",
  }

  function context(
    prior: DagStore.NodeRow[],
    current: DagEvent.TargetFingerprint = fingerprint,
  ): unknown {
    const plan = planRecovery(config, prior, ["retry"], 2, 5, current)
    return plan.config.nodes.find((item) => item.recovery?.previous_node_id === "retry")!.prompt_template.input!
      .__workflow_recovery
  }

  it("omits the prior session and inspect instruction when the attempt never spawned", () => {
    const recovery = context([upstream(fingerprint), retry(null)])
    expect(recovery).toMatchObject({ previous_attempt: "never_started", previous_node_id: "retry" })
    expect(recovery).not.toHaveProperty("previous_child_session_id")
    expect(JSON.stringify(recovery)).not.toContain("Inspect the prior session")
  })

  it("keeps the prior session and inspect instruction when it exists", () => {
    const recovery = context([upstream(fingerprint), retry("ses_retry_old")])
    expect(recovery).toMatchObject({
      previous_child_session_id: "ses_retry_old",
      previous_status: "skipped",
      previous_error: "workflow_failed",
      instruction: expect.stringContaining("Inspect the prior session"),
    })
    expect(recovery).not.toHaveProperty("previous_attempt")
  })

  it("marks reused upstream evidence stale when its fingerprint differs", () => {
    const recovery = context([upstream(fingerprint), retry(null)], { ...fingerprint, value: "moved" })
    expect(recovery).toMatchObject({
      upstream: [{ node_id: "upstream", fingerprint, stale: true }],
    })
    expect(staleUpstreamNodes(recovery)).toEqual(["upstream"])
    expect(staleUpstreamNote(["upstream"])).toContain("Upstream evidence is stale")
  })

  it("keeps matching upstream evidence current and renders no stale note", () => {
    const recovery = context([upstream(fingerprint), retry(null)])
    expect(recovery).toMatchObject({
      upstream: [{ node_id: "upstream", fingerprint, stale: false }],
    })
    expect(staleUpstreamNodes(recovery)).toEqual([])
    expect(staleUpstreamNote([])).toBe("")
  })

  it("does not mark legacy evidence without a fingerprint stale", () => {
    expect(staleUpstreamNodes(context([upstream(), retry(null)]))).toEqual([])
  })

  it("includes reused input-mapping sources in upstream evidence", () => {
    const mapped: WorkflowConfig = {
      name: "recovery-mapped",
      nodes: [
        node("upstream"),
        node("side"),
        node("retry", "build", { input_mapping: { report: "side.output" } }),
      ],
    }
    const side = { ...upstream(fingerprint), id: "side", name: "side" }
    const mappedRetry = { ...retry("ses_retry_old"), dependsOn: [] }
    const plan = planRecovery(mapped, [upstream(fingerprint), side, mappedRetry], ["retry"], 2, 5, fingerprint)
    const recovery = plan.config.nodes.find((item) => item.recovery?.previous_node_id === "retry")!
      .prompt_template.input!.__workflow_recovery
    expect(recovery).toMatchObject({
      upstream: [{ node_id: "side", fingerprint, stale: false }],
    })
  })

  it("ignores malformed recovery payloads", () => {
    expect(staleUpstreamNodes(undefined)).toEqual([])
    expect(staleUpstreamNodes({ upstream: [null, { stale: true }] })).toEqual([])
  })

  it("compares recovered review evidence with the current tree rather than the creation tree", async () => {
    for (const changedAfterReview of [false, true]) {
      await using tmp = await tmpdir({ git: true })
      const worktree = path.join(tmp.path, "linked")
      await $`git worktree add ${worktree} -b recovery-linked`.cwd(tmp.path).quiet()
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* seed(tmp.path)
          const dag = yield* Dag.Service
          const store = yield* DagStore.Service
          const workflowConfig: WorkflowConfig = {
            name: "recovery-current-tree",
            workspace: worktree,
            nodes: [
              node("writer"),
              node("review", "review", { depends_on: ["writer"] }),
              node("retry", "build", { depends_on: ["review"] }),
            ],
          }
          const id = yield* dag.create({ projectID, sessionID, title: "recover", config: workflowConfig })
          const initial = DagLocation.fingerprintTarget(worktree)
          yield* dag.nodeStarted(id, "writer", "ses_writer", undefined, false, undefined, worktree, undefined, initial)
          writeFileSync(path.join(worktree, "change.txt"), "writer change")
          yield* dag.nodeCompleted(id, "writer", "written")
          const reviewed = DagLocation.fingerprintTarget(worktree)
          expect(DagLocation.sameFingerprint(initial, reviewed)).toBe(false)
          yield* dag.nodeStarted(id, "review", "ses_review", undefined, false, undefined, worktree, undefined, reviewed)
          yield* dag.nodeCompleted(id, "review", { verdict: "ACCEPT" })
          expect((yield* store.getNode(id, "review"))?.staleTarget).toBeFalsy()
          if (changedAfterReview) writeFileSync(path.join(worktree, "change.txt"), "later change")
          yield* dag.pause(id)
          const workflow = (yield* store.getWorkflow(id))!
          yield* dag.recover(id, { nodeIDs: ["retry"], expectedGraphRev: workflow.graphRev })
          const updated = Dag.parseWorkflowConfig((yield* store.getWorkflow(id))!.config)!
          const recovery = updated.nodes.find((item) => item.recovery?.previous_node_id === "retry")!
            .prompt_template.input!.__workflow_recovery
          expect(staleUpstreamNodes(recovery)).toEqual(changedAfterReview ? ["review"] : [])
          expect(recovery).toMatchObject({ upstream: [{ node_id: "review", fingerprint: reviewed, stale: changedAfterReview }] })
        }).pipe(Effect.provide(retargetLayer()), Effect.scoped),
      )
    }
  })
})

describe("Dag retarget", () => {
  it("permits an unchanged target but rejects a changed fingerprint after review", async () => {
    await using tmp = await tmpdir({ git: true })
    await Effect.runPromise(
      Effect.gen(function* () {
        const { dag, dagID, fingerprint } = yield* start(tmp.path)
        const store = yield* DagStore.Service
        yield* dag.nodeCompleted(dagID, "review", { verdict: "ACCEPT" })
        const unchanged = yield* dag.retarget(dagID, { fingerprint: fingerprintArg(fingerprint) })
        expect(unchanged.nodes).toEqual([])
        const before = yield* store.getNode(dagID, "review")
        const workflow = yield* store.getWorkflow(dagID)
        writeFileSync(path.join(tmp.path, "change.txt"), "changed")
        const current = DagLocation.fingerprintTarget(tmp.path)
        const rejected = yield* dag.retarget(dagID, { fingerprint: fingerprintArg(current) }).pipe(Effect.flip)
        expect(rejected.message).toContain("review")
        expect(yield* store.getNode(dagID, "review")).toEqual(before)
        expect(yield* store.getWorkflow(dagID)).toEqual(workflow)
      }).pipe(Effect.provide(retargetLayer()), Effect.scoped),
    )
  })

  it("rejects changing targets with completed target-sensitive evidence", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = path.join(tmp.path, "linked")
    await $`git worktree add ${worktree} -b completed-review-linked`.cwd(tmp.path).quiet()
    await Effect.runPromise(
      Effect.gen(function* () {
        const { dag, dagID } = yield* start(tmp.path)
        const store = yield* DagStore.Service
        yield* dag.nodeCompleted(dagID, "review", { verdict: "ACCEPT" })
        const before = yield* store.getNode(dagID, "review")
        const workflow = yield* store.getWorkflow(dagID)
        expect(before).toMatchObject({ status: "completed", staleTarget: false })
        expect((yield* store.getNode(dagID, "build"))?.status).toBe("running")
        const rejected = yield* dag.retarget(dagID, { workspace: worktree }).pipe(Effect.flip)
        expect(rejected.message).toContain("review")
        expect(rejected.message).toMatch(/recover|re-run/i)
        expect(yield* store.getNode(dagID, "review")).toEqual(before)
        expect(yield* store.getWorkflow(dagID)).toEqual(workflow)
        expect(yield* store.getLatestRetarget!(dagID)).toBeUndefined()
      }).pipe(Effect.provide(retargetLayer()), Effect.scoped),
    )
  })

  it("restarts only running target-sensitive attempts and updates the target", async () => {
    await using tmp = await tmpdir({ git: true })
    await Effect.runPromise(
      Effect.gen(function* () {
        const { dag, dagID, fingerprint } = yield* start(tmp.path)
        const store = yield* DagStore.Service
        const result = yield* dag.retarget(dagID, {
          fingerprint: fingerprintArg(fingerprint),
          reason: "tree moved",
        })

        expect(result.nodes).toEqual(["review"])
        expect(result.graphRev).toBe(2)
        expect(result.toFingerprint).toEqual(fingerprint)
        expect(yield* store.getNode(dagID, "review")).toMatchObject({
          status: "pending",
          replanAttempts: 1,
        })
        expect(yield* store.getNode(dagID, "build")).toMatchObject({ status: "running", replanAttempts: 0 })
        expect((yield* store.getWorkflow(dagID))?.targetFingerprint).toEqual(fingerprint)
        expect((yield* store.getWorkflow(dagID))?.graphRev).toBe(2)

        const audit = yield* store.getLatestRetarget!(dagID)
        expect(audit?.retarget).toMatchObject({
          fromFingerprint: fingerprint,
          toFingerprint: fingerprint,
          reason: "tree moved",
          nodes: ["review"],
        })

        const staleAttempt = yield* dag
          .nodeCompleted(dagID, "review", { verdict: "old" }, { replanAttempts: 0, childSessionID: "ses_review" })
          .pipe(Effect.flip)
        expect(staleAttempt).toBeInstanceOf(StaleNodeAttemptError)
        const lateCompletion = yield* dag.nodeCompleted(dagID, "review", { verdict: "old" }).pipe(Effect.flip)
        expect(lateCompletion).toBeInstanceOf(InvalidTransitionError)
      }).pipe(Effect.provide(retargetLayer()), Effect.scoped),
    )
  })

  it("restarts a selected target-sensitive node and rejects non-target-sensitive ids", async () => {
    await using tmp = await tmpdir({ git: true })
    await Effect.runPromise(
      Effect.gen(function* () {
        const { dag, dagID, fingerprint } = yield* start(tmp.path)
        const rejected = yield* dag
          .retarget(dagID, { fingerprint: fingerprintArg(fingerprint), nodeIDs: ["build"] })
          .pipe(Effect.flip)
        expect(rejected.message).toContain("not running target-sensitive")
        expect((yield* (yield* DagStore.Service).getNode(dagID, "review"))?.status).toBe("running")

        const selected = yield* dag.retarget(dagID, {
          fingerprint: fingerprintArg(fingerprint),
          nodeIDs: ["review"],
        })
        expect(selected.nodes).toEqual(["review"])
      }).pipe(Effect.provide(retargetLayer()), Effect.scoped),
    )
  })

  it("rejects a fingerprint mismatch and an empty selection without side effects", async () => {
    await using tmp = await tmpdir({ git: true })
    await Effect.runPromise(
      Effect.gen(function* () {
        const { dag, dagID } = yield* start(tmp.path)
        const store = yield* DagStore.Service
        const mismatch = yield* dag.retarget(dagID, { fingerprint: "deadbeef" }).pipe(Effect.flip)
        expect(mismatch.message).toContain("expected target fingerprint deadbeef")
        const empty = yield* dag.retarget(dagID, { fingerprint: fingerprintArg(DagLocation.fingerprintTarget(tmp.path)), nodeIDs: [] }).pipe(Effect.flip)
        expect(empty.message).toContain("node_ids must not be empty")
        const missing = yield* dag.retarget(dagID, {}).pipe(Effect.flip)
        expect(missing.message).toContain("provide workspace or fingerprint")
        expect((yield* store.getNode(dagID, "review"))?.status).toBe("running")
        expect(yield* store.getLatestRetarget!(dagID)).toBeUndefined()
      }).pipe(Effect.provide(retargetLayer()), Effect.scoped),
    )
  })

  it("rebinds the workspace, config, and execution directory together", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = path.join(tmp.path, "linked")
    await $`git worktree add ${worktree} -b retarget-linked`.cwd(tmp.path).quiet()
    writeFileSync(path.join(worktree, "new.txt"), "new tree")
    await Effect.runPromise(
      Effect.gen(function* () {
        const { dag, dagID } = yield* start(tmp.path)
        const store = yield* DagStore.Service
        const result = yield* dag.retarget(dagID, { workspace: worktree, reason: "switch worktree" })

        const resolved = DagLocation.canonicalDirectory(worktree)
        expect(result.toDirectory).toBe(resolved)
        expect(result.fromDirectory).toBe(DagLocation.canonicalDirectory(tmp.path))
        expect(result.nodes).toEqual(["review"])
        const workflow = yield* store.getWorkflow(dagID)
        expect(workflow?.executionDirectory).toBe(resolved)
        expect(workflow?.targetFingerprint).toEqual(DagLocation.fingerprintTarget(resolved))
        expect(Dag.parseWorkflowConfig(workflow!.config)?.workspace).toBe(resolved)
        expect(yield* store.getNode(dagID, "review")).toMatchObject({ status: "pending", replanAttempts: 1 })
        const audit = yield* store.getLatestRetarget!(dagID)
        expect(audit?.retarget).toMatchObject({
          fromDirectory: DagLocation.canonicalDirectory(tmp.path),
          toDirectory: resolved,
          nodes: ["review"],
        })
      }).pipe(Effect.provide(retargetLayer()), Effect.scoped),
    )
  })

  it("rejects an invalid workspace before any event is published", async () => {
    await using tmp = await tmpdir({ git: true })
    await Effect.runPromise(
      Effect.gen(function* () {
        const { dag, dagID } = yield* start(tmp.path)
        const invalid = yield* dag.retarget(dagID, { workspace: "/definitely/missing" }).pipe(Effect.flip)
        expect(invalid.message).toContain("workspace does not exist")
        expect((yield* (yield* DagStore.Service).getNode(dagID, "review"))?.status).toBe("running")
        expect(yield* (yield* DagStore.Service).getLatestRetarget!(dagID)).toBeUndefined()
      }).pipe(Effect.provide(retargetLayer()), Effect.scoped),
    )
  })

  it("keeps legacy WorkflowReplanned events without retarget as a target no-op", async () => {
    await using tmp = await tmpdir({ git: true })
    await Effect.runPromise(
      Effect.gen(function* () {
        const { dagID, fingerprint } = yield* start(tmp.path)
        const store = yield* DagStore.Service
        const events = yield* EventV2.Service
        const timestamp = DateTime.makeUnsafe(1)
        for (let seq = 0; seq < 2; seq++) {
          yield* events.publish(DagEvent.WorkflowReplanned, {
            dagID: DagEvent.DagID.make(dagID),
            added: 0,
            removed: 0,
            replaced: 0,
            restarted: 0,
            timestamp,
          })
        }
        const workflow = yield* store.getWorkflow(dagID)
        expect(workflow?.targetFingerprint).toEqual(fingerprint)
        expect(workflow?.executionDirectory).toBeFalsy()
        expect(yield* store.getLatestRetarget!(dagID)).toBeUndefined()
      }).pipe(Effect.provide(retargetLayer()), Effect.scoped),
    )
  })
})
