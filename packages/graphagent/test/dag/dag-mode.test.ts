// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1031 M1: the pure rules behind session-level DAG mode.
import { describe, expect, test } from "bun:test"
import { DagMode } from "@/dag/mode"
import { EngineProcess } from "@/session/engine-process"
import { SessionID } from "@/session/schema"

describe("DagMode.resolveInitial", () => {
  test("an explicit creation value wins over the global default", () => {
    expect(DagMode.resolveInitial({ explicit: "off", global: { mode: "on" } })).toBe("off")
    expect(DagMode.resolveInitial({ explicit: "on", global: { mode: "off" } })).toBe("on")
  })

  test("an absent explicit value falls back to the global default, then off", () => {
    expect(DagMode.resolveInitial({ global: { mode: "on" } })).toBe("on")
    expect(DagMode.resolveInitial({ global: {} })).toBe("off")
    expect(DagMode.resolveInitial({})).toBe("off")
  })

  test("a child session always starts off, even with an explicit value", () => {
    expect(
      DagMode.resolveInitial({
        explicit: "on",
        parentID: SessionID.make("ses_parent"),
        global: { mode: "on" },
      }),
    ).toBe("off")
  })
})

describe("DagMode slot", () => {
  test("on carries the model-facing text and off clears it", () => {
    const on = DagMode.slot("on")
    expect(on.key).toBe("dag_mode")
    expect(on.parts.join("\n")).toContain("DAG mode is on")
    expect(on.cleared.length).toBeGreaterThan(0)

    const off = DagMode.slot("off")
    expect(off.key).toBe("dag_mode")
    expect(off.parts).toEqual([])
  })

  test("set and ensure write the process registry for the session", () => {
    const sessionID = SessionID.make("ses_dag_mode_slot")
    DagMode.set(sessionID, "on")
    expect(EngineProcess.runtimes.runtimeSlots.list(sessionID).map((slot) => slot.key)).toEqual(["dag_mode"])

    DagMode.ensure({ id: sessionID, dagMode: "off" })
    const slot = EngineProcess.runtimes.runtimeSlots.list(sessionID).find((item) => item.key === "dag_mode")
    expect(slot?.parts).toEqual([])
  })
})

describe("DagMode receipt", () => {
  test("carries the TUI metadata shape", () => {
    expect(DagMode.receipt("off", { n: 2 })).toEqual({
      command: "dag-mode",
      receipt: { kind: "off", values: { n: 2 } },
    })
  })

  test("fallback text marks absent numbers and budget", () => {
    expect(DagMode.text("off", { n: 2 })).toContain("2")
    expect(DagMode.text("status", { state: "on", default: "off" })).toContain("—")
  })
})