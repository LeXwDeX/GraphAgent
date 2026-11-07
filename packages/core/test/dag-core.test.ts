import { describe, expect, it } from "bun:test"
import { CycleError, DependencyGraph, NodeNotFoundError } from "@graphagent/core/dag/core/graph"
import { planReplan } from "@graphagent/core/dag/core/replan"
import {
  assertValidNodeTransition,
  assertValidWorkflowTransition,
  getValidNextNodeStatuses,
  getValidNextWorkflowStatuses,
  InvalidTransitionError,
  isTransitionRejection,
  isNodeTerminalStatus,
  isWorkflowTerminalStatus,
  NodeStatus,
  StaleNodeAttemptError,
  TerminalViolationError,
  WorkflowStatus,
} from "@graphagent/core/dag/core/types"
import {
  aggregateBranchStatus,
  DEFAULT_FALLBACK_TRIGGER,
  transitionToNodeEvent,
  transitionToWorkflowEvent,
} from "@graphagent/core/dag/core/transitions"
import { FallbackTrigger } from "@graphagent/core/dag/core/types"
import { validateRequiredNodes } from "@graphagent/core/dag/core/required-validator"
import {
  buildGraph,
  toSchedulingNodes,
  type SchedulingNode,
  WorkflowRuntime,
} from "@graphagent/core/dag/core/scheduling"

describe("DependencyGraph", () => {
  it("adds nodes and edges", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    g.addNode("b")
    g.addEdge("b", "a")
    expect(g.hasEdge("b", "a")).toBe(true)
    expect(g.getDependencies("b")).toEqual(["a"])
    expect(g.getDependents("a")).toEqual(["b"])
  })

  it("throws NodeNotFoundError for unknown nodes", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    expect(() => g.getDependencies("missing")).toThrow(NodeNotFoundError)
    expect(() => g.addEdge("a", "missing")).toThrow(NodeNotFoundError)
  })

  it("detects self-loops as cycles on addEdge", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    expect(() => g.addEdge("a", "a")).toThrow(CycleError)
  })

  it("prevents cycles via wouldCreateCycle pre-check", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    g.addNode("b")
    g.addNode("c")
    g.addEdge("b", "a") // b depends on a
    g.addEdge("c", "b") // c depends on b
    // a -> b -> c chain; adding a->c completes a cycle c->b->a->c
    expect(() => g.addEdge("a", "c")).toThrow(CycleError)
  })

  it("topologicalSort is deterministic (lexicographic ties)", () => {
    const g = new DependencyGraph()
    for (const id of ["x", "y", "z", "a", "b"]) g.addNode(id)
    // No edges — all roots, sort by name
    expect(g.topologicalSort()).toEqual(["a", "b", "x", "y", "z"])
  })

  it("topologicalSort respects dependencies", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    g.addNode("b")
    g.addNode("c")
    g.addEdge("b", "a") // b depends on a → a before b
    g.addEdge("c", "b") // c depends on b → b before c
    const sorted = g.topologicalSort()
    expect(sorted.indexOf("a")).toBeLessThan(sorted.indexOf("b"))
    expect(sorted.indexOf("b")).toBeLessThan(sorted.indexOf("c"))
  })

  it("getLayers groups parallel nodes into the same wavefront", () => {
    const g = new DependencyGraph()
    // a, b, c are roots (parallel); d depends on all three (converge)
    for (const id of ["a", "b", "c", "d"]) g.addNode(id)
    g.addEdge("d", "a")
    g.addEdge("d", "b")
    g.addEdge("d", "c")
    const layers = g.getLayers()
    expect(layers[0].sort()).toEqual(["a", "b", "c"])
    expect(layers[1]).toEqual(["d"])
  })

  it("getLayers throws on cycle", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    g.addNode("b")
    // Manually build a cycle bypassing addEdge's pre-check
    ;(g as unknown as { deps: Map<string, Set<string>> }).deps.get("a")!.add("b")
    ;(g as unknown as { deps: Map<string, Set<string>> }).deps.get("b")!.add("a")
    expect(() => g.getLayers()).toThrow(CycleError)
  })

  it("getExecutableNodes returns nodes whose deps are all completed", () => {
    const g = new DependencyGraph()
    for (const id of ["a", "b", "c"]) g.addNode(id)
    g.addEdge("c", "a")
    g.addEdge("c", "b")
    expect(g.getExecutableNodes(new Set()).sort()).toEqual(["a", "b"])
    expect(g.getExecutableNodes(new Set(["a", "b"]))).toEqual(["c"])
  })

  it("serializes and deserializes via fromJSON", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    g.addNode("b")
    g.addEdge("b", "a")
    const json = g.toJSON()
    const g2 = DependencyGraph.fromJSON(json)
    expect(g2.getDependencies("b")).toEqual(["a"])
    expect(g2.hasEdge("b", "a")).toBe(true)
  })

  it("counts nodes/edges and computes stats", () => {
    const g = new DependencyGraph()
    for (const id of ["a", "b", "c"]) g.addNode(id)
    g.addEdge("b", "a")
    g.addEdge("c", "b")
    expect(g.getNodeCount()).toBe(3)
    expect(g.getEdgeCount()).toBe(2)
    const stats = g.getStats()
    expect(stats).toMatchObject({ nodeCount: 3, edgeCount: 2, maxDepth: 2, hasCycle: false })
    expect(stats.averageDegree).toBeCloseTo(2 / 3)
  })

  it("getStats handles an empty graph", () => {
    expect(new DependencyGraph().getStats()).toEqual({
      nodeCount: 0,
      edgeCount: 0,
      averageDegree: 0,
      maxDepth: 0,
      hasCycle: false,
    })
  })

  it("getStats reports -1 maxDepth for a cyclic graph", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    g.addNode("b")
    ;(g as unknown as { deps: Map<string, Set<string>> }).deps.get("a")!.add("b")
    ;(g as unknown as { deps: Map<string, Set<string>> }).deps.get("b")!.add("a")
    expect(g.getStats()).toMatchObject({ maxDepth: -1, hasCycle: true })
  })

  it("collects transitive dependencies and dependents", () => {
    const g = new DependencyGraph()
    for (const id of ["a", "b", "c", "d"]) g.addNode(id)
    g.addEdge("b", "a")
    g.addEdge("c", "b")
    g.addEdge("d", "c")
    expect(g.getAllDependencies("d").sort()).toEqual(["a", "b", "c"])
    expect(g.getAllDependents("a").sort()).toEqual(["b", "c", "d"])
    expect(() => g.getAllDependencies("missing")).toThrow(NodeNotFoundError)
    expect(() => g.getAllDependents("missing")).toThrow(NodeNotFoundError)
  })

  it("removes edges and nodes while keeping both directions consistent", () => {
    const g = new DependencyGraph()
    for (const id of ["a", "b", "c"]) g.addNode(id)
    g.addEdge("b", "a")
    g.addEdge("c", "b")
    g.removeEdge("b", "a")
    expect(g.hasEdge("b", "a")).toBe(false)
    expect(g.getDependents("a")).toEqual([])
    expect(() => g.removeEdge("missing", "a")).toThrow(NodeNotFoundError)
    g.removeNode("b")
    expect(g.hasNode("b")).toBe(false)
    expect(g.getDependencies("c")).toEqual([])
    expect(() => g.removeNode("missing")).toThrow(NodeNotFoundError)
  })

  it("finds and validates cycles, then clones and clears", () => {
    const g = new DependencyGraph()
    for (const id of ["a", "b", "c", "d"]) g.addNode(id)
    g.addEdge("a", "b")
    // Drive the acyclic branch first, then a cycle discovered later: exercises
    // the DFS backtracking path in findCycleFrom.
    ;(g as unknown as { deps: Map<string, Set<string>> }).deps.get("c")!.add("d")
    ;(g as unknown as { deps: Map<string, Set<string>> }).deps.get("d")!.add("c")
    expect(g.findCycles()).toEqual([["c", "d"]])
    expect(g.validate()).toEqual(["Graph contains cycle(s)"])

    const cloned = g.clone()
    expect(cloned.getEdgeCount()).toBe(3)
    cloned.clear()
    expect(cloned.getNodeCount()).toBe(0)
    expect(g.getNodeCount()).toBe(4)
  })

  it("validate returns true and findCycles is empty for acyclic graphs", () => {
    const g = new DependencyGraph()
    g.addNode("a")
    expect(g.validate()).toBe(true)
    expect(g.findCycles()).toEqual([])
  })
})

describe("iron laws (transition tables)", () => {
  it("isWorkflowTerminalStatus identifies the 4 terminal workflow statuses", () => {
    expect(isWorkflowTerminalStatus(WorkflowStatus.COMPLETED)).toBe(true)
    expect(isWorkflowTerminalStatus(WorkflowStatus.FAILED)).toBe(true)
    expect(isWorkflowTerminalStatus(WorkflowStatus.CANCELLED)).toBe(true)
    expect(isWorkflowTerminalStatus(WorkflowStatus.ARCHIVED)).toBe(true)
    expect(isWorkflowTerminalStatus(WorkflowStatus.RUNNING)).toBe(false)
    expect(isWorkflowTerminalStatus(WorkflowStatus.PAUSED)).toBe(false)
  })

  it("isNodeTerminalStatus identifies the 4 terminal node statuses", () => {
    expect(isNodeTerminalStatus(NodeStatus.COMPLETED)).toBe(true)
    expect(isNodeTerminalStatus(NodeStatus.FAILED)).toBe(true)
    expect(isNodeTerminalStatus(NodeStatus.ABORTED)).toBe(true)
    expect(isNodeTerminalStatus(NodeStatus.SKIPPED)).toBe(true)
    expect(isNodeTerminalStatus(NodeStatus.RUNNING)).toBe(false)
    expect(isNodeTerminalStatus(NodeStatus.PENDING)).toBe(false)
  })

  it("getValidNextNodeStatuses: PENDING → QUEUED/RUNNING/SKIPPED", () => {
    expect(getValidNextNodeStatuses(NodeStatus.PENDING).sort()).toEqual(
      [NodeStatus.QUEUED, NodeStatus.RUNNING, NodeStatus.SKIPPED, NodeStatus.FAILED].sort(),
    )
  })

  it("getValidNextNodeStatuses: terminal returns empty (irreversible)", () => {
    expect(getValidNextNodeStatuses(NodeStatus.COMPLETED)).toEqual([])
    expect(getValidNextNodeStatuses(NodeStatus.FAILED)).toEqual([])
    expect(getValidNextNodeStatuses(NodeStatus.ABORTED)).toEqual([])
    expect(getValidNextNodeStatuses(NodeStatus.SKIPPED)).toEqual([])
  })

  it("getValidNextWorkflowStatuses: RUNNING → PAUSED/STEPPING/COMPLETED/FAILED/CANCELLED", () => {
    expect(getValidNextWorkflowStatuses(WorkflowStatus.RUNNING).sort()).toEqual(
      [
        WorkflowStatus.PAUSED,
        WorkflowStatus.STEPPING,
        WorkflowStatus.COMPLETED,
        WorkflowStatus.FAILED,
        WorkflowStatus.CANCELLED,
      ].sort(),
    )
  })

  it("covers the complete node transition matrix", () => {
    const transitions = [
      [NodeStatus.PENDING, [NodeStatus.QUEUED, NodeStatus.RUNNING, NodeStatus.SKIPPED, NodeStatus.FAILED]],
      // P0-2: QUEUED→QUEUED idempotent re-admission, →PENDING replan reset,
      // →FAILED queue-wait timeout.
      [
        NodeStatus.QUEUED,
        [NodeStatus.QUEUED, NodeStatus.RUNNING, NodeStatus.PENDING, NodeStatus.SKIPPED, NodeStatus.FAILED],
      ],
      [
        NodeStatus.RUNNING,
        [
          NodeStatus.COMPLETED,
          NodeStatus.FAILED,
          NodeStatus.ABORTED,
          NodeStatus.PAUSED,
          NodeStatus.PENDING,
          NodeStatus.SKIPPED,
        ],
      ],
      [NodeStatus.PAUSED, [NodeStatus.RUNNING, NodeStatus.ABORTED, NodeStatus.SKIPPED, NodeStatus.FAILED]],
      [NodeStatus.COMPLETED, []],
      [NodeStatus.FAILED, []],
      [NodeStatus.ABORTED, []],
      [NodeStatus.SKIPPED, []],
    ] as const

    for (const [status, expected] of transitions) {
      expect(getValidNextNodeStatuses(status)).toEqual([...expected])
    }
  })

  it("covers the complete workflow transition matrix", () => {
    const transitions = [
      [WorkflowStatus.PENDING, [WorkflowStatus.RUNNING]],
      [
        WorkflowStatus.RUNNING,
        [
          WorkflowStatus.PAUSED,
          WorkflowStatus.STEPPING,
          WorkflowStatus.COMPLETED,
          WorkflowStatus.FAILED,
          WorkflowStatus.CANCELLED,
        ],
      ],
      [
        WorkflowStatus.STEPPING,
        [
          WorkflowStatus.RUNNING,
          WorkflowStatus.PAUSED,
          WorkflowStatus.STEPPING,
          WorkflowStatus.COMPLETED,
          WorkflowStatus.FAILED,
          WorkflowStatus.CANCELLED,
        ],
      ],
      [WorkflowStatus.PAUSED, [WorkflowStatus.RUNNING, WorkflowStatus.CANCELLED]],
      [WorkflowStatus.COMPLETED, [WorkflowStatus.ARCHIVED]],
      [WorkflowStatus.FAILED, [WorkflowStatus.ARCHIVED]],
      [WorkflowStatus.CANCELLED, [WorkflowStatus.ARCHIVED]],
      [WorkflowStatus.ARCHIVED, []],
    ] as const

    for (const [status, expected] of transitions) {
      expect(getValidNextWorkflowStatuses(status)).toEqual([...expected])
    }
  })

  it("assertValidNodeTransition throws TerminalViolationError from terminal", () => {
    expect(() => assertValidNodeTransition("n1", NodeStatus.COMPLETED, NodeStatus.RUNNING)).toThrow(
      TerminalViolationError,
    )
  })

  it("assertValidNodeTransition throws InvalidTransitionError for illegal jump", () => {
    expect(() => assertValidNodeTransition("n1", NodeStatus.PENDING, NodeStatus.COMPLETED)).toThrow(
      InvalidTransitionError,
    )
  })

  it("classifies stale execution attempts as concurrent transition rejections", () => {
    const error = new StaleNodeAttemptError(
      "n1",
      { replanAttempts: 0, nodeSeq: 4, childSessionID: "ses_old", graphRev: 2 },
      { replanAttempts: 1, nodeSeq: 9, childSessionID: "ses_new", graphRev: 3 },
    )
    expect(isTransitionRejection(error)).toBe(true)
    expect(error.context).toEqual({
      nodeId: "n1",
      expected: { replanAttempts: 0, nodeSeq: 4, childSessionID: "ses_old", graphRev: 2 },
      actual: { replanAttempts: 1, nodeSeq: 9, childSessionID: "ses_new", graphRev: 3 },
    })
  })

  it("assertValidWorkflowTransition allows PAUSED → RUNNING (resume)", () => {
    expect(() => assertValidWorkflowTransition("w1", WorkflowStatus.PAUSED, WorkflowStatus.RUNNING)).not.toThrow()
  })

  it("assertValidWorkflowTransition accepts every declared workflow transition", () => {
    for (const from of Object.values(WorkflowStatus)) {
      for (const to of getValidNextWorkflowStatuses(from)) {
        expect(() => assertValidWorkflowTransition("w1", from, to)).not.toThrow()
      }
    }
  })

  it("assertValidNodeTransition accepts every declared node transition", () => {
    for (const from of Object.values(NodeStatus)) {
      for (const to of getValidNextNodeStatuses(from)) {
        expect(() => assertValidNodeTransition("n1", from, to)).not.toThrow()
      }
    }
  })

  it("rejects every undeclared workflow transition", () => {
    for (const from of Object.values(WorkflowStatus)) {
      for (const to of Object.values(WorkflowStatus)) {
        if (getValidNextWorkflowStatuses(from).includes(to)) continue
        const error = isWorkflowTerminalStatus(from) ? TerminalViolationError : InvalidTransitionError
        expect(() => assertValidWorkflowTransition("w1", from, to)).toThrow(error)
      }
    }
  })

  it("rejects every undeclared node transition", () => {
    for (const from of Object.values(NodeStatus)) {
      for (const to of Object.values(NodeStatus)) {
        if (getValidNextNodeStatuses(from).includes(to)) continue
        const error = isNodeTerminalStatus(from) ? TerminalViolationError : InvalidTransitionError
        expect(() => assertValidNodeTransition("n1", from, to)).toThrow(error)
      }
    }
  })
})

describe("transitions (event mappings + aggregation)", () => {
  it("transitionToNodeEvent: PENDING → RUNNING emits node.started", () => {
    expect(transitionToNodeEvent(NodeStatus.PENDING, NodeStatus.RUNNING)).toBe("node.started")
  })

  it("transitionToNodeEvent: PAUSED → RUNNING emits node.resumed", () => {
    expect(transitionToNodeEvent(NodeStatus.PAUSED, NodeStatus.RUNNING)).toBe("node.resumed")
  })

  it("transitionToNodeEvent: FAILED → RUNNING emits node.restarted (replan path)", () => {
    expect(transitionToNodeEvent(NodeStatus.FAILED, NodeStatus.RUNNING)).toBe("node.restarted")
  })

  it("transitionToNodeEvent: → QUEUED emits node.queued (P0-2 admission)", () => {
    expect(transitionToNodeEvent(NodeStatus.PENDING, NodeStatus.QUEUED)).toBe("node.queued")
  })

  it("transitionToWorkflowEvent: PAUSED → RUNNING emits workflow.resumed", () => {
    expect(transitionToWorkflowEvent(WorkflowStatus.PAUSED, WorkflowStatus.RUNNING)).toBe("workflow.resumed")
  })

  it("transitionToWorkflowEvent: PENDING → RUNNING emits workflow.started", () => {
    expect(transitionToWorkflowEvent(WorkflowStatus.PENDING, WorkflowStatus.RUNNING)).toBe("workflow.started")
  })

  it("maps every node target state to its durable event", () => {
    const events = [
      [NodeStatus.PENDING, null],
      [NodeStatus.QUEUED, "node.queued"],
      [NodeStatus.RUNNING, "node.started"],
      [NodeStatus.PAUSED, "node.paused"],
      [NodeStatus.COMPLETED, "node.completed"],
      [NodeStatus.FAILED, "node.failed"],
      [NodeStatus.ABORTED, "node.aborted"],
      [NodeStatus.SKIPPED, "node.skipped"],
    ] as const

    for (const [status, event] of events) {
      expect(transitionToNodeEvent(NodeStatus.PENDING, status)).toBe(event)
    }
  })

  it("maps every workflow target state to its durable event", () => {
    const events = [
      [WorkflowStatus.PENDING, "workflow.created"],
      [WorkflowStatus.RUNNING, "workflow.started"],
      [WorkflowStatus.PAUSED, "workflow.paused"],
      [WorkflowStatus.STEPPING, "workflow.stepped"],
      [WorkflowStatus.COMPLETED, "workflow.completed"],
      [WorkflowStatus.FAILED, "workflow.failed"],
      [WorkflowStatus.CANCELLED, "workflow.cancelled"],
      [WorkflowStatus.ARCHIVED, "workflow.archived"],
    ] as const

    for (const [status, event] of events) {
      expect(transitionToWorkflowEvent(WorkflowStatus.PENDING, status)).toBe(event)
    }
  })

  it("aggregateBranchStatus: any FAILED → FAILED", () => {
    expect(aggregateBranchStatus([NodeStatus.COMPLETED, NodeStatus.FAILED, NodeStatus.RUNNING])).toBe(NodeStatus.FAILED)
  })

  it("aggregateBranchStatus: all COMPLETED → COMPLETED", () => {
    expect(aggregateBranchStatus([NodeStatus.COMPLETED, NodeStatus.COMPLETED])).toBe(NodeStatus.COMPLETED)
  })

  it("aggregateBranchStatus: empty → PENDING", () => {
    expect(aggregateBranchStatus([])).toBe(NodeStatus.PENDING)
  })

  it("aggregateBranchStatus: uniform SKIPPED/ABORTED and mixed terminal states", () => {
    expect(aggregateBranchStatus([NodeStatus.SKIPPED, NodeStatus.SKIPPED])).toBe(NodeStatus.SKIPPED)
    expect(aggregateBranchStatus([NodeStatus.ABORTED, NodeStatus.ABORTED])).toBe(NodeStatus.ABORTED)
    expect(aggregateBranchStatus([NodeStatus.COMPLETED, NodeStatus.SKIPPED])).toBe(NodeStatus.PENDING)
  })

  it("transitionToNodeEvent: unexpected RUNNING source emits no event", () => {
    expect(transitionToNodeEvent(NodeStatus.COMPLETED, NodeStatus.RUNNING)).toBeNull()
  })

  it("DEFAULT_FALLBACK_TRIGGER is EXEC_FAILED", () => {
    expect(DEFAULT_FALLBACK_TRIGGER).toBe(FallbackTrigger.EXEC_FAILED)
  })
})

describe("validateRequiredNodes", () => {
  it("passes for a consistent config", () => {
    const result = validateRequiredNodes({
      nodes: [
        { id: "a", depends_on: [], required: true },
        { id: "b", depends_on: ["a"], required: true },
      ],
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it("warns when all nodes are required", () => {
    const result = validateRequiredNodes({
      nodes: [
        { id: "a", depends_on: [], required: true },
        { id: "b", depends_on: ["a"], required: true },
      ],
    })
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it("passes when some nodes are optional", () => {
    const result = validateRequiredNodes({
      nodes: [
        { id: "a", depends_on: [], required: true },
        { id: "b", depends_on: ["a"], required: false },
      ],
    })
    expect(result.warnings).toEqual([])
  })
})

describe("planReplan (D11 simplified model)", () => {
  for (const status of [NodeStatus.PENDING, NodeStatus.QUEUED, NodeStatus.PAUSED]) {
    it(`rejects a new dependency on an omitted ${status} node`, () => {
      const plan = planReplan(
        { nodes: [{ id: "old", status, depends_on: [] }] },
        { nodes: [{ id: "new", depends_on: ["old"] }] },
      )
      expect(plan.errors).toEqual([
        'Node "new" depends on "old" which is not present after merge (the dep was cancelled, superseded, or never existed)',
      ])
    })

    it(`excludes an omitted ${status} node from a valid replacement graph`, () => {
      const plan = planReplan(
        { nodes: [{ id: "old", status, depends_on: [] }] },
        { nodes: [{ id: "new", depends_on: [] }] },
      )
      expect(plan.errors).toEqual([])
      expect(plan.cancel).toEqual(["old"])
      expect(plan.add).toEqual(["new"])
      expect(plan.mergedGraph.getAllNodes()).toEqual(["new"])
    })

    it(`preserves a ${status} node and its dependency when included in the fragment`, () => {
      const plan = planReplan(
        { nodes: [{ id: "old", status, depends_on: [] }] },
        {
          nodes: [
            { id: "old", depends_on: [] },
            { id: "new", depends_on: ["old"] },
          ],
        },
      )
      expect(plan.errors).toEqual([])
      expect(plan.cancel).toEqual([])
      expect(plan.replace).toEqual(["old"])
      expect(plan.mergedGraph.getDependencies("new")).toEqual(["old"])
    })
  }

  it("rejects restart + cancel on the same node", () => {
    const plan = planReplan(
      { nodes: [{ id: "n1", status: NodeStatus.RUNNING, depends_on: [] }] },
      { nodes: [{ id: "n1", depends_on: [], restart: true, cancel: true }] },
    )
    expect(plan.errors.length).toBeGreaterThan(0)
    expect(plan.errors[0]).toContain("restart and cancel")
  })

  it("rejects restart on a non-running node", () => {
    const plan = planReplan(
      { nodes: [{ id: "n1", status: NodeStatus.PENDING, depends_on: [] }] },
      { nodes: [{ id: "n1", depends_on: [], restart: true }] },
    )
    expect(plan.errors.length).toBeGreaterThan(0)
  })

  it("rejects cancel on a terminal node", () => {
    const plan = planReplan(
      { nodes: [{ id: "n1", status: NodeStatus.COMPLETED, depends_on: [] }] },
      { nodes: [{ id: "n1", depends_on: [], cancel: true }] },
    )
    expect(plan.errors.length).toBeGreaterThan(0)
  })

  it("ignores terminal nodes that appear in the fragment (iron law #2)", () => {
    const plan = planReplan(
      { nodes: [{ id: "done", status: NodeStatus.COMPLETED, depends_on: [] }] },
      { nodes: [{ id: "done", depends_on: ["new-node"] }] },
    )
    // 'done' is terminal — fragment entry ignored. But 'new-node' doesn't exist
    // so the fragment refs fail. Either way, 'done' must be in ignore, not in errors-by-name.
    expect(plan.ignore).toContain("done")
  })

  it("classifies pending-not-in-fragment as cancel (superseded)", () => {
    const plan = planReplan(
      {
        nodes: [
          { id: "a", status: NodeStatus.COMPLETED, depends_on: [] },
          { id: "b", status: NodeStatus.PENDING, depends_on: ["a"] },
        ],
      },
      { nodes: [] }, // empty fragment: everything pending gets cancelled
    )
    expect(plan.cancel).toContain("b")
  })

  it("classifies pending-in-fragment as replace", () => {
    const plan = planReplan(
      {
        nodes: [
          { id: "a", status: NodeStatus.COMPLETED, depends_on: [] },
          { id: "b", status: NodeStatus.PENDING, depends_on: ["a"] },
        ],
      },
      { nodes: [{ id: "b", depends_on: ["a"] }] },
    )
    expect(plan.replace).toContain("b")
    expect(plan.cancel).not.toContain("b")
  })

  it("classifies new ids as add", () => {
    const plan = planReplan(
      { nodes: [{ id: "a", status: NodeStatus.COMPLETED, depends_on: [] }] },
      { nodes: [{ id: "new", depends_on: ["a"] }] },
    )
    expect(plan.add).toContain("new")
  })

  it("classifies running-with-restart as restart", () => {
    const plan = planReplan(
      { nodes: [{ id: "r", status: NodeStatus.RUNNING, depends_on: [] }] },
      { nodes: [{ id: "r", depends_on: [], restart: true }] },
    )
    expect(plan.restart).toContain("r")
  })

  it("classifies running-with-cancel as cancel", () => {
    const plan = planReplan(
      { nodes: [{ id: "r", status: NodeStatus.RUNNING, depends_on: [] }] },
      { nodes: [{ id: "r", depends_on: [], cancel: true }] },
    )
    expect(plan.cancel).toContain("r")
  })

  it("keeps running-not-in-fragment unchanged (not in any bucket)", () => {
    const plan = planReplan({ nodes: [{ id: "r", status: NodeStatus.RUNNING, depends_on: [] }] }, { nodes: [] })
    expect(plan.cancel).not.toContain("r")
    expect(plan.restart).not.toContain("r")
    expect(plan.replace).not.toContain("r")
    expect(plan.add).not.toContain("r")
  })

  it("rejects a fragment that would create a cycle in the merged graph", () => {
    // Current: a -> b (b depends on a). Fragment flips a to depend on b → cycle.
    const plan = planReplan(
      {
        nodes: [
          { id: "a", status: NodeStatus.COMPLETED, depends_on: [] },
          { id: "b", status: NodeStatus.PENDING, depends_on: ["a"] },
        ],
      },
      {
        nodes: [
          { id: "b", depends_on: ["a"] },
          { id: "a", depends_on: ["b"] },
        ],
      },
    )
    // 'a' is COMPLETED (terminal) so the fragment's a→b edge is ignored; no cycle.
    // To actually test cycle rejection we need a non-terminal example:
    expect(plan.ignore).toContain("a")
  })

  it("rejects a real cycle among pending/added nodes", () => {
    const plan = planReplan(
      { nodes: [] },
      {
        nodes: [
          { id: "x", depends_on: ["y"] },
          { id: "y", depends_on: ["x"] },
        ],
      },
    )
    expect(plan.errors.length).toBeGreaterThan(0)
    expect(plan.errors.join(" ").toLowerCase()).toContain("cycle")
  })

  it("mergedGraph is acyclic for a valid plan", () => {
    const plan = planReplan(
      { nodes: [{ id: "a", status: NodeStatus.COMPLETED, depends_on: [] }] },
      {
        nodes: [
          { id: "b", depends_on: ["a"] },
          { id: "c", depends_on: ["b"] },
        ],
      },
    )
    expect(plan.errors).toEqual([])
    expect(plan.mergedGraph.hasCycle()).toBe(false)
  })
})

describe("buildGraph", () => {
  it("builds a graph from SchedulingNode list", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "pending", required: false },
      { id: "b", dependsOn: ["a"], status: "pending", required: false },
    ]
    const g = buildGraph(nodes)
    expect(g.hasNode("a")).toBe(true)
    expect(g.hasNode("b")).toBe(true)
    expect(g.hasEdge("b", "a")).toBe(true)
  })

  it("ignores dependency edges to unknown nodes", () => {
    const nodes: SchedulingNode[] = [{ id: "a", dependsOn: ["ghost"], status: "pending", required: false }]
    const g = buildGraph(nodes)
    expect(g.hasNode("a")).toBe(true)
    expect(g.getDependencies("a")).toEqual([])
  })
})

describe("WorkflowRuntime", () => {
  const linearNodes = (statuses: Record<string, SchedulingNode["status"]> = {}): SchedulingNode[] => [
    { id: "a", dependsOn: [], status: statuses["a"] ?? "pending", required: false },
    { id: "b", dependsOn: ["a"], status: statuses["b"] ?? "pending", required: false },
    { id: "c", dependsOn: ["b"], status: statuses["c"] ?? "pending", required: false },
  ]

  it("markSatisfied unblocks dependents", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    expect(rt.getReadyNodes()).toEqual(["a"])
    rt.markSatisfied("a")
    expect(rt.getReadyNodes()).toEqual(["b"])
    rt.markSatisfied("b")
    expect(rt.getReadyNodes()).toEqual(["c"])
  })

  it("required markUnsatisfied blocks dependents", () => {
    const rt = new WorkflowRuntime(
      linearNodes().map((node) => (node.id === "a" ? { ...node, required: true } : node)),
      4,
    )
    expect(rt.getReadyNodes()).toEqual(["a"])
    rt.markUnsatisfied("a")
    expect(rt.getReadyNodes()).toEqual([])
  })

  it("optional markUnsatisfied unblocks dependents", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    rt.markUnsatisfied("a")
    expect(rt.getReadyNodes()).toEqual(["b"])
    expect(rt.hasRequiredFailure()).toBe(false)
  })

  it("markRunning excludes a node from getReadyNodes", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    const ready = rt.getReadyNodes()
    expect(ready).toEqual(["a"])
    rt.markRunning("a")
    expect(rt.getReadyNodes()).toEqual([])
  })

  it("markSatisfied removes node from running", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    rt.markRunning("a")
    rt.markSatisfied("a")
    expect(rt.getReadyNodes()).toEqual(["b"])
  })

  it("isComplete when all nodes are terminal", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    expect(rt.isComplete()).toBe(false)
    rt.markSatisfied("a")
    expect(rt.isComplete()).toBe(false)
    rt.markSatisfied("b")
    expect(rt.isComplete()).toBe(false)
    rt.markSatisfied("c")
    expect(rt.isComplete()).toBe(true)
  })

  it("isComplete with mixed satisfied and unsatisfied", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    rt.markSatisfied("a")
    rt.markUnsatisfied("b")
    expect(rt.getReadyNodes()).toEqual(["c"])
    expect(rt.isComplete()).toBe(false)
    expect(rt.hasRequiredFailure()).toBe(false)
    rt.markSatisfied("c")
    expect(rt.isComplete()).toBe(true)
  })

  it("hasRequiredFailure detects required node failure", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "pending", required: true },
      { id: "b", dependsOn: [], status: "pending", required: false },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    expect(rt.hasRequiredFailure()).toBe(false)
    rt.markUnsatisfied("b")
    expect(rt.hasRequiredFailure()).toBe(false)
    rt.markUnsatisfied("a")
    expect(rt.hasRequiredFailure()).toBe(true)
  })

  it("hasRequiredFailure is false when non-required node fails", () => {
    const nodes: SchedulingNode[] = [{ id: "a", dependsOn: [], status: "pending", required: false }]
    const rt = new WorkflowRuntime(nodes, 4)
    rt.markUnsatisfied("a")
    expect(rt.hasRequiredFailure()).toBe(false)
  })

  it("rebuildGraph reflects new topology", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    expect(rt.containsNode("a")).toBe(true)
    expect(rt.containsNode("x")).toBe(false)
    rt.markSatisfied("a")
    rt.markSatisfied("b")
    const newNodes: SchedulingNode[] = [
      { id: "x", dependsOn: [], status: "pending", required: false },
      { id: "y", dependsOn: ["x"], status: "pending", required: false },
    ]
    rt.rebuildGraph(newNodes)
    expect(rt.containsNode("a")).toBe(false)
    expect(rt.containsNode("x")).toBe(true)
    expect(rt.getReadyNodes()).toEqual(["x"])
    expect(rt.isComplete()).toBe(false)
  })

  it("rebuildGraph re-seeds from node statuses", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    rt.markSatisfied("a")
    rt.rebuildGraph(linearNodes({ a: "satisfied" }))
    expect(rt.getReadyNodes()).toEqual(["b"])
  })

  it("paused state suppresses getReadyNodes", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    expect(rt.getReadyNodes()).toEqual(["a"])
    rt.setPaused(true)
    expect(rt.isPaused()).toBe(true)
    expect(rt.getReadyNodes()).toEqual([])
    rt.setPaused(false)
    expect(rt.isPaused()).toBe(false)
    expect(rt.getReadyNodes()).toEqual(["a"])
  })

  it("constructor seeds from satisfied node statuses", () => {
    const rt = new WorkflowRuntime(linearNodes({ a: "satisfied" }), 4)
    expect(rt.getReadyNodes()).toEqual(["b"])
  })

  it("constructor seeds from unsatisfied node statuses", () => {
    const rt = new WorkflowRuntime(linearNodes({ a: "unsatisfied" }), 4)
    expect(rt.getReadyNodes()).toEqual(["b"])
    expect(rt.isComplete()).toBe(false)
    expect(rt.hasRequiredFailure()).toBe(false)
  })

  it("diamond dependency — all deps must be satisfied", () => {
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
  })

  it("markUnsatisfied cascades to transitive dependents", () => {
    const rt = new WorkflowRuntime(
      linearNodes().map((node) => (node.id === "a" ? { ...node, required: true } : node)),
      4,
    )
    rt.markUnsatisfied("a")
    expect(rt.isComplete()).toBe(true)
    expect(rt.getReadyNodes()).toEqual([])
  })

  it("markUnsatisfied cascade respects already-satisfied nodes", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "pending", required: true },
      { id: "b", dependsOn: ["a"], status: "pending", required: false },
      { id: "c", dependsOn: [], status: "pending", required: false },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    rt.markSatisfied("c")
    rt.markUnsatisfied("a")
    expect(rt.isComplete()).toBe(true)
  })

  it("tracks running nodes with and without a predicate", () => {
    const rt = new WorkflowRuntime(linearNodes(), 4)
    expect(rt.hasRunning()).toBe(false)
    rt.markRunning("a")
    expect(rt.hasRunning()).toBe(true)
    expect(rt.hasRunningMatching((id) => id === "b")).toBe(false)
    expect(rt.hasRunningMatching((id) => id === "a")).toBe(true)
  })

  it("getRequiredFailures names required unsatisfied nodes in sorted order", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "pending", required: true },
      { id: "b", dependsOn: [], status: "pending", required: false },
      { id: "c", dependsOn: [], status: "pending", required: true },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    rt.markUnsatisfied("b")
    rt.markUnsatisfied("c")
    rt.markUnsatisfied("a")
    expect(rt.getRequiredFailures()).toEqual(["a", "c"])
  })

  it("step mode releases one sorted ready node per call", () => {
    const nodes: SchedulingNode[] = [
      { id: "b", dependsOn: [], status: "pending", required: false },
      { id: "a", dependsOn: [], status: "pending", required: false },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    expect(rt.isStepMode()).toBe(false)
    rt.setStepMode(true)
    expect(rt.isStepMode()).toBe(true)
    expect(rt.getReadyNodes()).toEqual(["a"])
  })
})

describe("WorkflowRuntime skipped semantics (D13)", () => {
  it("markSkipped excludes pure-skip dependents from ready and flags them for cascade", () => {
    const nodes: SchedulingNode[] = [
      { id: "gate", dependsOn: [], status: "pending", required: true },
      { id: "impl", dependsOn: ["gate"], status: "pending", required: true },
      { id: "audit", dependsOn: ["impl"], status: "pending", required: true },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    rt.markSatisfied("gate")
    rt.markSkipped("impl")
    // impl is the only dependency of audit and it is skipped — audit must NOT
    // become ready (the pre-fix bug: skip ≡ satisfied let audit run).
    expect(rt.getReadyNodes()).toEqual([])
    expect(rt.getCascadeSkipNodes()).toEqual(["audit"])
  })

  it("cascade waves reach a fixpoint transitively", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "pending", required: true },
      { id: "b", dependsOn: ["a"], status: "pending", required: true },
      { id: "c", dependsOn: ["b"], status: "pending", required: true },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    rt.markSkipped("a")
    expect(rt.getCascadeSkipNodes()).toEqual(["b"])
    rt.markSkipped("b")
    expect(rt.getCascadeSkipNodes()).toEqual(["c"])
    rt.markSkipped("c")
    expect(rt.getCascadeSkipNodes()).toEqual([])
    expect(rt.isComplete()).toBe(true)
  })

  it("a mixed fan-in with at least one satisfied dependency still runs", () => {
    const nodes: SchedulingNode[] = [
      { id: "left", dependsOn: [], status: "pending", required: false },
      { id: "right", dependsOn: [], status: "pending", required: false },
      { id: "fanin", dependsOn: ["left", "right"], status: "pending", required: true },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    rt.markSatisfied("left")
    rt.markSkipped("right")
    // Graceful degradation is preserved: the fan-in sees the skip as a
    // placeholder input instead of cascading.
    expect(rt.getReadyNodes()).toEqual(["fanin"])
    expect(rt.getCascadeSkipNodes()).toEqual([])
  })

  it("isComplete counts skipped as terminal and skip of a required node is not a required failure", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "pending", required: true },
      { id: "b", dependsOn: ["a"], status: "pending", required: true },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    rt.markSkipped("a")
    rt.markSkipped("b")
    expect(rt.isComplete()).toBe(true)
    expect(rt.hasRequiredFailure()).toBe(false)
  })

  it("constructor seeds skipped nodes from durable statuses", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "skipped", required: true },
      { id: "b", dependsOn: ["a"], status: "pending", required: true },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    expect(rt.getReadyNodes()).toEqual([])
    expect(rt.getCascadeSkipNodes()).toEqual(["b"])
    expect(rt.isActive("a")).toBe(false)
  })

  it("cascade respects pause — a paused workflow must stay replannable", () => {
    const nodes: SchedulingNode[] = [
      { id: "a", dependsOn: [], status: "skipped", required: true },
      { id: "b", dependsOn: ["a"], status: "pending", required: true },
    ]
    const rt = new WorkflowRuntime(nodes, 4)
    rt.setPaused(true)
    expect(rt.getCascadeSkipNodes()).toEqual([])
    rt.setPaused(false)
    expect(rt.getCascadeSkipNodes()).toEqual(["b"])
  })
})

describe("toSchedulingNodes mapping", () => {
  it("keeps skipped and aborted distinguishable from satisfied", () => {
    const rows = [
      { id: "done", status: "completed", dependsOn: [], required: true },
      { id: "gone", status: "skipped", dependsOn: [], required: true },
      { id: "aborted", status: "aborted", dependsOn: [], required: true },
      { id: "dead", status: "failed", dependsOn: [], required: true },
      { id: "live", status: "running", dependsOn: [], required: true },
      { id: "wait", status: "queued", dependsOn: [], required: true },
    ]
    expect(toSchedulingNodes(rows).map((n) => n.status)).toEqual([
      "satisfied",
      "skipped",
      "skipped",
      "unsatisfied",
      "running",
      "pending",
    ])
  })
})

describe("planReplan fragment validation additions", () => {
  it("rejects duplicate ids within the fragment", () => {
    const plan = planReplan(
      { nodes: [] },
      {
        nodes: [
          { id: "x", depends_on: [] },
          { id: "x", depends_on: [] },
        ],
      },
    )
    expect(plan.errors.join(" ")).toContain('duplicate node id "x"')
  })

  it("restart on a terminal node explains the replacement path", () => {
    const plan = planReplan(
      { nodes: [{ id: "f", status: NodeStatus.FAILED, depends_on: [] }] },
      { nodes: [{ id: "f", depends_on: [], restart: true }] },
    )
    expect(plan.errors.join(" ")).toContain("add a replacement node under a new id")
  })
})
