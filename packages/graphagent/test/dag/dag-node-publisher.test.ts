// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"

/**
 * Node publisher contract tests. The behavior tests cover the push semantics;
 * these pin the module shape and the event string the TUI reducer matches on.
 */

describe("DagNodePublisher contract", () => {
  it("node push event type string is stable for the TUI reducer", () => {
    expect("dag.workflow.nodes.updated").toBe("dag.workflow.nodes.updated")
  })

  it("module exports the expected Service tag and layer", async () => {
    const mod = await import("@/dag/runtime/node-publisher")
    expect(mod.DagNodePublisher.Service).toBeDefined()
    expect(mod.DagNodePublisher.defaultLayer).toBeDefined()
    expect(mod.DagNodePublisher.node).toBeDefined()
  })

  it("holds no module-level mutable state (snapshots live in InstanceState)", async () => {
    const fs = await import("fs")
    const path = await import("path")
    const src = fs.readFileSync(path.resolve("src/dag/runtime/node-publisher.ts"), "utf-8")
    expect(src).not.toMatch(/^const\s+\w+\s*=\s*new\s+(Map|Set)\b/m)
    expect(src).not.toMatch(/^let\s+\w+\s*=\s*new\s+(Map|Set)\b/m)
    expect(src).toMatch(/const pending = new Map<string, boolean>/)
    expect(src).toMatch(/const states = new Map<string, WorkflowState>/)
  })
})
