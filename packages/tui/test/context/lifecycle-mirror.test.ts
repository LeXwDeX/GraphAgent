// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { LifecycleState } from "@graphagent/sdk"
import {
  entryFromState,
  entryFromTransition,
  goalStatus,
  isFinishedPhase,
  LIFECYCLE_MIRROR_MAX,
  lifecycleKey,
  overflowKeys,
  type LifecycleMirrorEntry,
} from "../../src/context/lifecycle-mirror"

function entry(id: string, phase: LifecycleMirrorEntry["phase"], at: number): LifecycleMirrorEntry {
  return { domain: "job", id, value: phase, phase, at }
}

describe("lifecycleKey", () => {
  test("names a ref by domain and id", () => {
    expect(lifecycleKey({ domain: "job", id: "job_1" })).toBe("job:job_1")
    expect(lifecycleKey({ domain: "goal", id: "ses_a" })).toBe("goal:ses_a")
  })
})

describe("entryFromTransition", () => {
  test("keeps the value the event moved to and the session it names", () => {
    expect(
      entryFromTransition({
        domain: "job",
        stateID: "job_1",
        sessionID: "ses_a",
        from: "running",
        to: "settling",
        phase: "settling",
        reason: "process_restart",
        timestamp: 1_700,
      }),
    ).toEqual({
      domain: "job",
      id: "job_1",
      sessionID: "ses_a",
      value: "settling",
      phase: "settling",
      reason: "process_restart",
      at: 1_700,
    })
  })

  test("a transition without a session or reason leaves them out", () => {
    const next = entryFromTransition({
      domain: "turn",
      stateID: "turn_1",
      to: "ended",
      phase: "succeeded",
      timestamp: 5,
    })
    expect(next.sessionID).toBeUndefined()
    expect(next.reason).toBeUndefined()
  })
})

describe("entryFromState", () => {
  const state: LifecycleState = {
    domain: "goal",
    id: "ses_a",
    value: "paused",
    phase: "paused",
    terminal: false,
    settled: false,
    source: "persisted",
    observedAt: 900,
  }

  test("carries the session over from the transition that introduced the ref", () => {
    expect(entryFromState(state, "ses_a")).toEqual({
      domain: "goal",
      id: "ses_a",
      sessionID: "ses_a",
      value: "paused",
      phase: "paused",
      at: 900,
    })
  })

  test("a non-finite observation time falls back to a finite one", () => {
    const next = entryFromState({ ...state, observedAt: "NaN" }, undefined)
    expect(Number.isFinite(next.at)).toBe(true)
    expect(next.sessionID).toBeUndefined()
  })
})

describe("isFinishedPhase", () => {
  test("only the phases that will not change on their own are finished", () => {
    for (const phase of ["succeeded", "failed", "cancelled", "skipped"] as const) {
      expect(isFinishedPhase(phase)).toBe(true)
    }
    for (const phase of ["pending", "running", "waiting", "settling", "paused"] as const) {
      expect(isFinishedPhase(phase)).toBe(false)
    }
  })
})

describe("overflowKeys", () => {
  test("keeps everything while within the limit", () => {
    const entries = new Map([["job:a", entry("a", "running", 1)]])
    expect(overflowKeys(entries, 1)).toEqual([])
    expect(overflowKeys(entries)).toEqual([])
  })

  test("evicts finished entries before live ones, oldest first", () => {
    const entries = new Map([
      ["job:live_old", entry("live_old", "running", 1)],
      ["job:done_new", entry("done_new", "succeeded", 40)],
      ["job:done_old", entry("done_old", "failed", 10)],
      ["job:live_new", entry("live_new", "paused", 50)],
      ["job:done_mid", entry("done_mid", "cancelled", 20)],
    ])
    expect(overflowKeys(entries, 3)).toEqual(["job:done_old", "job:done_mid"])
    expect(overflowKeys(entries, 1)).toEqual(["job:done_old", "job:done_mid", "job:done_new", "job:live_old"])
  })

  test("falls back to the oldest live entries when nothing has finished", () => {
    const entries = new Map([
      ["job:a", entry("a", "running", 30)],
      ["job:b", entry("b", "waiting", 10)],
      ["job:c", entry("c", "pending", 20)],
    ])
    expect(overflowKeys(entries, 2)).toEqual(["job:b"])
  })

  test("the default limit is the mirror limit", () => {
    const entries = new Map<string, LifecycleMirrorEntry>()
    for (let index = 0; index < LIFECYCLE_MIRROR_MAX + 3; index++) {
      entries.set(`job:${index}`, entry(String(index), "succeeded", index))
    }
    expect(overflowKeys(entries)).toEqual(["job:0", "job:1", "job:2"])
  })
})

describe("goalStatus", () => {
  test("accepts the statuses the goal slice knows", () => {
    for (const value of ["active", "waiting", "paused", "done"] as const) expect(goalStatus(value)).toBe(value)
  })

  test("rejects every other lifecycle value", () => {
    for (const value of ["running", "settling", "completed", "ended", ""]) expect(goalStatus(value)).toBeUndefined()
  })
})
