import { describe, expect, it } from "bun:test"
import { WorkflowRuntime } from "@opencode-ai/core/dag/core/scheduling"
import { DagBlocks } from "@/dag/blocks"
import { DagConfig } from "@/dag/config"

describe("workflow blocks", () => {
  it("compiles a staged route and carries objective, instructions, and dependencies", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Add durable session recovery",
      blocks: [
        {
          id: "map",
          kind: "explore",
          instruction: "Locate persistence ownership",
        },
        {
          id: "build",
          kind: "coding",
          depends_on: ["map"],
        },
        {
          id: "verify",
          kind: "verify",
          depends_on: ["build"],
        },
      ],
    })

    expect(nodes.map((node) => ({ id: node.id, worker: node.worker_type, dependsOn: node.depends_on }))).toEqual([
      { id: "map", worker: "explore", dependsOn: [] },
      { id: "build", worker: "build", dependsOn: ["map"] },
      { id: "verify", worker: "general", dependsOn: ["build"] },
    ])
    expect(nodes[0]?.prompt_template.input).toEqual({
      objective: "Add durable session recovery",
      instruction: "Locate persistence ownership",
    })
    expect(nodes[1]?.prompt_template.inline).toContain("failing check")
    expect(nodes[1]?.prompt_template.inline).not.toContain("Skill")
    expect(nodes.map((node) => ({ id: node.id, required: node.required }))).toEqual([
      { id: "map", required: false },
      { id: "build", required: false },
      { id: "verify", required: true },
    ])
  })

  // issue #323: a reporting checkpoint adjudicates a direction — its prompt
  // must demand adversarial independent verification, not self-confirmation
  // of upstream claims. The production incident: cp-after-exploration
  // confirmed a parent-supplied "defect" that was a production no-op because
  // the gate re-read the parent's narrative instead of reading the source.
  it("compiles reporting checkpoints with an adversarial verification clause", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Ship the feature",
      blocks: [
        { id: "cp-after-exploration", kind: "explore", report_to_parent: true },
        { id: "stage", kind: "coding", depends_on: ["cp-after-exploration"] },
      ],
    })
    const checkpoint = nodes.find((node) => node.id === "cp-after-exploration")
    expect(checkpoint?.report_to_parent).toBe(true)
    // Upstream claims are hypotheses to verify, not facts to confirm.
    expect(checkpoint?.prompt_template.inline).toContain("hypotheses to verify")
    // Independent source inspection is mandatory for load-bearing claims.
    expect(checkpoint?.prompt_template.inline).toContain("Independently read the relevant source")
    // A quantified spot-check floor on the most load-bearing claims.
    expect(checkpoint?.prompt_template.inline).toContain("at least three")
    // A claim that fails inspection must fail the direction, not pass it.
    expect(checkpoint?.prompt_template.inline).toContain("replan or reject")
  })

  it("keeps the adversarial clause off non-reporting nodes", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Ship the feature",
      blocks: [
        { id: "map", kind: "explore" },
        { id: "stage", kind: "coding", depends_on: ["map"] },
      ],
    })
    // Only adjudicating checkpoints pay the adversarial cost; evidence
    // producers (a plain explore) and executors (coding) do not.
    for (const node of nodes) {
      expect(node.report_to_parent).toBe(false)
      expect(node.prompt_template.inline).not.toContain("hypotheses to verify")
    }
  })

  it("gives default-reporting synthesize nodes the adversarial clause", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Ship the feature",
      blocks: [{ id: "closing", kind: "synthesize" }],
    })
    expect(nodes[0]?.report_to_parent).toBe(true)
    expect(nodes[0]?.prompt_template.inline).toContain("hypotheses to verify")
  })

  it("composes configured design delivery capabilities without new lifecycle kinds", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Design, implement, and review project-owned memory",
      blocks: [
        {
          id: "codebase-design",
          kind: "plan",
          instruction: "Define the project identity seam and migration boundary.",
        },
        { id: "coding", kind: "coding", depends_on: ["codebase-design"] },
        { id: "verify", kind: "verify", depends_on: ["coding"] },
        { id: "global-review", kind: "review", depends_on: ["verify"] },
      ],
    })

    expect(nodes.map((node) => node.id)).toEqual([
      "codebase-design",
      "coding",
      "verify",
      "global-review--standards",
      "global-review--intent",
      "global-review",
    ])
    expect(nodes[0]?.prompt_template.input).toMatchObject({
      instruction: "Define the project identity seam and migration boundary.",
    })
  })

  it("makes a review-route verification gate a reporting checkpoint gated by its dependents", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Fix the parser",
      blocks: [
        { id: "coding", kind: "coding" },
        { id: "verify", kind: "verify", depends_on: ["coding"] },
        { id: "review", kind: "review", depends_on: ["verify"] },
      ],
    })
    const verify = nodes.find((node) => node.id === "verify")
    expect(verify?.report_to_parent).toBe(true)
    expect(verify?.prompt_template.inline).not.toContain("hypotheses to verify")
    for (const dependent of nodes.filter((node) => node.depends_on.includes("verify"))) {
      expect(dependent.condition).toBe('verify.output.verdict == "PASS"')
    }
  })

  it("keeps a verification with an ungated dependent non-reporting", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Fix the parser",
      blocks: [
        { id: "coding", kind: "coding" },
        { id: "verify", kind: "verify", depends_on: ["coding"] },
        { id: "review", kind: "review", depends_on: ["verify"] },
        { id: "notes", kind: "synthesize", depends_on: ["verify"] },
      ],
    })
    expect(nodes.find((node) => node.id === "verify")?.report_to_parent).toBe(false)
    const explicit = DagBlocks.compileWorkflowBlocks({
      objective: "Fix the parser",
      blocks: [
        { id: "coding", kind: "coding" },
        { id: "verify", kind: "verify", depends_on: ["coding"], report_to_parent: false },
        { id: "review", kind: "review", depends_on: ["verify"] },
      ],
    })
    expect(explicit.find((node) => node.id === "verify")?.report_to_parent).toBe(false)
  })

  it("keeps a pruned design delivery route valid when evidence is already supplied", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Implement the confirmed design from supplied file-level evidence",
      blocks: [
        { id: "coding", kind: "coding" },
        { id: "verify", kind: "verify", depends_on: ["coding"] },
        { id: "global-review", kind: "review", depends_on: ["verify"] },
      ],
    })

    expect(nodes.some((node) => node.worker_type === "explore")).toBe(false)
    expect(nodes.find((node) => node.id === "global-review")?.required).toBe(true)
  })

  it("expands debug into evidence and diagnosis nodes", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Find the source of a timeout",
      blocks: [{ id: "root-cause", kind: "debug", report_to_parent: true }],
    })

    expect(nodes.map((node) => node.id)).toEqual(["root-cause--evidence", "root-cause"])
    expect(nodes[0]).toMatchObject({
      worker_type: "explore",
      depends_on: [],
      report_to_parent: false,
    })
    expect(nodes[1]).toMatchObject({
      worker_type: "general",
      depends_on: ["root-cause--evidence"],
      report_to_parent: true,
    })
  })

  it("expands review into two independent lanes and a reporting verdict gate", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Review the implementation",
      blocks: [
        { id: "implementation", kind: "coding" },
        { id: "verification", kind: "verify", depends_on: ["implementation"] },
        { id: "decision", kind: "review", depends_on: ["verification"] },
        { id: "report", kind: "synthesize", depends_on: ["decision"] },
      ],
    })

    expect(nodes.map((node) => node.id)).toEqual([
      "implementation",
      "verification",
      "decision--standards",
      "decision--intent",
      "decision",
      "report",
    ])
    expect(nodes.find((node) => node.id === "decision")).toMatchObject({
      depends_on: ["decision--standards", "decision--intent", "verification"],
      required: true,
      report_to_parent: true,
      condition: 'verification.output.verdict == "PASS"',
      review: {
        phase: "diff",
        implementation_node_id: "implementation",
        verification_node_id: "verification",
      },
      input_mapping: {
        implementation_changed_files: "implementation.output.changed_files",
        implementation_fingerprint: "implementation.output.fingerprint",
        verification: "verification.output",
        standards_review: "decision--standards.output",
        intent_review: "decision--intent.output",
      },
      output_schema: {
        type: "object",
        properties: {
          verdict: { enum: ["ACCEPT", "REJECT"] },
          implementation_fingerprint: { type: "string" },
        },
      },
    })
    expect(nodes.find((node) => node.id === "implementation")?.output_schema).toEqual(
      expect.objectContaining({ required: expect.arrayContaining(["changed_files", "fingerprint"]) }),
    )
    expect(nodes.find((node) => node.id === "verification")?.output_schema).toEqual(
      expect.objectContaining({
        required: expect.arrayContaining(["verdict"]),
        properties: expect.objectContaining({ verdict: { type: "string", enum: ["PASS", "FAIL"] } }),
      }),
    )
    expect(nodes.find((node) => node.id === "report")?.condition).toBe('decision.output.verdict == "ACCEPT"')
  })

  // Issue #304: a synthesize following a review is the route's final gate —
  // it must map the review output, otherwise an ACCEPTed review stays listed
  // as an unresolved review outcome forever.
  it("binds the review output into a following synthesize as the final gate", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Deliver a reviewed change with a bound final report",
      blocks: [
        { id: "implementation", kind: "coding" },
        { id: "verification", kind: "verify", depends_on: ["implementation"] },
        { id: "decision", kind: "review", depends_on: ["verification"] },
        { id: "report", kind: "synthesize", depends_on: ["decision"] },
        { id: "side-note", kind: "synthesize", depends_on: ["verification"] },
      ],
    })

    expect(nodes.find((node) => node.id === "report")?.input_mapping).toEqual({
      decision_review: "decision.output",
    })
    expect(nodes.find((node) => node.id === "side-note")?.input_mapping).toBeUndefined()
  })

  it("keeps every downstream branch behind a reporting scope gate", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Deliver only while the bounded route remains valid",
      blocks: [
        { id: "evidence", kind: "explore" },
        { id: "scope-gate", kind: "review", depends_on: ["evidence"], report_to_parent: true },
        { id: "implementation", kind: "coding", depends_on: ["scope-gate"] },
        { id: "verification", kind: "verify", depends_on: ["implementation"] },
        { id: "decision", kind: "review", depends_on: ["verification"] },
        { id: "report", kind: "synthesize", depends_on: ["decision"] },
      ],
    })

    expect(nodes.find((node) => node.id === "scope-gate")).toMatchObject({
      report_to_parent: true,
      output_schema: {
        properties: { verdict: { enum: ["ACCEPT", "REVISE", "REJECT", "BLOCKED"] } },
      },
    })
    expect(nodes.find((node) => node.id === "implementation")?.condition).toBe('scope-gate.output.verdict == "ACCEPT"')
    expect(nodes.find((node) => node.id === "decision--standards")?.condition).toBe(
      'verification.output.verdict == "PASS"',
    )
    expect(nodes.find((node) => node.id === "decision--intent")?.condition).toBe(
      'verification.output.verdict == "PASS"',
    )
    expect(nodes.find((node) => node.id === "report")?.condition).toBe('decision.output.verdict == "ACCEPT"')

    const runtime = new WorkflowRuntime(
      nodes.map((node) => ({
        id: node.id,
        dependsOn: node.depends_on,
        required: node.required ?? false,
        status: "pending" as const,
      })),
      8,
    )
    ;["evidence", "scope-gate--standards", "scope-gate--intent", "scope-gate"].forEach((id) =>
      runtime.markSatisfied(id),
    )
    runtime.markSkipped("implementation")
    expect(runtime.getReadyNodes()).toEqual([])
    expect(runtime.getCascadeSkipNodes()).toEqual(["verification"])
    runtime.markSkipped("verification")
    expect(runtime.getCascadeSkipNodes()).toEqual(["decision--intent", "decision--standards"])
    ;["decision--intent", "decision--standards"].forEach((id) => runtime.markSkipped(id))
    expect(runtime.getCascadeSkipNodes()).toEqual(["decision"])
    runtime.markSkipped("decision")
    expect(runtime.getCascadeSkipNodes()).toEqual(["report"])
    runtime.markSkipped("report")
    expect(runtime.isComplete()).toBe(true)
  })

  // issue #425: block-level worker_config must reach every node the block
  // expands into — including the injected aggregator and the verify block
  // rebuilt by parallel-writer rewiring — while blocks that omit it stay
  // untouched for node_defaults to fill in.
  it("threads block-level worker_config onto every expanded node", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Bound each block individually",
      blocks: [
        { id: "impl-a", kind: "coding" },
        { id: "impl-b", kind: "prototype" },
        {
          id: "impl-verify",
          kind: "verify",
          depends_on: ["impl-a", "impl-b"],
          worker_config: { timeout_ms: 4321 },
        },
        { id: "gate", kind: "review", depends_on: ["impl-verify"], worker_config: { timeout_ms: 4321 } },
        { id: "diag", kind: "debug", depends_on: ["gate"], worker_config: { timeout_ms: 4321 } },
        { id: "map", kind: "explore", depends_on: ["gate"], worker_config: { timeout_ms: 4321 } },
      ],
    })

    expect(Object.fromEntries(nodes.map((node) => [node.id, node.worker_config]))).toEqual({
      "impl-a": undefined,
      "impl-b": undefined,
      "impl-verify": { timeout_ms: 4321 },
      "gate--aggregate": { timeout_ms: 4321 },
      "gate--standards": { timeout_ms: 4321 },
      "gate--intent": { timeout_ms: 4321 },
      gate: { timeout_ms: 4321 },
      "diag--evidence": { timeout_ms: 4321 },
      diag: { timeout_ms: 4321 },
      map: { timeout_ms: 4321 },
    })
    // The rewired verify block keeps its own timeout while its dependencies
    // move onto the injected aggregator.
    expect(nodes.find((node) => node.id === "impl-verify")?.depends_on).toEqual(["gate--aggregate"])
  })

  it("rejects an implementation review without one verification gate", () => {
    expect(() =>
      DagBlocks.compileWorkflowBlocks({
        objective: "Review current implementation",
        blocks: [
          { id: "implementation", kind: "coding" },
          { id: "decision", kind: "review", depends_on: ["implementation"] },
        ],
      }),
    ).toThrow("requires exactly one verification ancestor")
  })

  it("publishes evidence when a prototype is the latest verified writer", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Validate a prototype before deciding whether to promote it",
      blocks: [
        { id: "implementation", kind: "coding" },
        { id: "experiment", kind: "prototype", depends_on: ["implementation"] },
        { id: "verification", kind: "verify", depends_on: ["experiment"] },
        { id: "decision", kind: "review", depends_on: ["verification"] },
      ],
    })

    expect(nodes.find((node) => node.id === "experiment")?.output_schema).toEqual(
      expect.objectContaining({ required: expect.arrayContaining(["changed_files", "fingerprint"]) }),
    )
    expect(nodes.find((node) => node.id === "decision")).toMatchObject({
      review: { implementation_node_id: "experiment", verification_node_id: "verification" },
      input_mapping: {
        implementation_changed_files: "experiment.output.changed_files",
        implementation_fingerprint: "experiment.output.fingerprint",
      },
    })
  })

  it("keeps unordered workspace writers parallel and read-only lanes parallel", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Build two packages from independent evidence",
      blocks: [
        { id: "map-a", kind: "explore" },
        { id: "map-b", kind: "explore" },
        { id: "package-a", kind: "coding", depends_on: ["map-a"] },
        { id: "experiment", kind: "prototype", depends_on: ["map-b"] },
        { id: "package-b", kind: "coding", depends_on: ["map-b"] },
      ],
    })

    expect(nodes.find((node) => node.id === "map-a")?.depends_on).toEqual([])
    expect(nodes.find((node) => node.id === "map-b")?.depends_on).toEqual([])
    expect(nodes.find((node) => node.id === "package-a")?.depends_on).toEqual(["map-a"])
    expect(nodes.find((node) => node.id === "experiment")?.depends_on).toEqual(["map-b"])
    expect(nodes.find((node) => node.id === "package-b")?.depends_on).toEqual(["map-b"])
  })

  it("routes volume blocks to the standard tier and decision blocks to the advanced tier", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: "Deliver a reviewed project change",
      blocks: [
        { id: "map", kind: "explore" },
        { id: "plan", kind: "plan", depends_on: ["map"] },
        { id: "experiment", kind: "prototype", depends_on: ["map"] },
        { id: "diagnose", kind: "debug", depends_on: ["map"] },
        { id: "build", kind: "coding", depends_on: ["plan", "diagnose"] },
        { id: "verify", kind: "verify", depends_on: ["build", "experiment"] },
        { id: "decision", kind: "review", depends_on: ["verify"] },
        { id: "report", kind: "synthesize", depends_on: ["decision"] },
      ],
    })
    const models = Object.fromEntries(
      nodes.map((node) => [
        node.id,
        DagConfig.tierModel(
          { model: { advanced: "test/advanced", standard: "test/standard" } },
          { required: node.required ?? false, workerType: node.worker_type },
        )?.modelID,
      ]),
    )

    expect(models).toEqual({
      map: "standard",
      plan: "advanced",
      experiment: "standard",
      "diagnose--evidence": "standard",
      diagnose: "advanced",
      build: "standard",
      "decision--aggregate": "advanced",
      verify: "advanced",
      "decision--standards": "standard",
      "decision--intent": "standard",
      decision: "advanced",
      report: "advanced",
    })
    expect(Object.fromEntries(nodes.map((node) => [node.id, node.required]))).toEqual({
      map: false,
      plan: true,
      experiment: false,
      "diagnose--evidence": false,
      diagnose: true,
      build: false,
      "decision--aggregate": true,
      verify: true,
      "decision--standards": false,
      "decision--intent": false,
      decision: true,
      report: true,
    })
  })

  it("rejects ambiguous dependencies and expansion collisions", () => {
    expect(() =>
      DagBlocks.compileWorkflowBlocks({
        objective: "Invalid graph",
        blocks: [{ id: "build", kind: "coding", depends_on: ["missing"] }],
      }),
    ).toThrow('Block "build" depends on unknown block "missing"')

    expect(() =>
      DagBlocks.compileWorkflowBlocks({
        objective: "Colliding graph",
        blocks: [
          { id: "check", kind: "review" },
          { id: "check--intent", kind: "verify" },
        ],
      }),
    ).toThrow("Block expansion creates duplicate node ids: check--intent")

    expect(() =>
      DagBlocks.compileWorkflowBlocks({
        objective: "Cyclic graph",
        blocks: [
          { id: "a", kind: "plan", depends_on: ["b"] },
          { id: "b", kind: "plan", depends_on: ["a"] },
        ],
      }),
    ).toThrow("dependency cycle")

    expect(() =>
      DagBlocks.compileWorkflowBlocks({
        objective: "Unsafe ID",
        blocks: [{ id: "review.output", kind: "review" }],
      }),
    ).toThrow("must use only letters")
  })

  it("allows an extension block to depend on an existing durable node", () => {
    const nodes = DagBlocks.compileWorkflowBlocks(
      {
        objective: "Continue from durable evidence",
        blocks: [{ id: "repair", kind: "coding", depends_on: ["existing-evidence"] }],
      },
      { known_dependencies: ["existing-evidence"] },
    )

    expect(nodes[0]?.depends_on).toEqual(["existing-evidence"])
  })

  it("requires one objective and one review dependency per continuation", () => {
    expect(() => DagBlocks.compileWorkflowBlocks({ objective: " ", blocks: [{ id: "x", kind: "coding" }] })).toThrow(
      "non-empty objective",
    )
    expect(() =>
      DagBlocks.compileWorkflowBlocks({
        objective: "Ambiguous gates",
        blocks: [
          { id: "review-a", kind: "review" },
          { id: "review-b", kind: "review" },
          { id: "build", kind: "coding", depends_on: ["review-a", "review-b"] },
        ],
      }),
    ).toThrow("depends on multiple review gates")
  })

  // issue #387: an instruction that duplicates the objective (after
  // trim/line-ending normalization) must not be emitted twice in the single
  // child prompt — the objective section already carries the content.
  it("drops an instruction that duplicates the objective (issue #387)", () => {
    const duplicated = DagBlocks.compileWorkflowBlocks({
      objective: "Ship the memory feature",
      blocks: [{ id: "map", kind: "explore", instruction: "Ship the memory feature" }],
    })
    expect(duplicated[0]?.prompt_template.inline).not.toContain("Block-specific instruction")
    expect(duplicated[0]?.prompt_template.input).not.toHaveProperty("instruction")

    const whitespaceEquivalent = DagBlocks.compileWorkflowBlocks({
      objective: "Ship the memory feature",
      blocks: [{ id: "map", kind: "explore", instruction: "  Ship the memory feature\r\n" }],
    })
    expect(whitespaceEquivalent[0]?.prompt_template.inline).not.toContain("Block-specific instruction")
    expect(whitespaceEquivalent[0]?.prompt_template.input).not.toHaveProperty("instruction")
  })

  // Equivalence is exact, not fuzzy: block-specific instructions survive —
  // both a fully distinct one and one that carries the objective plus
  // additional detail — ordered after the objective.
  it("keeps block-specific instructions that extend the objective (issue #387)", () => {
    const distinct = DagBlocks.compileWorkflowBlocks({
      objective: "Ship the memory feature",
      blocks: [{ id: "map", kind: "explore", instruction: "Focus on the persistence seam" }],
    })
    const distinctInline = distinct[0]?.prompt_template.inline ?? ""
    expect(distinctInline).toContain("Block-specific instruction:\n{{instruction}}")
    expect(distinct[0]?.prompt_template.input).toMatchObject({ instruction: "Focus on the persistence seam" })

    const extended = DagBlocks.compileWorkflowBlocks({
      objective: "Ship the memory feature",
      blocks: [{ id: "map", kind: "explore", instruction: "Ship the memory feature, then profile the persistence seam" }],
    })
    const extendedInline = extended[0]?.prompt_template.inline ?? ""
    expect(extendedInline).toContain("Block-specific instruction:\n{{instruction}}")
    expect(extended[0]?.prompt_template.input).toMatchObject({
      instruction: "Ship the memory feature, then profile the persistence seam",
    })
    expect(extendedInline.indexOf("Workflow objective")).toBeLessThan(extendedInline.indexOf("Block-specific instruction"))
  })
})
