// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import {
  dagEscalationLabel,
  dagNodeGlyph,
  dagNodeHistoryLabel,
  dagStatusColor,
  formatDagAgentInput,
  formatDagAgentMessages,
  formatDagDeadline,
  formatDagDuration,
  formatDagError,
  formatDagOutputPreview,
  formatDagProgress,
  type DagNode,
} from "../../src/dag/model"

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

describe("agent observations", () => {
  test("keeps legacy nodes compatible and distinguishes accepted input from frozen snapshots", () => {
    expect(formatDagAgentMessages(node("legacy"))).toBeUndefined()
    expect(formatDagAgentInput(node("legacy"))).toBeUndefined()
    const observed = {
      ...node("worker"),
      attempt_id: "attempt-1",
      accepted_input_revision: 4,
      snapshot_revision: 2,
      agent_messages: { queued: 2, delivered: 1, undeliverable: 1 },
    }
    expect(formatDagAgentMessages(observed)).toBe("messages 2 queued · 1 delivered · 1 undeliverable")
    expect(formatDagAgentInput(observed)).toBe("attempt attempt-1 · input 4 · snapshot 2")
  })
})

describe("shared status presentation", () => {
  test("one status maps to one theme token across every DAG surface", () => {
    expect(dagStatusColor("completed")).toBe("success")
    expect(dagStatusColor("failed")).toBe("error")
    expect(dagStatusColor("paused")).toBe("statusPaused")
    expect(dagStatusColor("stepping")).toBe("statusPaused")
    expect(dagStatusColor("running")).toBe("statusRunning")
    expect(dagStatusColor("pending")).toBe("statusQueued")
    expect(dagStatusColor("queued")).toBe("statusQueued")
    expect(dagStatusColor("skipped")).toBe("textMuted")
    expect(dagStatusColor("cancelled")).toBe("textMuted")
    expect(dagStatusColor("aborted")).toBe("textMuted")
    expect(dagStatusColor("unknown-status")).toBe("text")
  })

  test("node glyphs mirror the todo-item vocabulary", () => {
    expect(dagNodeGlyph("completed")).toBe("✓")
    expect(dagNodeGlyph("failed")).toBe("✗")
    expect(dagNodeGlyph("skipped")).toBe("⊘")
    expect(dagNodeGlyph("aborted")).toBe("↯")
    expect(dagNodeGlyph("queued")).toBe("◌")
    expect(dagNodeGlyph("pending")).toBe("○")
  })
})

describe("formatDagError", () => {
  test("removes Effect and provider error wrappers without hiding the useful message", () => {
    expect(
      formatDagError("Cause([Die(ProviderModelNotFoundError: Model not found: local/local/glm. Did you mean: glm?)])"),
    ).toBe("Model not found: local/local/glm. Did you mean: glm?")
  })
})

describe("node detail formatting", () => {
  test("formats durations and tolerates SDK non-finite sentinels", () => {
    expect(formatDagDuration(1_000, 63_000)).toBe("1m 2s")
    expect(formatDagDuration(1_000, 5_000)).toBe("4s")
    expect(formatDagDuration(undefined, 5_000)).toBeUndefined()
    expect(formatDagDuration("NaN", 5_000)).toBeUndefined()
  })

  test("flattens output previews to one bounded line", () => {
    expect(formatDagOutputPreview("line one\n  line two")).toBe("line one line two")
    expect(formatDagOutputPreview({ verdict: "ACCEPT" })).toBe('{"verdict":"ACCEPT"}')
    expect(formatDagOutputPreview(null)).toBeUndefined()
    expect(formatDagOutputPreview("   ")).toBeUndefined()
    expect(formatDagOutputPreview("x".repeat(300))?.length).toBe(201)
  })

  test("deadline countdown only labels nodes still executing", () => {
    expect(formatDagDeadline("running", 63_000, 1_000)).toBe("1m 2s left")
    expect(formatDagDeadline("queued", 5_000, 1_000)).toBe("4s left")
    expect(formatDagDeadline("running", 1_000, 5_000)).toBe("overdue")
    expect(formatDagDeadline("completed", 63_000, 1_000)).toBeUndefined()
    expect(formatDagDeadline("running", undefined, 1_000)).toBeUndefined()
    expect(formatDagDeadline("running", "Infinity", 1_000)).toBeUndefined()
  })

  test("replan history label appears only after a restart", () => {
    expect(dagNodeHistoryLabel({ replan_attempts: 0 })).toBeUndefined()
    expect(dagNodeHistoryLabel({ replan_attempts: 1 })).toBe("restarted ×1")
    expect(dagNodeHistoryLabel({ replan_attempts: 3 })).toBe("restarted ×3")
  })

  test("progress splits settled into completed/skipped so a skipped majority is not a false success (P1-E)", () => {
    expect(formatDagProgress({ nodeCount: 9, completedNodes: 3, skippedNodes: 4 })).toBe("7/9 ✓3 ⊘4")
    expect(formatDagProgress({ nodeCount: 2, completedNodes: 0, skippedNodes: 0 })).toBe("0/2")
    // audit #8 — the incident shape: a cancelled workflow's 1 completed + 7
    // skipped must NOT read as a bare "8/8" success; the ✓/⊘ split exposes it.
    expect(formatDagProgress({ nodeCount: 8, completedNodes: 1, skippedNodes: 7 })).toBe("8/8 ✓1 ⊘7")
    // D11: aborted is terminal but not settled — it stays out of the numerator.
    expect(formatDagProgress({ nodeCount: 8, completedNodes: 1, skippedNodes: 6, abortedNodes: 1 })).toBe(
      "7/8 ✓1 ⊘6 ↯1",
    )
  })
})

describe("dagEscalationLabel", () => {
  test("shows the timeout-pending count only when a node is escalated", () => {
    expect(dagEscalationLabel({ escalatedNodes: 0 })).toBeUndefined()
    expect(dagEscalationLabel({ escalatedNodes: 2 })).toBe("timeout ×2")
    expect(dagEscalationLabel({ escalatedNodes: "Infinity" })).toBeUndefined()
  })
})
