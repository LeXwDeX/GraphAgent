// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { WorkflowAuthoring } from "@/dag/authoring"
import { Dag, type NodeConfig } from "@/dag/dag"
import { resolveInputMappingChecked } from "@/dag/runtime/eval"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

function node(id: string, dependsOn: string[] = []): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
  }
}

const authoring = testEffect(CrossSpawnSpawner.defaultLayer)

describe("input_mapping authoring validation", () => {
  authoring.effect("rejects unknown, self, unordered, and malformed sources with exact mapping paths", () =>
    Effect.gen(function* () {
      const result = yield* WorkflowAuthoring.make().prepare({
        action: "start",
        source: {
          kind: "inline",
          value: {
            config: {
              name: "bad-mappings",
              nodes: [
                node("producer"),
                { ...node("unknown"), input_mapping: { value: "typo.output.value" } },
                { ...node("self"), input_mapping: { value: "self.output" } },
                { ...node("unordered"), input_mapping: { value: "producer.output.value" } },
                { ...node("malformed", ["producer"]), input_mapping: { value: "producer.value" } },
              ],
            },
          },
        },
        profile: "portable",
      })

      expect(result.valid).toBe(false)
      expect(result.errors.map((error) => error.path)).toEqual(
        expect.arrayContaining([
          "nodes[unknown].input_mapping.value",
          "nodes[self].input_mapping.value",
          "nodes[unordered].input_mapping.value",
          "nodes[malformed].input_mapping.value",
        ]),
      )
      expect(result.errors.map((error) => error.message).join("\n")).toContain('unknown source node "typo"')
      expect(result.errors.map((error) => error.message).join("\n")).toContain("references itself")
      expect(result.errors.map((error) => error.message).join("\n")).toContain('unordered source node "producer"')
      expect(result.errors.map((error) => error.message).join("\n")).toContain('first path segment must be "output"')
    }),
  )

  authoring.effect("accepts documented source forms through direct and transitive dependencies", () =>
    Effect.gen(function* () {
      const result = yield* WorkflowAuthoring.make().prepare({
        action: "start",
        source: {
          kind: "inline",
          value: {
            config: {
              name: "valid-mappings",
              nodes: [
                node("producer"),
                node("middle", ["producer"]),
                {
                  ...node("consumer", ["middle"]),
                  input_mapping: {
                    wholeNodeOutput: "producer",
                    explicitOutput: "producer.output",
                    nestedField: "producer.output.value",
                  },
                },
              ],
            },
          },
        },
        profile: "portable",
      })

      expect(result.errors).toEqual([])
      expect(result.valid).toBe(true)
    }),
  )
})

describe("strict input_mapping resolution", () => {
  const found = (output: unknown) => ({ found: true as const, output })

  authoring.effect("keeps explicit null values but rejects missing producers and fields", () =>
    Effect.sync(() => {
      expect(resolveInputMappingChecked({ value: "producer.output.value" }, () => found({ value: null }))).toEqual({
        ok: true,
        value: { value: null },
      })
      expect(resolveInputMappingChecked({ value: "producer.output.value" }, () => ({ found: false }))).toEqual({
        ok: false,
        error:
          'input_mapping variable "value" source "producer.output.value" has no durable output for node "producer"',
      })
      expect(resolveInputMappingChecked({ value: "producer.output.value" }, () => found({ other: 1 }))).toEqual({
        ok: false,
        error: 'input_mapping variable "value" source "producer.output.value" resolved to undefined',
      })
    }),
  )
})

const persistence = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
)
const runtime = testEffect(Layer.provideMerge(Dag.layer, persistence))

function setupPersistence(sessionID: string) {
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
        directory: "/project",
        title: sessionID,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

describe("input_mapping replan validation", () => {
  runtime.effect("reuses a completed historical producer when it is in the new node's dependency closure", () =>
    Effect.gen(function* () {
      yield* setupPersistence("ses_mapping_replan")

      const dag = yield* Dag.Service
      const dagID = yield* dag
        .create({
          projectID: Project.ID.global,
          sessionID: "ses_mapping_replan",
          title: "mapping-replan",
          config: { name: "mapping-replan", nodes: [node("producer")] },
        })
        .pipe(Effect.orDie)
      yield* dag.nodeQueued(dagID, "producer").pipe(Effect.orDie)
      yield* dag.nodeStarted(dagID, "producer", "ses_mapping_producer").pipe(Effect.orDie)
      yield* dag.nodeCompleted(dagID, "producer", { value: 42 }).pipe(Effect.orDie)

      yield* dag
        .replan(dagID, {
          nodes: [
            {
              ...node("consumer", ["producer"]),
              input_mapping: { answer: "producer.output.value" },
            },
          ],
        })
        .pipe(Effect.orDie)

      expect((yield* dag.store.getNode(dagID, "consumer").pipe(Effect.orDie))?.status).toBe("pending")
    }),
  )

  runtime.effect("rejects unknown and unordered sources even when the unordered producer is historical", () =>
    Effect.gen(function* () {
      yield* setupPersistence("ses_mapping_replan_reject")
      const dag = yield* Dag.Service
      const dagID = yield* dag
        .create({
          projectID: Project.ID.global,
          sessionID: "ses_mapping_replan_reject",
          title: "mapping-replan-reject",
          config: { name: "mapping-replan-reject", nodes: [node("producer"), node("anchor")] },
        })
        .pipe(Effect.orDie)
      for (const id of ["producer", "anchor"]) {
        yield* dag.nodeQueued(dagID, id).pipe(Effect.orDie)
        yield* dag.nodeStarted(dagID, id, `ses_mapping_${id}`).pipe(Effect.orDie)
        yield* dag.nodeCompleted(dagID, id, { value: id }).pipe(Effect.orDie)
      }

      const error = yield* dag
        .replan(dagID, {
          nodes: [
            {
              ...node("consumer", ["anchor"]),
              input_mapping: {
                unordered: "producer.output.value",
                unknown: "ghost.output.value",
              },
            },
          ],
        })
        .pipe(Effect.catch((failure: Error) => Effect.succeed(failure)))

      expect(error).toBeInstanceOf(Dag.StructuralValidationError)
      if (!(error instanceof Error)) throw new Error("replan unexpectedly succeeded")
      expect(error.message).toContain('unordered source node "producer"')
      expect(error.message).toContain('unknown source node "ghost"')
      expect(yield* dag.store.getNode(dagID, "consumer").pipe(Effect.orDie)).toBeUndefined()
    }),
  )
})
