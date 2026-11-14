// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { classifyPoll, type Snapshot } from "@/pr-watch/forge"

/**
 * #1071 PR2: the poller's classification keeps watching across a head change.
 * The one-shot tool still uses `classify`, which reports `superseded`.
 */

const snapshot = (input: Partial<Snapshot> & Pick<Snapshot, "head">): Snapshot => ({
  state: "open",
  review: "NONE",
  checks: { total: 1, pending: 1, failed: 0, passed: 0 },
  ...input,
})

describe("classifyPoll", () => {
  test("rebaselines onto a new head instead of terminating", () => {
    expect(classifyPoll({ head: "a", review: "NONE" }, snapshot({ head: "b" }))).toEqual({
      kind: "rebaseline",
      head: "b",
      review: "NONE",
    })
  })

  test("a merged or closed request is terminal even on a new head", () => {
    expect(classifyPoll({ head: "a", review: "NONE" }, snapshot({ head: "b", state: "merged" }))).toEqual({
      kind: "observe",
      outcome: "merged",
    })
    expect(classifyPoll({ head: "a", review: "NONE" }, snapshot({ head: "b", state: "closed" }))).toEqual({
      kind: "observe",
      outcome: "closed",
    })
  })

  test("observes failures, settled success and review changes on the baseline head", () => {
    expect(
      classifyPoll(
        { head: "a", review: "NONE" },
        snapshot({ head: "a", checks: { total: 1, pending: 0, failed: 1, passed: 0 } }),
      ),
    ).toEqual({ kind: "observe", outcome: "failure" })
    expect(
      classifyPoll(
        { head: "a", review: "NONE" },
        snapshot({ head: "a", checks: { total: 1, pending: 0, failed: 0, passed: 1 } }),
      ),
    ).toEqual({ kind: "observe", outcome: "success" })
    expect(classifyPoll({ head: "a", review: "NONE" }, snapshot({ head: "a", review: "APPROVED" }))).toEqual({
      kind: "observe",
      outcome: "review",
    })
    expect(classifyPoll({ head: "a", review: "NONE" }, snapshot({ head: "a" }))).toEqual({ kind: "continue" })
  })

  test("does not treat a missing check rollup as success", () => {
    expect(
      classifyPoll(
        { head: "a", review: "NONE" },
        snapshot({ head: "a", checks: { total: 0, pending: 0, failed: 0, passed: 0 } }),
      ),
    ).toEqual({ kind: "continue" })
  })
})