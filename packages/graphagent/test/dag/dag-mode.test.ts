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
    // L1 already says the current message overrides the setting for that request (#1457).
    expect(text).not.toContain("applies to that request only")
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

// #1324: the user's tier for unattended permissions. The model-visible wording
// is fixed by the Issue and must not drift; L1 stays a constant text, and L2
// states the tier only when it is not the default.
describe("DagMode unattended permission tier (#1324)", () => {
  const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

  const OLD_SENTENCE =
    "Node permission prompts never reach the user: a node call that matches the safety list is denied with a reason and the node continues, and you are told in the report."
  const NEW_SENTENCE =
    "Node permission prompts are never yours to answer. By default they do not reach the user: a node call that matches the safety list is denied with a reason and the node continues, and you are told in the report. Under other user settings a node may wait for the user's approval or be limited to read-only tools; the dag_mode block states the setting when it is not the default."
  const ASK_LINE =
    "Node permissions: ask. Each node edit, command, or MCP call waits for the user's approval; expect waits and keep graphs small."
  const READONLY_LINE =
    "Node permissions: read-only. Nodes cannot edit files, and can run only read-only git and gh queries; plan research and review work only."

  /**
   * L2 texts without a tier line: byte length and SHA-256 of
   * `DagMode.state(...).parts.join("\n")`. The default tier must reproduce
   * every one of them byte for byte. #1457 re-measured them after cutting the
   * sentences that L1 or the engine already carry.
   */
  const BEFORE_L2 = {
    base: { facts, bytes: 2051, sha256: "ee6fd81d8c4648f843c562643f559ac46d36c0954a4f4de9ad255cb6879c30cf" },
    unlimited: {
      facts: { ...facts, budget: null },
      bytes: 2047,
      sha256: "1038286291f3233b6e883f98c007869207fb4124040a2953d433c38bbbb674fd",
    },
    planAndNoninteractive: {
      facts: { ...facts, plan: true, noninteractive: true },
      bytes: 2340,
      sha256: "f1e720ed7934066ac22e9982f03bf4e020b47b39e3c188c48b6daac6f246bc44",
    },
    exhausted: {
      facts: {
        ...facts,
        plan: true,
        noninteractive: true,
        budgetState: { used: 1200, cacheRead: 10, budget: 1000, warnRatio: 0.8, tier: "exhausted" as const },
      },
      bytes: 2558,
      sha256: "c057b8c1ae76cae84d80db2326db111cdae9da77ade70706fb8c146c92cbd8e7",
    },
    warn: {
      facts: {
        ...facts,
        budgetState: { used: 850, cacheRead: 10, budget: 1000, warnRatio: 0.8, tier: "warn" as const },
      },
      bytes: 2132,
      sha256: "3c16ec62a8d53ddce3d2b13379f372a0b753d9b98c29221e7225789bbad821a0",
    },
    unavailable: {
      facts: { ...facts, unavailable: "start_denied" as const },
      bytes: 107,
      sha256: "9104950a4761221cee34e926271efbcb5685357b922e4447590a542d4847e967",
    },
  }

  test("L1 carries the tier-aware sentence verbatim and nothing else changed", () => {
    expect(DagMode.SYSTEM).toContain(NEW_SENTENCE)
    expect(DagMode.SYSTEM).not.toContain(OLD_SENTENCE)
    // Swapping the sentence back must give the L1 text as it was before it (re-measured by #1457).
    expect(sha256(DagMode.SYSTEM.replace(NEW_SENTENCE, OLD_SENTENCE))).toBe(
      "0dc084921d8c316823ff70aab524d361ffbf9f2fe16b0df631a0fdc30ca01a49",
    )
  })

  test("the default tier leaves L2 byte for byte as it was", () => {
    for (const [name, before] of Object.entries(BEFORE_L2)) {
      const implicit = DagMode.state(before.facts).parts.join("\n")
      const explicit = DagMode.state({ ...before.facts, permission: "allow" }).parts.join("\n")
      expect([name, Buffer.byteLength(implicit), sha256(implicit)]).toEqual([name, before.bytes, before.sha256])
      expect(explicit).toBe(implicit)
    }
  })

  test("ask and readonly append their own line to the ON block", () => {
    for (const [name, before] of Object.entries(BEFORE_L2)) {
      if ("unavailable" in before.facts) continue
      const allow = DagMode.state(before.facts).parts.join("\n")
      const ask = DagMode.state({ ...before.facts, permission: "ask" }).parts.join("\n")
      const readonly = DagMode.state({ ...before.facts, permission: "readonly" }).parts.join("\n")
      expect([name, ask]).toEqual([name, `${allow}\n${ASK_LINE}`])
      expect([name, readonly]).toEqual([name, `${allow}\n${READONLY_LINE}`])
    }
  })

  test("an ON block that cannot run workflows states no tier", () => {
    for (const permission of ["ask", "readonly"] as const) {
      const text = DagMode.state({ ...facts, unavailable: "start_denied", permission }).parts.join("\n")
      expect(text).toBe(
        "DAG mode: ON but unavailable (start_denied). Work directly and tell the user once that DAG mode cannot run.",
      )
    }
  })

  test("the OFF block never names the tier", () => {
    for (const permission of ["allow", "ask", "readonly"] as const) {
      const slot = DagMode.state({ ...facts, mode: "off", permission })
      expect(slot.parts).toEqual([])
      expect(slot.cleared).toContain("DAG mode: OFF")
      expect(slot.cleared).not.toContain("Node permissions")
    }
  })

  test("the slot follows each published snapshot and nothing republishes it by itself", () => {
    const sessionID = SessionID.make("ses_dag_mode_tier_switch")
    const slotText = () =>
      EngineProcess.runtimes.runtimeSlots
        .list(sessionID)
        .find((item) => item.key === "dag_mode")
        ?.parts.join("\n")

    DagMode.set(sessionID, { ...facts, permission: "ask" })
    expect(slotText()).toContain(ASK_LINE)

    // A tier switch in the global configuration publishes nothing: the slot
    // keeps its text until the request builder publishes the next snapshot.
    expect(slotText()).toContain(ASK_LINE)

    DagMode.set(sessionID, { ...facts, permission: "readonly" })
    expect(slotText()).toContain(READONLY_LINE)
    expect(slotText()).not.toContain(ASK_LINE)

    DagMode.set(sessionID, { ...facts, permission: "allow" })
    expect(slotText()).not.toContain("Node permissions")
  })

  // L2 rides in runtime context on every request, so its size is capped: 2.3 KB under
  // the default tier (#1031 M2), kept byte for byte, and 2.5 KB under ask and readonly,
  // whose one extra line (127 and 137 bytes, newline included) cannot fit the 22 bytes
  // of headroom the default text leaves (#1324).
  const CAP = { allow: 2.3 * 1024, ask: 2.5 * 1024, readonly: 2.5 * 1024 } as const

  test("the tier lines are the only growth over the default tier", () => {
    const allow = Buffer.byteLength(DagMode.state(facts).parts.join("\n"))
    const ask = Buffer.byteLength(DagMode.state({ ...facts, permission: "ask" }).parts.join("\n"))
    const readonly = Buffer.byteLength(DagMode.state({ ...facts, permission: "readonly" }).parts.join("\n"))
    expect(ask - allow).toBe(1 + Buffer.byteLength(ASK_LINE))
    expect(readonly - allow).toBe(1 + Buffer.byteLength(READONLY_LINE))
  })

  // A variant whose default text already passes 2.3 KB (the exhausted budget) was over the cap
  // before the tier existed and stays as it was, so the cap is asserted for every variant that
  // fits it today: the test facts, the unlimited budget, the plan and non-interactive notes and a
  // budget warning (the last two fit since #1457).
  test("L2 stays within its tier's cap: 2.3 KB for allow, 2.5 KB for ask and readonly", () => {
    const fitting = Object.entries(BEFORE_L2).filter(([, before]) => before.bytes <= CAP.allow)
    expect(fitting.map(([name]) => name)).toEqual(expect.arrayContaining(["base", "unlimited"]))
    for (const [name, before] of fitting) {
      for (const tier of ["allow", "ask", "readonly"] as const) {
        const bytes = Buffer.byteLength(DagMode.state({ ...before.facts, permission: tier }).parts.join("\n"))
        expect([name, tier, bytes <= CAP[tier]]).toEqual([name, tier, true])
      }
    }
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