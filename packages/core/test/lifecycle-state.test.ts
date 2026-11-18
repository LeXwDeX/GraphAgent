// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { ref, stateOf } from "@graphagent/core/lifecycle/state"

describe("lifecycle state", () => {
  it("derives the phase and the terminal flags from the vocabulary", () => {
    const queued = stateOf({ ref: ref("job", "job_1"), value: "queued", source: "live", observedAt: 5 })
    expect(queued).toMatchObject({ domain: "job", id: "job_1", value: "queued", phase: "pending", terminal: false })
    expect(queued.settled).toBe(false)
  })

  it("carries `since` only when the owner knows when it entered the value (#1407)", () => {
    const known = stateOf({ ref: ref("job", "job_1"), value: "running", source: "live", since: 1_234 })
    expect(known.since).toBe(1_234)
    // A zero is a time too: only an absent value is left out.
    expect(stateOf({ ref: ref("job", "job_1"), value: "running", source: "live", since: 0 }).since).toBe(0)
    const unknown = stateOf({ ref: ref("job", "job_1"), value: "running", source: "persisted" })
    expect(Object.hasOwn(unknown, "since")).toBe(false)
  })
})
