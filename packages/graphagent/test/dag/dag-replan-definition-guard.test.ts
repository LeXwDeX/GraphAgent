// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it as bunIt } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Dag, type NodeConfig, parseWorkflowConfig } from "@/dag/dag"
import { ReplanDefinition } from "@/dag/replan-definition"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const persistence = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
)
const it = testEffect(Layer.provideMerge(Dag.layer, persistence))

function node(id: string, dependsOn: string[] = []): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    report_to_parent: true,
  }
}

function setup(sessionID: string, directory = "/project") {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({
        id: Project.ID.global,
        worktree: AbsolutePath.make("/project"),
        sandboxes: [],
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionID.make(sessionID),
        project_id: Project.ID.global,
        slug: sessionID,
        directory: AbsolutePath.make(directory),
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

function start(dag: Dag.Interface, dagID: string, nodeID: string, childSessionID: string) {
  return Effect.gen(function* () {
    yield* dag.nodeQueued(dagID, nodeID, Date.now() + 60_000)
    yield* dag.nodeStarted(dagID, nodeID, childSessionID, Date.now() + 60_000)
  })
}

describe("replan admitted-definition guard", () => {
  for (const status of ["queued"] as const) {
    it.effect(`rejects new dependencies on omitted ${status} nodes before changing durable state`, () =>
      Effect.gen(function* () {
        const sessionID = `ses_replan_omitted_${status}`
        yield* setup(sessionID)
        const dag = yield* Dag.Service
        const old = { ...node("old"), report_to_parent: false }
        const dagID = yield* create(dag, sessionID, [old])
        yield* dag.nodeQueued(dagID, "old", Date.now() + 60_000)
        const before = yield* dag.store.getWorkflow(dagID)
        const beforeNodes = yield* dag.store.getNodes(dagID)
        const failure = yield* dag.replan(dagID, { nodes: [node("new", ["old"])] }).pipe(Effect.flip)
        expect(failure.message).toContain('depends on "old" which is not present after merge')
        expect(yield* dag.store.getWorkflow(dagID)).toEqual(before)
        expect(yield* dag.store.getNodes(dagID)).toEqual(beforeNodes)

        const preserved = yield* dag.replan(dagID, { nodes: [old, node("new", ["old"])] })
        expect(preserved.cancel).toEqual([])
        expect((yield* dag.store.getNode(dagID, "old"))?.status).toBe(status)
        expect((yield* dag.store.getNode(dagID, "new"))?.dependsOn).toEqual(["old"])

        const replaced = yield* dag.replan(dagID, { nodes: [node("replacement")] })
        expect(replaced.cancel.sort()).toEqual(["new", "old"])
        expect((yield* dag.store.getNode(dagID, "old"))?.superseded).toBe(true)
        expect((yield* dag.store.getCurrentNodes(dagID)).map((entry) => entry.id)).toEqual(["replacement"])
      }),
    )
  }

  it.effect("rejects running execution-field changes before mutation and preserves the old attempt", () =>
    Effect.gen(function* () {
      const sessionID = "ses_replan_definition_reject"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const target: NodeConfig = {
        ...node("target", ["dep"]),
        name: "old name",
        prompt_template: { inline: "old {{value}}", input: { alpha: 1, nested: { left: true, right: false } } },
        worker_config: { timeout_ms: 5_000 },
        input_mapping: { value: "dep.output.value" },
        condition: "dep.output.value == 1",
        skip_ok: false,
        model: { providerID: "test", modelID: "old-model" },
        output_schema: { type: "string", description: "old output" },
      }
      const dagID = yield* create(dag, sessionID, [node("dep"), target])
      yield* start(dag, dagID, "dep", "ses_replan_definition_dep")
      yield* dag.nodeCompleted(dagID, "dep", { value: 1 })
      yield* start(dag, dagID, "target", "ses_replan_definition_old")

      const releaseOld = yield* Deferred.make<void>()
      const oldFiber = yield* Deferred.await(releaseOld).pipe(Effect.as("old execution returned"), Effect.forkScoped)
      const workflowBefore = yield* dag.store.getWorkflow(dagID)
      const nodeBefore = yield* dag.store.getNode(dagID, "target")

      const error = yield* dag
        .replan(dagID, {
          nodes: [
            {
              ...node("target"),
              name: "new name",
              worker_type: "explore",
              required: false,
              prompt_template: { inline: "new prompt" },
              worker_config: { timeout_ms: 5_000 },
              model: { providerID: "other", modelID: "new-model" },
              report_to_parent: false,
              output_schema: { type: "object", properties: { answer: { type: "number" } } },
            },
          ],
        })
        .pipe(Effect.catch((failure: Error) => Effect.succeed(failure)))

      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) throw new Error("replan unexpectedly succeeded")
      expect(error.message).toContain('Node "target" is running')
      for (const field of [
        "condition",
        "depends_on",
        "input_mapping",
        "model",
        "name",
        "output_schema",
        "prompt_template",
        "report_to_parent",
        "required",
        "worker_type",
      ]) {
        expect(error.message).toContain(field)
      }
      expect(error.message).toContain("restart: true")
      expect(yield* dag.store.getWorkflow(dagID)).toEqual(workflowBefore)
      expect(yield* dag.store.getNode(dagID, "target")).toEqual(nodeBefore)

      yield* Deferred.succeed(releaseOld, undefined)
      expect(yield* Fiber.join(oldFiber)).toBe("old execution returned")
      yield* dag.nodeCompleted(dagID, "target", "old result")
      expect((yield* dag.store.getNode(dagID, "target"))?.output).toBe("old result")
      const persisted = parseWorkflowConfig((yield* dag.store.getWorkflow(dagID))?.config ?? "")
      expect(persisted?.nodes.find((value) => value.id === "target")).toEqual(target)
    }),
  )

  for (const status of ["queued", "running"] as const) {
    it.effect(`admits an unchanged legacy definition while ${status}`, () =>
      Effect.gen(function* () {
        const sessionID = `ses_replan_legacy_${status}`
        yield* setup(sessionID)
        const dag = yield* Dag.Service
        const { db } = yield* Database.Service
        const dagID = yield* create(dag, sessionID, [node("legacy")])
        const before = (yield* dag.store.getWorkflow(dagID))!
        const config = parseWorkflowConfig(before.config)!
        const legacy = config.nodes.find((candidate) => candidate.id === "legacy")!
        const { skip_ok: _skipOk, ...legacyWithoutSkip } = legacy
        yield* db
          .update(WorkflowTable)
          .set({ config: JSON.stringify({ ...config, nodes: [legacyWithoutSkip] }) })
          .where(eq(WorkflowTable.id, dagID))
          .run()

        yield* dag.nodeQueued(dagID, "legacy", Date.now() + 60_000)
        if (status === "running") yield* dag.nodeStarted(dagID, "legacy", "ses_legacy", Date.now() + 60_000)

        const result = yield* dag.replan(dagID, { nodes: [legacyWithoutSkip] }).pipe(Effect.result)
        expect(result._tag).toBe("Success")
        const after = parseWorkflowConfig((yield* dag.store.getWorkflow(dagID))!.config)!
        expect(after.nodes.find((candidate) => candidate.id === "legacy")?.skip_ok).toBeUndefined()
      }),
    )
  }

  it.effect("allows a running timeout update and definitions that differ only by object key order", () =>
    Effect.gen(function* () {
      const sessionID = "ses_replan_definition_timeout"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const target: NodeConfig = {
        ...node("target", ["dep"]),
        prompt_template: { inline: "{{first}} {{second}}", input: { first: 1, second: { a: true, b: false } } },
        worker_config: { timeout_ms: 5_000 },
        input_mapping: { first: "dep.output.first", second: "dep.output.second" },
        model: { providerID: "test", modelID: "model" },
        output_schema: {
          type: "object",
          properties: { first: { type: "number" }, second: { type: "number" } },
          required: ["first", "second"],
        },
      }
      const dagID = yield* create(dag, sessionID, [node("dep"), target])
      yield* start(dag, dagID, "dep", "ses_replan_timeout_dep")
      yield* dag.nodeCompleted(dagID, "dep", { first: 1, second: 2 })
      yield* start(dag, dagID, "target", "ses_replan_timeout_target")

      const plan = yield* dag.replan(dagID, {
        nodes: [
          {
            id: "target",
            name: "target",
            worker_type: "build",
            depends_on: ["dep"],
            required: true,
            prompt_template: { input: { second: { b: false, a: true }, first: 1 }, inline: "{{first}} {{second}}" },
            worker_config: { timeout_ms: 9_000 },
            input_mapping: { second: "dep.output.second", first: "dep.output.first" },
            report_to_parent: true,
            model: { modelID: "model", providerID: "test" },
            output_schema: {
              required: ["first", "second"],
              properties: { second: { type: "number" }, first: { type: "number" } },
              type: "object",
            },
          },
        ],
      })

      expect(plan.replace).toEqual(["target"])
      expect((yield* dag.store.getNode(dagID, "target"))?.status).toBe("running")
      const persisted = parseWorkflowConfig((yield* dag.store.getWorkflow(dagID))?.config ?? "")
      expect(persisted?.nodes.find((value) => value.id === "target")?.worker_config?.timeout_ms).toBe(9_000)
      yield* dag.nodeCompleted(dagID, "target", { first: 1, second: 2 })
    }),
  )

  it.effect("rejects queued changes with an actionable replacement path and allows an equivalent fragment", () =>
    Effect.gen(function* () {
      const sessionID = "ses_replan_definition_queued"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const queued = { ...node("queued"), worker_config: { timeout_ms: 5_000 } }
      const dagID = yield* create(dag, sessionID, [queued])
      yield* dag.nodeQueued(dagID, "queued", Date.now() + 60_000)
      const workflowBefore = yield* dag.store.getWorkflow(dagID)
      const nodeBefore = yield* dag.store.getNode(dagID, "queued")

      const error = yield* dag
        .replan(dagID, {
          nodes: [
            {
              ...node("queued"),
              prompt_template: { inline: "changed" },
              worker_config: { timeout_ms: 9_000 },
            },
          ],
        })
        .pipe(Effect.catch((failure: Error) => Effect.succeed(failure)))
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) throw new Error("queued replan unexpectedly succeeded")
      expect(error.message).toContain('Node "queued" is queued')
      expect(error.message).toContain("prompt_template")
      expect(error.message).toContain("worker_config.timeout_ms")
      expect(error.message).toContain("replacement node under a new id")
      expect(error.message).not.toContain("restart: true")
      expect(yield* dag.store.getWorkflow(dagID)).toEqual(workflowBefore)
      expect(yield* dag.store.getNode(dagID, "queued")).toEqual(nodeBefore)

      const plan = yield* dag.replan(dagID, { nodes: [queued] })
      expect(plan.replace).toEqual(["queued"])
      expect((yield* dag.store.getNode(dagID, "queued"))?.status).toBe("queued")
    }),
  )

  it.effect("allows pending edits, ignores terminal edits, and restarts a running node onto its new definition", () =>
    Effect.gen(function* () {
      const sessionID = "ses_replan_definition_lifecycle"
      yield* setup(sessionID)
      const dag = yield* Dag.Service
      const dagID = yield* create(dag, sessionID, [node("done"), node("pending"), node("running")])
      yield* start(dag, dagID, "done", "ses_replan_definition_done")
      yield* dag.nodeCompleted(dagID, "done", "done")
      yield* start(dag, dagID, "running", "ses_replan_definition_running")

      const releaseOld = yield* Deferred.make<void>()
      const oldFiber = yield* Deferred.await(releaseOld).pipe(Effect.as("old attempt returned"), Effect.forkScoped)
      const plan = yield* dag.replan(dagID, {
        nodes: [
          { ...node("done"), prompt_template: { inline: "ignored terminal edit" } },
          { ...node("pending"), prompt_template: { inline: "new pending prompt" } },
          {
            ...node("running"),
            name: "restarted name",
            worker_type: "explore",
            prompt_template: { inline: "new running prompt" },
            restart: true,
          },
        ],
      })

      expect(plan.ignore).toEqual(["done"])
      expect(plan.replace).toEqual(["pending"])
      expect(plan.restart).toEqual(["running"])
      const persisted = parseWorkflowConfig((yield* dag.store.getWorkflow(dagID))?.config ?? "")
      expect(persisted?.nodes.find((value) => value.id === "done")?.prompt_template.inline).toBe("done")
      expect(persisted?.nodes.find((value) => value.id === "pending")?.prompt_template.inline).toBe(
        "new pending prompt",
      )
      expect(persisted?.nodes.find((value) => value.id === "running")?.prompt_template.inline).toBe(
        "new running prompt",
      )
      expect((yield* dag.store.getNode(dagID, "running"))?.status).toBe("pending")

      yield* Deferred.succeed(releaseOld, undefined)
      expect(yield* Fiber.join(oldFiber)).toBe("old attempt returned")
      yield* start(dag, dagID, "running", "ses_replan_definition_restarted")
      yield* dag.nodeCompleted(dagID, "running", "new result")
      expect((yield* dag.store.getNode(dagID, "running"))?.output).toBe("new result")
    }),
  )

  it.effect("pins a direct replan node workspace to its realpath", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      const linked = path.join(os.tmpdir(), `opencode-replan-ws-${Math.random().toString(36).slice(2)}`)
      const alias = path.join(os.tmpdir(), `opencode-replan-ws-alias-${Math.random().toString(36).slice(2)}`)
      const cleanup = Effect.promise(async () => {
        await fs.rm(alias, { force: true })
        await $`git -C ${tmp.path} worktree remove --force ${linked}`.quiet().catch(() => undefined)
        await fs.rm(linked, { recursive: true, force: true })
        await tmp[Symbol.asyncDispose]()
      })
      return yield* Effect.gen(function* () {
        yield* Effect.promise(() => $`git worktree add --detach ${linked} HEAD`.cwd(tmp.path).quiet())
        const real = yield* Effect.promise(() => fs.realpath(linked))
        yield* Effect.promise(() => fs.symlink(real, alias))
        const sessionID = "ses_replan_workspace_pin"
        yield* setup(sessionID, tmp.path)
        const dag = yield* Dag.Service
        const old = { ...node("old"), report_to_parent: false }
        const dagID = yield* create(dag, sessionID, [old])
        yield* dag.replan(dagID, { nodes: [old, { ...node("new", ["old"]), workspace: alias }] })
        const persisted = parseWorkflowConfig((yield* dag.store.getWorkflow(dagID))!.config)
        expect(persisted?.nodes.find((value) => value.id === "new")?.workspace).toBe(real)
      }).pipe(Effect.ensuring(cleanup))
    }),
  )

  it.effect("rejects an invalid direct replan node workspace through the error channel", () =>
    Effect.gen(function* () {
      yield* setup("ses_replan_workspace_invalid")
      const dag = yield* Dag.Service
      const old = { ...node("old"), report_to_parent: false }
      const dagID = yield* create(dag, "ses_replan_workspace_invalid", [old])
      const exit = yield* Effect.exit(
        dag.replan(dagID, {
          nodes: [old, { ...node("new", ["old"]), workspace: "../outside" }],
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(false)
        expect(Cause.pretty(exit.cause)).toContain("absolute path")
      }
      const persisted = parseWorkflowConfig((yield* dag.store.getWorkflow(dagID))!.config)
      expect(persisted?.nodes.find((value) => value.id === "new")).toBeUndefined()
    }),
  )

  bunIt("compares nested future execution fields while ignoring control markers", () => {
    const current = {
      ...node("worker"),
      permissions: { write: false, read: true },
      review: { phase: "diff", implementation_node_id: "impl" },
      worker_config: { timeout_ms: 5_000, sandbox: { network: false, filesystem: "read" } },
    }
    const next = {
      ...node("worker"),
      restart: true,
      permissions: { read: true, write: true },
      review: { implementation_node_id: "impl", phase: "design" },
      worker_config: { sandbox: { filesystem: "write", network: false }, timeout_ms: 9_000 },
    }

    expect(ReplanDefinition.changedAdmittedNodeFields(current, next, { allowTimeoutUpdate: true })).toEqual([
      "permissions",
      "review",
      "worker_config.sandbox",
    ])
  })
})
