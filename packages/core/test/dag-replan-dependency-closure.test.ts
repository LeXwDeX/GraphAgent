import { describe, expect, it } from "bun:test"
import { planReplan } from "../src/dag/core/replan"
import { NodeStatus } from "../src/dag/core/types"

describe("replan dependency closure (#697)", () => {
  for (const status of [NodeStatus.PENDING, NodeStatus.QUEUED, NodeStatus.PAUSED]) {
    it(`excludes omitted ${status} nodes from both the plan and merged graph`, () => {
      const plan = planReplan({ nodes: [{ id: "old", status, depends_on: [] }] }, { nodes: [] })
      expect(plan.errors).toEqual([])
      expect(plan.cancel).toEqual(["old"])
      expect(plan.mergedGraph.hasNode("old")).toBe(false)
    })

    it(`rejects a new node depending on an omitted ${status} node`, () => {
      const plan = planReplan(
        { nodes: [{ id: "old", status, depends_on: [] }] },
        { nodes: [{ id: "new", depends_on: ["old"] }] },
      )
      expect(plan.errors).toEqual([expect.stringContaining('Node "new" depends on "old"')])
    })

    it(`rejects a retained running node's dependency on an omitted ${status} node`, () => {
      const plan = planReplan(
        { nodes: [
          { id: "old", status, depends_on: [] },
          { id: "running", status: NodeStatus.RUNNING, depends_on: ["old"] },
        ] },
        { nodes: [] },
      )
      expect(plan.errors).toEqual([expect.stringContaining('Node "running" depends on "old"')])
    })
  }

  for (const status of [NodeStatus.QUEUED, NodeStatus.PAUSED]) {
    it(`preserves an included ${status} node and its valid dependencies`, () => {
      const plan = planReplan(
        { nodes: [
          { id: "done", status: NodeStatus.COMPLETED, depends_on: [] },
          { id: "retained", status, depends_on: ["done"] },
        ] },
        { nodes: [{ id: "retained", depends_on: ["done"] }] },
      )
      expect(plan.errors).toEqual([])
      expect(plan.replace).toEqual(["retained"])
      expect(plan.cancel).toEqual([])
      expect(plan.mergedGraph.hasEdge("retained", "done")).toBe(true)
    })
  }

  it("rejects a replacement depending on an explicitly cancelled node", () => {
    const plan = planReplan(
      { nodes: [
        { id: "old", status: NodeStatus.RUNNING, depends_on: [] },
        { id: "replacement", status: NodeStatus.PENDING, depends_on: [] },
      ] },
      { nodes: [
        { id: "old", depends_on: [], cancel: true },
        { id: "replacement", depends_on: ["old"] },
      ] },
    )
    expect(plan.errors).toEqual([expect.stringContaining('Node "replacement" depends on "old"')])
  })

  it("preserves completed outputs with historical superseded dependencies", () => {
    const plan = planReplan(
      { nodes: [
        { id: "historical", status: NodeStatus.PAUSED, depends_on: [] },
        { id: "done", status: NodeStatus.COMPLETED, depends_on: ["historical"] },
      ] },
      { nodes: [{ id: "next", depends_on: ["done"] }] },
    )
    expect(plan.errors).toEqual([])
    expect(plan.cancel).toEqual(["historical"])
    expect(plan.mergedGraph.hasNode("done")).toBe(true)
    expect(plan.mergedGraph.hasEdge("next", "done")).toBe(true)
    expect(plan.mergedGraph.hasNode("historical")).toBe(false)
  })

  it("keeps unchanged running dependencies on terminal outputs", () => {
    const plan = planReplan(
      { nodes: [
        { id: "done", status: NodeStatus.COMPLETED, depends_on: [] },
        { id: "running", status: NodeStatus.RUNNING, depends_on: ["done"] },
      ] },
      { nodes: [] },
    )
    expect(plan.errors).toEqual([])
    expect(plan.cancel).toEqual([])
    expect(plan.mergedGraph.hasEdge("running", "done")).toBe(true)
  })
  it("rejects a new node depending on a node an earlier replan superseded", () => {
    // A superseded row is out of the current graph revision: the runtime
    // rebuilds from current rows only and would drop the edge, running the
    // dependent as a root. The plan must reject it with an actionable error.
    const plan = planReplan(
      { nodes: [
        { id: "done", status: NodeStatus.COMPLETED, depends_on: [] },
        { id: "old", status: NodeStatus.FAILED, depends_on: ["done"], superseded: true },
      ] },
      { nodes: [{ id: "new", depends_on: ["old"] }] },
    )
    expect(plan.errors).toEqual([
      expect.stringContaining('Node "new" depends on "old", which an earlier replan superseded'),
    ])
  })

  it("rejects a pending replacement rewired onto a superseded node", () => {
    const plan = planReplan(
      { nodes: [
        { id: "old", status: NodeStatus.FAILED, depends_on: [], superseded: true },
        { id: "next", status: NodeStatus.PENDING, depends_on: [] },
      ] },
      { nodes: [{ id: "next", depends_on: ["old"] }] },
    )
    expect(plan.errors).toEqual([expect.stringContaining('Node "next" depends on "old"')])
  })

  it("keeps terminal history on superseded nodes and excludes them from the merged graph", () => {
    const plan = planReplan(
      { nodes: [
        { id: "old", status: NodeStatus.FAILED, depends_on: [], superseded: true },
        { id: "done", status: NodeStatus.COMPLETED, depends_on: ["old"] },
      ] },
      { nodes: [{ id: "old", depends_on: [] }, { id: "next", depends_on: ["done"] }] },
    )
    expect(plan.errors).toEqual([])
    expect(plan.ignore).toEqual(["old"])
    expect(plan.add).toEqual(["next"])
    expect(plan.mergedGraph.hasNode("old")).toBe(false)
    expect(plan.mergedGraph.hasEdge("next", "done")).toBe(true)
  })
})
