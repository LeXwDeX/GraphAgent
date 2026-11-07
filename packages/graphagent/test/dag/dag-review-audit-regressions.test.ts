/**
 * Regression suite for the findings verified out of the DAG self-review
 * (workflow dag_04df6bfa6ffe3EO429nwGkG1VT) and fixed afterwards:
 *
 * - H1: validateAgainstSchema skipped ALL type validation when `type` was a
 *   JSON Schema type array (["string","null"]).
 * - B1: reconcileWorkflow completed recovered diff-review nodes from
 *   capturedOutput without validateReviewResult — the crash-recovery bypass
 *   of spawn's review completion gate. Includes pins proving the completion
 *   gate (reviewAccepted) never re-checks fingerprints, which is why the fix
 *   lives in recovery.
 * - B2 (no bug): pins proving loop's validateReviewExecutionInput gate rejects
 *   diff reviews with empty/missing fingerprints BEFORE spawn, so spawn's
 *   falsy-fingerprint guard is not a reachable bypass.
 * - B3: evaluateCondition returned a silent `false` for numeric comparisons on
 *   non-numeric operands (missing field path, plain-text output) → silent
 *   condition_false skip. Now fails loudly.
 * - B4: the schema subset validator silently ignored min/max, length, pattern,
 *   item-count, and additionalProperties constraints.
 */
import { describe, expect, it } from "bun:test"
import { Effect, Layer, Semaphore, Fiber } from "effect"
import { reconcileWorkflow } from "@/dag/runtime/recovery"
import { validateAgainstSchema, unsupportedSchemaKeywords } from "@/dag/runtime/capture"
import { evaluateCondition } from "@/dag/runtime/eval"
import { spawnNode } from "@/dag/runtime/spawn"
import { Dag } from "@/dag/dag"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { validateReviewExecutionInput, unresolvedReviewOutcomes } from "@/dag/review-lifecycle"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { makeNodeRow } from "./fixtures"

type TrackedEvent = { type: string; nodeID: string; output?: unknown; reason?: string; trigger?: string }

function makeDagLayer(nodes: DagStore.NodeRow[], trackedEvents: TrackedEvent[]) {
  return Layer.mock(Dag.Service, {
    store: {
      getNodes: () => Effect.succeed(nodes),
      getNode: (id: string) => Effect.succeed(nodes.find((n) => n.id === id)),
    } as unknown as DagStore.Interface,
    nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string, output: unknown) =>
      Effect.sync(() => trackedEvents.push({ type: "nodeCompleted", nodeID, output })),
    ),
    nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string, trigger: string) =>
      Effect.sync(() => trackedEvents.push({ type: "nodeFailed", nodeID, reason, trigger })),
    ),
  })
}

// ============================================================================
// H1 — capture.ts:37 type-array bypass
// ============================================================================
describe("H1: validateAgainstSchema with JSON Schema type arrays", () => {
  it("rejects a number when schema declares type ['string','null']", () => {
    const result = validateAgainstSchema(42, { type: ["string", "null"] })
    expect(result.ok).toBe(false)
  })

  it("rejects an object when schema declares type ['number','integer']", () => {
    const result = validateAgainstSchema({ sneaky: true }, { type: ["number", "integer"] })
    expect(result.ok).toBe(false)
  })

  it("accepts null when schema declares type ['string','null']", () => {
    expect(validateAgainstSchema(null, { type: ["string", "null"] }).ok).toBe(true)
  })

  it("accepts a string when schema declares type ['string','null']", () => {
    expect(validateAgainstSchema("ok", { type: ["string", "null"] }).ok).toBe(true)
  })

  it("single-string type behavior unchanged", () => {
    expect(validateAgainstSchema("ok", { type: "string" }).ok).toBe(true)
    expect(validateAgainstSchema(42, { type: "string" }).ok).toBe(false)
  })

  it("single-string type 'null' is now enforced (was inert before the type-array fix)", () => {
    // Deliberate behavior change beyond H1's letter: the old validator had no
    // null branch, so { type: "null" } accepted anything.
    expect(validateAgainstSchema(null, { type: "null" }).ok).toBe(true)
    expect(validateAgainstSchema("x", { type: "null" }).ok).toBe(false)
  })
})

// ============================================================================
// #346 — object-semantic keywords without `type: "object"` used to let any
// non-object value pass silently (ok:true), hiding the DAG-01 consequence
// inside a legal schema spelling.
// ============================================================================
describe("#346: object-semantic keywords imply an object value", () => {
  it("rejects a string when the schema has required/properties but no type", () => {
    const schema = { required: ["verdict"], properties: { verdict: { type: "string" } } }
    expect(validateAgainstSchema("accepted", schema).ok).toBe(false)
  })

  it("rejects a number for a properties-only schema", () => {
    expect(validateAgainstSchema(42, { properties: { verdict: { type: "string" } } }).ok).toBe(false)
  })

  it("still accepts a conforming object for the same schema", () => {
    const schema = { required: ["verdict"], properties: { verdict: { type: "string" } } }
    expect(validateAgainstSchema({ verdict: "replan" }, schema).ok).toBe(true)
  })

  it("still rejects a missing required field on a conforming-typed object", () => {
    const schema = { required: ["verdict"], properties: { verdict: { type: "string" } } }
    expect(validateAgainstSchema({}, schema).ok).toBe(false)
  })

  it("additionalProperties:false fences keys even without a properties block", () => {
    expect(validateAgainstSchema({ rogue: 1 }, { type: "object", additionalProperties: false }).ok).toBe(false)
    expect(validateAgainstSchema({}, { type: "object", additionalProperties: false }).ok).toBe(true)
  })

  it("additionalProperties as a keyword implies an object value", () => {
    expect(validateAgainstSchema("str", { additionalProperties: false }).ok).toBe(false)
  })

  it("an unknown type name fails instead of permissively passing", () => {
    expect(validateAgainstSchema("x", { type: "strng" }).ok).toBe(false)
    expect(validateAgainstSchema(42, { type: "strng" }).ok).toBe(false)
  })
})

// ============================================================================
// B1 — recovery path completes review nodes without validateReviewResult
// ============================================================================
describe("B1: reconcileWorkflow review-contract gap", () => {
  // A diff review exactly as the normal path would run it: review block +
  // fingerprint input_mapping, so spawn.ts:233 WOULD validate this node.
  // Recovery must enforce the same contract.
  const reviewNodeConfig = {
    id: "review-1",
    output_schema: { type: "object", required: ["verdict", "implementation_fingerprint"] },
    review: { phase: "diff" as const, implementation_node_id: "implement", verification_node_id: "verify" },
    input_mapping: {
      diff: "implement.output.diff",
      fingerprint: "implement.output.fingerprint",
      verification: "verify.output",
    },
  }
  const rows = (capturedOutput: unknown) => [
    makeNodeRow({
      id: "implement",
      status: "completed",
      output: { fingerprint: "current-fp", diff: "diff --git a b" },
    }),
    makeNodeRow({ id: "verify", status: "completed", output: { verdict: "PASS" } }),
    makeNodeRow({
      id: "review-1",
      workerType: "review",
      status: "running",
      childSessionId: "ses_r",
      capturedOutput,
    }),
  ]
  const config = { nodes: [{ id: "implement" }, { id: "verify" }, reviewNodeConfig] }

  it("recovered diff review with invalid verdict must not be completed", async () => {
    const events: TrackedEvent[] = []
    const nodes = rows({ verdict: "MAYBE", implementation_fingerprint: "current-fp" })
    await Effect.runPromise(
      reconcileWorkflow("wf-1", () => Effect.succeed("completed" as const), undefined, config).pipe(
        Effect.provide(makeDagLayer(nodes, events)),
      ),
    )
    // Recovery enforces the same review contract (verdict ∈ ACCEPT|REJECT)
    // as spawn's completion gate — both call settleCapturedOutput.
    expect(events).not.toContainEqual(expect.objectContaining({ type: "nodeCompleted", nodeID: "review-1" }))
    expect(events).toContainEqual(expect.objectContaining({ type: "nodeFailed", nodeID: "review-1", trigger: "verdict_fail" }))
  })

  it("recovered diff review with stale fingerprint must not be completed", async () => {
    const events: TrackedEvent[] = []
    const nodes = rows({ verdict: "ACCEPT", implementation_fingerprint: "stale-fp" })
    await Effect.runPromise(
      reconcileWorkflow("wf-1", () => Effect.succeed("completed" as const), undefined, config).pipe(
        Effect.provide(makeDagLayer(nodes, events)),
      ),
    )
    expect(events).not.toContainEqual(expect.objectContaining({ type: "nodeCompleted", nodeID: "review-1" }))
  })

  it("valid recovered diff review still completes", async () => {
    const events: TrackedEvent[] = []
    const nodes = rows({ verdict: "ACCEPT", implementation_fingerprint: "current-fp" })
    await Effect.runPromise(
      reconcileWorkflow("wf-1", () => Effect.succeed("completed" as const), undefined, config).pipe(
        Effect.provide(makeDagLayer(nodes, events)),
      ),
    )
    expect(events).toContainEqual(expect.objectContaining({ type: "nodeCompleted", nodeID: "review-1" }))
  })

  it("deep-mode completion gate accepts ACCEPT with a stale fingerprint (last line of defense has no fingerprint check)", () => {
    const config: WorkflowConfig = {
      name: "wf",
      mode: "deep",
      nodes: [
        node("implement", { output_schema: { type: "object", required: ["fingerprint", "diff"] } }),
        node("verify", { depends_on: ["implement"] }),
        node("review-1", {
          worker_type: "review",
          depends_on: ["verify"],
          review: { phase: "diff", implementation_node_id: "implement", verification_node_id: "verify" },
          input_mapping: {
            diff: "implement.output.diff",
            fingerprint: "implement.output.fingerprint",
            verification: "verify.output",
          },
          condition: "verify.output.verdict == PASS",
          output_schema: { type: "object", required: ["verdict", "implementation_fingerprint"] },
        }),
        node("finalize", {
          depends_on: ["review-1"],
          input_mapping: { review: "review-1.output" },
          condition: "review-1.output.verdict == ACCEPT",
        }),
      ],
    }
    const rows = [
      { id: "implement", status: "completed", output: { fingerprint: "current-fp", diff: "d" } },
      { id: "verify", status: "completed", output: { verdict: "PASS" } },
      { id: "review-1", status: "completed", output: { verdict: "ACCEPT", implementation_fingerprint: "stale-fp" } },
      { id: "finalize", status: "completed", output: "done" },
    ]
    // Documents the residual gap: reviewAccepted checks verdict === ACCEPT and
    // a completed final gate, but never re-checks the fingerprint. The chosen
    // fix layer is recovery (entry point of unvalidated data); this pin makes
    // the read-side behavior explicit.
    expect(unresolvedReviewOutcomes(config, rows)).toEqual([])
    // #944: a review whose target changed mid-run is never accepted, even
    // with an ACCEPT verdict and a completed final gate.
    expect(
      unresolvedReviewOutcomes(
        config,
        rows.map((row) => (row.id === "review-1" ? { ...row, staleTarget: true } : row)),
      ),
    ).toEqual(["review-1"])
  })
})

// ============================================================================
// B2 — is spawn.ts:232's falsy-fingerprint guard reachable for a diff review?
// ============================================================================
describe("B2: loop-level gate coverage for empty fingerprints", () => {
  it("diff review with empty fingerprint evidence is rejected BEFORE spawn (loop.ts:146 gate)", () => {
    const review = node("review-1", {
      worker_type: "review",
      review: { phase: "diff", implementation_node_id: "implement", verification_node_id: "verify" },
      input_mapping: {
        diff: "implement.output.diff",
        fingerprint: "implement.output.fingerprint",
        verification: "verify.output",
      },
    })
    const resolved = { diff: "diff --git a b", fingerprint: "", verification: { verdict: "PASS" } }
    const result = validateReviewExecutionInput(review, resolved)
    expect(result.valid).toBe(false)
    expect(result.errors.join(" ")).toContain("fingerprint")
  })

  it("diff review with missing fingerprint mapping is rejected BEFORE spawn", () => {
    const review = node("review-1", {
      worker_type: "review",
      review: { phase: "diff", implementation_node_id: "implement", verification_node_id: "verify" },
      input_mapping: { diff: "implement.output.diff", verification: "verify.output" },
    })
    const resolved = { diff: "diff --git a b", verification: { verdict: "PASS" } }
    expect(validateReviewExecutionInput(review, resolved).valid).toBe(false)
  })

  it("review worker without a review block has no contract to enforce (standard mode)", () => {
    const review = node("review-1", { worker_type: "review" })
    expect(validateReviewExecutionInput(review, {}).valid).toBe(true)
  })
})

// ============================================================================
// B3 — eval.ts numeric comparison silently false on non-numeric operands
// ============================================================================
describe("B3: evaluateCondition numeric comparisons", () => {
  it("unresolvable field path in a numeric comparison must fail loudly, not skip silently", () => {
    // nodeA has plain-text output, so nodeA.output.count resolves to undefined.
    // A silent { ok:true, value:false } here would cascade nodeSkipped through
    // required downstream nodes; ok:false makes the loop fail the node loudly.
    const result = evaluateCondition("a.output.count > 0", { a: { output: "plain text output" } })
    expect(result.ok).toBe(false)
  })

  it("non-numeric operand in a numeric comparison must fail loudly", () => {
    const result = evaluateCondition("a.output.label > 5", { a: { output: { label: "not-a-number" } } })
    expect(result.ok).toBe(false)
  })

  it("non-finite operands fail loudly too (parseValue turns 'Infinity' into a number)", () => {
    expect(evaluateCondition("a.output.count > Infinity", { a: { output: { count: 1 } } }).ok).toBe(false)
    expect(evaluateCondition("a.output.count > 0", { a: { output: { count: Number.POSITIVE_INFINITY } } }).ok).toBe(false)
  })

  it("numeric comparison on real numbers still works", () => {
    expect(evaluateCondition("a.output.count > 0", { a: { output: { count: 3 } } })).toEqual({ ok: true, value: true })
    expect(evaluateCondition("a.output.count < 2", { a: { output: { count: 3 } } })).toEqual({ ok: true, value: false })
  })

  it("equality comparisons on strings unaffected", () => {
    expect(evaluateCondition("a.output.verdict == ACCEPT", { a: { output: { verdict: "ACCEPT" } } })).toEqual({
      ok: true,
      value: true,
    })
  })
})

// ============================================================================
// B4 — schema validator silently ignores unsupported constraint keywords
// ============================================================================
describe("B4: validateAgainstSchema unsupported keywords", () => {
  it("minimum is enforced", () => {
    expect(validateAgainstSchema(5, { type: "number", minimum: 10 }).ok).toBe(false)
    expect(validateAgainstSchema(15, { type: "number", minimum: 10 }).ok).toBe(true)
  })

  it("maxLength is enforced", () => {
    expect(validateAgainstSchema("toolong", { type: "string", maxLength: 3 }).ok).toBe(false)
  })

  it("additionalProperties:false rejects extra properties", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false }
    expect(validateAgainstSchema({ a: "x", extra: 1 }, schema).ok).toBe(false)
    expect(validateAgainstSchema({ a: "x" }, schema).ok).toBe(true)
  })
})

describe("B4: unsupportedSchemaKeywords", () => {
  it("reports combinators and $ref the subset validator ignores, including nested ones", () => {
    const schema = {
      type: "object",
      properties: {
        a: { oneOf: [{ type: "string" }] },
        b: { type: "array", items: { $ref: "#/defs/x" } },
      },
      allOf: [{ required: ["a"] }],
    }
    expect(unsupportedSchemaKeywords(schema)).toEqual(["$ref", "allOf", "oneOf"])
  })

  it("stays silent for fully supported schemas and bare annotations", () => {
    const schema = {
      type: "object",
      title: "result",
      description: "…",
      required: ["verdict"],
      properties: { verdict: { enum: ["ACCEPT", "REJECT"] }, count: { type: "number", minimum: 0 } },
      additionalProperties: false,
    }
    expect(unsupportedSchemaKeywords(schema)).toEqual([])
  })

  it("flags inert forms the validator cannot enforce: tuple items and schema-form additionalProperties", () => {
    expect(unsupportedSchemaKeywords({ type: "array", items: [{ type: "string" }, { oneOf: [] }] }))
      .toEqual(["items (tuple form)", "oneOf"])
    expect(unsupportedSchemaKeywords({ type: "object", additionalProperties: { type: "string" } }))
      .toEqual(["additionalProperties (schema form)"])
  })
})

// ============================================================================
// B5 — spawn early-exit failures settle once, without failing the caller
// ============================================================================
describe("B5: spawn pre-admission failures", () => {
  function makeSpawnHarness() {
    const events: { type: string; nodeID: string; reason?: string }[] = []
    const dagLayer = Layer.mock(Dag.Service, {
      store: {} as DagStore.Interface,
      nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string) =>
        Effect.sync(() => events.push({ type: "nodeFailed", nodeID, reason })),
      ),
    })
    const sessionLayer = Layer.mock(Session.Service, {
      get: () => Effect.succeed({ id: "ses_parent" as never, permission: [], agent: "build" } as never),
      create: (input?: { directory?: string }) =>
    Effect.succeed({ id: "ses_child" as never, directory: input?.directory ?? process.cwd() } as never),
    })
    const promptLayer = Layer.mock(SessionPrompt.Service, {})
    return { events, dagLayer, sessionLayer, promptLayer }
  }

  async function runSpawnToSettled(agentLayer: Layer.Layer<never>, harness: ReturnType<typeof makeSpawnHarness>) {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* spawnNode(Semaphore.makeUnsafe(1), {
            dagID: "wf-1",
            nodeID: "node-1",
            node: makeNodeRow(),
            parentSessionID: "ses_parent",
            promptParts: [{ type: "text", text: "run" }] as never,
          })
          yield* Fiber.await(result.fiber)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(harness.dagLayer, agentLayer, harness.sessionLayer, harness.promptLayer))) as Effect.Effect<never>,
    )
  }

  it("unknown worker_type publishes exactly one nodeFailed and resolves (no Effect.fail to the caller)", async () => {
    const harness = makeSpawnHarness()
    const agentLayer = Layer.mock(Agent.Service, {
      get: () => Effect.die(new Error("no such agent")),
    })
    // The await itself is the assertion that spawnNode no longer fails —
    // before B5 this promise rejected and loop's catchCause published a
    // second, guard-rejected NodeFailed.
    await runSpawnToSettled(agentLayer, harness)
    expect(harness.events).toEqual([
      { type: "nodeFailed", nodeID: "node-1", reason: "unknown worker_type: build" },
    ])
  })

  it("missing model publishes exactly one nodeFailed and resolves", async () => {
    const harness = makeSpawnHarness()
    const agentLayer = Layer.mock(Agent.Service, {
      get: () =>
        Effect.succeed({
          name: "general", mode: "all", permission: [], options: {}, description: "", prompt: "",
          tools: {}, hooks: {},
        }),
    })
    await runSpawnToSettled(agentLayer, harness)
    expect(harness.events).toEqual([
      { type: "nodeFailed", nodeID: "node-1", reason: "no model configured for agent: general" },
    ])
  })
})

function node(id: string, overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: `Run ${id}` },
    ...overrides,
  }
}
