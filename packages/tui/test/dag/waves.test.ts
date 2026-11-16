// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { DagNode } from "@graphagent/sdk"
import { dagNodeRow } from "../../src/dag/model"
import { computeWaves } from "../../src/dag/waves"

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
