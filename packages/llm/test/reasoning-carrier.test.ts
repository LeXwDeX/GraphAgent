// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ReasoningCarrier } from "@graphagent/llm"

const text = "ORIGINAL"
const detail = { type: "reasoning.text", text, format: "unknown", index: 0 }

describe("ReasoningCarrier.classify", () => {
  test("text without provider metadata is plain", () => {
    expect(ReasoningCarrier.classify(undefined, text)).toEqual({ kind: "plain" })
    expect(ReasoningCarrier.classify({}, text)).toEqual({ kind: "plain" })
    expect(ReasoningCarrier.classify({ openaiCompatible: {}, relay: {} }, text)).toEqual({ kind: "plain" })
  })

  test("engine protocol replay metadata is opaque", () => {
    expect(ReasoningCarrier.classify({ anthropic: { signature: "sig" } }, text)).toEqual({
      kind: "opaque",
      reason: "signed",
    })
    expect(ReasoningCarrier.classify({ anthropic: { redactedData: "blob" } }, text)).toMatchObject({ kind: "opaque" })
    expect(ReasoningCarrier.classify({ bedrock: { signature: "sig" } }, text)).toMatchObject({ kind: "opaque" })
    expect(ReasoningCarrier.classify({ google: { thoughtSignature: "sig" } }, text)).toEqual({
      kind: "opaque",
      reason: "signed",
    })
    expect(ReasoningCarrier.classify({ copilot: { reasoningOpaque: "x" } }, text)).toMatchObject({ kind: "opaque" })
    expect(ReasoningCarrier.classify({ openai: { itemId: "rs_1", reasoningEncryptedContent: "state" } }, text)).toEqual(
      { kind: "opaque", reason: "reference" },
    )
    expect(ReasoningCarrier.classify({ openai: { reasoningEncryptedContent: "state" } }, text)).toEqual({
      kind: "opaque",
      reason: "encrypted",
    })
  })

  test("an opaque key protects the part even when empty or nested", () => {
    for (const extra of [{ signature: null }, { encrypted_content: "" }, { data: null }])
      expect(
        ReasoningCarrier.classify({ relay: { reasoning_details: [{ ...detail, ...extra }] } }, text),
      ).toMatchObject({ kind: "opaque" })
    expect(ReasoningCarrier.classify({ openai: { itemId: "rs_1", reasoningEncryptedContent: null } }, text)).toEqual({
      kind: "opaque",
      reason: "reference",
    })
  })

  test("a single plaintext reasoning_details entry is a mirror under any namespace", () => {
    expect(ReasoningCarrier.classify({ openrouter: { reasoning_details: [detail] } }, text)).toEqual({
      kind: "mirror",
      paths: [["openrouter", "reasoning_details", 0, "text"]],
    })
    expect(
      ReasoningCarrier.classify({ relay: { reasoning_details: [{ type: "reasoning.text", text }] } }, text),
    ).toEqual({ kind: "mirror", paths: [["relay", "reasoning_details", 0, "text"]] })
  })

  test("inconsistent, unrecognized or oversized metadata is unknown", () => {
    expect(ReasoningCarrier.classify({ relay: { reasoning_details: [{ ...detail, text: "OTHER" }] } }, text)).toEqual({
      kind: "unknown",
      reason: "mismatch",
    })
    expect(
      ReasoningCarrier.classify({ relay: { reasoning_details: [{ ...detail, format: "anthropic-claude-v1" }] } }, text),
    ).toEqual({ kind: "unknown", reason: "unrecognized" })
    expect(ReasoningCarrier.classify({ relay: { reasoning_details: [detail, detail] } }, text)).toEqual({
      kind: "unknown",
      reason: "unrecognized",
    })
    expect(ReasoningCarrier.classify({ relay: { arbitrary: text } }, text)).toEqual({
      kind: "unknown",
      reason: "unrecognized",
    })
    expect(ReasoningCarrier.classify({ relay: "flat" }, text)).toEqual({ kind: "unknown", reason: "unrecognized" })
    expect(ReasoningCarrier.classify("flat", text)).toEqual({ kind: "unknown", reason: "unrecognized" })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(ReasoningCarrier.classify({ relay: cyclic }, text)).toEqual({ kind: "unknown", reason: "bounds" })
    let deep: Record<string, unknown> = {}
    const root = deep
    for (let index = 0; index < 12; index++) deep = deep.next = {}
    expect(ReasoningCarrier.classify({ relay: root }, text)).toEqual({ kind: "unknown", reason: "bounds" })
    expect(ReasoningCarrier.classify({ relay: { huge: "x".repeat(1_000_001) } }, text)).toEqual({
      kind: "unknown",
      reason: "bounds",
    })
  })
})
