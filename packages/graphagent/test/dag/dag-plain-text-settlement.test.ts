// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Dag, type NodeConfig } from "@/dag/dag"
import { reconcileWorkflow } from "@/dag/runtime/recovery"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const persistence = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(Layer.provideMerge(Dag.layer, persistence))

function node(id: string, outputSchema?: Record<string, unknown>): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
    ...(outputSchema ? { output_schema: outputSchema } : {}),
  }
}

function setupProject() {
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
  })
}

function createRunning(dag: Dag.Interface, id: string, outputSchema?: Record<string, unknown>) {
  return Effect.gen(function* () {
    const sessionID = SessionID.make(`ses_parent_${id}`)
    const childSessionID = `ses_child_${id}`
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: id,
        directory: AbsolutePath.make("/project"),
        title: id,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    const config = node(id, outputSchema)
    const dagID = yield* dag.create({
      projectID: Project.ID.global,
      sessionID,
      title: id,
      config: { name: id, nodes: [config] },
    })
    yield* dag.nodeQueued(dagID, id, Date.now() + 60_000)
    yield* dag.nodeStarted(dagID, id, childSessionID, Date.now() + 60_000)
    return { childSessionID, dagID }
  })
}

const completed = () => Effect.succeed<"active" | "completed" | "failed" | "unknown">("completed")

describe("plain-text settlement parity", () => {
  it.effect("fails missing, empty, and whitespace-only recovered output with verdict_fail", () =>
    Effect.gen(function* () {
      yield* setupProject()
      const dag = yield* Dag.Service
      const cases: ReadonlyArray<{
        readonly id: string
        readonly reader?: () => Effect.Effect<string | undefined, Error>
      }> = [
        { id: "missing-reader" },
        { id: "missing-text", reader: () => Effect.succeed(undefined) },
        { id: "empty-text", reader: () => Effect.succeed("") },
        { id: "whitespace-text", reader: () => Effect.succeed(" \n\t  ") },
      ]

      for (const item of cases) {
        const current = yield* createRunning(dag, item.id)
        yield* reconcileWorkflow(current.dagID, completed, undefined, { nodes: [{ id: item.id }] }, item.reader)
        const row = yield* dag.store.getNode(current.dagID, item.id)
        expect(row?.status).toBe("failed")
        expect(row?.errorReason).toBe("provider returned empty output")
        expect(row?.errorClass).toBe("verdict_fail")
        expect(row?.output).toBeNull()
      }
    }),
  )

  it.live("preserves recovered inline text and commits file results to durable objects", () =>
    Effect.gen(function* () {
      yield* setupProject()
      const dag = yield* Dag.Service

      const exact = "\n  exact result with surrounding whitespace\t"
      const inline = yield* createRunning(dag, "inline")
      yield* reconcileWorkflow(inline.dagID, completed, undefined, { nodes: [{ id: "inline" }] }, () =>
        Effect.succeed(exact),
      )
      const inlineRow = yield* dag.store.getNode(inline.dagID, "inline")
      expect(inlineRow?.status).toBe("completed")
      expect(inlineRow?.output).toBe(exact)

      const dir = yield* tmpdirScoped()
      const reportPath = path.join(dir, "report.md")
      yield* Effect.promise(() => fs.writeFile(reportPath, "durable report"))
      const file = yield* createRunning(dag, "file")
      yield* reconcileWorkflow(
        file.dagID,
        completed,
        undefined,
        { nodes: [{ id: "file" }] },
        () => Effect.succeed(reportPath),
        dir,
      )
      const fileRow = yield* dag.store.getNode(file.dagID, "file")
      expect(fileRow?.status).toBe("completed")
      expect(fileRow?.output).toEqual(expect.stringContaining("workflow-artifacts"))
      expect(fileRow?.capturedOutput).toEqual(
        expect.objectContaining({
          kind: "file_ref",
          storage: "managed-v1",
          source_path: reportPath,
          content_ref: fileRow?.output,
          path: fileRow?.output,
        }),
      )
    }),
  )

  it.effect("leaves structured-output recovery on its existing captured settlement contract", () =>
    Effect.gen(function* () {
      yield* setupProject()
      const dag = yield* Dag.Service
      const schema = {
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
      }
      const current = yield* createRunning(dag, "structured", schema)
      const output = { summary: "structured result" }
      yield* dag.store.setCapturedOutput(current.childSessionID, output)
      yield* reconcileWorkflow(
        current.dagID,
        completed,
        undefined,
        { nodes: [{ id: "structured", output_schema: schema }] },
        () => Effect.succeed("plain text must stay irrelevant"),
      )

      const row = yield* dag.store.getNode(current.dagID, "structured")
      expect(row?.status).toBe("completed")
      expect(row?.output).toEqual(output)
      expect(row?.errorClass).toBeNull()
    }),
  )
})
