// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158 PR5: `NodeView.expanded_from`, the slot that generated a node of a compose expansion. A node row has no
// definition columns, so the mark is read from the workflow's persisted definition and handed to the row projection.
import { describe, expect, it } from "bun:test"
import { DagNodeView } from "@/dag/node-view"
import { makeNodeRow } from "./fixtures"

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  worker_type: "explore",
  depends_on: [],
  ...extra,
})
const definition = (nodes: unknown[]) => JSON.stringify({ name: "w", nodes })

describe("the expanded_from marks of a workflow's definition", () => {
  it("lists the nodes that carry one, with the slot that generated each", () => {
    const marks = DagNodeView.expandedFrom(
      definition([
        node("survey--split"),
        node("survey--a", { expanded_from: "survey" }),
        node("survey--big", { expanded_from: "survey" }),
        node("survey--big--x", { expanded_from: "survey--big" }),
        node("survey"),
      ]),
    )
    expect([...marks]).toEqual([
      ["survey--a", "survey"],
      ["survey--big", "survey"],
      ["survey--big--x", "survey--big"],
    ])
  })

  it("is empty for a workflow no expansion touched", () => {
    expect(DagNodeView.expandedFrom(definition([node("a"), node("b", { depends_on: ["a"] })])).size).toBe(0)
    expect(DagNodeView.expandedFrom(definition([])).size).toBe(0)
  })

  it("is empty, and never throws, for a definition that is empty or unreadable", () => {
    // The node publisher is handed rows with an empty definition by its stand-in store, and a stored row can be
    // damaged: a client then loses the grouping and nothing else.
    const unreadable = ["", " ", "{", "not json", "null", "[]", "{}", '{"nodes":"x"}', '{"nodes":[{"id":1}]}']
    for (const text of unreadable) expect(DagNodeView.expandedFrom(text).size, JSON.stringify(text)).toBe(0)
  })

  it("keeps only a mark that names a slot, so the view stays decodable", () => {
    const marks = DagNodeView.expandedFrom(
      definition([
        node("a", { expanded_from: 3 }),
        node("b", { expanded_from: null }),
        node("c", { expanded_from: { id: "x" } }),
        node("d", { expanded_from: "slot" }),
      ]),
    )
    expect([...marks]).toEqual([["d", "slot"]])
  })
})

describe("a node row as a view", () => {
  const row = makeNodeRow({ id: "survey--a", workflowId: "wf", dependsOn: ["survey--split"] })

  it("carries the slot that generated the node when it has one", () => {
    expect(DagNodeView.base(row, "survey")).toMatchObject({ id: "survey--a", expanded_from: "survey" })
  })

  it("leaves the field out, rather than undefined, when it has none: a workflow without compose is byte-identical", () => {
    const view = DagNodeView.base(row)
    expect("expanded_from" in view).toBe(false)
    expect(JSON.stringify(view)).toBe(JSON.stringify(DagNodeView.base(row, undefined)))
    expect(JSON.stringify(view)).not.toContain("expanded_from")
  })

  it("keeps the mark when the mailbox counters are added to the view", () => {
    const metadata = {
      endpoint: { id: "ep", kind: "node", sessionID: "ses", workflowID: "wf", nodeID: "survey--a", attemptID: "att-1" },
      accepted: 1,
      snapshot: 0,
      queued: 1,
      delivered: 0,
      undeliverable: 0,
    } satisfies Parameters<typeof DagNodeView.observed>[1]
    const view = DagNodeView.observed(DagNodeView.base(row, "survey"), metadata)
    expect(view).toMatchObject({ expanded_from: "survey", attempt_id: "att-1", agent_messages: { queued: 1 } })
  })
})
