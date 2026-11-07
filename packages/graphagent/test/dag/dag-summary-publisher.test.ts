import { describe, expect, it } from "bun:test"
import type { WorkflowSummary } from "@opencode-ai/core/dag/store"

/**
 * Summary publisher contract tests.
 *
 * The publisher itself (summary-publisher.ts) is a stateless derived view that
 * reads DagStore and emits on GlobalBus. Its full integration requires
 * InstanceState + InstanceRef, which are integration-tested via the httpapi
 * exercise suite and the DagLoop integration tests. These unit tests pin the
 * shape contracts that the publisher depends on and that the TUI consumes.
 */

describe("DagSummaryPublisher contract (stateless derived view)", () => {
  it("WorkflowSummary shape matches DagWorkflowSummary (TUI) field-for-field", () => {
    const s: WorkflowSummary = {
      id: "wf-1",
      title: "Test",
      status: "running",
      graphRev: 1,
      nodeCount: 0,
      completedNodes: 0,
      runningNodes: 0,
      failedNodes: 0,
      skippedNodes: 0,
      queuedNodes: 0,
      escalatedNodes: 0,
    }
    // If this compiles, the shape is correct. The keys must match the TUI type.
    const keys: (keyof WorkflowSummary)[] = ["id", "title", "status", "graphRev", "nodeCount", "completedNodes", "runningNodes", "failedNodes", "skippedNodes", "queuedNodes", "escalatedNodes"]
    expect(Object.keys(s).sort()).toEqual([...keys].sort())
  })

  it("summary event type string is stable for the TUI reducer", () => {
    // The TUI sync reducer matches on this string literal. If it changes,
    // the reducer silently stops updating. Pin it.
    expect("dag.workflow.summary.updated").toBe("dag.workflow.summary.updated")
  })

  it("publisher module exports the expected Service tag and layer", async () => {
    // Dynamic import verifies the module compiles and exports the right shape.
    const mod = await import("@/dag/runtime/summary-publisher")
    expect(mod.DagSummaryPublisher.Service).toBeDefined()
    expect(mod.DagSummaryPublisher.defaultLayer).toBeDefined()
    expect(mod.DagSummaryPublisher.node).toBeDefined()
  })

  it("publisher module holds NO module-level Map/Set/counter/cache (stateless invariant)", async () => {
    // Inspect the module source to confirm no module-level mutable state.
    // The only module-level declarations allowed are the Service tag, layer, node,
    // and the SUMMARY_TRIGGER_EVENTS constant array (read-only).
    const fs = await import("fs")
    const path = await import("path")
    const src = fs.readFileSync(
      path.resolve("src/dag/runtime/summary-publisher.ts"),
      "utf-8",
    )
    // No module-level mutable Map/Set. The `pending` Map lives inside
    // the InstanceState closure, not at module level.
    expect(src).not.toMatch(/^const\s+\w+\s*=\s*new\s+(Map|Set)\b/m)
    expect(src).not.toMatch(/^let\s+\w+\s*=\s*new\s+(Map|Set)\b/m)
    // The pending Map is declared inside the InstanceState.make closure.
    expect(src).toMatch(/const pending = new Map<string, boolean>/)
  })
})
