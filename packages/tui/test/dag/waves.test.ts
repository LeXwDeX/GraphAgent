// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { DagNode } from "@graphagent/sdk"
import { dagNodeRow } from "../../src/dag/model"
import { computeWaves, dagUnplacedReasons } from "../../src/dag/waves"

const node = (id: string, depends_on: string[] = [], name = id): DagNode => ({
  id,
  workflow_id: "wf-1",
  name,
  status: "pending",
  worker_type: "task",
  required: false,
  depends_on,
  replan_attempts: 0,
})

const ids = (groups: readonly (readonly { id: string }[])[]) => groups.map((group) => group.map((n) => n.id))

describe("computeWaves", () => {
  test("empty input produces no waves and nothing unplaced", () => {
    expect(computeWaves([])).toEqual({ waves: [], unplaced: [] })
  })

  test("independent nodes land in one wave sorted by name", () => {
    const { waves, unplaced } = computeWaves([node("b"), node("a"), node("c")])
    expect(waves).toHaveLength(1)
    expect(waves[0].map((n) => n.id)).toEqual(["a", "b", "c"])
    expect(unplaced).toEqual([])
  })

  test("linear chain produces one wave per node", () => {
    const { waves, unplaced } = computeWaves([node("c", ["b"]), node("a"), node("b", ["a"])])
    expect(ids(waves)).toEqual([["a"], ["b"], ["c"]])
    expect(unplaced).toEqual([])
  })

  test("diamond topology groups by depth", () => {
    const { waves } = computeWaves([
      node("root"),
      node("left", ["root"]),
      node("right", ["root"]),
      node("merge", ["left", "right"]),
    ])
    expect(ids(waves)).toEqual([["root"], ["left", "right"], ["merge"]])
  })

  test("dependency cycle terminates; its members come back as unplaced", () => {
    const { waves, unplaced } = computeWaves([node("a"), node("x", ["y"]), node("y", ["x"])])
    expect(ids(waves)).toEqual([["a"]])
    expect(unplaced.map((n) => n.id)).toEqual(["x", "y"])
  })

  test("a two-node cycle (A to B to A) leaves no wave and both nodes unplaced", () => {
    const { waves, unplaced } = computeWaves([node("A", ["B"]), node("B", ["A"])])
    expect(waves).toEqual([])
    expect(unplaced.map((n) => n.id)).toEqual(["A", "B"])
  })

  test("a node that depends on a cycle member can never run, so it is unplaced too", () => {
    const { waves, unplaced } = computeWaves([
      node("ok"),
      node("x", ["y"]),
      node("y", ["x"]),
      node("after", ["x"]),
      node("later", ["after"]),
    ])
    expect(ids(waves)).toEqual([["ok"]])
    expect(unplaced.map((n) => n.id)).toEqual(["after", "later", "x", "y"])
  })

  test("a node that depends on itself is unplaced", () => {
    const { waves, unplaced } = computeWaves([node("a"), node("loop", ["loop"])])
    expect(ids(waves)).toEqual([["a"]])
    expect(unplaced.map((n) => n.id)).toEqual(["loop"])
  })

  test("unplaced nodes are sorted by name, not by input order", () => {
    const { unplaced } = computeWaves([node("z", ["y"], "zeta"), node("y", ["z"], "alpha")])
    expect(unplaced.map((n) => n.name)).toEqual(["alpha", "zeta"])
  })

  test("dependency on a missing node is treated as satisfied (replan removed it)", () => {
    const { waves, unplaced } = computeWaves([node("a", ["ghost"]), node("b", ["a"])])
    expect(ids(waves)).toEqual([["a"], ["b"]])
    expect(unplaced).toEqual([])
  })

  test("a missing dependency does not rescue a node that also waits on a cycle", () => {
    const { waves, unplaced } = computeWaves([node("x", ["y"]), node("y", ["x"]), node("z", ["ghost", "x"])])
    expect(waves).toEqual([])
    expect(unplaced.map((n) => n.id)).toEqual(["x", "y", "z"])
  })

  test("every node is either in a wave or unplaced, exactly once", () => {
    const input = [node("a"), node("b", ["a"]), node("c", ["d"]), node("d", ["c"]), node("e", ["ghost"])]
    const { waves, unplaced } = computeWaves(input)
    const seen = [...waves.flat(), ...unplaced].map((n) => n.id).toSorted()
    expect(seen).toEqual(["a", "b", "c", "d", "e"])
  })

  test("works on the stored row as well as the SDK node", () => {
    const rows = [dagNodeRow(node("b", ["a"])), dagNodeRow(node("a")), dagNodeRow(node("x", ["x"]))]
    const { waves, unplaced } = computeWaves(rows)
    expect(ids(waves)).toEqual([["a"], ["b"]])
    expect(unplaced.map((n) => n.id)).toEqual(["x"])
  })
})

/** `computeWaves` leaves these out; the reasons are read from exactly that list. */
function reasonsOf(nodes: readonly DagNode[]) {
  const { unplaced } = computeWaves(nodes)
  return Object.fromEntries(dagUnplacedReasons(unplaced))
}

describe("dagUnplacedReasons", () => {
  test("nothing unplaced, nothing to explain", () => {
    expect(dagUnplacedReasons([]).size).toBe(0)
    expect(reasonsOf([node("a"), node("b", ["a"])])).toEqual({})
  })

  test("both members of a two-node cycle are cycle members", () => {
    expect(reasonsOf([node("A", ["B"]), node("B", ["A"])])).toEqual({ A: { kind: "cycle" }, B: { kind: "cycle" } })
  })

  test("a node that depends on itself is a cycle member", () => {
    expect(reasonsOf([node("ok"), node("loop", ["loop"])])).toEqual({ loop: { kind: "cycle" } })
  })

  test("a longer cycle puts every node on it in the cycle, and nothing else", () => {
    expect(reasonsOf([node("a", ["c"]), node("b", ["a"]), node("c", ["b"]), node("free")])).toEqual({
      a: { kind: "cycle" },
      b: { kind: "cycle" },
      c: { kind: "cycle" },
    })
  })

  test("nodes that wait on a cycle, directly or through other nodes, are downstream of it", () => {
    const reasons = reasonsOf([
      node("ok"),
      node("x", ["y"]),
      node("y", ["x"]),
      node("after", ["x"]),
      node("later", ["after"]),
    ])
    expect(reasons).toEqual({
      x: { kind: "cycle" },
      y: { kind: "cycle" },
      after: { kind: "downstream", via: "x" },
      later: { kind: "downstream", via: "x" },
    })
  })

  test("`via` is the nearest cycle member; equally near ones are told apart by name", () => {
    const reasons = reasonsOf([
      node("a", ["b"]),
      node("b", ["a"]),
      node("c", ["d"]),
      node("d", ["c"]),
      node("m", ["a"]),
      // `c` is one hop away, `a` two: the nearer one is named.
      node("t", ["m", "c"]),
      // `b` and `c` are both one hop away: the first by name wins, whatever the dependency order.
      node("u", ["c", "b"]),
    ])
    expect(reasons.t).toEqual({ kind: "downstream", via: "c" })
    expect(reasons.u).toEqual({ kind: "downstream", via: "b" })
    expect(reasons.m).toEqual({ kind: "downstream", via: "a" })
  })

  test("a node between two cycles is downstream of the first, not a cycle member itself", () => {
    const reasons = reasonsOf([
      node("a", ["b"]),
      node("b", ["a"]),
      node("mid", ["a"]),
      node("c", ["d", "mid"]),
      node("d", ["c"]),
    ])
    expect(reasons.mid).toEqual({ kind: "downstream", via: "a" })
    expect(reasons.c).toEqual({ kind: "cycle" })
    expect(reasons.d).toEqual({ kind: "cycle" })
  })

  test("a dependency on a node that is not there is no reason by itself", () => {
    const reasons = reasonsOf([node("x", ["y"]), node("y", ["x"]), node("z", ["ghost", "x"]), node("fine", ["ghost"])])
    expect(reasons).toEqual({
      x: { kind: "cycle" },
      y: { kind: "cycle" },
      z: { kind: "downstream", via: "x" },
    })
  })

  test("every unplaced node gets exactly one reason, whatever order they come in", () => {
    const input = [
      node("a"),
      node("b", ["a"]),
      node("c", ["d"]),
      node("d", ["c"]),
      node("e", ["c", "ghost"]),
      node("f", ["e"]),
    ]
    const { unplaced } = computeWaves(input)
    const reasons = dagUnplacedReasons(unplaced)
    expect([...reasons.keys()].toSorted()).toEqual(unplaced.map((n) => n.id).toSorted())
    expect(Object.fromEntries(dagUnplacedReasons(unplaced.toReversed()))).toEqual(Object.fromEntries(reasons))
  })

  test("works on the stored row as well as the SDK node, and ignores what else a node carries", () => {
    const rows = [dagNodeRow(node("x", ["y"])), dagNodeRow(node("y", ["x"])), dagNodeRow(node("z", ["y"]))]
    const { unplaced } = computeWaves(rows)
    expect(Object.fromEntries(dagUnplacedReasons(unplaced))).toEqual({
      x: { kind: "cycle" },
      y: { kind: "cycle" },
      z: { kind: "downstream", via: "y" },
    })
  })

  test("a very long chain behind a cycle neither overflows the stack nor takes long", () => {
    const chain: DagNode[] = [node("x", ["y"]), node("y", ["x"]), node("n0", ["x"])]
    for (let index = 1; index < 20_000; index++) chain.push(node(`n${index}`, [`n${index - 1}`]))
    const started = performance.now()
    const reasons = reasonsOf(chain)
    expect(Object.keys(reasons)).toHaveLength(20_002)
    expect(reasons.n19999).toEqual({ kind: "downstream", via: "x" })
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})
