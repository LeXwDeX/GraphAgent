// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ERROR_CLASS_CANCELLED, NodeStatus, displayState } from "@graphagent/core/dag/core/types"
import {
  DAG_STATE_STYLE,
  DAG_STATE_TABLE,
  dagBarGlyph,
  dagCurrentWave,
  dagDisplayState,
  dagElapsedMs,
  dagEscalationLabel,
  dagFinite,
  dagNodeGlyph,
  dagNodeHistoryLabel,
  dagNodeRow,
  dagStateStyle,
  dagStatusColor,
  dagWorkflowView,
  formatDagAgentInput,
  formatDagAgentMessages,
  formatDagDeadline,
  formatDagDuration,
  formatDagError,
  formatDagOutputPreview,
  formatDagProgress,
  selectMainWorkflow,
  type DagBarGlyph,
  type DagDisplayState,
  type DagNode,
  type DagStatusToken,
  type DagWorkflowSummary,
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
    expect(dagStatusColor("skipped")).toBe("statusQueued")
    expect(dagStatusColor("cancelled")).toBe("statusQueued")
    expect(dagStatusColor("aborted")).toBe("statusQueued")
    expect(dagStatusColor("unknown-status")).toBe("text")
  })

  test("running and queued no longer share a color", () => {
    expect(dagStatusColor("running")).not.toBe(dagStatusColor("queued"))
    expect(dagStatusColor("running")).not.toBe(dagStatusColor("completed"))
  })

  test("node glyphs mirror the todo-item vocabulary", () => {
    expect(dagNodeGlyph("completed")).toBe("✓")
    expect(dagNodeGlyph("failed")).toBe("✗")
    expect(dagNodeGlyph("running")).toBe("●")
    expect(dagNodeGlyph("skipped")).toBe("⊘")
    expect(dagNodeGlyph("cancelled")).toBe("⊘")
    expect(dagNodeGlyph("aborted")).toBe("↯")
    expect(dagNodeGlyph("queued")).toBe("○")
    expect(dagNodeGlyph("pending")).toBe("○")
    expect(dagNodeGlyph("unknown-status")).toBe("○")
  })

  test("a cancelled node is a failed one with the cancelled class, and reads as cancelled everywhere", () => {
    expect(dagStatusColor("failed", "cancelled")).toBe("statusQueued")
    expect(dagNodeGlyph("failed", "cancelled")).toBe("⊘")
    expect(dagBarGlyph("failed", "cancelled")).toBe("╌")
    // Any other class stays a failure.
    expect(dagStatusColor("failed", "timeout")).toBe("error")
    expect(dagNodeGlyph("failed", "exec_failed")).toBe("✗")
  })
})

describe("display states", () => {
  // persisted status, error class, display state, token, bar glyph, row symbol
  const CASES: ReadonlyArray<
    readonly [string, string | undefined, DagDisplayState, DagStatusToken, DagBarGlyph, string]
  > = [
    ["pending", undefined, "pending", "statusQueued", "─", "○"],
    ["queued", undefined, "queued", "statusQueued", "─", "○"],
    ["running", undefined, "running", "statusRunning", "━", "●"],
    ["completed", undefined, "completed", "success", "━", "✓"],
    ["failed", undefined, "failed", "error", "━", "✗"],
    ["failed", "timeout", "failed", "error", "━", "✗"],
    ["failed", "cancelled", "cancelled", "statusQueued", "╌", "⊘"],
    ["aborted", undefined, "aborted", "statusQueued", "╌", "↯"],
    ["skipped", undefined, "skipped", "statusQueued", "╌", "⊘"],
    // Workflow-only statuses: no node row holds them.
    ["paused", undefined, "paused", "statusPaused", "━", "○"],
    ["stepping", undefined, "stepping", "statusPaused", "━", "○"],
    ["cancelled", undefined, "cancelled", "statusQueued", "╌", "⊘"],
  ]

  test.each(CASES)("%s (class %s) displays as %s", (status, errorClass, state, token, bar, glyph) => {
    expect(dagDisplayState(status, errorClass)).toBe(state)
    expect(dagStateStyle(status, errorClass)).toMatchObject({ token, bar, glyph })
    expect(dagStatusColor(status, errorClass)).toBe(token)
    expect(dagBarGlyph(status, errorClass)).toBe(bar)
    expect(dagNodeGlyph(status, errorClass)).toBe(glyph)
  })

  test("the error class only changes a failure", () => {
    expect(dagDisplayState("running", "cancelled")).toBe("running")
    expect(dagDisplayState("completed", "cancelled")).toBe("completed")
    expect(dagDisplayState("failed")).toBe("failed")
    expect(dagDisplayState("failed", "")).toBe("failed")
  })

  test("a status the table does not know has no display state and draws as plain text", () => {
    expect(dagDisplayState("retrying")).toBeUndefined()
    expect(dagStateStyle("retrying")).toMatchObject({ token: "text", bar: "─", glyph: "○" })
  })

  test("the table covers every persisted node status, in step with the core display state", () => {
    for (const status of Object.values(NodeStatus)) {
      // Widened: the core state also has `escalated`, which a node row cannot show.
      const ours: string | undefined = dagDisplayState(status)
      expect(ours, status).toBe(displayState({ status }))
    }
    const cancelled: string | undefined = dagDisplayState("failed", ERROR_CLASS_CANCELLED)
    expect(cancelled).toBe(displayState({ status: "failed", errorClass: ERROR_CLASS_CANCELLED }))
    expect(cancelled).toBe("cancelled")
  })

  test("every state the table can return has a style, and every style is reachable", () => {
    const reachable = new Set(DAG_STATE_TABLE.map((rule) => rule.state))
    expect<string[]>([...reachable].toSorted()).toEqual(Object.keys(DAG_STATE_STYLE).toSorted())
  })

  test("the cancelled rule sits above plain failed, since the first match wins", () => {
    const failed = DAG_STATE_TABLE.map((rule, index) => ({ rule, index })).filter(
      ({ rule }) => rule.status === "failed",
    )
    expect(failed.map(({ rule }) => rule.state)).toEqual(["cancelled", "failed"])
  })

  test("the three bar glyphs tell the states apart without color", () => {
    const solid = (["running", "completed", "failed", "paused", "stepping"] as const).map(
      (state) => DAG_STATE_STYLE[state].bar,
    )
    expect(new Set(solid)).toEqual(new Set(["━"]))
    expect(new Set((["pending", "queued"] as const).map((state) => DAG_STATE_STYLE[state].bar))).toEqual(new Set(["─"]))
    expect(new Set((["skipped", "cancelled", "aborted"] as const).map((state) => DAG_STATE_STYLE[state].bar))).toEqual(
      new Set(["╌"]),
    )
  })

  test("when a wave collapses to one segment the worst state wins: failed, running, paused, waiting, skipped, completed", () => {
    const rank = (state: DagDisplayState) => DAG_STATE_STYLE[state].rank
    expect(rank("failed")).toBeGreaterThan(rank("running"))
    expect(rank("running")).toBeGreaterThan(rank("paused"))
    expect(rank("paused")).toBeGreaterThan(rank("queued"))
    expect(rank("queued")).toBeGreaterThan(rank("skipped"))
    expect(rank("skipped")).toBeGreaterThan(rank("completed"))
    // States that share a glyph and color also share a rank.
    expect(rank("pending")).toBe(rank("queued"))
    expect(rank("stepping")).toBe(rank("paused"))
    expect(new Set([rank("skipped"), rank("cancelled"), rank("aborted")]).size).toBe(1)
  })
})

describe("node rows", () => {
  const wire: DagNode = {
    id: "n1",
    workflow_id: "wf-1",
    name: "build",
    worker_type: "task",
    status: "running",
    required: true,
    depends_on: ["n0"],
    expanded_from: "slot-1",
    model_id: "model-x",
    model_provider_id: "provider-y",
    child_session_id: "ses_child",
    directory: "/work/tree",
    head: "abc123",
    last_activity_at: "2026-01-01T00:00:00Z",
    attempt_id: "attempt-1",
    accepted_input_revision: 4,
    snapshot_revision: 2,
    agent_messages: { queued: 2, delivered: 1, undeliverable: 0, closed_reason: "done" },
    output: { text: "x".repeat(10_000) },
    error_reason: "boom",
    error_class: "timeout",
    deadline_ms: 9_000,
    replan_attempts: 2,
    started_at: 1_000,
    completed_at: 5_000,
    safety_denials: { items: [{ attempt: 1, ruleID: "r", permission: "bash", summary: "denied", at: 1 }], total: 1 },
  }

  test("keeps the display fields and drops the output and the rest", () => {
    const row = dagNodeRow(wire)
    expect(row).toEqual({
      id: "n1",
      workflow_id: "wf-1",
      name: "build",
      worker_type: "task",
      status: "running",
      required: true,
      depends_on: ["n0"],
      expanded_from: "slot-1",
      child_session_id: "ses_child",
      directory: "/work/tree",
      head: "abc123",
      attempt_id: "attempt-1",
      accepted_input_revision: 4,
      snapshot_revision: 2,
      agent_messages: { queued: 2, delivered: 1, undeliverable: 0, closed_reason: "done" },
      error_reason: "boom",
      error_class: "timeout",
      deadline_ms: 9_000,
      replan_attempts: 2,
      started_at: 1_000,
      completed_at: 5_000,
    })
    for (const dropped of ["output", "model_id", "model_provider_id", "last_activity_at", "safety_denials"]) {
      expect(dropped in row, dropped).toBe(false)
    }
  })

  test("the slot a node was generated by is kept, and a node with no mark has no such key", () => {
    expect(dagNodeRow({ ...node("c"), expanded_from: "plan" }).expanded_from).toBe("plan")
    expect("expanded_from" in dagNodeRow(node("c"))).toBe(false)
  })

  test("a bare node has no optional keys, not keys set to undefined", () => {
    const row = dagNodeRow(node("a"))
    expect(Object.keys(row).toSorted()).toEqual(
      ["depends_on", "id", "name", "replan_attempts", "required", "status", "worker_type", "workflow_id"].toSorted(),
    )
  })

  test("resolves the SDK's non-finite sentinels once", () => {
    const row = dagNodeRow({
      ...node("a"),
      replan_attempts: "NaN",
      started_at: "Infinity",
      completed_at: "-Infinity",
      deadline_ms: "NaN",
    })
    expect(row.replan_attempts).toBe(0)
    for (const key of ["started_at", "completed_at", "deadline_ms"]) expect(key in row, key).toBe(false)
  })

  test("shares nothing with the wire object", () => {
    const row = dagNodeRow(wire)
    expect(row.depends_on).not.toBe(wire.depends_on)
    expect(row.agent_messages).not.toBe(wire.agent_messages)
    expect(row.depends_on).toEqual(wire.depends_on)
  })

  test("dagFinite keeps finite numbers and rejects everything else", () => {
    expect(dagFinite(3)).toBe(3)
    expect(dagFinite(0)).toBe(0)
    expect(dagFinite(-1)).toBe(-1)
    expect(dagFinite("NaN")).toBeUndefined()
    expect(dagFinite("Infinity")).toBeUndefined()
    expect(dagFinite(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(dagFinite(Number.NaN)).toBeUndefined()
    expect(dagFinite(undefined)).toBeUndefined()
  })

  test("a stored row feeds the formatters the same way the wire node does", () => {
    const row = dagNodeRow(wire)
    expect(formatDagAgentInput(row)).toBe(formatDagAgentInput(wire))
    expect(formatDagAgentMessages(row)).toBe(formatDagAgentMessages(wire))
    expect(dagNodeHistoryLabel(row)).toBe("restarted ×2")
  })
})

describe("main workflow", () => {
  const workflow = (id: string, status: string): DagWorkflowSummary => ({
    id,
    title: id,
    status,
    graphRev: 1,
    nodeCount: 3,
    completedNodes: 0,
    runningNodes: 0,
    failedNodes: 0,
    skippedNodes: 0,
    abortedNodes: 0,
    queuedNodes: 0,
    escalatedNodes: 0,
  })
  const none = new Set<string>()

  test("an active workflow wins over a failed one and a finished one; the rest fold into +N", () => {
    const selection = selectMainWorkflow([
      workflow("done", "completed"),
      workflow("bad", "failed"),
      workflow("live", "running"),
    ])
    expect(selection.main?.id).toBe("live")
    expect(selection.others.map((w) => w.id)).toEqual(["done", "bad"])
    expect(selection.attention).toBe(true)
  })

  test("running, stepping and paused all count as active", () => {
    for (const status of ["running", "stepping", "paused"]) {
      const selection = selectMainWorkflow([workflow("done", "completed"), workflow("a", status)])
      expect(selection.main?.id, status).toBe("a")
      expect(selection.attention, status).toBe(true)
    }
  })

  test("among equals the first listed wins: the server lists the newest first", () => {
    expect(selectMainWorkflow([workflow("new", "running"), workflow("old", "running")]).main?.id).toBe("new")
    expect(selectMainWorkflow([workflow("new", "failed"), workflow("old", "failed")]).main?.id).toBe("new")
  })

  test("the workflow the user picked in the panel wins while it exists", () => {
    const list = [workflow("live", "running"), workflow("other", "running"), workflow("done", "completed")]
    expect(selectMainWorkflow(list, { chosen: "other" }).main?.id).toBe("other")
    expect(selectMainWorkflow(list, { chosen: "other" }).others.map((w) => w.id)).toEqual(["live", "done"])
    // Even a finished one: the band keeps what the user chose.
    expect(selectMainWorkflow(list, { chosen: "done" }).main?.id).toBe("done")
  })

  test("a choice that no longer exists falls back to the rules", () => {
    const list = [workflow("live", "running")]
    expect(selectMainWorkflow(list, { chosen: "gone" }).main?.id).toBe("live")
  })

  test("with nothing active, a failed workflow the user has not confirmed is kept", () => {
    const list = [workflow("done", "completed"), workflow("bad", "failed")]
    const selection = selectMainWorkflow(list, { acknowledged: none })
    expect(selection.main?.id).toBe("bad")
    expect(selection.attention).toBe(true)
  })

  test("a confirmed failure no longer holds the band", () => {
    const list = [workflow("done", "completed"), workflow("bad", "failed")]
    const selection = selectMainWorkflow(list, { acknowledged: new Set(["bad"]) })
    expect(selection.main).toBeUndefined()
    expect(selection.attention).toBe(false)
    expect(selection.others.map((w) => w.id)).toEqual(["done", "bad"])
  })

  test("a confirmed failure does not hide an active workflow, and an active one outranks an unconfirmed failure", () => {
    const list = [workflow("bad", "failed"), workflow("live", "running")]
    expect(selectMainWorkflow(list, { acknowledged: none }).main?.id).toBe("live")
    expect(selectMainWorkflow(list, { acknowledged: new Set(["bad"]) }).main?.id).toBe("live")
  })

  test("when everything finished there is nothing for an automatic band", () => {
    const selection = selectMainWorkflow([workflow("a", "completed"), workflow("b", "cancelled")])
    expect(selection.main).toBeUndefined()
    expect(selection.attention).toBe(false)
    expect(selection.others).toHaveLength(2)
  })

  test("a workflow that has not started is neither active nor a failure", () => {
    const selection = selectMainWorkflow([workflow("new", "pending")])
    expect(selection.main).toBeUndefined()
    expect(selection.attention).toBe(false)
  })

  test("no workflows at all", () => {
    expect(selectMainWorkflow([])).toEqual({ main: undefined, others: [], attention: false })
  })
})

describe("workflow view", () => {
  const summary: DagWorkflowSummary = {
    id: "wf-1",
    title: "t",
    status: "running",
    graphRev: 1,
    nodeCount: 4,
    completedNodes: 0,
    runningNodes: 0,
    failedNodes: 0,
    skippedNodes: 0,
    abortedNodes: 0,
    queuedNodes: 0,
    escalatedNodes: 0,
  }

  test("before the table loads it holds no nodes and no waves, and the counts stay on the summary", () => {
    const view = dagWorkflowView(summary, undefined)
    expect(view).toEqual({ summary, nodes: [], waves: [], unplaced: [] })
  })

  test("groups the loaded rows into waves and keeps the ones no wave can take", () => {
    const rows = [
      dagNodeRow(node("b", ["a"])),
      dagNodeRow(node("a")),
      dagNodeRow(node("x", ["y"])),
      dagNodeRow(node("y", ["x"])),
    ]
    const view = dagWorkflowView(summary, rows)
    expect(view.nodes).toBe(rows)
    expect(view.waves.map((wave) => wave.map((n) => n.id))).toEqual([["a"], ["b"]])
    expect(view.unplaced.map((n) => n.id)).toEqual(["x", "y"])
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

describe("dagCurrentWave", () => {
  const at = (status: string, error_class?: string) => ({ status, ...(error_class ? { error_class } : {}) })

  test("no waves, no current wave", () => {
    expect(dagCurrentWave([])).toBeUndefined()
  })

  test("is the first wave that still has a node to run or running", () => {
    expect(dagCurrentWave([[at("completed")], [at("running"), at("completed")], [at("pending")]])).toBe(1)
    expect(dagCurrentWave([[at("pending")], [at("pending")]])).toBe(0)
    expect(dagCurrentWave([[at("completed")], [at("queued")]])).toBe(1)
  })

  test("a settled node of any kind is not work left: failed, skipped, aborted and cancelled all pass", () => {
    const settled = [at("failed"), at("skipped"), at("aborted"), at("failed", "cancelled")]
    expect(dagCurrentWave([settled, [at("pending")]])).toBe(1)
  })

  test("a wave that is all settled behind one that is not does not count", () => {
    expect(dagCurrentWave([[at("running")], [at("completed")]])).toBe(0)
  })

  test("once everything has settled it rests on the last wave", () => {
    expect(dagCurrentWave([[at("completed")], [at("completed")], [at("skipped")]])).toBe(2)
  })

  test("a status the table does not know counts as work left, like a waiting node", () => {
    expect(dagCurrentWave([[at("completed")], [at("exotic")]])).toBe(1)
  })
})

describe("dagElapsedMs", () => {
  const ran = (started_at?: number, completed_at?: number) => ({
    status: completed_at === undefined ? "running" : "completed",
    ...(started_at === undefined ? {} : { started_at }),
    ...(completed_at === undefined ? {} : { completed_at }),
  })

  test("nothing has started, so there is nothing to count", () => {
    expect(dagElapsedMs([], 9_000, true)).toBeUndefined()
    expect(dagElapsedMs([ran(), ran()], 9_000, true)).toBeUndefined()
  })

  test("counts from the earliest start up to now while the workflow is going", () => {
    expect(dagElapsedMs([ran(4_000, 6_000), ran(2_000), ran()], 9_000, true)).toBe(7_000)
  })

  test("keeps counting between waves, when every node that started has finished", () => {
    expect(dagElapsedMs([ran(2_000, 3_000), ran(3_000, 4_000)], 9_000, true)).toBe(7_000)
  })

  test("stops at the last completion once the workflow is over", () => {
    expect(dagElapsedMs([ran(2_000, 3_000), ran(3_000, 8_000), ran(2_500, 5_000)], 99_000, false)).toBe(6_000)
  })

  test("a node still marked running in a workflow that is over does not stretch the count", () => {
    expect(dagElapsedMs([ran(2_000, 3_000), ran(2_500)], 99_000, false)).toBe(1_000)
  })

  test("never goes below zero when the clocks disagree", () => {
    expect(dagElapsedMs([ran(12_000)], 9_000, true)).toBe(0)
    expect(dagElapsedMs([ran(12_000)], 9_000, false)).toBe(0)
  })
})
