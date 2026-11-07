// Compatibility regression: the strict condition grammar and the evaluated
// diff-review PASS gate apply to definitions a mutation authors. A workflow
// persisted before those checks — a bare multi-word condition value
// (`A.output.s == in progress`) or a PASS gate on another field
// (`verify.output.status == PASS`) — must stay extendable, replannable and
// recoverable when the mutation does not touch those nodes. New fragment
// conditions keep full strictness. (Create/start strictness is covered by
// dag-condition-syntax and dag-review-lifecycle-authoring.)
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { WorkflowTable } from "@opencode-ai/core/dag/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Dag, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
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

function node(id: string, dependsOn: string[] = [], extra: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    ...extra,
  }
}

/** Create a valid workflow, then rewrite its persisted definition to the
 * legacy shape — what an older build accepted and stored. */
const setupLegacy = Effect.fn(function* (nodes: NodeConfig[], legacy: (config: WorkflowConfig) => WorkflowConfig) {
  const { db } = yield* Database.Service
  const sessionID = SessionID.make("ses_legacy_gate_parent")
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: AbsolutePath.make("/project"),
      title: sessionID,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  const dag = yield* Dag.Service
  const id = yield* dag.create({
    projectID: Project.ID.global,
    sessionID,
    title: "Legacy gate workflow",
    config: { name: "legacy-gate", nodes },
  })
  const stored = Dag.parseWorkflowConfig((yield* dag.store.getWorkflow(id))!.config)!
  yield* db
    .update(WorkflowTable)
    .set({ config: JSON.stringify(legacy(stored)) })
    .where(eq(WorkflowTable.id, id))
    .run()
    .pipe(Effect.orDie)
  return { dag, id }
})

const withCondition = (config: WorkflowConfig, nodeID: string, condition: string): WorkflowConfig => ({
  ...config,
  nodes: config.nodes.map((item) => (item.id === nodeID ? { ...item, condition } : item)),
})

const failureMessage = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Error ? error.message : String(error))),
  )

describe("legacy gate compatibility", () => {
  it.effect("a preserved bare multi-word condition does not block extend or recover", () =>
    Effect.gen(function* () {
      const { dag, id } = yield* setupLegacy(
        [node("A"), node("P", ["A"], { required: false, condition: 'A.output.s == "in progress"' }), node("X")],
        (config) => withCondition(config, "P", "A.output.s == in progress"),
      )
      const added = yield* dag.extend(id, [node("N")])
      expect(added.add).toEqual(["N"])

      // Fail the workflow: P is skipped as termination collateral and recovery
      // re-adds it with its stored (legacy) condition.
      yield* dag.nodeQueued(id, "X")
      yield* dag.nodeStarted(id, "X", "ses_X")
      yield* dag.nodeFailed(id, "X", "transport failed", "exec_failed")
      yield* dag.fail(id, "required node failed")
      const workflow = (yield* dag.store.getWorkflow(id))!
      const recovered = yield* dag.recover(id, { nodeIDs: ["X"], expectedGraphRev: workflow.graphRev })
      expect(recovered.replacements.some((item) => item.previous === "P")).toBe(true)
      const config = Dag.parseWorkflowConfig((yield* dag.store.getWorkflow(id))!.config)!
      const retryP = config.nodes.find((item) => item.recovery?.previous_node_id === "P")!
      expect(retryP.condition).toEndWith(".output.s == in progress")
    }),
  )

  it.effect("a fragment that introduces unsupported condition syntax is still rejected", () =>
    Effect.gen(function* () {
      const { dag, id } = yield* setupLegacy(
        [node("A"), node("P", ["A"], { required: false, condition: 'A.output.s == "in progress"' })],
        (config) => withCondition(config, "P", "A.output.s == in progress"),
      )
      // Replan carries every pending node it keeps; A and P are re-sent with
      // their stored definitions.
      const stored = Dag.parseWorkflowConfig((yield* dag.store.getWorkflow(id))!.config)!.nodes
      const legacyA = stored.find((item) => item.id === "A")!
      const legacyP = stored.find((item) => item.id === "P")!
      const unchanged = yield* dag.replan(id, { nodes: [legacyA, legacyP, node("R", ["A"], { required: false })] })
      expect(unchanged.add).toEqual(["R"])

      const added = yield* failureMessage(
        dag.replan(id, {
          nodes: [legacyA, legacyP, node("Q", ["A"], { required: false, condition: 'A.output.s !== "done"' })],
        }),
      )
      expect(added).toContain('node "Q" condition "A.output.s !== "done"" uses unsupported syntax')
      expect(added).not.toContain('node "P"')

      const changed = yield* failureMessage(
        dag.replan(id, { nodes: [legacyA, { ...legacyP, condition: 'A.output.s !== "done"' }] }),
      )
      expect(changed).toContain('node "P" condition')
      expect(changed).toContain("unsupported syntax")
    }),
  )

  it.effect("a persisted deep review gate on another PASS field does not block extend", () =>
    Effect.gen(function* () {
      const verifySchema = {
        type: "object",
        properties: { verdict: { enum: ["PASS", "FAIL"] }, status: { type: "string" } },
        required: ["verdict"],
      }
      const reviewSchema = {
        type: "object",
        properties: { verdict: { enum: ["ACCEPT", "REJECT"] }, implementation_fingerprint: { type: "string" } },
        required: ["verdict", "implementation_fingerprint"],
      }
      const review = (reviewID: string, condition: string) =>
        node(reviewID, ["verify"], {
          worker_type: "review",
          review: { phase: "diff", implementation_node_id: "implement", verification_node_id: "verify" },
          input_mapping: {
            diff: "implement.output.diff",
            implementation_fingerprint: "implement.output.fingerprint",
            verification: "verify.output",
          },
          condition,
          output_schema: reviewSchema,
        })
      const finalGate = (gateID: string, reviewID: string) =>
        node(gateID, [reviewID], {
          worker_type: "audit",
          input_mapping: { review: `${reviewID}.output` },
          condition: `${reviewID}.output.verdict == "ACCEPT"`,
          prompt_template: { inline: "Audit {{review}}" },
        })
      const { dag, id } = yield* setupLegacy(
        [
          node("implement", [], {
            output_schema: {
              type: "object",
              properties: { diff: { type: "string" }, fingerprint: { type: "string" } },
              required: ["diff", "fingerprint"],
            },
          }),
          node("verify", ["implement"], { output_schema: verifySchema }),
          review("review-diff", 'verify.output.verdict == "PASS"'),
          finalGate("final-audit", "review-diff"),
        ],
        (config) => ({ ...withCondition(config, "review-diff", "verify.output.status == PASS"), mode: "deep" }),
      )

      const added = yield* dag.extend(id, [node("N", [], { required: false })])
      expect(added.add).toEqual(["N"])

      const rejected = yield* failureMessage(
        dag.extend(id, [review("review-2", 'verify.output.verdict != "PASS"'), finalGate("final-2", "review-2")]),
      )
      expect(rejected).toContain("review-2: condition must require PASS from verification node verify")
      expect(rejected).not.toContain("review-diff: condition must require PASS")
    }),
  )
})
