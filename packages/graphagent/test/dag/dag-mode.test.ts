// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1031 M1/M2: the pure rules behind session-level DAG mode and its three
// notice layers.
import { describe, expect, test } from "bun:test"
import { DagMode } from "@/dag/mode"
import { EngineProcess } from "@/session/engine-process"
import { SessionID } from "@/session/schema"

const facts = {
  mode: "on" as const,
  budget: 500_000,
  concurrency: 12,
  maxTotalNodes: 100,
}

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

describe("DagMode.SYSTEM (L1)", () => {
  test("carries the mechanism, the user-owned switch, and the per-request override", () => {
    expect(DagMode.SYSTEM).toContain("# DAG workflows")
    expect(DagMode.SYSTEM).toContain("only the user can change")
    expect(DagMode.SYSTEM).toContain("the latest dag_mode <runtime_context> block reports it")
    expect(DagMode.SYSTEM).toContain("overrides the setting for that request")
    expect(DagMode.SYSTEM).toContain("Never change DAG mode or the DAG budget yourself")
    expect(DagMode.SYSTEM).toContain("Load the dag-auto skill")
  })
})

describe("DagMode.state (L2)", () => {
  test("on renders the mode, the limits and the budget", () => {
    const slot = DagMode.state(facts)
    expect(slot.key).toBe("dag_mode")
    const text = slot.parts.join("\n")
    expect(text).toContain("DAG mode: ON")
    expect(text).toContain("concurrency 12 shared by all sessions")
    expect(text).toContain("100 nodes per workflow")
    expect(text).toContain("DAG token budget 500000 tokens")
    expect(text).toContain("applies to that request only")
    expect(text).toContain("Load the dag-auto skill")
    // #1031 M2: the block travels in runtime context on every request; the
    // Issue caps it at 2.3 KB.
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2.3 * 1024)
  })

  test("an unlimited budget reads as unlimited", () => {
    expect(DagMode.state({ ...facts, budget: null }).parts.join("\n")).toContain("DAG token budget unlimited")
  })

  test("off carries no block and announces the cleared state", () => {
    const slot = DagMode.state({ ...facts, mode: "off" })
    expect(slot.key).toBe("dag_mode")
    expect(slot.parts).toEqual([])
    expect(slot.cleared).toContain("DAG mode: OFF")
  })

  test("unavailable keeps the first line and drops the playbook", () => {
    const text = DagMode.state({ ...facts, unavailable: "start_denied" }).parts.join("\n")
    expect(text).toBe(
      "DAG mode: ON but unavailable (start_denied). Work directly and tell the user once that DAG mode cannot run.",
    )
  })

  test("a warn-tier budget appends the warning line with its percentage", () => {
    const text = DagMode.state({
      ...facts,
      budgetState: { used: 850, cacheRead: 10, budget: 1000, warnRatio: 0.8, tier: "warn" },
    }).parts.join("\n")
    expect(text).toContain("DAG token budget: over 85% used. Prefer finishing and reporting over new stages.")
  })

  test("an exhausted budget appends the exhaustion line and the budget line stays", () => {
    const text = DagMode.state({
      ...facts,
      budgetState: { used: 1200, cacheRead: 10, budget: 1000, warnRatio: 0.8, tier: "exhausted" },
    }).parts.join("\n")
    expect(text).toContain("DAG token budget exhausted: the engine paused this session's workflows")
    expect(text).toContain("DAG token budget 500000 tokens")
    expect(text).not.toContain("over 120% used")
  })

  test("a normal or unlimited tier adds no budget line", () => {
    const normal = DagMode.state({
      ...facts,
      budgetState: { used: 10, cacheRead: 0, budget: 1000, warnRatio: 0.8, tier: "normal" },
    }).parts.join("\n")
    const unlimited = DagMode.state({
      ...facts,
      budgetState: { used: 10_000_000, cacheRead: 0, budget: null, warnRatio: 0.8, tier: "normal" },
    }).parts.join("\n")
    expect(normal).not.toContain("DAG token budget:")
    expect(unlimited).not.toContain("DAG token budget:")
  })

  test("plan mode and a non-interactive run add their own line", () => {
    const text = DagMode.state({ ...facts, plan: true, noninteractive: true }).parts.join("\n")
    expect(text).toContain("Plan mode is active: start only read-only workflows")
    expect(text).toContain("Non-interactive run: do not decide product questions")
  })

  test("set writes the process registry for the session", () => {
    const sessionID = SessionID.make("ses_dag_mode_slot")
    DagMode.set(sessionID, facts)
    const slot = EngineProcess.runtimes.runtimeSlots.list(sessionID).find((item) => item.key === "dag_mode")
    expect(slot?.parts.join("\n")).toContain("DAG mode: ON")

    DagMode.set(sessionID, { ...facts, mode: "off" })
    const cleared = EngineProcess.runtimes.runtimeSlots.list(sessionID).find((item) => item.key === "dag_mode")
    expect(cleared?.parts).toEqual([])
  })
})

describe("DagMode.REMINDER (L3)", () => {
  test("is static, short, and scopes a direct-work request to itself", () => {
    expect(DagMode.REMINDER).toContain("Follow the latest dag_mode context")
    expect(DagMode.REMINDER).toContain("orchestrate this request")
    expect(DagMode.REMINDER).toContain("asked to work directly for this request")
    expect(Buffer.byteLength(DagMode.REMINDER)).toBeLessThan(300)
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