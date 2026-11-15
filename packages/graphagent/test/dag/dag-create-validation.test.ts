// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { Dag, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
import { DagAdmission } from "@/dag/admission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TestConfig } from "../fixture/config"

const testLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
)

const dagLayer = Layer.provideMerge(Dag.layer, testLayer)

/** The same graph runtime with a global `dag.max_total_nodes` user cap. */
const dagLayerWithGlobalCap = (maxTotalNodes: number) =>
  Layer.provideMerge(
    Dag.layer,
    Layer.mergeAll(testLayer, TestConfig.layer({ dagGlobal: () => Effect.succeed({ max_total_nodes: maxTotalNodes }) })),
  )

/** The same graph runtime with a mutable global cap: the config layer is
 * consulted per call, so a test can lower `dag.max_total_nodes` after
 * creation and observe the next mutation clamp against it. */
const dagLayerWithMutableGlobalCap = (cap: { value: number }) =>
  Layer.provideMerge(
    Dag.layer,
    Layer.mergeAll(testLayer, TestConfig.layer({ dagGlobal: () => Effect.succeed({ max_total_nodes: cap.value }) })),
  )

/** Drive one node to failure, then pause scheduling: the state recover accepts. */
const failNodeAndPause = (dag: Dag.Interface, dagID: string, nodeID: string) =>
  Effect.gen(function* () {
    yield* dag.nodeQueued(dagID, nodeID)
    yield* dag.nodeStarted(dagID, nodeID, `ses_${nodeID}`)
    yield* dag.nodeFailed(dagID, nodeID, "transport failed", "exec_failed")
    yield* dag.pause(dagID)
  })

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

// Structural validation fails BEFORE any event is published, so no
// project/session FK rows are needed for the rejection paths.
function createExpectingError(config: Partial<WorkflowConfig> & { nodes: NodeConfig[] }) {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const error = yield* dag
      .create({
        projectID: "project-1",
        sessionID: "ses_create",
        title: "create-validation",
        config: { name: "create-validation", ...config },
      })
      .pipe(Effect.catch((e: Error) => Effect.succeed(e)))
    expect(error).toBeInstanceOf(Error)
    return error as Error
  })
}

function setupFKs() {
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
        id: "ses_create" as never,
        project_id: Project.ID.global,
        slug: "create",
        directory: "/project",
        title: "create",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

describe("Dag.create structural validation", () => {
  it("rejects duplicate node ids instead of silently merging them", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* createExpectingError({ nodes: [node("a"), node("b"), node("a")] })
        expect(error.message).toContain("duplicate node ids: a")
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })

  it("rejects unknown depends_on references instead of silently dropping the edge", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Pre-fix, buildGraph dropped the edge and a typo'd dependency turned
        // the node into an immediately-runnable root.
        const error = yield* createExpectingError({ nodes: [node("a"), node("b", ["ghost"])] })
        expect(error.message).toContain('node "b" depends on unknown node "ghost"')
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })

  it("enforces a declared max_total_nodes at creation, not only on replan", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* createExpectingError({
          max_total_nodes: 2,
          nodes: [node("a"), node("b"), node("c")],
        })
        // A declaration below the user cap is honored (no 100-node floor).
        expect(error.message).toContain("Total node ceiling exceeded: 3 nodes > 2 max")
        if (!(error instanceof Dag.StructuralValidationError)) throw new Error("expected a structural failure")
        const hint = error.diagnostics[0]?.hint
        expect(hint).toContain("Raise config.max_total_nodes")
        expect(hint).toContain("dag.max_total_nodes cap of 100")
      }).pipe(Effect.scoped, Effect.provide(dagLayer)),
    )
  })

  it("applies the global dag.max_total_nodes cap to an omitted declaration", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* createExpectingError({ nodes: [node("a"), node("b"), node("c")] })
        expect(error.message).toContain("Total node ceiling exceeded: 3 nodes > 2 max")
        if (!(error instanceof Dag.StructuralValidationError)) throw new Error("expected a structural failure")
        // Only the user's global key can move this ceiling; the start document
        // carries no declaration of its own to raise.
        expect(error.diagnostics[0]?.hint).toContain("raise dag.max_total_nodes")
      }).pipe(Effect.scoped, Effect.provide(dagLayerWithGlobalCap(2))),
    )
  })

  it("clamps a declaration above the global cap to the user's ceiling", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* createExpectingError({
          max_total_nodes: 50,
          nodes: [node("a"), node("b"), node("c")],
        })
        expect(error).toBeInstanceOf(Dag.StructuralValidationError)
        expect(error.message).toContain("Total node ceiling exceeded: 3 nodes > 2 max")
      }).pipe(Effect.scoped, Effect.provide(dagLayerWithGlobalCap(2))),
    )
  })

  it("allows a graph the global cap admits even beyond the old default floor", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_create",
            title: "raised-global-cap",
            config: {
              name: "raised-global-cap",
              nodes: Array.from({ length: 120 }, (_, i) => node(`n${i}`)),
            },
          })
          .pipe(Effect.orDie)
        expect(dagID.startsWith("dag")).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(dagLayerWithGlobalCap(150))),
    )
  })

  it("rejects a replan over the ceiling without suggesting a field the fragment cannot carry", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_create",
            title: "replan-ceiling",
            config: { name: "replan-ceiling", max_total_nodes: 2, nodes: [node("a")] },
          })
          .pipe(Effect.orDie)
        const error = yield* dag
          .replan(dagID, { nodes: [node("b"), node("c")] })
          .pipe(Effect.catch((e: Error) => Effect.succeed(e)))
        expect(error).toBeInstanceOf(Dag.StructuralValidationError)
        if (!(error instanceof Dag.StructuralValidationError)) throw new Error("expected a structural failure")
        const ceiling = error.diagnostics.find((d) =>
          d.message.includes("Total node ceiling exceeded: 3 nodes > 2 max"),
        )!
        expect(ceiling.hint).not.toContain("raise config.max_total_nodes")
        expect(ceiling.hint).toContain("fixed by the start document")
        expect(ceiling.hint).toContain("Shrink the fragment")
        expect(ceiling.hint).toContain("bounded successor workflow")
      }).pipe(Effect.scoped, Effect.provide(dagLayer)),
    )
  })

  it("rejects an extend that reaches past the global cap, even when the start document omitted it", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_create",
            title: "extend-ceiling",
            config: { name: "extend-ceiling", nodes: [node("a"), node("b")] },
          })
          .pipe(Effect.orDie)
        const error = yield* dag
          .extend(dagID, [node("c")])
          .pipe(Effect.catch((e: Error) => Effect.succeed(e)))
        expect(error).toBeInstanceOf(Dag.StructuralValidationError)
        if (!(error instanceof Dag.StructuralValidationError)) throw new Error("expected a structural failure")
        expect(error.message).toContain("Total node ceiling exceeded: 3 nodes > 2 max")
        expect(error.diagnostics[0]?.hint).toContain("fixed by the start document")
      }).pipe(Effect.scoped, Effect.provide(dagLayerWithGlobalCap(2))),
    )
  })

  it("recovers a 120-node workflow created under a global cap of 150 (#1031 M4)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_create",
            title: "recover-global-cap",
            config: {
              name: "recover-global-cap",
              nodes: Array.from({ length: 120 }, (_, i) => node(`n${i}`)),
            },
          })
          .pipe(Effect.orDie)
        yield* failNodeAndPause(dag, dagID, "n0")
        const workflow = (yield* dag.store.getWorkflow(dagID))!
        // Pre-fix recover fell back to the 100-node default ceiling and
        // rejected this retry (121 nodes) the create path had admitted.
        const recovered = yield* dag.recover(dagID, { nodeIDs: ["n0"], expectedGraphRev: workflow.graphRev })
        expect(recovered.replacements.map((item) => item.previous)).toEqual(["n0"])
        expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("running")
      }).pipe(Effect.scoped, Effect.provide(dagLayerWithGlobalCap(150))),
    )
  })

  it("rejects a recovery the lowered global cap no longer admits (#1031 M4)", async () => {
    const cap = { value: 10 }
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_create",
            title: "recover-lowered-cap",
            config: { name: "recover-lowered-cap", nodes: [node("a"), node("b"), node("c")] },
          })
          .pipe(Effect.orDie)
        yield* failNodeAndPause(dag, dagID, "a")
        // The cap is read per mutation: creation was admitted under 10, but
        // recovery must honor the current 2-node ceiling, like replan does.
        cap.value = 2
        const workflow = (yield* dag.store.getWorkflow(dagID))!
        const error = yield* dag
          .recover(dagID, { nodeIDs: ["a"], expectedGraphRev: workflow.graphRev })
          .pipe(Effect.catch((e: Error) => Effect.succeed(e)))
        expect(error).toBeInstanceOf(Dag.StructuralValidationError)
        if (!(error instanceof Dag.StructuralValidationError)) throw new Error("expected a structural failure")
        expect(error.message).toContain("Total node ceiling exceeded: 4 nodes > 2 max")
        expect(error.diagnostics[0]?.hint).toContain("recover document")
        expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("paused")
      }).pipe(Effect.scoped, Effect.provide(dagLayerWithMutableGlobalCap(cap))),
    )
  })

  it("rejects workflow isolation combined with a workflow workspace (#1030)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* createExpectingError({
          isolation: "worktree",
          workspace: "/project/wt",
          nodes: [node("a")],
        })
        expect(error.message).toContain("config.isolation and config.workspace are mutually exclusive")
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })

  it("fails closed when workflow isolation has no usable git target (#1030)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // No durable session row: create falls back to the ambient stamp, which
        // is empty without an instance. The isolation gate must reject before
        // any worktree or event exists.
        const error = yield* createExpectingError({ isolation: "worktree", nodes: [node("a")] })
        expect(error.message).toContain("workflow worktree isolation requires a git target")
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })

  it("rejects a condition referencing a node outside depends_on", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Pre-fix, the condition would silently resolve to undefined at spawn
        // time and evaluate false — a silent skip instead of a loud rejection.
        const error = yield* createExpectingError({
          nodes: [
            node("gate"),
            node("other"),
            { ...node("impl", ["other"]), condition: 'gate.output.verdict == "ACCEPT"' },
          ],
        })
        expect(error.message).toContain('node "impl" condition references "gate"')
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })

  it("accepts a valid config (condition on a direct dependency)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_create",
            title: "create-validation",
            config: {
              name: "create-validation",
              nodes: [node("gate"), { ...node("impl", ["gate"]), condition: 'gate.output.verdict == "ACCEPT"' }],
            },
          })
          .pipe(Effect.orDie)
        expect(dagID.startsWith("dag")).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })

  it("persists config.acceptance and the fixed review gate", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_create",
            title: "review-gate",
            config: {
              name: "review-gate",
              review_gate: "strict",
              acceptance: [{ id: "AC1", text: "the change works" }],
              // Strict writers must come from blocks; this case pins persistence, not writer coverage.
              nodes: [{ ...node("a"), worker_type: "explore" }],
            },
          })
          .pipe(Effect.orDie)
        const workflow = yield* dag.store.getWorkflow(dagID).pipe(Effect.orDie)
        const config = workflow ? Dag.parseWorkflowConfig(workflow.config) : undefined
        expect(config?.review_gate).toBe("strict")
        expect(config?.acceptance).toEqual([{ id: "AC1", text: "the change works" }])
      }).pipe(Effect.scoped, Effect.provide(dagLayer)),
    )
  })

  it("derives deep acceptance AC1..ACn from the admission brief at create", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_create",
            title: "deep-gate",
            config: {
              name: "deep-gate",
              mode: "deep",
              admission: DagAdmission.createAdmissionRecord({
                brief_revision: 1,
                qa_mode: "STANDARD",
                verdict: "READY",
                brief: {
                  goal: "Ship the change",
                  scope: { in: ["src"], out: [] },
                  constraints: [],
                  assumptions: [],
                  acceptance_criteria: ["first criterion", "second criterion"],
                  evidence_required: ["focused checks pass"],
                  risks: [],
                  review_plan: ["independent review"],
                  open_questions: [],
                  blocking_questions: [],
                },
              }),
              // Strict writers must come from blocks; this case pins derived acceptance.
              nodes: [{ ...node("a"), worker_type: "explore" }],
            },
          })
          .pipe(Effect.orDie)
        const workflow = yield* dag.store.getWorkflow(dagID).pipe(Effect.orDie)
        const config = workflow ? Dag.parseWorkflowConfig(workflow.config) : undefined
        expect(config?.acceptance).toEqual([
          { id: "AC1", text: "first criterion" },
          { id: "AC2", text: "second criterion" },
        ])
      }).pipe(Effect.scoped, Effect.provide(dagLayer)),
    )
  })
})

describe("Dag prompt_template binding validation", () => {
  it("rejects an inline template referencing a variable with no binding source", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Pre-fix, the graph was "Added" and every node died at spawn time
        // (verdict_fail: Unresolved template placeholders) — a silent window
        // where the wave looked running. Acceptance rejects it up front.
        const error = yield* createExpectingError({
          nodes: [{ ...node("repair"), prompt_template: { inline: "Work in {{path}}" } }],
        })
        expect(error.message).toContain('node "repair" prompt_template references unbound variable "{{path}}"')
      }).pipe(Effect.scoped, Effect.provide(dagLayer)),
    )
  })

  it("accepts when prompt_template.input binds the variable", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_create",
            title: "binding-input",
            config: {
              name: "binding-input",
              nodes: [{ ...node("repair"), prompt_template: { inline: "Work in {{path}}", input: { path: "/repo" } } }],
            },
          })
          .pipe(Effect.orDie)
        expect(dagID.startsWith("dag")).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(dagLayer)),
    )
  })

  it("accepts when depends_on identity binding covers the variable", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_create",
            title: "binding-identity",
            config: {
              name: "binding-identity",
              nodes: [
                node("explore"),
                { ...node("repair", ["explore"]), prompt_template: { inline: "Use {{explore}}" } },
              ],
            },
          })
          .pipe(Effect.orDie)
        expect(dagID.startsWith("dag")).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(dagLayer)),
    )
  })

  it("accepts when input_mapping binds the variable", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_create",
            title: "binding-mapping",
            config: {
              name: "binding-mapping",
              nodes: [
                node("explore"),
                {
                  ...node("repair", ["explore"]),
                  input_mapping: { findings: "explore.output" },
                  prompt_template: { inline: "Use {{findings}}" },
                },
              ],
            },
          })
          .pipe(Effect.orDie)
        expect(dagID.startsWith("dag")).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(dagLayer)),
    )
  })

  it("does not binding-check id templates at acceptance (spawn-time enforcement covers them)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_create",
            title: "binding-id-template",
            config: {
              name: "binding-id-template",
              nodes: [{ ...node("repair"), prompt_template: { id: "not-on-disk" } }],
            },
          })
          .pipe(Effect.orDie)
        expect(dagID.startsWith("dag")).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(dagLayer)),
    )
  })

  it("rejects an extend whose new node has an unbound inline placeholder", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        const dag = yield* Dag.Service
        const dagID = yield* dag
          .create({
            projectID: Project.ID.global,
            sessionID: "ses_create",
            title: "binding-extend",
            config: { name: "binding-extend", nodes: [node("explore")] },
          })
          .pipe(Effect.orDie)
        // extend internally routes through _replan, which now uses the same
        // StructuralValidationError as create (shared authority).
        const error = yield* dag
          .extend(dagID, [{ ...node("repair", ["explore"]), prompt_template: { inline: "Use {{path}}" } }])
          .pipe(Effect.catch((e: unknown) => Effect.succeed(e)))
        expect(error).toBeInstanceOf(Dag.StructuralValidationError)
        if (!(error instanceof Error)) throw error
        expect(error.message).toContain('node "repair" prompt_template references unbound variable "{{path}}"')
      }).pipe(Effect.scoped, Effect.provide(dagLayer)),
    )
  })
})
