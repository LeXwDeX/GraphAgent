// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { DagNode } from "@graphagent/sdk/v2"
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

describe("computeWaves", () => {
  test("empty input produces no waves", () => {
    expect(computeWaves([])).toEqual([])
  })

  test("independent nodes land in one wave sorted by name", () => {
    const waves = computeWaves([node("b"), node("a"), node("c")])
    expect(waves).toHaveLength(1)
    expect(waves[0].map((n) => n.id)).toEqual(["a", "b", "c"])
  })

  test("linear chain produces one wave per node", () => {
    const waves = computeWaves([node("c", ["b"]), node("a"), node("b", ["a"])])
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["a"], ["b"], ["c"]])
  })

  test("diamond topology groups by depth", () => {
    const waves = computeWaves([
      node("root"),
      node("left", ["root"]),
      node("right", ["root"]),
      node("merge", ["left", "right"]),
    ])
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["root"], ["left", "right"], ["merge"]])
  })

  test("dependency cycle terminates and drops only the cycle members", () => {
    const waves = computeWaves([node("a"), node("x", ["y"]), node("y", ["x"])])
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["a"]])
  })

  test("dependency on a missing node is treated as satisfied (replan removed it)", () => {
    const waves = computeWaves([node("a", ["ghost"]), node("b", ["a"])])
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["a"], ["b"]])
  })
})
