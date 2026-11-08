import { describe, expect, test } from "bun:test"
import {
  ERROR_CLASS_BUDGET_EXHAUSTED,
  ERROR_CLASS_CANCELLED,
  NODE_STATUS_VALUES,
  NODE_TERMINAL_STATUS_VALUES,
  PAUSE_REASON_BUDGET_EXHAUSTED,
  WORKFLOW_STATUS_VALUES,
  WORKFLOW_TERMINAL_STATUS_VALUES,
  displayState,
  isActive,
  isSettled,
  isTerminal,
} from "../src/dag-status"

describe("DAG status vocabulary (D11)", () => {
  test("workflow literals are exactly the seven persisted statuses, without archived", () => {
    expect(WORKFLOW_STATUS_VALUES).toEqual([
      "pending",
      "running",
      "paused",
      "stepping",
      "completed",
      "failed",
      "cancelled",
    ])
    expect(WORKFLOW_STATUS_VALUES).not.toContain("archived")
  })

  test("node literals are exactly the seven persisted statuses, without paused", () => {
    expect(NODE_STATUS_VALUES).toEqual([
      "pending",
      "queued",
      "running",
      "completed",
      "failed",
      "aborted",
      "skipped",
    ])
    expect(NODE_STATUS_VALUES).not.toContain("paused")
  })

  test("terminal sets cover both domains without treating archived/paused as terminal", () => {
    expect(WORKFLOW_TERMINAL_STATUS_VALUES).toEqual(["completed", "failed", "cancelled"])
    expect(NODE_TERMINAL_STATUS_VALUES).toEqual(["completed", "failed", "aborted", "skipped"])
    for (const status of [...WORKFLOW_TERMINAL_STATUS_VALUES, ...NODE_TERMINAL_STATUS_VALUES]) {
      expect(isTerminal(status)).toBe(true)
      expect(isActive(status)).toBe(false)
    }
    for (const status of ["pending", "running", "paused", "stepping", "queued", "archived"]) {
      expect(isTerminal(status)).toBe(false)
      expect(isActive(status)).toBe(true)
    }
  })

  test("settled is exactly completed|skipped; aborted and failed are not settled", () => {
    expect(isSettled("completed")).toBe(true)
    expect(isSettled("skipped")).toBe(true)
    for (const status of ["pending", "queued", "running", "paused", "stepping", "failed", "aborted", "cancelled"]) {
      expect(isSettled(status)).toBe(false)
    }
  })

  test("displayState exposes cancellation and timeout escalation structurally", () => {
    // Cancellation is failed + error_class=cancelled, never an error_reason string.
    expect(displayState({ status: "failed", errorClass: ERROR_CLASS_CANCELLED })).toBe("cancelled")
    expect(displayState({ status: "failed", errorClass: ERROR_CLASS_BUDGET_EXHAUSTED })).toBe("failed")
    expect(displayState({ status: "failed", errorClass: null })).toBe("failed")
    // A running node awaiting timeout adjudication reads as escalated.
    expect(displayState({ status: "running", escalationPending: true })).toBe("escalated")
    expect(displayState({ status: "running", escalationPending: false })).toBe("running")
    expect(displayState({ status: "queued" })).toBe("queued")
    expect(displayState({ status: "completed" })).toBe("completed")
  })

  test("pause reason and error-class constants are stable wire values", () => {
    expect(PAUSE_REASON_BUDGET_EXHAUSTED).toBe("budget_exhausted")
    expect(ERROR_CLASS_CANCELLED).toBe("cancelled")
    expect(ERROR_CLASS_BUDGET_EXHAUSTED).toBe("budget_exhausted")
  })
})
