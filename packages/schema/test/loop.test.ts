// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  LOOP_NEXT_PROMPT_MAX_CHARS,
  LOOP_REASON_MAX_CHARS,
  LoopAnalysisResult,
  LoopIntent,
  LoopVerdict,
} from "../src/loop"

const intent: LoopIntent = {
  objective: "Ship the loop analysis service",
  acceptance: [
    { id: "A1", text: "The schema is exported", status: "met", evidence: "packages/schema/src/loop.ts" },
    { id: "A2", text: "The validator rejects drift", status: "unmet" },
  ],
  constraints: ["Do not touch the shared runner"],
  non_goals: ["No new configuration keys"],
  assumptions: ["The session model supports variants"],
  open_questions: [],
}

const full: LoopAnalysisResult = {
  verdict: "continue",
  intent,
  intent_change: { changed: true, basis_message_id: "msg_1", summary: "Added a constraint" },
  progress: { advanced: true, summary: "Schema landed", done: ["schema"], remaining: ["validator"] },
  next_prompt: "Implement the validator next and run its tests.",
  reason: "One acceptance item is still unmet.",
}

describe("LoopAnalysisResult schema (#1328)", () => {
  test("decodes a complete result and keeps every field", () => {
    expect(Schema.decodeUnknownSync(LoopAnalysisResult)(full)).toEqual(full)
  })

  test("optional fields may be omitted", () => {
    const minimal = {
      verdict: "done",
      intent: {
        ...intent,
        acceptance: [{ id: "A1", text: "The schema is exported", status: "met" }],
      },
      intent_change: { changed: false },
      progress: { advanced: false, summary: "", done: [], remaining: [] },
      reason: "Everything is met.",
    }
    const decoded = Schema.decodeUnknownSync(LoopAnalysisResult)(minimal)
    expect(decoded.next_prompt).toBeUndefined()
    expect(decoded.intent_change.basis_message_id).toBeUndefined()
    expect(decoded.intent.acceptance[0]?.evidence).toBeUndefined()
  })

  test("LoopIntent decodes on its own, so a caller can persist and reload it", () => {
    expect(Schema.decodeUnknownSync(LoopIntent)(intent)).toEqual(intent)
  })

  test("verdict is exactly the five values", () => {
    expect(Schema.decodeUnknownSync(LoopVerdict)("goal_changed")).toBe("goal_changed")
    for (const verdict of ["continue", "done", "blocked", "goal_changed", "user_stop"] as const) {
      expect(Schema.decodeUnknownSync(LoopVerdict)(verdict)).toBe(verdict)
    }
    expect(() => Schema.decodeUnknownSync(LoopVerdict)("paused")).toThrow()
  })

  test("rejects structural errors", () => {
    const decode = Schema.decodeUnknownSync(LoopAnalysisResult)
    expect(() => decode({ ...full, verdict: "paused" })).toThrow()
    expect(() => decode({ ...full, reason: undefined })).toThrow()
    expect(() => decode({ ...full, intent: { ...intent, acceptance: [{ id: "A1", text: "x", status: "done" }] } })).toThrow()
    expect(() => decode({ ...full, intent: { ...intent, open_questions: undefined } })).toThrow()
    expect(() => decode({ ...full, progress: { advanced: "yes", summary: "", done: [], remaining: [] } })).toThrow()
  })

  test("content rules are not schema rules: empty and oversized strings still decode", () => {
    // V1-V8 are the runtime validator's job so the model gets a numbered rule back.
    const decode = Schema.decodeUnknownSync(LoopAnalysisResult)
    expect(() => decode({ ...full, reason: "" })).not.toThrow()
    expect(() => decode({ ...full, next_prompt: "x".repeat(LOOP_NEXT_PROMPT_MAX_CHARS + 1) })).not.toThrow()
    expect(() => decode({ ...full, intent: { ...intent, acceptance: [] } })).not.toThrow()
  })

  test("limits match the spec", () => {
    expect(LOOP_NEXT_PROMPT_MAX_CHARS).toBe(8000)
    expect(LOOP_REASON_MAX_CHARS).toBe(300)
  })

  test("serializes to an object-rooted JSON Schema, as submit_analysis parameters must", () => {
    const document = Schema.toJsonSchemaDocument(LoopAnalysisResult)
    const root = document.schema as { type?: string; properties?: Record<string, unknown>; required?: string[] }
    expect(root.type).toBe("object")
    expect(Object.keys(root.properties ?? {})).toEqual([
      "verdict",
      "intent",
      "intent_change",
      "progress",
      "next_prompt",
      "reason",
    ])
    expect(root.required).toEqual(["verdict", "intent", "intent_change", "progress", "reason"])
    expect(Object.keys(document.definitions)).toEqual([])
  })
})
