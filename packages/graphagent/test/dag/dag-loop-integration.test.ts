import { describe, expect, it } from "bun:test"
import {
  type SchedulingNode,
  WorkflowRuntime,
} from "@opencode-ai/core/dag/core/scheduling"

function makeNodes(ids: string[], deps: Record<string, string[]> = {}, required: Set<string> = new Set()): SchedulingNode[] {
  return ids.map((id) => ({
    id,
    dependsOn: deps[id] ?? [],
    status: "pending" as const,
    required: required.has(id),
  }))
}

describe("E2E: linear pipeline (A → B → C)", () => {
  it("all nodes complete, workflow reaches COMPLETED", () => {
    const nodes = makeNodes(["a", "b", "c"], { b: ["a"], c: ["b"] })
    const rt = new WorkflowRuntime(nodes, 4)

    expect(rt.isComplete()).toBe(false)
    expect(rt.getReadyNodes()).toEqual(["a"])

    rt.markRunning("a")
    expect(rt.getReadyNodes()).toEqual([])

    rt.markSatisfied("a")
    expect(rt.getReadyNodes()).toEqual(["b"])

    rt.markRunning("b")
    rt.markSatisfied("b")
    expect(rt.getReadyNodes()).toEqual(["c"])

    rt.markRunning("c")
    rt.markSatisfied("c")

    expect(rt.isComplete()).toBe(true)
    expect(rt.hasRequiredFailure()).toBe(false)
  })
})

describe("E2E: required node fails", () => {
  it("cascade-fail marks dependents unsatisfied — workflow reaches CANCELLED", () => {
    const nodes = makeNodes(["a", "b"], { b: ["a"] }, new Set(["a"]))
    const rt = new WorkflowRuntime(nodes, 4)

    rt.markRunning("a")
    rt.markUnsatisfied("a")

    expect(rt.getReadyNodes()).toEqual([])
    expect(rt.isComplete()).toBe(true)
    expect(rt.hasRequiredFailure()).toBe(true)
  })

  it("cascade-fail propagates transitively through a chain", () => {
    const nodes = makeNodes(["a", "b", "c"], { b: ["a"], c: ["b"] }, new Set(["a"]))
    const rt = new WorkflowRuntime(nodes, 4)

    rt.markUnsatisfied("a")

    expect(rt.isComplete()).toBe(true)
    expect(rt.hasRequiredFailure()).toBe(true)
  })

  it("workflow completes when non-required node fails", () => {
    const nodes = makeNodes(["a", "b"], { b: ["a"] }, new Set())
    const rt = new WorkflowRuntime(nodes, 4)

    rt.markSatisfied("a")
    rt.markUnsatisfied("b")

    expect(rt.isComplete()).toBe(true)
    expect(rt.hasRequiredFailure()).toBe(false)
  })
})

describe("E2E: pause/resume", () => {
  it("spawning halts on pause, resumes on resume", () => {
    const nodes = makeNodes(["a", "b"], { b: ["a"] })
    const rt = new WorkflowRuntime(nodes, 4)

    expect(rt.getReadyNodes()).toEqual(["a"])

    rt.setPaused(true)
    expect(rt.getReadyNodes()).toEqual([])

    rt.setPaused(false)
    expect(rt.getReadyNodes()).toEqual(["a"])
  })

  it("pause after partial completion preserves state", () => {
    const nodes = makeNodes(["a", "b", "c"], { b: ["a"], c: ["b"] })
    const rt = new WorkflowRuntime(nodes, 4)

    rt.markSatisfied("a")
    expect(rt.getReadyNodes()).toEqual(["b"])

    rt.setPaused(true)
    expect(rt.getReadyNodes()).toEqual([])

    rt.setPaused(false)
    expect(rt.getReadyNodes()).toEqual(["b"])
  })
})

describe("E2E: replan scenario", () => {
  it("rebuildGraph reflects new topology after replan", () => {
    const nodes = makeNodes(["a", "b"], { b: ["a"] })
    const rt = new WorkflowRuntime(nodes, 4)

    rt.markSatisfied("a")
    expect(rt.getReadyNodes()).toEqual(["b"])

    const newNodes: SchedulingNode[] = [
      { id: "x", dependsOn: [], status: "pending", required: false },
      { id: "y", dependsOn: ["x"], status: "pending", required: false },
      { id: "z", dependsOn: ["x", "y"], status: "pending", required: false },
    ]
    rt.rebuildGraph(newNodes)

    expect(rt.isComplete()).toBe(false)
    expect(rt.getReadyNodes()).toEqual(["x"])

    rt.markSatisfied("x")
    expect(rt.getReadyNodes()).toEqual(["y"])

    rt.markSatisfied("y")
    expect(rt.getReadyNodes()).toEqual(["z"])
  })
})

describe("E2E: diamond dependency (A → {B,C} → D)", () => {
  it("parallel branches converge correctly", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "pending", required: false },
      { id: "b", dependsOn: ["a"], status: "pending", required: false },
      { id: "c", dependsOn: ["a"], status: "pending", required: false },
      { id: "d", dependsOn: ["b", "c"], status: "pending", required: false },
    ]
    const rt = new WorkflowRuntime(nodes, 4)

    expect(rt.getReadyNodes()).toEqual(["a"])

    rt.markSatisfied("a")
    expect(rt.getReadyNodes().sort()).toEqual(["b", "c"])

    rt.markSatisfied("b")
    expect(rt.getReadyNodes()).toEqual(["c"])

    rt.markSatisfied("c")
    expect(rt.getReadyNodes()).toEqual(["d"])

    rt.markSatisfied("d")
    expect(rt.isComplete()).toBe(true)
  })
})

describe("hasRunningMatching (safety-net gate)", () => {
  it("returns false when no running node has current-process fiber ownership", () => {
    const nodes = makeNodes(["a"])
    const rt = new WorkflowRuntime(nodes, 4)
    rt.markRunning("a")
    const fibers = new Map<string, unknown>()
    expect(rt.hasRunningMatching((id) => fibers.has(id))).toBe(false)
  })

  it("returns true when at least one running node has a fiber", () => {
    const nodes = makeNodes(["a", "b"])
    const rt = new WorkflowRuntime(nodes, 4)
    rt.markRunning("a")
    rt.markRunning("b")
    const fibers = new Map<string, unknown>([["a", {}]])
    expect(rt.hasRunningMatching((id) => fibers.has(id))).toBe(true)
  })

  it("returns false when there are no running nodes at all", () => {
    const nodes = makeNodes(["a"])
    const rt = new WorkflowRuntime(nodes, 4)
    const fibers = new Map<string, unknown>([["a", {}]])
    expect(rt.hasRunningMatching((id) => fibers.has(id))).toBe(false)
  })
})
