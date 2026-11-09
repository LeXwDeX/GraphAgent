// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { $ } from "bun"
import { DateTime, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { writeFileSync } from "node:fs"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { EventTable, EventSequenceTable } from "@graphagent/core/event/sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath, NonNegativeInt } from "@graphagent/core/schema"
import { Session } from "@graphagent/schema/session"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Dag, type WorkflowConfig } from "@/dag/dag"
import { DagBlocks } from "@/dag/blocks"
import { DagLocation } from "@/dag/location"
import { targetSensitiveNode } from "@/dag/review-lifecycle"
import { resultTargetFields } from "@/tool/workflow"
import { EventV2Bridge } from "@/event-v2-bridge"
import { tmpdir } from "../fixture/fixture"

const projectID = Project.ID.make("project-target")
const sessionID = Session.ID.make("ses_target_parent")
const childSessionID = Session.ID.make("ses_target_child")
const ts = (n: number) => DateTime.makeUnsafe(n)

const reviewConfig: WorkflowConfig = {
  name: "target-fingerprint",
  nodes: [
    {
      id: "review-1",
      name: "Review",
      worker_type: "review",
      depends_on: [],
      required: true,
      prompt_template: { inline: "review" },
    },
  ],
}

function targetLayer() {
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
        slug: "target",
        directory,
        title: "Target",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
}

function startReview(directory: string) {
  return Effect.gen(function* () {
    yield* seed(directory)
    const dag = yield* Dag.Service
    const dagID = yield* dag.create({
      projectID,
      sessionID,
      title: "target",
      config: reviewConfig,
    })
    const start = DagLocation.fingerprintTarget(directory)
    yield* dag.nodeStarted(
      dagID,
      "review-1",
      childSessionID,
      undefined,
      true,
      undefined,
      directory,
      DagLocation.gitHead(directory),
      start,
    )
    return { dag, dagID, start }
  })
}

describe("fingerprintTarget", () => {
  it("treats unavailable fingerprint evidence as stale while preserving legacy missing values", () => {
    const git = { kind: "git", head: "head", diff: "clean", untracked: "clean", value: "value" } as const
    const unavailable = { ...git, diff: "unavailable" }
    const unavailableUntracked = { ...git, untracked: "unavailable" }
    const none = { kind: "none" } as const
    expect(DagLocation.sameFingerprint(unavailable, unavailable)).toBe(false)
    expect(DagLocation.sameFingerprint(unavailable, git)).toBe(false)
    expect(DagLocation.sameFingerprint(git, unavailable)).toBe(false)
    expect(DagLocation.sameFingerprint(unavailable, none)).toBe(false)
    expect(DagLocation.sameFingerprint(none, unavailable)).toBe(false)
    expect(DagLocation.sameFingerprint(unavailableUntracked, unavailableUntracked)).toBe(false)
    expect(DagLocation.sameFingerprint(unavailableUntracked, git)).toBe(false)
    expect(DagLocation.sameFingerprint(git, unavailableUntracked)).toBe(false)
    expect(DagLocation.sameFingerprint(unavailableUntracked, none)).toBe(false)
    expect(DagLocation.sameFingerprint(none, unavailableUntracked)).toBe(false)
    for (const missing of [null, undefined]) {
      for (const value of [git, unavailable, unavailableUntracked, none, null, undefined]) {
        expect(DagLocation.sameFingerprint(missing, value)).toBe(true)
        expect(DagLocation.sameFingerprint(value, missing)).toBe(true)
      }
    }
    expect(DagLocation.sameFingerprint(git, { ...git })).toBe(true)
  })
  it("keeps a clean git target stable", async () => {
    await using tmp = await tmpdir({ git: true })
    const first = DagLocation.fingerprintTarget(tmp.path)
    const second = DagLocation.fingerprintTarget(tmp.path)
    expect(first.kind).toBe("git")
    expect(second).toEqual(first)
    expect(DagLocation.sameFingerprint(first, second)).toBe(true)
  })

  it("changes the diff hash when a tracked file changes", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "tracked.txt"), "one")
        await $`git add tracked.txt`.cwd(dir).quiet()
        await $`git commit -m tracked`.cwd(dir).quiet()
      },
    })
    const before = DagLocation.fingerprintTarget(tmp.path)
    writeFileSync(path.join(tmp.path, "tracked.txt"), "two")
    const after = DagLocation.fingerprintTarget(tmp.path)
    expect(before.kind).toBe("git")
    expect(after.kind).toBe("git")
    if (before.kind !== "git" || after.kind !== "git") return
    expect(after.head).toBe(before.head)
    expect(after.diff).not.toBe(before.diff)
    expect(after.value).not.toBe(before.value)
    expect(DagLocation.sameFingerprint(before, after)).toBe(false)
  })

  it("changes the untracked hash when an untracked file changes", async () => {
    await using tmp = await tmpdir({ git: true })
    writeFileSync(path.join(tmp.path, "new.txt"), "one")
    const before = DagLocation.fingerprintTarget(tmp.path)
    writeFileSync(path.join(tmp.path, "new.txt"), "two")
    const after = DagLocation.fingerprintTarget(tmp.path)
    expect(before.kind).toBe("git")
    expect(after.kind).toBe("git")
    if (before.kind !== "git" || after.kind !== "git") return
    expect(after.untracked).not.toBe(before.untracked)
    expect(after.value).not.toBe(before.value)
  })

  it("marks a non-git directory as none and never stale", async () => {
    await using tmp = await tmpdir()
    const fingerprint = DagLocation.fingerprintTarget(tmp.path)
    expect(fingerprint).toEqual({ kind: "none" })
    expect(DagLocation.sameFingerprint(fingerprint, { kind: "none" })).toBe(true)
    expect(DagLocation.sameFingerprint(fingerprint, fingerprint)).toBe(true)
  })
})

describe("Dag target fingerprint lifecycle", () => {
  it("classifies compiled, review, and custom nodes without relying on names", () => {
    expect(targetSensitiveNode({ target_sensitive: true }, "general")).toBe(true)
    expect(targetSensitiveNode({ review: { phase: "design" } }, "general")).toBe(true)
    expect(targetSensitiveNode(undefined, "review")).toBe(true)
    expect(targetSensitiveNode(undefined, "review-standards")).toBe(true)
    expect(targetSensitiveNode(undefined, "general")).toBe(false)
    expect(targetSensitiveNode({}, "build")).toBe(false)
  })

  it("passes completion and stores the fingerprint when the target is unchanged", async () => {
    await using tmp = await tmpdir({ git: true })
    await Effect.runPromise(
      Effect.gen(function* () {
        const { dag, dagID, start } = yield* startReview(tmp.path)
        const store = yield* DagStore.Service
        yield* dag.nodeCompleted(dagID, "review-1", { verdict: "PASS" })
        const node = yield* store.getNode(dagID, "review-1")
        expect(node?.staleTarget).toBe(false)
        expect(node?.targetFingerprint).toEqual(start)
        yield* dag.complete(dagID)
        const workflow = yield* store.getWorkflow(dagID)
        expect(workflow?.status).toBe("completed")
        expect(workflow?.targetFingerprint).toEqual(DagLocation.fingerprintTarget(tmp.path))
      }).pipe(Effect.provide(targetLayer()), Effect.scoped),
    )
  })

  it("marks a review stale when the target changes mid-run and the gate rejects it", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "tracked.txt"), "one")
        await $`git add tracked.txt`.cwd(dir).quiet()
        await $`git commit -m tracked`.cwd(dir).quiet()
      },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const { dag, dagID } = yield* startReview(tmp.path)
        const store = yield* DagStore.Service
        writeFileSync(path.join(tmp.path, "tracked.txt"), "two")
        yield* dag.nodeCompleted(dagID, "review-1", { verdict: "ACCEPT" })
        const node = yield* store.getNode(dagID, "review-1")
        expect(node?.staleTarget).toBe(true)
        expect(node?.targetFingerprint?.kind).toBe("git")
        const error = yield* dag.complete(dagID).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Dag.CompletionGateError)
        if (!(error instanceof Dag.CompletionGateError)) throw error
        expect(error.gaps).toEqual(["review-1 (stale target)"])
      }).pipe(Effect.provide(targetLayer()), Effect.scoped),
    )
  })

  it("exposes the fingerprint and stale marker in status and result views", () => {
    const fingerprint: DagEvent.TargetFingerprint = {
      kind: "git",
      head: "0123456789abcdef",
      diff: "diff",
      untracked: "untracked",
      value: "value",
    }
    expect(DagLocation.nodeLocationView({ targetFingerprint: fingerprint, staleTarget: true })).toEqual({
      target_fingerprint: fingerprint,
      stale_target: true,
    })
    expect(resultTargetFields({ targetFingerprint: fingerprint, staleTarget: true })).toEqual({
      target_fingerprint: fingerprint,
      stale_target: true,
    })
    expect(resultTargetFields({})).toEqual({})
  })

  it("rejects a stale built-in review lane even though it is not required", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "tracked.txt"), "one")
        await $`git add tracked.txt`.cwd(dir).quiet()
        await $`git commit -m tracked`.cwd(dir).quiet()
      },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed(tmp.path)
        const dag = yield* Dag.Service
        const store = yield* DagStore.Service
        const dagID = yield* dag.create({
          projectID,
          sessionID,
          title: "review lanes",
          config: {
            name: "review lanes",
            nodes: DagBlocks.compileWorkflowBlocks({
              objective: "Judge the working tree",
              blocks: [{ id: "gate", kind: "review" }],
            }),
          },
        })
        const started = (nodeID: string) =>
          dag.nodeStarted(
            dagID,
            nodeID,
            childSessionID,
            undefined,
            true,
            undefined,
            tmp.path,
            DagLocation.gitHead(tmp.path),
            DagLocation.fingerprintTarget(tmp.path),
          )
        const lane = { verdict: "ACCEPT", summary: "ok", findings: [], required_actions: [] }

        yield* started("gate--standards")
        writeFileSync(path.join(tmp.path, "tracked.txt"), "two")
        yield* dag.nodeCompleted(dagID, "gate--standards", lane)
        expect((yield* store.getNode(dagID, "gate--standards"))?.staleTarget).toBe(true)

        // Start the remaining nodes after the edit so only the lane is stale.
        for (const id of ["gate--intent", "gate"]) {
          yield* started(id)
          yield* dag.nodeCompleted(dagID, id, lane)
        }

        const error = yield* dag.complete(dagID).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Dag.CompletionGateError)
        if (!(error instanceof Dag.CompletionGateError)) throw error
        expect(error.gaps).toEqual(["gate--standards (stale target)"])
      }).pipe(Effect.provide(targetLayer()), Effect.scoped),
    )
  })

  it("rejects a stale verify block gate", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "tracked.txt"), "one")
        await $`git add tracked.txt`.cwd(dir).quiet()
        await $`git commit -m tracked`.cwd(dir).quiet()
      },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed(tmp.path)
        const dag = yield* Dag.Service
        const store = yield* DagStore.Service
        const dagID = yield* dag.create({
          projectID,
          sessionID,
          title: "verify gate",
          config: {
            name: "verify gate",
            nodes: DagBlocks.compileWorkflowBlocks({
              objective: "Verify the working tree",
              blocks: [{ id: "check", kind: "verify" }],
            }),
          },
        })
        yield* dag.nodeStarted(
          dagID,
          "check",
          childSessionID,
          undefined,
          true,
          undefined,
          tmp.path,
          DagLocation.gitHead(tmp.path),
          DagLocation.fingerprintTarget(tmp.path),
        )
        writeFileSync(path.join(tmp.path, "tracked.txt"), "two")
        yield* dag.nodeCompleted(dagID, "check", { verdict: "PASS" })
        expect((yield* store.getNode(dagID, "check"))?.staleTarget).toBe(true)

        const error = yield* dag.complete(dagID).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Dag.CompletionGateError)
        if (!(error instanceof Dag.CompletionGateError)) throw error
        expect(error.gaps).toEqual(["check (stale target)"])
      }).pipe(Effect.provide(targetLayer()), Effect.scoped),
    )
  })

  it("rejects a stale synthesize final gate", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "tracked.txt"), "one")
        await $`git add tracked.txt`.cwd(dir).quiet()
        await $`git commit -m tracked`.cwd(dir).quiet()
      },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed(tmp.path)
        const dag = yield* Dag.Service
        const store = yield* DagStore.Service
        const dagID = yield* dag.create({
          projectID,
          sessionID,
          title: "synthesize gate",
          config: {
            name: "synthesize gate",
            nodes: DagBlocks.compileWorkflowBlocks({
              objective: "Synthesize the working tree",
              blocks: [{ id: "final", kind: "synthesize" }],
            }),
          },
        })
        yield* dag.nodeStarted(
          dagID,
          "final",
          childSessionID,
          undefined,
          true,
          undefined,
          tmp.path,
          DagLocation.gitHead(tmp.path),
          DagLocation.fingerprintTarget(tmp.path),
        )
        writeFileSync(path.join(tmp.path, "tracked.txt"), "two")
        yield* dag.nodeCompleted(dagID, "final", { summary: "done" })
        expect((yield* store.getNode(dagID, "final"))?.staleTarget).toBe(true)

        const error = yield* dag.complete(dagID).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Dag.CompletionGateError)
        if (!(error instanceof Dag.CompletionGateError)) throw error
        expect(error.gaps).toEqual(["final (stale target)"])
      }).pipe(Effect.provide(targetLayer()), Effect.scoped),
    )
  })

  it("passes all three block gates when the target is unchanged", async () => {
    await using tmp = await tmpdir({ git: true })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed(tmp.path)
        const dag = yield* Dag.Service
        const store = yield* DagStore.Service
        const lane = { verdict: "ACCEPT", summary: "ok", findings: [], required_actions: [] }
        const routes = [
          { blocks: [{ id: "gate", kind: "review" as const }], outputs: { "gate--standards": lane, "gate--intent": lane, gate: lane } },
          { blocks: [{ id: "check", kind: "verify" as const }], outputs: { check: { verdict: "PASS" } } },
          { blocks: [{ id: "final", kind: "synthesize" as const }], outputs: { final: { summary: "done" } } },
        ]

        for (const route of routes) {
          const nodes = DagBlocks.compileWorkflowBlocks({
            objective: "Judge the working tree",
            blocks: route.blocks,
          })
          const dagID = yield* dag.create({
            projectID,
            sessionID,
            title: "unchanged target",
            config: { name: "unchanged target", nodes },
          })
          const outputs: Record<string, unknown> = route.outputs
          for (const node of nodes) {
            yield* dag.nodeStarted(
              dagID,
              node.id,
              childSessionID,
              undefined,
              true,
              undefined,
              tmp.path,
              DagLocation.gitHead(tmp.path),
              DagLocation.fingerprintTarget(tmp.path),
            )
            yield* dag.nodeCompleted(dagID, node.id, outputs[node.id])
          }
          yield* dag.complete(dagID)
          expect((yield* store.getWorkflow(dagID))?.status).toBe("completed")
        }
      }).pipe(Effect.provide(targetLayer()), Effect.scoped),
    )
  })
})

/** Read an aggregate's durable events, then erase its read model and event
 * rows so replay rebuilds them from the same serialized data. */
function serializeAndWipe(dagID: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(EventTable)
      .where(sql`${EventTable.aggregate_id} = ${dagID}`)
      .orderBy(EventTable.seq)
      .all()
      .pipe(Effect.orDie)
    const serialized = rows.map((row) => ({
      id: row.id,
      type: row.type,
      seq: row.seq,
      aggregateID: row.aggregate_id,
      data: row.data,
    }))
    yield* db
      .delete(EventTable)
      .where(sql`${EventTable.aggregate_id} = ${dagID}`)
      .run()
      .pipe(Effect.orDie)
    yield* db
      .delete(EventSequenceTable)
      .where(sql`${EventSequenceTable.aggregate_id} = ${dagID}`)
      .run()
      .pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM workflow_node WHERE workflow_id = ${dagID}`).pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM workflow WHERE id = ${dagID}`).pipe(Effect.orDie)
    return serialized
  })
}

describe("DagProjector: target fingerprint", () => {
  const legacyDagID = DagEvent.DagID.make("dag_target_legacy")
  const replayDagID = DagEvent.DagID.make("dag_target_replay")

  const projectorLayer = Layer.mergeAll(
    Database.defaultLayer,
    EventV2.defaultLayer,
    DagProjector.defaultLayer,
    DagStore.defaultLayer,
  )

  function legacySeed() {
    return Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "target",
          directory: "/project",
          title: "Target",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })
  }

  it("projects legacy events without a fingerprint to the non-git marker and false", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* legacySeed()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        yield* events.publish(DagEvent.WorkflowCreated, {
          dagID: legacyDagID,
          projectID,
          sessionID,
          title: "legacy",
          config: "",
          status: "pending",
          timestamp: ts(0),
        })
        yield* events.publish(DagEvent.NodeRegistered, {
          dagID: legacyDagID,
          nodeID: DagEvent.NodeID.make("review-1"),
          name: "Review",
          workerType: "review",
          dependsOn: [],
          required: true,
          timestamp: ts(1),
        })
        yield* events.publish(DagEvent.NodeStarted, {
          dagID: legacyDagID,
          nodeID: DagEvent.NodeID.make("review-1"),
          childSessionID,
          timestamp: ts(2),
        })
        yield* events.publish(DagEvent.NodeCompleted, {
          dagID: legacyDagID,
          nodeID: DagEvent.NodeID.make("review-1"),
          output: { verdict: "PASS" },
          durationMs: NonNegativeInt.make(0),
          timestamp: ts(3),
        })
        expect((yield* store.getWorkflow(legacyDagID))?.targetFingerprint).toEqual({ kind: "none" })
        const node = yield* store.getNode(legacyDagID, "review-1")
        expect(node?.targetFingerprint).toBeNull()
        expect(node?.staleTarget).toBe(false)
      }).pipe(Effect.provide(projectorLayer), Effect.orDie),
    )
  })

  it("replays a completion with fingerprint and stale flag idempotently", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* legacySeed()
        const events = yield* EventV2.Service
        const store = yield* DagStore.Service
        const fingerprint: DagEvent.TargetFingerprint = {
          kind: "git",
          head: "0123456789abcdef",
          diff: "diff",
          untracked: "clean",
          value: "value",
        }
        yield* events.publish(DagEvent.WorkflowCreated, {
          dagID: replayDagID,
          projectID,
          sessionID,
          title: "replay",
          config: "",
          status: "pending",
          targetFingerprint: fingerprint,
          timestamp: ts(0),
        })
        yield* events.publish(DagEvent.NodeRegistered, {
          dagID: replayDagID,
          nodeID: DagEvent.NodeID.make("review-1"),
          name: "Review",
          workerType: "review",
          dependsOn: [],
          required: true,
          timestamp: ts(1),
        })
        yield* events.publish(DagEvent.NodeStarted, {
          dagID: replayDagID,
          nodeID: DagEvent.NodeID.make("review-1"),
          childSessionID,
          targetFingerprint: fingerprint,
          timestamp: ts(2),
        })
        yield* events.publish(DagEvent.NodeCompleted, {
          dagID: replayDagID,
          nodeID: DagEvent.NodeID.make("review-1"),
          output: { verdict: "ACCEPT" },
          targetFingerprint: { ...fingerprint, value: "completed" },
          staleTarget: true,
          durationMs: NonNegativeInt.make(0),
          timestamp: ts(3),
        })
        expect((yield* store.getWorkflow(replayDagID))?.targetFingerprint).toEqual(fingerprint)
        const node = yield* store.getNode(replayDagID, "review-1")
        expect(node?.targetFingerprint).toEqual({ ...fingerprint, value: "completed" })
        expect(node?.staleTarget).toBe(true)

        const serialized = yield* serializeAndWipe(replayDagID)
        yield* events.replayAll(serialized)
        const restoredWorkflow = yield* store.getWorkflow(replayDagID)
        const restoredNode = yield* store.getNode(replayDagID, "review-1")
        expect(restoredWorkflow?.targetFingerprint).toEqual(fingerprint)
        expect(restoredNode?.staleTarget).toBe(true)
        expect(restoredNode?.targetFingerprint).toEqual({ ...fingerprint, value: "completed" })

        yield* events.replayAll(serialized)
        expect(yield* store.getWorkflow(replayDagID)).toEqual(restoredWorkflow)
        expect(yield* store.getNode(replayDagID, "review-1")).toEqual(restoredNode)
      }).pipe(Effect.provide(projectorLayer), Effect.orDie),
    )
  })
})
