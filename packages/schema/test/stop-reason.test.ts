// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import {
  STOP_REASON_PROPS,
  STOP_REASON_VALUES,
  type Stop,
  type StopClass,
  type StopReason,
  type StopReasonProps,
  type StopRecord,
} from "../src/stop-reason"

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T

// Compile-time coverage. A reason missing from the property table or from `Stop`
// (or a stray one in either) turns these into errors.
export type PropsCoverEveryReason = Assert<Equal<keyof typeof STOP_REASON_PROPS, StopReason>>
export type StopCoversEveryReason = Assert<Equal<Stop["reason"], StopReason>>

// The negative side of the same guarantee: dropping a row, or adding a key that is
// not a reason, must not compile. `@ts-expect-error` fails the typecheck if it does.
const droppedRow = {
  completed: { class: "completion", ends: "completed" },
  user_stopped: { class: "user", ends: "no" },
  user_interrupted: { class: "user", ends: "no" },
  goal_changed: { class: "user", ends: "cancelled" },
  needs_user: { class: "needs_human", ends: "no" },
  provider_unavailable: { class: "external", ends: "no" },
  context_exhausted: { class: "external", ends: "no" },
  content_refused: { class: "external", ends: "no" },
  hook_stopped: { class: "external", ends: "no" },
  session_archived: { class: "external", ends: "cancelled" },
  budget_exhausted: { class: "guardrail", ends: "no" },
  no_progress: { class: "guardrail", ends: "no" },
  wait_expired: { class: "guardrail", ends: "no" },
  analysis_failed: { class: "guardrail", ends: "no" },
  // internal_error is missing
  // @ts-expect-error the table must cover every reason (TS reports it at `satisfies`)
} satisfies Record<StopReason, StopReasonProps>

// @ts-expect-error a key that is not a reason does not belong in the table
const strayRow = { ...STOP_REASON_PROPS, not_a_reason: { class: "fallback", ends: "no" } } satisfies Record<
  StopReason,
  StopReasonProps
>

// @ts-expect-error a reason whose row defines a detail cannot omit it
const missingDetail: Stop = { reason: "needs_user" }
// @ts-expect-error a reason without a detail row cannot carry one
const strayDetail: Stop = { reason: "completed", detail: { code: "x" } }
// @ts-expect-error `code` is a closed set per reason
const wrongCode: Stop = { reason: "needs_user", detail: { code: "other" } }
// @ts-expect-error an inferred goal change names the message it rests on
const noBasis: Stop = { reason: "goal_changed", detail: { code: "inferred" } }

const CLASSES = {
  completion: ["completed"],
  user: ["user_stopped", "user_interrupted", "goal_changed"],
  needs_human: ["needs_user"],
  external: ["provider_unavailable", "context_exhausted", "content_refused", "hook_stopped", "session_archived"],
  guardrail: ["budget_exhausted", "no_progress", "wait_expired", "analysis_failed"],
  fallback: ["internal_error"],
} satisfies Record<StopClass, StopReason[]>

describe("stop reason vocabulary (#1327)", () => {
  test("has exactly the 15 reasons, each once", () => {
    expect(STOP_REASON_VALUES).toEqual([
      "completed",
      "user_stopped",
      "user_interrupted",
      "goal_changed",
      "needs_user",
      "provider_unavailable",
      "context_exhausted",
      "content_refused",
      "hook_stopped",
      "session_archived",
      "budget_exhausted",
      "no_progress",
      "wait_expired",
      "analysis_failed",
      "internal_error",
    ])
    expect(STOP_REASON_VALUES.length).toBe(15)
    expect(new Set(STOP_REASON_VALUES).size).toBe(15)
  })

  test("the property table has a row for every reason and no other", () => {
    expect(Object.keys(STOP_REASON_PROPS).sort()).toEqual([...STOP_REASON_VALUES].sort())
  })

  test("each class holds the reasons the spec lists", () => {
    for (const [name, reasons] of Object.entries(CLASSES)) {
      const actual = STOP_REASON_VALUES.filter((reason) => STOP_REASON_PROPS[reason].class === name)
      expect(actual).toEqual(reasons)
    }
    expect(Object.values(CLASSES).flat().length).toBe(15)
  })

  test("only completed completes; goal_changed and session_archived cancel; the rest stay resumable", () => {
    for (const reason of STOP_REASON_VALUES) {
      const expected =
        reason === "completed"
          ? "completed"
          : reason === "goal_changed" || reason === "session_archived"
            ? "cancelled"
            : "no"
      expect(STOP_REASON_PROPS[reason].ends).toBe(expected)
    }
  })

  test("detail shapes follow the reason table, and every reason that defines one is sampled", () => {
    const samples = [
      { reason: "user_stopped" },
      { reason: "user_stopped", detail: { basis_message_id: "msg_1" } },
      { reason: "user_stopped", detail: { code: "migrated", message: "paused: waiting for review" } },
      { reason: "goal_changed", detail: { code: "explicit" } },
      { reason: "goal_changed", detail: { code: "inferred", basis_message_id: "msg_2" } },
      { reason: "needs_user", detail: { code: "open_question" } },
      { reason: "needs_user", detail: { code: "rejected" } },
      { reason: "provider_unavailable", detail: { code: "APIError", status: 503, message: "down" } },
      { reason: "provider_unavailable", detail: { code: "APIError", message: "fetch failed" } },
      { reason: "hook_stopped", detail: { message: "policy" } },
      { reason: "analysis_failed", detail: { code: "invalid_output" } },
      { reason: "analysis_failed", detail: { code: "limit" } },
      { reason: "internal_error", detail: { code: "TypeError", message: "boom" } },
    ] satisfies Stop[]
    expect(new Set(samples.map((sample) => sample.reason))).toEqual(
      new Set([
        "user_stopped",
        "goal_changed",
        "needs_user",
        "provider_unavailable",
        "hook_stopped",
        "analysis_failed",
        "internal_error",
      ]),
    )
    expect(wrongCode).toBeDefined()
    expect(noBasis).toBeDefined()
  })

  test("a stop record is a stop plus the time it happened", () => {
    const record: StopRecord = {
      reason: "provider_unavailable",
      detail: { code: "APIError", status: 503, message: "down" },
      at: 1,
    }
    expect(record.at).toBe(1)
    expect(droppedRow).toBeDefined()
    expect(strayRow).toBeDefined()
    expect(missingDetail).toBeDefined()
    expect(strayDetail).toBeDefined()
  })
})
