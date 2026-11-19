// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { EventManifest } from "../src/event-manifest"
import { SessionID } from "../src/session-id"
import { SessionLoop } from "../src/session-loop"
import { STOP_REASON_VALUES, type StopReason, type StopRecord } from "../src/stop-reason"

const at = 1_700_000_000_000
const sessionID = SessionID.make("ses_1")

// One record per reason, typed so that a reason without a sample, or a sample under
// the wrong reason, does not compile.
const samples: { readonly [R in StopReason]: Extract<StopRecord, { readonly reason: R }> } = {
  completed: { reason: "completed", at },
  user_stopped: { reason: "user_stopped", at },
  user_interrupted: { reason: "user_interrupted", at },
  goal_changed: { reason: "goal_changed", detail: { code: "explicit" }, at },
  needs_user: { reason: "needs_user", detail: { code: "open_question" }, at },
  provider_unavailable: {
    reason: "provider_unavailable",
    detail: { code: "APIError", status: 503, message: "upstream unavailable" },
    at,
  },
  context_exhausted: { reason: "context_exhausted", at },
  content_refused: { reason: "content_refused", at },
  hook_stopped: { reason: "hook_stopped", detail: { message: "blocked by policy" }, at },
  session_archived: { reason: "session_archived", at },
  budget_exhausted: { reason: "budget_exhausted", at },
  no_progress: { reason: "no_progress", at },
  wait_expired: { reason: "wait_expired", at },
  analysis_failed: { reason: "analysis_failed", detail: { code: "limit" }, at },
  internal_error: { reason: "internal_error", detail: { code: "structured_missing", message: "defect" }, at },
}

const roundTrip = (record: SessionLoop.StopRecord) =>
  Schema.decodeUnknownSync(SessionLoop.StopRecord)(
    JSON.parse(JSON.stringify(Schema.encodeSync(SessionLoop.StopRecord)(record))),
  )

describe("SessionLoop.StopRecord (#1329)", () => {
  test("has a sample for every stop reason, and each one round-trips", () => {
    expect(Object.keys(samples).toSorted()).toEqual([...STOP_REASON_VALUES].toSorted())
    for (const reason of STOP_REASON_VALUES) expect(roundTrip(samples[reason]), reason).toEqual(samples[reason])
  })

  test("round-trips the detail variants of user_stopped and goal_changed", () => {
    const variants: ReadonlyArray<SessionLoop.StopRecord> = [
      { reason: "user_stopped", detail: { basis_message_id: "msg_1" }, at },
      { reason: "user_stopped", detail: { code: "migrated", message: "paused by the user" }, at },
      { reason: "goal_changed", detail: { code: "inferred", basis_message_id: "msg_2" }, at },
      { reason: "needs_user", detail: { code: "rejected" }, at },
      { reason: "analysis_failed", detail: { code: "invalid_output" }, at },
    ]
    for (const record of variants) expect(roundTrip(record)).toEqual(record)
  })

  test("rejects what the vocabulary does not allow", () => {
    const decode = (value: unknown) => () => Schema.decodeUnknownSync(SessionLoop.StopRecord)(value)
    expect(decode({ reason: "paused", at })).toThrow()
    expect(decode({ reason: "completed" })).toThrow()
    expect(decode({ reason: "needs_user", at })).toThrow()
    expect(decode({ reason: "needs_user", detail: { code: "other" }, at })).toThrow()
    expect(decode({ reason: "goal_changed", at })).toThrow()
    expect(decode({ reason: "goal_changed", detail: { code: "inferred" }, at })).toThrow()
    expect(decode({ reason: "hook_stopped", detail: {}, at })).toThrow()
    expect(decode({ reason: "analysis_failed", detail: { code: "provider" }, at })).toThrow()
    expect(decode({ reason: "completed", at: "yesterday" })).toThrow()
  })
})

describe("loop events (#1329)", () => {
  const info: SessionLoop.Info = {
    loopID: "loop_1",
    status: "waiting",
    round: 2,
    maxRounds: 20,
    prompt: "Make the build green.",
    objective: "The build is green on every platform",
    analyzing: true,
    probeAt: at,
    wait: { source: "background_job", deadline: at },
    intentRevision: 1,
    lastVerdict: "continue",
    lastReason: "One item is still unmet.",
    stop: samples.provider_unavailable,
  }

  test("are public, transient and registered in the manifest", () => {
    const { Updated, Cleared } = SessionLoop.Event
    expect([Updated.type, Cleared.type]).toEqual(["loop.updated", "loop.cleared"])
    expect(Updated.durable).toBeUndefined()
    expect(Cleared.durable).toBeUndefined()
    expect(SessionLoop.Event.Definitions).toEqual([Updated, Cleared])
    expect(EventManifest.Latest.get("loop.updated")).toBe(Updated)
    expect(EventManifest.Latest.get("loop.cleared")).toBe(Cleared)
  })

  test("loop.updated carries the loop, with only the identity and the counters required", () => {
    const decode = Schema.decodeUnknownSync(SessionLoop.Event.Updated.data)
    expect(decode({ sessionID, loop: info })).toEqual({ sessionID, loop: info })
    const minimal: SessionLoop.Info = {
      loopID: "loop_2",
      status: "active",
      round: 1,
      maxRounds: 20,
      prompt: "go",
      analyzing: false,
      intentRevision: 0,
    }
    expect(decode({ sessionID, loop: minimal }).loop).toEqual(minimal)
    expect(() => decode({ sessionID, loop: { ...minimal, status: "paused" } })).toThrow()
    expect(() => decode({ sessionID, loop: { ...minimal, analyzing: undefined } })).toThrow()
  })

  test("loop.cleared carries the terminal status and the stop record, or neither for a removed session", () => {
    const decode = Schema.decodeUnknownSync(SessionLoop.Event.Cleared.data)
    const ended = { sessionID, status: "cancelled" as const, stop: samples.goal_changed }
    expect(decode(ended)).toEqual(ended)
    expect(decode({ sessionID })).toEqual({ sessionID })
    expect(() => decode({ sessionID, status: "stopped", stop: samples.no_progress })).toThrow()
    expect(() => decode({ sessionID, status: "completed", stop: { reason: "paused", at } })).toThrow()
  })
})
