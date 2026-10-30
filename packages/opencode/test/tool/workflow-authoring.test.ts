import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { CommandPlugin } from "@opencode-ai/core/plugin/command"
import { Parameters } from "../../src/tool/workflow"
import { DagBlocks } from "../../src/dag/blocks"

// Regression fixtures for change repair-workflow-authoring-validation.
//
// The worktree-lifecycle task had already produced a complete decision brief
// and correctly selected `plan → coding(2 packages) → verify → review` with
// an explicit explore skip. The route choice was right; every start call then
// failed at the tool boundary:
//
//   1. start carrying an empty workflow_id (Dag.ID entry validation),
//   2. start carrying other actions' fields (operation=complete, node_id,
//      limit),
//   3. start whose inline spec stayed `{}` because the provider-facing
//      schema declared no spec structure.
//
// These fixtures pin the decision brief's route and the two polluted call
// shapes so the discriminated-union schema is measured against them.

const WORKTREE_LIFECYCLE_BRIEF = {
  objective:
    "Repair worktree lifecycle handling: fix bootstrap cleanup races and cover both tiers with regression tests",
  route: ["plan", "coding(worktree-core)", "coding(callers-and-fixture)", "verify", "review"],
  skips: [
    "explore — the confirmed brief already supplies file references, failure mechanism, package split, risks, and acceptance checks",
  ],
  packages: {
    "worktree-core": "worktree bootstrap/cleanup ownership in the core lifecycle",
    "callers-and-fixture": "call-site updates plus the isolated memory fixture in cli tests",
  },
} as const

const block = (input: {
  id: string
  kind: (typeof DagBlocks.WORKFLOW_BLOCK_KINDS)[number]
  depends_on?: string[]
  instruction?: string
}) => new DagBlocks.WorkflowBlock(input)

// The accepted start fixture: only start-owned fields, complete config.blocks.
const worktreeLifecycleStartInput = {
  action: "start",
  spec: {
    title: "Worktree lifecycle repair",
    config: {
      name: "worktree-lifecycle-repair",
      objective: WORKTREE_LIFECYCLE_BRIEF.objective,
      blocks: [
        block({
          id: "plan",
          kind: "plan",
          instruction: "Use the confirmed brief; do not repeat discovery.",
        }),
        block({
          id: "coding-worktree-core",
          kind: "coding",
          depends_on: ["plan"],
          instruction: WORKTREE_LIFECYCLE_BRIEF.packages["worktree-core"],
        }),
        block({
          id: "coding-callers-and-fixture",
          kind: "coding",
          depends_on: ["plan"],
          instruction: WORKTREE_LIFECYCLE_BRIEF.packages["callers-and-fixture"],
        }),
        block({
          id: "verify",
          kind: "verify",
          depends_on: ["coding-worktree-core", "coding-callers-and-fixture"],
          instruction: "Run the two packages' acceptance commands and record evidence",
        }),
        block({
          id: "review",
          kind: "review",
          depends_on: ["verify"],
        }),
      ],
    },
  },
} as const

const worktreeLifecyclePathInput = {
  params: {
    action: "start",
    spec_path: ".opencode/workflows/worktree-lifecycle-repair.yaml",
  },
} as const

// The previously observed polluted calls: a start that carries another
// action's identifiers and control fields. The empty-workflow_id shape
// already fails the Dag.ID brand today; the plausible-id shape passes the
// flat schema and must be rejected once fields become action-owned.
const pollutedStartWithForeignFields = {
  action: "start",
  workflow_id: "dag_2x9k4m",
  operation: "complete",
  node_id: "verify",
  cursor: "",
  limit: 8000,
  spec: worktreeLifecycleStartInput.spec,
}

const pollutedStartWithEmptySpec = {
  action: "start",
  spec: {},
}

// The tool admits parameters with strict parsing (foreign fields are an
// error, not a silent drop), so the fixtures decode the same way.
const decode = (input: unknown) =>
  Result.isSuccess(Schema.decodeUnknownResult(Parameters, { onExcessProperty: "error" })(input))

describe("worktree-lifecycle regression fixtures", () => {
  test("model-facing graph actions require a YAML source path", () => {
    const spec = worktreeLifecycleStartInput.spec

    expect(decode({ params: { action: "start", spec_path: "workflow.yaml" } })).toBe(true)
    expect(decode({ params: { action: "start", spec } })).toBe(false)
    expect(decode({ params: { action: "extend", workflow_id: "dag_2x9k4m", spec_path: "extend.yaml" } })).toBe(true)
    expect(decode({ params: { action: "extend", workflow_id: "dag_2x9k4m", spec } })).toBe(false)
    expect(
      decode({
        params: { action: "control", operation: "replan", workflow_id: "dag_2x9k4m", spec_path: "replan.yaml" },
      }),
    ).toBe(true)
    expect(decode({ params: { action: "control", operation: "replan", workflow_id: "dag_2x9k4m", spec } })).toBe(false)
    expect(decode({ params: { action: "validate", spec_path: "workflow.yaml", profile: "environment" } })).toBe(true)
    expect(decode({ params: { action: "validate", spec, profile: "environment" } })).toBe(false)
  })

  test("decision brief route compiles under the block compiler", () => {
    const nodes = DagBlocks.compileWorkflowBlocks({
      objective: WORKTREE_LIFECYCLE_BRIEF.objective,
      blocks: [...worktreeLifecycleStartInput.spec.config.blocks],
    })
    const byID = new Map(nodes.map((node) => [node.id, node]))
    // Parallel writers: both coding blocks only declared the plan dependency,
    // and compilation keeps them unordered — no injected writer-to-writer edge.
    expect(byID.get("coding-callers-and-fixture")?.depends_on).toEqual(["plan"])
    expect(byID.get("coding-worktree-core")?.depends_on).toEqual(["plan"])
    // The compiler injects one aggregation node between the parallel writers
    // and the verification gate; verify is rewired onto it.
    expect(byID.get("verify")?.depends_on).toEqual(["review--aggregate"])
    expect(byID.get("review--aggregate")).toMatchObject({
      worker_type: "explore",
      required: true,
      depends_on: ["coding-worktree-core", "coding-callers-and-fixture"],
    })
    expect(byID.get("review--aggregate")?.output_schema).toEqual(
      expect.objectContaining({ required: expect.arrayContaining(["changed_files", "fingerprint"]) }),
    )
    const reviewDecision = byID.get("review")
    expect(reviewDecision?.review?.phase).toBe("diff")
    // The diff review binds to the aggregator's post-merge fingerprint.
    expect(reviewDecision?.review?.implementation_node_id).toBe("review--aggregate")
    expect(reviewDecision?.review?.verification_node_id).toBe("verify")
    expect(reviewDecision?.input_mapping?.["implementation_fingerprint"]).toBe("review--aggregate.output.fingerprint")
  })

  test("accepted start carries only its YAML path while the authored fixture keeps complete blocks", () => {
    expect(Object.keys(worktreeLifecyclePathInput.params)).toEqual(["action", "spec_path"])
    expect(worktreeLifecycleStartInput.spec.config.blocks.length).toBe(5)
    expect(decode(worktreeLifecyclePathInput)).toBe(true)
  })

  test("replay: the complete audit adds no explore block and strict decode keeps a file-backed start", () => {
    // The confirmed brief already supplies repository evidence, so the route
    // starts at plan — no explore lane is added back.
    const blockIDs = worktreeLifecycleStartInput.spec.config.blocks.map((block) => block.id)
    expect(blockIDs.some((id) => id.includes("explore"))).toBe(false)
    expect(blockIDs).toEqual(["plan", "coding-worktree-core", "coding-callers-and-fixture", "verify", "review"])
    // Strict decoding admits exactly the start-owned fields.
    const decoded = Schema.decodeUnknownSync(Parameters, { onExcessProperty: "error" })(worktreeLifecyclePathInput)
    expect(decoded.params.action).toBe("start")
    expect("spec_path" in decoded.params).toBe(true)
    expect("spec" in decoded.params).toBe(false)
    expect("workflow_id" in decoded.params).toBe(false)
    expect("operation" in decoded.params).toBe(false)
    expect("node_id" in decoded.params).toBe(false)
  })

  test("start polluted with empty workflow/control/result fields is rejected", () => {
    expect(decode(pollutedStartWithForeignFields)).toBe(false)
  })

  test("start with an empty inline spec is rejected", () => {
    expect(decode(pollutedStartWithEmptySpec)).toBe(false)
  })

  test("start without any graph source is rejected", () => {
    expect(decode({ params: { action: "start" } })).toBe(false)
  })

  test("validate rejects control and result fields it does not own", () => {
    const spec_path = "workflow.yaml"
    expect(decode({ params: { action: "validate", spec_path, workflow_id: "dag_2x9k4m" } })).toBe(false)
    expect(decode({ params: { action: "validate", spec_path, node_id: "verify" } })).toBe(false)
    expect(decode({ params: { action: "validate", spec_path, operation: "cancel" } })).toBe(false)
    expect(decode({ params: { action: "validate", spec_path, cursor: "", limit: 500 } })).toBe(false)
    // The validate action itself stays clean with its file source.
    expect(decode({ params: { action: "validate", spec_path, profile: "portable" } })).toBe(true)
    expect(decode({ params: { action: "validate", spec_path: "saved-route", profile: "environment" } })).toBe(true)
  })

  test("model-facing start rejects inline admission objects entirely", () => {
    const brief = {
      goal: "Ship the change",
      scope: { in: ["dag"], out: [] },
      constraints: [],
      assumptions: [],
      acceptance_criteria: [],
      evidence_required: [],
      risks: ["unresolved rollout"],
      review_plan: [],
      open_questions: [],
      blocking_questions: [],
    }
    const cleanAdmission = {
      brief_revision: 1,
      qa_mode: "STANDARD",
      verdict: "WAIVED",
      brief,
      waiver_reason: "Preview release only",
      acknowledged_risks: ["unresolved rollout"],
    }
    const spec = { ...worktreeLifecycleStartInput.spec, mode: "deep", admission: cleanAdmission }
    expect(decode({ params: { action: "start", spec } })).toBe(false)
    for (const field of ["protocol_version", "state", "fingerprint"]) {
      expect(
        decode({ params: { action: "start", spec: { ...spec, admission: { ...cleanAdmission, [field]: "x" } } } }),
      ).toBe(false)
    }
  })
})

// Issue #775: draft is a start-only authoring path, and the model-facing
// guidance must not drift from the action-specific envelopes the authoring
// layer decodes (start=config, extend=top-level objective+blocks or nodes,
// replan=fragment).
describe("workflow tool authoring guidance (#775)", () => {
  const draft = (config: unknown) => ({ params: { action: "draft", config } })

  test("draft accepts both graph shapes through the start config envelope", () => {
    const blocksConfig = {
      name: "draft-blocks",
      objective: "Draft the block route.",
      blocks: [block({ id: "a", kind: "coding" })],
    }
    const nodesConfig = {
      name: "draft-nodes",
      nodes: [{ id: "a", name: "a", worker_type: "general", depends_on: [], prompt_template: { inline: "Do it" } }],
    }
    expect(decode(draft(blocksConfig))).toBe(true)
    expect(decode(draft(nodesConfig))).toBe(true)
    // A top-level objective is not a draft field — the config envelope is the
    // only graph carrier at this boundary.
    expect(decode({ params: { action: "draft", objective: "top level" } })).toBe(false)
  })

  test("the entry description points at guides that state the start-only draft contract and exact envelopes", () => {
    const routing = CommandPlugin.WorkflowContent
    expect(routing).toContain('workflow(action="draft")')
    expect(routing).toContain('guide(topic="blocks")')

    const interfaceGuide = CommandPlugin.WorkflowFactsContent
    expect(interfaceGuide).toContain("The draft is a start document only")
    expect(interfaceGuide).toContain("either `{ objective, blocks: [...] }` (block route)")
    expect(interfaceGuide).toContain("or `{ nodes: [...] }` (low-level route)")
    expect(interfaceGuide).toContain("`fragment`")

    const blocksGuide = CommandPlugin.WorkflowBlocksContent
    // The extended start-envelope statement stays intact for the drift hints.
    expect(blocksGuide).toContain("`objective` lives INSIDE `config`")
    expect(blocksGuide).toContain("or `nodes` for the low-level route")
    expect(blocksGuide).toContain("graph budgets")
    expect(blocksGuide).toContain("never both")
  })
})
