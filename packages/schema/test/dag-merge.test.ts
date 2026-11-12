// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { DagMerge } from "../src/dag-merge"
import type { NodeView } from "../src/dag-summary"

const node = (id: string, status = "pending"): NodeView => ({
  id,
  workflow_id: "wf",
  name: id,
  worker_type: "build",
  status,
  required: true,
  depends_on: [],
  replan_attempts: 0,
})

const patch = (seq: number, nodes: NodeView[], removed: string[] = []): DagMerge.NodesPatch => ({
  workflowID: "wf",
  graphRev: 1,
  seq,
  nodes,
  removed,
})

const snapshot = (seq: number, nodes: NodeView[], graphRev = 1): DagMerge.Snapshot => ({
  workflowID: "wf",
  graphRev,
  seq,
  nodes,
})

const ready = (view: DagMerge.Snapshot): DagMerge.Feed => ({ status: "ready", view })

const ids = (feed: DagMerge.Feed) =>
  DagMerge.snapshotOf(feed)
    ?.nodes.map((item) => item.id)
    .sort()

describe("dag node feed", () => {
  test("a push before the first load buffers and asks for a fetch", () => {
    const feed = DagMerge.push(DagMerge.empty, patch(1, [node("a", "running")]))
    expect(DagMerge.needsFetch(feed)).toBe(true)
    expect(feed.status).toBe("loading")
    expect(DagMerge.snapshotOf(feed)).toBeUndefined()
  })

  test("receive replays buffered pushes in sequence order", () => {
    let feed = DagMerge.push(DagMerge.loading(), patch(2, [node("b", "running")]))
    feed = DagMerge.push(feed, patch(1, [node("a", "running")]))
    feed = DagMerge.receive(feed, snapshot(0, [node("a"), node("b")]))
    expect(feed.status).toBe("ready")
    expect(ids(feed)).toEqual(["a", "b"])
    expect(DagMerge.snapshotOf(feed)?.nodes.find((item) => item.id === "a")?.status).toBe("running")
    expect(DagMerge.snapshotOf(feed)?.seq).toBe(2)
  })

  test("receive ignores pushes for another graph revision", () => {
    const stale: DagMerge.NodesPatch = { ...patch(1, [node("a", "running")]), graphRev: 2 }
    const feed = DagMerge.receive(DagMerge.push(DagMerge.empty, stale), snapshot(0, [node("a")]))
    expect(DagMerge.snapshotOf(feed)?.nodes[0]?.status).toBe("pending")
  })

  test("merges changed rows, drops removed ids, and appends unseen nodes", () => {
    const feed = DagMerge.push(
      ready(snapshot(1, [node("a"), node("b")])),
      patch(2, [node("a", "running"), node("c", "queued")], ["b"]),
    )
    expect(ids(feed)).toEqual(["a", "c"])
    expect(DagMerge.snapshotOf(feed)?.nodes.find((item) => item.id === "a")?.status).toBe("running")
    expect(DagMerge.snapshotOf(feed)?.seq).toBe(2)
  })

  test("drops stale and duplicate pushes", () => {
    const start = ready(snapshot(5, [node("a", "running")]))
    expect(DagMerge.push(start, patch(5, [node("a", "completed")]))).toBe(start)
    expect(DagMerge.push(start, patch(4, [node("a", "completed")]))).toBe(start)
  })

  test("a graph revision change returns to loading instead of merging", () => {
    const start = ready(snapshot(5, [node("a", "running")]))
    const revived: DagMerge.NodesPatch = {
      workflowID: "wf",
      graphRev: 2,
      seq: 6,
      nodes: [node("b", "pending")],
      removed: [],
    }
    const feed = DagMerge.push(start, revived)
    expect(feed.status).toBe("loading")
    expect(DagMerge.snapshotOf(feed)).toBeUndefined()
  })

  test("resync clears the buffered patches and requests a refetch", () => {
    let feed = DagMerge.push(DagMerge.empty, patch(1, [node("a", "running")]))
    feed = DagMerge.push(feed, { ...patch(2, []), resync: true })
    expect(feed.status).toBe("loading")
    expect(feed.status === "loading" ? feed.buffered.length : -1).toBe(1)
    const after = DagMerge.receive(feed, snapshot(3, [node("a", "completed")]))
    expect(DagMerge.snapshotOf(after)?.nodes[0]?.status).toBe("completed")
  })

  test("a ready feed ignores pushes for another workflow", () => {
    const start = ready(snapshot(1, [node("a")]))
    const other: DagMerge.NodesPatch = { ...patch(2, [node("b")]), workflowID: "other" }
    const feed = DagMerge.push(start, other)
    expect(feed.status).toBe("loading")
    expect(DagMerge.snapshotOf(feed)).toBeUndefined()
  })
})
