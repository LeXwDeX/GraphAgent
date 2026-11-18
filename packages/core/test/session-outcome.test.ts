// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import { SessionID } from "@graphagent/schema/session-id"
import {
  TOOL_OUTCOME_KINDS,
  addCorrections,
  correctionsOf,
  toolOutcomeRow,
  type ToolOutcomeKind,
} from "@graphagent/core/session/outcome"

const model = { providerID: "provider", modelID: "model" }
const sessionID = SessionID.make("ses_outcome_test")
const messageID = SessionV1.MessageID.make("msg_outcome_test")

function toolPart(tool: string, state: SessionV1.ToolState, id = "prt_outcome_test"): SessionV1.ToolPart {
  return { id: SessionV1.PartID.make(id), sessionID, messageID, type: "tool", callID: "call", tool, state }
}

const completed = (metadata: Record<string, unknown> = {}, input: Record<string, unknown> = {}) =>
  ({ status: "completed", input, output: "ok", title: "t", metadata, time: { start: 1, end: 2 } }) as const

const failed = (metadata?: Record<string, unknown>, input: Record<string, unknown> = {}) =>
  ({ status: "error", input, error: "boom", metadata, time: { start: 1, end: 2 } }) as const

describe("correctionsOf", () => {
  test("reads nothing from metadata without a valid list", () => {
    expect(correctionsOf(undefined)).toEqual([])
    expect(correctionsOf({})).toEqual([])
    expect(correctionsOf({ corrections: "args_repaired" })).toEqual([])
    expect(correctionsOf({ corrections: { 0: "args_repaired" } })).toEqual([])
  })

  test("keeps valid kinds once, in order", () => {
    expect(correctionsOf({ corrections: ["args_repaired", "fuzzy_match", "args_repaired"] })).toEqual([
      "args_repaired",
      "fuzzy_match",
    ])
  })

  test("drops entries that are not kind strings", () => {
    expect(correctionsOf({ corrections: ["Upper", "1abc", "has space", "", 7, null, {}, "ok_1"] })).toEqual(["ok_1"])
  })

  test("returns at most 16 kinds", () => {
    const many = Array.from({ length: 30 }, (_, index) => `kind_${index}`)
    const kinds = correctionsOf({ corrections: many })
    expect(kinds).toHaveLength(16)
    expect(kinds[15]).toBe("kind_15")
  })
})

describe("addCorrections", () => {
  test("creates the key and returns a new object", () => {
    const metadata = { diff: "d" }
    const next = addCorrections(metadata, "args_repaired")
    expect(next).toEqual({ diff: "d", corrections: ["args_repaired"] })
    expect(next).not.toBe(metadata)
    expect(metadata).toEqual({ diff: "d" })
  })

  test("appends after the kinds already recorded and never repeats one", () => {
    const next = addCorrections({ corrections: ["fuzzy_match"] }, "args_repaired", "fuzzy_match", "args_repaired")
    expect(next.corrections).toEqual(["fuzzy_match", "args_repaired"])
  })

  test("drops invalid kinds and leaves the key out when nothing is left", () => {
    expect(addCorrections({ a: 1 }, "Bad Kind", "9x", "")).toEqual({ a: 1 })
    expect(addCorrections({ corrections: ["x"] }, "Bad Kind")).toEqual({ corrections: ["x"] })
  })

  test("accepts missing metadata", () => {
    expect(addCorrections(undefined, "clamped")).toEqual({ corrections: ["clamped"] })
    expect(addCorrections(undefined)).toEqual({})
  })

  test("never writes more than 16 kinds", () => {
    const kinds = Array.from({ length: 20 }, (_, index) => `kind_${index}`)
    expect(addCorrections({}, ...kinds).corrections).toHaveLength(16)
  })
})

describe("toolOutcomeRow", () => {
  test("books only finished tool parts", () => {
    expect(toolOutcomeRow(toolPart("edit", { status: "pending", input: {}, raw: "" }), model)).toBeUndefined()
    expect(
      toolOutcomeRow(toolPart("edit", { status: "running", input: {}, time: { start: 1 } }), model),
    ).toBeUndefined()
    const text = { id: SessionV1.PartID.make("prt_text"), sessionID, messageID, type: "text" as const, text: "hi" }
    expect(toolOutcomeRow(text, model)).toBeUndefined()
  })

  test("a completed part is ok and carries the model, tool and session", () => {
    expect(toolOutcomeRow(toolPart("edit", completed()), model)).toEqual({
      part_id: SessionV1.PartID.make("prt_outcome_test"),
      session_id: sessionID,
      provider_id: "provider",
      model_id: "model",
      tool: "edit",
      outcome: "ok",
      corrections: [],
      truncated: false,
    })
  })

  test("a completed part that a hook denied is denied", () => {
    expect(toolOutcomeRow(toolPart("bash", completed({ hookDenied: true })), model)?.outcome).toBe("denied")
    expect(toolOutcomeRow(toolPart("bash", completed({ hookDenied: "yes" })), model)?.outcome).toBe("ok")
    // A hook stop is not a denial.
    expect(toolOutcomeRow(toolPart("bash", completed({ hookStopped: true })), model)?.outcome).toBe("ok")
  })

  test("an error part reports the recorded outcome and falls back to execution_error", () => {
    for (const kind of TOOL_OUTCOME_KINDS) {
      expect(toolOutcomeRow(toolPart("bash", failed({ outcome: kind })), model)?.outcome).toBe(kind)
    }
    for (const metadata of [undefined, {}, { outcome: "nonsense" }, { outcome: 3 }]) {
      expect(toolOutcomeRow(toolPart("bash", failed(metadata)), model)?.outcome).toBe("execution_error")
    }
  })

  test("reads corrections and truncation from the state metadata", () => {
    const row = toolOutcomeRow(
      toolPart("edit", completed({ corrections: ["args_repaired", "Bad"], truncated: true })),
      model,
    )
    expect(row?.corrections).toEqual(["args_repaired"])
    expect(row?.truncated).toBe(true)
    expect(toolOutcomeRow(toolPart("edit", completed({ truncated: "true" })), model)?.truncated).toBe(false)
    expect(toolOutcomeRow(toolPart("edit", failed({ truncated: true })), model)?.truncated).toBe(true)
  })

  test("cuts the tool name to 64 characters", () => {
    const row = toolOutcomeRow(toolPart("t".repeat(100), completed()), model)
    expect(row?.tool).toBe("t".repeat(64))
  })

  test("an invalid part from before unknown tools became errors is booked under the called tool", () => {
    const row = toolOutcomeRow(toolPart("invalid", completed({}, { tool: "wrtie", error: "bad" })), model)
    expect(row?.tool).toBe("wrtie")
    expect(row?.outcome).toBe("validation_error")
    expect(toolOutcomeRow(toolPart("invalid", failed({}, { tool: "x".repeat(80) })), model)?.tool).toBe("x".repeat(64))
    // Without a usable name the part stays under `invalid`.
    expect(toolOutcomeRow(toolPart("invalid", completed({}, { tool: 5 })), model)).toMatchObject({
      tool: "invalid",
      outcome: "validation_error",
    })
  })

  test("the outcome vocabulary is the six documented kinds", () => {
    const expected: ToolOutcomeKind[] = [
      "ok",
      "validation_error",
      "execution_error",
      "denied",
      "aborted",
      "arguments_truncated",
    ]
    expect([...TOOL_OUTCOME_KINDS]).toEqual(expected)
  })
})
