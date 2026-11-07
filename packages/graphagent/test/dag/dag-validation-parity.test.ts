import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagValidation } from "@/dag/validation"
import { WorkflowAuthoring } from "@/dag/authoring"
import { testEffect } from "../lib/effect"

const testLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
)

const dagLayer = Layer.provideMerge(Dag.layer, testLayer)

const it = testEffect(dagLayer)

const validate = (value: unknown) =>
  WorkflowAuthoring.make().prepare({
    action: "start",
    source: { kind: "inline", value },
    profile: "portable",
  })

// The same bad spec must be rejected with the same diagnostic codes and
// field paths by the validate action (pure validator) and by start
// (Dag.create reusing the shared structural core) — before any event is
// published in either case.

const badNodes = [
  {
    id: "a",
    name: "a",
    worker_type: "general",
    depends_on: ["missing"],
    prompt_template: { inline: "Use {{gone}}" },
  },
  {
    id: "b",
    name: "b",
    worker_type: "general",
    depends_on: ["b"],
    prompt_template: { inline: "Self loop" },
  },
]

describe("validate/start parity through the shared validator", () => {
  it.effect("the same bad spec yields the same structural codes and paths", () =>
    Effect.gen(function* () {
      const dag = yield* Dag.Service
      const validation = yield* validate({ config: { name: "parity", nodes: badNodes } })
      expect(validation.valid).toBe(false)

      const error = yield* dag
        .create({
          projectID: "project-1",
          sessionID: "ses_parity",
          title: "parity",
          config: { name: "parity", nodes: badNodes as NodeConfig[] },
        })
        .pipe(Effect.catch((e: Error) => Effect.succeed(e)))
      expect(error).toBeInstanceOf(Dag.StructuralValidationError)
      const createErrors = (error as Dag.StructuralValidationError).diagnostics.filter(
        (d) => d.severity === "error",
      )
      const key = (d: { code: string; path: string; message: string }) => `${d.code}|${d.path}|${d.message}`
      // Same authority ⇒ same codes and paths for the structural rules
      // (order differs: create reports in legacy class order).
      expect(createErrors.map(key).sort()).toEqual(
        validation.errors
          .filter(
            (d) =>
              d.code === DagValidation.DIAGNOSTIC_CODES.dagInvalid ||
              d.code === DagValidation.DIAGNOSTIC_CODES.promptUnboundVariable,
          )
          .map(key)
          .sort(),
      )
    }),
  )

  it.effect("create rejection publishes no events", () =>
    Effect.gen(function* () {
      const dag = yield* Dag.Service
      const store = dag.store
      const error = yield* dag
        .create({
          projectID: "project-1",
          sessionID: "ses_parity_no_events",
          title: "parity-no-events",
          config: { name: "parity", nodes: badNodes as NodeConfig[] },
        })
        .pipe(Effect.catch((e: Error) => Effect.succeed(e)))
      expect(error).toBeInstanceOf(Error)
      expect(yield* store.getNodes("anything").pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("the same uncompilable block graph fails validate and start identically", () =>
    Effect.gen(function* () {
      // prototype writers feeding a review without verification — the exact
      // shape pinned from the pre-fix prototype-decision-route template.
      const value = {
        config: {
          name: "review-without-verify",
          objective: "Ship it",
          blocks: [
            { id: "proto", kind: "prototype" },
            { id: "plan", kind: "plan", depends_on: ["proto"] },
            { id: "review", kind: "review", depends_on: ["plan"] },
          ],
        },
      } as const
      const validation = yield* validate(value)
      expect(validation.valid).toBe(false)
      expect(validation.errors[0]?.code).toBe(DagValidation.DIAGNOSTIC_CODES.blockCompileFailed)
      // The start path compiles through the same shared function.
      const compiled = DagValidation.compileGraphSource(value.config)
      expect(compiled.nodes).toBeUndefined()
      expect(compiled.diagnostics.map((d) => [d.code, d.path, d.message])).toEqual(
        validation.errors.map((d) => [d.code, d.path, d.message]),
      )
    }),
  )

  it.effect("replan rejects the same structural errors through the shared authority", () =>
    Effect.gen(function* () {
      // FK setup so the valid workflow we replan against can persist events.
      const { db } = yield* Database.Service
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
      yield* db.insert(SessionTable).values({ id: "ses_replan_parity" as never, project_id: Project.ID.global, slug: "replan", directory: "/project", title: "replan", version: "test" }).run().pipe(Effect.orDie)

      const dag = yield* Dag.Service
      const goodNode: NodeConfig = {
        id: "good",
        name: "good",
        worker_type: "general",
        depends_on: [],
        required: true,
        prompt_template: { inline: "Work" },
      }
      const dagID = yield* dag.create({
        projectID: Project.ID.global,
        sessionID: "ses_replan_parity",
        title: "replan-parity",
        config: { name: "replan-parity", nodes: [goodNode] },
      }).pipe(Effect.orDie)

      // Structural errors that planReplan does NOT pre-filter: a condition
      // referencing a node outside depends_on, and an unbound prompt
      // placeholder. Both are enforced only by the shared structural authority,
      // so create and replan must produce the same diagnostic codes.
      const badReplanFragment: NodeConfig[] = [
        {
          id: "cond",
          name: "cond",
          worker_type: "general",
          depends_on: [],
          required: true,
          condition: 'gate.output.verdict == "ACCEPT"',
          prompt_template: { inline: "Work {{missing}}" },
        },
      ]

      const error = yield* dag.replan(dagID, { nodes: badReplanFragment }).pipe(
        Effect.catch((e: unknown) => Effect.succeed(e)),
      )
      expect(error).toBeInstanceOf(Dag.StructuralValidationError)
      const replanErrors = (error as Dag.StructuralValidationError).diagnostics.filter(
        (d) => d.severity === "error",
      )

      // Cross-check against the pure validator for the same fragment nodes.
      const validation = yield* validate({ config: { name: "replan-parity", nodes: badReplanFragment } })
      const key = (d: { code: string; path: string; message: string }) => `${d.code}|${d.path}|${d.message}`
      expect(replanErrors.map(key).sort()).toEqual(
        validation.errors
          .filter(
            (d) =>
              d.code === DagValidation.DIAGNOSTIC_CODES.dagInvalid ||
              d.code === DagValidation.DIAGNOSTIC_CODES.promptUnboundVariable,
          )
          .map(key)
          .sort(),
      )
    }),
  )
})
