// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { LoopMessage } from "@/loop/message"
import { intent } from "./fixture"

const base = { kind: "next", round: 3, maxRounds: 20, origin: "Make the build green." } as const

describe("LoopMessage.render", () => {
  test("puts the header first, the prompt in the middle and the final goal last", () => {
    const text = LoopMessage.render({ ...base, prompt: "Fix the flaky test.", intent: intent() })
    const header = text.indexOf("[Loop round 3/20: continuing]")
    const prompt = text.indexOf("## This round\nFix the flaky test.")
    const tail = text.indexOf("## Final goal")
    expect(header).toBe(0)
    expect(prompt).toBeGreaterThan(header)
    expect(tail).toBeGreaterThan(prompt)
  })

  test("starts with the prefix the automation check looks for, whatever the kind", () => {
    for (const kind of ["next", "wake", "review", "recovery"] as const) {
      expect(LoopMessage.render({ ...base, kind }).startsWith(LoopMessage.PREFIX)).toBe(true)
    }
  })

  test("tells the agent how to declare how a round ended, and that questions will not be answered", () => {
    const text = LoopMessage.render(base)
    for (const word of ["`await`", "`done`", "`blocked`", "Interactive questions are disabled"]) {
      expect(text).toContain(word)
    }
  })

  test("appends the objective, constraints and non-goals of the latest intent verbatim", () => {
    const text = LoopMessage.render({
      ...base,
      intent: intent({ objective: "Ship it.", constraints: ["Keep the API", "No new deps"], non_goals: ["A rewrite"] }),
    })
    expect(text).toContain("Objective: Ship it.")
    expect(text).toContain("Constraints:\n- Keep the API\n- No new deps")
    expect(text).toContain("Out of scope:\n- A rewrite")
  })

  test("falls back to the user's own words before any intent exists, and leaves empty lists out", () => {
    const text = LoopMessage.render(base)
    expect(text).toContain("Objective: Make the build green.")
    expect(text).not.toContain("Constraints:")
    expect(text).not.toContain("Out of scope:")
    expect(text).not.toContain("## This round")
    expect(text).not.toContain("## Why this round started")
  })

  test("puts the reason of a wake, a review or a recovery between the header and the prompt", () => {
    const text = LoopMessage.render({ ...base, kind: "wake", note: "job_1 finished", prompt: "Use its output." })
    expect(text.indexOf("## Why this round started\njob_1 finished")).toBeLessThan(text.indexOf("## This round"))
    expect(text).toContain("[Loop round 3/20: woken by an event]")
  })
})
