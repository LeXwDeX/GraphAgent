// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { RuntimeSlots } from "../../src/session/runtime-slots"
import { SessionID } from "../../src/session/schema"
import { it } from "../lib/effect"

const environment = { directory: "/work/project", root: "/work", git: true }

describe("RuntimeSlots.state", () => {
  test("keeps goal and memory first and in their original order", () => {
    const slots = RuntimeSlots.state({
      goal: ["goal-progress"],
      memory: ["memory-data"],
      environment,
      now: new Date(0),
      custom: [{ key: "dag_mode", parts: ["dag-mode"], cleared: "DAG mode is off." }],
    })
    expect(slots.map((slot) => slot.key)).toEqual(["goal", "memory", "env", "date", "dag_mode"])
    expect(slots[0]?.parts).toEqual(["goal-progress"])
    expect(slots[1]?.parts).toEqual(["memory-data"])
  })

  test("carries the working directory, workspace root and git state, but never the date", () => {
    const slot = RuntimeSlots.environment(environment)
    const text = slot.parts.join("\n")
    expect(text).toContain("Working directory: /work/project")
    expect(text).toContain("Workspace root folder: /work")
    expect(text).toContain("Is directory a git repo: yes")
    expect(text).not.toContain("Today's date")
  })

  test("announces cleared goal, memory and environment state", () => {
    expect(RuntimeSlots.goal([]).cleared).toBe("No autonomous goal is active.")
    expect(RuntimeSlots.memory([]).cleared).toBe("No project memory data applies to the current request.")
    expect(RuntimeSlots.environment(environment).cleared).toBe("No environment information is available.")
  })

  test("the date slot changes with the calendar day", () => {
    const first = RuntimeSlots.date(new Date("2026-11-11T23:59:00Z"))
    const same = RuntimeSlots.date(new Date("2026-11-11T10:00:00Z"))
    const next = RuntimeSlots.date(new Date("2026-11-12T00:01:00Z"))
    expect(first).toEqual(same)
    expect(next.parts).not.toEqual(first.parts)
  })

  // The request builder reads the date from the Effect clock so tests can move
  // it; a real `new Date()` would ignore TestClock.
  it.effect("date follows the Effect clock across midnight", () =>
    Effect.gen(function* () {
      const at = (now: DateTime.DateTime) => RuntimeSlots.date(new Date(DateTime.toEpochMillis(now)))
      const before = at(yield* DateTime.now)
      yield* TestClock.adjust("1 day")
      const after = at(yield* DateTime.now)
      expect(after.parts).not.toEqual(before.parts)
    }),
  )
})

describe("RuntimeSlots.Slots", () => {
  const sessionID = SessionID.make("ses_slots")

  test("stores and removes owner slots by key", () => {
    const slots = RuntimeSlots.make()
    slots.set(sessionID, "dag_mode", { parts: ["<dag_mode>on</dag_mode>"], cleared: "DAG mode is off." })
    expect(slots.list(sessionID)).toEqual([
      { key: "dag_mode", parts: ["<dag_mode>on</dag_mode>"], cleared: "DAG mode is off." },
    ])
    slots.set(sessionID, "dag_mode", { parts: ["<dag_mode>changed</dag_mode>"], cleared: "DAG mode is off." })
    expect(slots.list(sessionID)).toHaveLength(1)
    slots.delete(sessionID, "dag_mode")
    expect(slots.list(sessionID)).toEqual([])
  })

  test("rejects keys owned by the request builder", () => {
    const slots = RuntimeSlots.make()
    for (const key of ["goal", "memory", "env", "date"]) {
      expect(() => slots.set(sessionID, key, { parts: [], cleared: "cleared" })).toThrow(
        `Runtime slot "${key}" is owned by the request builder`,
      )
    }
  })

  test("forgets every slot of a session", () => {
    const slots = RuntimeSlots.make()
    slots.set(sessionID, "dag_mode", { parts: ["on"], cleared: "off" })
    slots.forget(sessionID)
    expect(slots.list(sessionID)).toEqual([])
  })
})
