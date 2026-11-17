// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { dagFold } from "../../src/dag/fold"
import { computeWaves } from "../../src/dag/waves"

interface Node {
  readonly id: string
  readonly name: string
  readonly depends_on: readonly string[]
  readonly expanded_from?: string
}

const node = (id: string, depends_on: string[] = [], expanded_from?: string, name = id): Node => ({
  id,
  name,
  depends_on,
  ...(expanded_from !== undefined ? { expanded_from } : {}),
})

/**
 * What a compose block looks like once its slot has expanded: the author's `intro`, the block's split node, three
 * workers the plan asked for, and the slot, which is the join node now and waits for them. `ship` waits for the slot.
 */
const compose = (): Node[] => [
  node("intro"),
  node("plan--split", ["intro"]),
  node("plan--a", ["plan--split"], "plan"),
  node("plan--b", ["plan--split"], "plan"),
  node("plan--c", ["plan--split"], "plan"),
  node("plan", ["plan--a", "plan--b", "plan--c"]),
  node("ship", ["plan"]),
]

const fold = (nodes: readonly Node[], open: string[] = []) => {
  const { waves, unplaced } = computeWaves(nodes)
  return dagFold(waves, unplaced, new Set(open))
}

const ids = (result: ReturnType<typeof fold>) => result.rows.map((row) => row.node.id)

describe("dagFold without marks", () => {
  test("is the nodes in wave order, then the ones outside every wave, none of them a slot", () => {
    const nodes = [node("b", ["a"]), node("a"), node("x", ["y"]), node("y", ["x"]), node("c", ["a"])]
    const { waves, unplaced } = computeWaves(nodes)
    const result = dagFold(waves, unplaced)
    expect(result.rows.map((row) => row.node)).toEqual([...waves.flat(), ...unplaced])
    expect(result.rows.map((row) => [row.node.id, row.wave, row.depth, row.children, row.unfolded])).toEqual([
      ["a", 0, 0, 0, false],
      ["b", 1, 0, 0, false],
      ["c", 1, 0, 0, false],
      ["x", undefined, 0, 0, false],
      ["y", undefined, 0, 0, false],
    ])
    expect(result.hidden.size).toBe(0)
  })

  test("an empty workflow has no rows", () => {
    expect(dagFold([], [])).toEqual({ rows: [], hidden: new Map() })
  })

  test("a set of open slots changes nothing when there is no slot", () => {
    const nodes = [node("a"), node("b", ["a"])]
    expect(ids(fold(nodes, ["a", "b", "gone"]))).toEqual(["a", "b"])
  })
})

describe("dagFold with a compose expansion", () => {
  test("every slot starts folded: its children are left out, and it says how many there are", () => {
    const result = fold(compose())
    expect(ids(result)).toEqual(["intro", "plan--split", "plan", "ship"])
    const slot = result.rows.find((row) => row.node.id === "plan")
    // The slot keeps the wave its own dependencies give it, after the workers it waits for.
    expect(slot).toMatchObject({ wave: 3, depth: 0, children: 3, unfolded: false })
    expect(result.rows.filter((row) => row.children > 0)).toHaveLength(1)
  })

  test("a node folded away is stood for by the slot above it", () => {
    const result = fold(compose())
    expect(result.hidden).toEqual(
      new Map([
        ["plan--a", "plan"],
        ["plan--b", "plan"],
        ["plan--c", "plan"],
      ]),
    )
    expect(result.hidden.get("ship")).toBeUndefined()
  })

  test("an unfolded slot is followed by its children in wave order, then by name, one step in", () => {
    const result = fold(compose(), ["plan"])
    expect(ids(result)).toEqual(["intro", "plan--split", "plan", "plan--a", "plan--b", "plan--c", "ship"])
    expect(result.rows.map((row) => row.depth)).toEqual([0, 0, 0, 1, 1, 1, 0])
    expect(result.rows[2]).toMatchObject({ children: 3, unfolded: true })
    // A child keeps the wave it is in: the note of a waiting node counts it.
    expect(result.rows.slice(3, 6).map((row) => row.wave)).toEqual([2, 2, 2])
    expect(result.hidden.size).toBe(0)
  })

  test("children come in the order of the waves, not the order the nodes were listed in", () => {
    const nodes = [
      node("plan--z", ["plan--split"], "plan"),
      node("plan--a", ["plan--m"], "plan"),
      node("plan--m", ["plan--split"], "plan", "plan--m"),
      node("plan--split"),
      node("plan", ["plan--z", "plan--a", "plan--m"]),
    ]
    // m and z share a wave (by name: m, then z); a waits for m, so it is in the wave after.
    expect(ids(fold(nodes, ["plan"]))).toEqual(["plan--split", "plan", "plan--m", "plan--z", "plan--a"])
  })

  test("other slots stay as they were when one is opened", () => {
    const nodes = [
      ...compose(),
      node("scan--split"),
      node("scan--a", ["scan--split"], "scan"),
      node("scan", ["scan--a"]),
    ]
    const result = fold(nodes, ["scan"])
    const rows = result.rows.map((row) => [row.node.id, row.depth, row.unfolded])
    expect(rows).toContainEqual(["scan", 0, true])
    expect(rows).toContainEqual(["scan--a", 1, false])
    expect(rows).toContainEqual(["plan", 0, false])
    expect(ids(result)).not.toContain("plan--a")
  })

  test("the order of the rest does not change with the slot folded or unfolded", () => {
    const outside = (open: string[]) => ids(fold(compose(), open)).filter((id) => !id.startsWith("plan--"))
    expect(outside([])).toEqual(outside(["plan"]))
  })
})

describe("dagFold with a slot inside a slot", () => {
  // `plan--b` was split again: its split node and the slot itself name the outer slot, and what the nested slot expanded
  // into names the nested slot.
  const nested = (): Node[] => [
    node("plan--split"),
    node("plan--a", ["plan--split"], "plan"),
    node("plan--b--split", ["plan--split"], "plan"),
    node("plan--b--x", ["plan--b--split"], "plan--b"),
    node("plan--b--y", ["plan--b--split"], "plan--b"),
    node("plan--b", ["plan--b--x", "plan--b--y"], "plan"),
    node("plan", ["plan--a", "plan--b"]),
  ]

  test("opening the outer slot shows the nested one folded, with its own count", () => {
    const result = fold(nested(), ["plan"])
    expect(ids(result)).toEqual(["plan--split", "plan", "plan--a", "plan--b--split", "plan--b"])
    expect(result.rows.find((row) => row.node.id === "plan--b")).toMatchObject({
      depth: 1,
      children: 2,
      unfolded: false,
    })
    expect(result.rows.find((row) => row.node.id === "plan")).toMatchObject({ children: 3, unfolded: true })
    expect(result.hidden).toEqual(
      new Map([
        ["plan--b--x", "plan--b"],
        ["plan--b--y", "plan--b"],
      ]),
    )
  })

  test("opening both shows the nested slot's children one step further in", () => {
    const result = fold(nested(), ["plan", "plan--b"])
    expect(ids(result)).toEqual([
      "plan--split",
      "plan",
      "plan--a",
      "plan--b--split",
      "plan--b",
      "plan--b--x",
      "plan--b--y",
    ])
    expect(result.rows.map((row) => row.depth)).toEqual([0, 0, 1, 1, 1, 2, 2])
    expect(result.hidden.size).toBe(0)
  })

  test("a nested slot that was opened stays closed behind a folded outer one, and every node there is stood for by the outer", () => {
    const result = fold(nested(), ["plan--b"])
    expect(ids(result)).toEqual(["plan--split", "plan"])
    expect(result.hidden).toEqual(
      new Map([
        ["plan--a", "plan"],
        ["plan--b--split", "plan"],
        ["plan--b", "plan"],
        ["plan--b--x", "plan"],
        ["plan--b--y", "plan"],
      ]),
    )
  })

  test("what the outer slot's fold hides comes back as it was left, nested openings included", () => {
    const open = ["plan", "plan--b"]
    const before = ids(fold(nested(), open))
    expect(ids(fold(nested(), ["plan--b"]))).toEqual(["plan--split", "plan"])
    expect(ids(fold(nested(), open))).toEqual(before)
  })
})

describe("dagFold with marks that lead nowhere", () => {
  test("a node that names an id that is not there stays where it was, and so does one that names itself", () => {
    const nodes = [node("a"), node("b", ["a"], "gone"), node("c", ["b"], "c")]
    const result = fold(nodes)
    expect(ids(result)).toEqual(["a", "b", "c"])
    expect(result.rows.every((row) => row.depth === 0 && row.children === 0)).toBe(true)
    expect(result.hidden.size).toBe(0)
  })

  test("a node that names a stranger neither hides nor changes the slot beside it", () => {
    const nodes = [...compose(), node("stray", ["intro"], "plan-from-an-older-run")]
    const result = fold(nodes)
    expect(ids(result)).toContain("stray")
    expect(result.rows.filter((row) => row.children > 0).map((row) => row.node.id)).toEqual(["plan"])
  })

  test("nodes that name each other are not lost: the one that comes first stays on its own", () => {
    const nodes = [node("a", [], "b"), node("b", [], "a"), node("c", [], "b")]
    expect(ids(fold(nodes, ["a", "b"])).toSorted()).toEqual(["a", "b", "c"])
    // `a` came first, so it is the root; `b` names it, and `c` names `b`.
    const result = fold(nodes, ["a", "b"])
    expect(result.rows.map((row) => [row.node.id, row.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ])
    const folded = fold(nodes)
    expect(ids(folded)).toEqual(["a"])
    expect(folded.hidden).toEqual(
      new Map([
        ["b", "a"],
        ["c", "a"],
      ]),
    )
  })

  test("every node is on show or stood for, exactly once, however the marks are tangled", () => {
    const nodes = [
      node("n0", [], "n3"),
      node("n1", [], "n0"),
      node("n2", [], "n2"),
      node("n3", [], "n1"),
      node("n4", [], "n9"),
      node("n5", [], "n4"),
    ]
    for (const open of [[], ["n0", "n1", "n2", "n3", "n4", "n5"]]) {
      const result = fold(nodes, open)
      const counted = [...ids(result), ...result.hidden.keys()].toSorted()
      expect(counted).toEqual(["n0", "n1", "n2", "n3", "n4", "n5"])
      // What stands for a hidden node is on show.
      for (const stand of result.hidden.values()) expect(ids(result)).toContain(stand)
    }
  })
})

describe("dagFold outside the waves", () => {
  test("the nodes no wave can take come last, with no wave of their own", () => {
    const nodes = [node("start"), node("x", ["y"]), node("y", ["x"])]
    const result = fold(nodes)
    expect(result.rows.map((row) => [row.node.id, row.wave])).toEqual([
      ["start", 0],
      ["x", undefined],
      ["y", undefined],
    ])
  })

  test("a slot that is outside the waves has its children under it, wherever they sit", () => {
    // The slot waits on a cycle; its children do not.
    const nodes = [
      node("loop-a", ["loop-b"]),
      node("loop-b", ["loop-a"]),
      node("plan--split"),
      node("plan--a", ["plan--split"], "plan"),
      node("plan", ["plan--a", "loop-a"]),
    ]
    const result = fold(nodes, ["plan"])
    expect(result.rows.map((row) => [row.node.id, row.wave, row.depth])).toEqual([
      ["plan--split", 0, 0],
      ["loop-a", undefined, 0],
      ["loop-b", undefined, 0],
      ["plan", undefined, 0],
      ["plan--a", 1, 1],
    ])
  })
})

describe("dagFold on its inputs and its reach", () => {
  test("it does not change what it is given", () => {
    const nodes = compose()
    const { waves, unplaced } = computeWaves(nodes)
    const before = JSON.stringify({ waves, unplaced })
    const open = new Set(["plan"])
    dagFold(waves, unplaced, open)
    expect(JSON.stringify({ waves, unplaced })).toBe(before)
    expect([...open]).toEqual(["plan"])
  })

  test("a chain of marks thousands long is walked without recursion", () => {
    const length = 5_000
    const nodes = Array.from({ length }, (_, index) =>
      node(
        `n${String(index).padStart(5, "0")}`,
        [],
        index === 0 ? undefined : `n${String(index - 1).padStart(5, "0")}`,
      ),
    )
    const open = nodes.map((each) => each.id)
    const result = fold(nodes, open)
    expect(result.rows).toHaveLength(length)
    expect(result.rows.at(-1)?.depth).toBe(length - 1)
    expect(fold(nodes).rows).toHaveLength(1)
  })
})
