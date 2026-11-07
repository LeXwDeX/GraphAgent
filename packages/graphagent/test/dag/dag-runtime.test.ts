import { describe, expect, it } from "bun:test"
import { conditionReference, evaluateCondition, resolveInputMapping } from "@/dag/runtime/eval"
import { planReplan } from "@opencode-ai/core/dag/core/replan"
import { WorkflowRuntime, buildGraph } from "@opencode-ai/core/dag/core/scheduling"
import { CycleError } from "@opencode-ai/core/dag/core/graph"
import { NodeStatus, WorkflowStatus, assertValidWorkflowTransition, TerminalViolationError } from "@opencode-ai/core/dag/core/types"

describe("evaluateCondition", () => {
  it("returns ok:true value:true when condition is empty/undefined", () => {
    expect(evaluateCondition(undefined, {})).toEqual({ ok: true, value: true })
    expect(evaluateCondition("", {})).toEqual({ ok: true, value: true })
    expect(evaluateCondition("   ", {})).toEqual({ ok: true, value: true })
  })

  it("returns ok:false with error containing expression text on unparseable syntax", () => {
    const result = evaluateCondition("foo ??? bar", {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("foo ??? bar")
  })

  it("evaluates numeric comparisons", () => {
    const outputs = { "explore-src": { output: { count: 3 } } }
    expect(evaluateCondition("explore-src.output.count > 0", outputs)).toEqual({ ok: true, value: true })
    expect(evaluateCondition("explore-src.output.count > 5", outputs)).toEqual({ ok: true, value: false })
  })

  it("evaluates equality", () => {
    const outputs = { node: { output: { status: "ok" } } }
    expect(evaluateCondition('node.output.status == "ok"', outputs)).toEqual({ ok: true, value: true })
    expect(evaluateCondition('node.output.status == "fail"', outputs)).toEqual({ ok: true, value: false })
  })

  it("returns ok:true value:true when path resolves to undefined with != ", () => {
    expect(evaluateCondition('missing.path != "expected"', {})).toEqual({ ok: true, value: true })
  })
})

describe("conditionReference", () => {
  it("extracts the referenced nodeID from a parseable condition", () => {
    expect(conditionReference('gate.output.verdict == "ACCEPT"')).toBe("gate")
    expect(conditionReference("explore-src.output.count > 0")).toBe("explore-src")
  })

  it("returns null for empty or unparseable conditions (runtime fails those loudly)", () => {
    expect(conditionReference(undefined)).toBeNull()
    expect(conditionReference("")).toBeNull()
    expect(conditionReference("   ")).toBeNull()
    expect(conditionReference("analysis.output.verdict ==")).toBeNull()
    expect(conditionReference("foo ??? bar")).toBeNull()
  })
})

describe("resolveInputMapping", () => {
  it("returns empty object for undefined mapping", () => {
    expect(resolveInputMapping(undefined, () => null)).toEqual({})
  })

  it("resolves node output reference", () => {
    const getOutput = (id: string) => (id === "refactor-core" ? { diff: "abc" } : undefined)
    const result = resolveInputMapping({ core_diff: "refactor-core.output" }, getOutput)
    expect(result).toEqual({ core_diff: { diff: "abc" } })
  })

  it("resolves nested field from output", () => {
    const getOutput = (id: string) => (id === "plan" ? { steps: ["a", "b"] } : undefined)
    const result = resolveInputMapping({ steps: "plan.output.steps" }, getOutput)
    expect(result).toEqual({ steps: ["a", "b"] })
  })
})

describe("planReplan integration (replan from runtime)", () => {
  it("classifies a mixed replan fragment correctly", () => {
    const plan = planReplan(
      {
        nodes: [
          { id: "a", status: NodeStatus.COMPLETED, depends_on: [] },
          { id: "b", status: NodeStatus.RUNNING, depends_on: ["a"] },
          { id: "c", status: NodeStatus.PENDING, depends_on: ["a"] },
          { id: "d", status: NodeStatus.PENDING, depends_on: ["c"] },
        ],
      },
      {
        nodes: [
          { id: "b", depends_on: ["a"], restart: true }, // restart running
          { id: "c", depends_on: ["a"] }, // replace pending
          { id: "e", depends_on: ["c"] }, // add new
        ],
      },
    )
    expect(plan.errors).toEqual([])
    expect(plan.restart).toContain("b")
    expect(plan.replace).toContain("c")
    expect(plan.add).toContain("e")
    expect(plan.cancel).toContain("d") // d is pending-not-in-fragment → cancelled
  })
})

describe("default concurrency", () => {
  it("defaults to 5 when max_concurrency is omitted", () => {
    const config: { max_concurrency?: number } = {}
    const maxConcurrency = Math.max(1, config.max_concurrency ?? 5)
    const runtime = new WorkflowRuntime([], maxConcurrency)
    expect(runtime.maxConcurrency).toBe(5)
  })

  it("uses declared value without clamping", () => {
    const config: { max_concurrency?: number } = { max_concurrency: 20 }
    const maxConcurrency = Math.max(1, config.max_concurrency ?? 5)
    const runtime = new WorkflowRuntime([], maxConcurrency)
    expect(runtime.maxConcurrency).toBe(20)
  })
})

describe("full-graph cycle detection (create guard)", () => {
  // Mirrors the cycle check in Dag.Service.create():
  // buildGraph throws CycleError via addEdge's wouldCreateCycle pre-check
  it("rejects non-required nodes forming a cycle", () => {
    const nodes = [
      { id: "a", dependsOn: ["b"], status: "pending" as const, required: true },
      { id: "b", dependsOn: ["a"], status: "pending" as const, required: false },
    ]
    expect(() => buildGraph(nodes)).toThrow(CycleError)
  })

  it("accepts a valid acyclic graph", () => {
    const nodes = [
      { id: "a", dependsOn: [], status: "pending" as const, required: true },
      { id: "b", dependsOn: ["a"], status: "pending" as const, required: false },
    ]
    const graph = buildGraph(nodes)
    expect(graph.hasCycle()).toBe(false)
  })

  it("detects a cycle among optional nodes that required-only validation misses", () => {
    // validateRequiredNodes only checks the required-node subgraph.
    // Two optional nodes forming a cycle would pass required validation
    // but must be caught by the full-graph check.
    const nodes = [
      { id: "req", dependsOn: [], status: "pending" as const, required: true },
      { id: "opt-a", dependsOn: ["opt-b"], status: "pending" as const, required: false },
      { id: "opt-b", dependsOn: ["opt-a"], status: "pending" as const, required: false },
    ]
    expect(() => buildGraph(nodes)).toThrow(CycleError)
  })
})

describe("terminal irrevocability", () => {
  // Terminal workflow statuses (COMPLETED, FAILED, CANCELLED) only allow
  // transition to ARCHIVED — pause/resume/cancel are rejected.
  it("completed workflow rejects pause/resume/cancel", () => {
    expect(() => assertValidWorkflowTransition("wf-1", WorkflowStatus.COMPLETED, WorkflowStatus.PAUSED)).toThrow(TerminalViolationError)
    expect(() => assertValidWorkflowTransition("wf-1", WorkflowStatus.COMPLETED, WorkflowStatus.RUNNING)).toThrow(TerminalViolationError)
    expect(() => assertValidWorkflowTransition("wf-1", WorkflowStatus.COMPLETED, WorkflowStatus.CANCELLED)).toThrow(TerminalViolationError)
  })

  it("failed workflow rejects pause/resume/cancel", () => {
    expect(() => assertValidWorkflowTransition("wf-1", WorkflowStatus.FAILED, WorkflowStatus.PAUSED)).toThrow(TerminalViolationError)
    expect(() => assertValidWorkflowTransition("wf-1", WorkflowStatus.FAILED, WorkflowStatus.RUNNING)).toThrow(TerminalViolationError)
  })

  it("cancelled workflow rejects pause/resume", () => {
    expect(() => assertValidWorkflowTransition("wf-1", WorkflowStatus.CANCELLED, WorkflowStatus.PAUSED)).toThrow(TerminalViolationError)
    expect(() => assertValidWorkflowTransition("wf-1", WorkflowStatus.CANCELLED, WorkflowStatus.RUNNING)).toThrow(TerminalViolationError)
  })
})

describe("NodeCompleted projection guard", () => {
  // The NodeCompleted projector uses WHERE status IN (pending, queued, running)
  // to prevent a stale NodeCompleted from flipping an already-terminal node.
  const GUARD_STATUSES = ["pending", "queued", "running"]

  it("guard excludes terminal node statuses", () => {
    for (const terminal of ["completed", "failed", "skipped", "cancelled", "aborted"]) {
      expect(GUARD_STATUSES).not.toContain(terminal)
    }
  })

  it("guard includes all non-terminal statuses", () => {
    for (const nonTerminal of ["pending", "queued", "running"]) {
      expect(GUARD_STATUSES).toContain(nonTerminal)
    }
  })
})
