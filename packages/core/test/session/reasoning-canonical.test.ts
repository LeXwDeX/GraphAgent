import { describe, expect, test } from "bun:test"
import {
  assessCanonicalReasoning,
  reasoningForReplay,
  replaceCanonicalReasoning,
} from "../../src/session/reasoning-distillation/canonical"

const plain = (metadata?: Record<string, unknown>) => ({
  text: "ORIGINAL",
  metadata,
  settled: true,
  distilled: false,
})

describe("canonical reasoning editability", () => {
  test("edits one exact plaintext mirror without changing its shape or other fields", () => {
    const metadata = {
      relay: {
        reasoning_details: [{ type: "reasoning.text", text: "ORIGINAL", format: "unknown", index: 0 }],
      },
    }
    const before = structuredClone(metadata)
    expect(assessCanonicalReasoning(plain(metadata))).toEqual({
      editable: true,
      aliasPaths: [["relay", "reasoning_details", 0, "text"]],
    })
    const edited = replaceCanonicalReasoning(plain(metadata), "DISTILLED")
    expect(edited).toEqual({
      text: "DISTILLED",
      metadata: {
        relay: { reasoning_details: [{ type: "reasoning.text", text: "DISTILLED", format: "unknown", index: 0 }] },
      },
      originalMetadata: metadata,
    })
    expect(metadata).toEqual(before)
    const carrier = edited?.metadata?.relay
    if (
      !carrier ||
      typeof carrier !== "object" ||
      !("reasoning_details" in carrier) ||
      !Array.isArray(carrier.reasoning_details) ||
      typeof carrier.reasoning_details[0] !== "object" ||
      carrier.reasoning_details[0] === null
    )
      throw new Error("missing edited plaintext mirror")
    expect(Object.keys(carrier.reasoning_details[0])).toEqual(["type", "text", "format", "index"])
  })

  test("protects nested signature, encryption, opaque data, unknown formats, and non-unique mirrors", () => {
    const detail = { type: "reasoning.text", text: "ORIGINAL", format: "unknown", index: 0 }
    for (const extra of [{ signature: null }, { encrypted_content: "" }, { data: null }]) {
      const metadata = { relay: { reasoning_details: [{ ...detail, ...extra }] } }
      expect(assessCanonicalReasoning(plain(metadata))).toEqual({ editable: false, reason: "protected-carrier" })
    }
    expect(
      assessCanonicalReasoning(plain({ relay: { reasoning_details: [{ ...detail, format: "anthropic-claude-v1" }] } })),
    ).toEqual({ editable: false, reason: "unknown-carrier" })
    expect(assessCanonicalReasoning(plain({ relay: { reasoning_details: [detail, detail] } }))).toEqual({
      editable: false,
      reason: "unknown-carrier",
    })
    expect(assessCanonicalReasoning(plain({ relay: { reasoning_details: [{ ...detail, text: "OTHER" }] } }))).toEqual({
      editable: false,
      reason: "metadata-mismatch",
    })
  })

  test("rejects unknown metadata and preserves empty-object carriers on disabled replay", () => {
    expect(assessCanonicalReasoning(plain({ relay: { arbitrary: "ORIGINAL" } }))).toEqual({
      editable: false,
      reason: "unknown-carrier",
    })
    expect(replaceCanonicalReasoning({ ...plain(), settled: false }, "DISTILLED")).toBeUndefined()
    expect(replaceCanonicalReasoning({ ...plain(), distilled: true }, "DISTILLED")).toBeUndefined()
    const saved = {
      originalText: "ORIGINAL",
      version: 2 as const,
      originalMetadata: {},
    }
    expect(reasoningForReplay({ text: "DISTILLED", metadata: {}, distillation: saved, enabled: false })).toEqual({
      text: "ORIGINAL",
      metadata: {},
    })
    expect(reasoningForReplay({ text: "DISTILLED", metadata: {}, distillation: saved, enabled: true })).toEqual({
      text: "DISTILLED",
      metadata: {},
    })
  })

  test("replays the original pair when a v2 provenance no longer matches its source", () => {
    const saved = {
      originalText: "ORIGINAL",
      sourceFingerprint: "bad-fingerprint",
      version: 2 as const,
      originalMetadata: { relay: { reasoning_details: [{ type: "reasoning.text", text: "ORIGINAL" }] } },
    }
    expect(reasoningForReplay({ text: "DISTILLED", metadata: {}, distillation: saved, enabled: true })).toEqual({
      text: "ORIGINAL",
      metadata: saved.originalMetadata,
    })
  })

  test("empty distilled text updates a plaintext mirror and restores the original on disabled replay", () => {
    const metadata = {
      relay: { reasoning_details: [{ type: "reasoning.text", text: "ORIGINAL", format: "unknown", index: 0 }] },
    }
    const edited = replaceCanonicalReasoning(plain(metadata), "")
    expect(edited?.text).toBe("")
    expect(edited?.metadata).toEqual({
      relay: { reasoning_details: [{ type: "reasoning.text", text: "", format: "unknown", index: 0 }] },
    })
    expect(
      reasoningForReplay({
        text: "",
        metadata: edited?.metadata,
        distillation: {
          originalText: "ORIGINAL",
          originalMetadata: metadata,
          version: 2,
        },
        enabled: false,
      }),
    ).toEqual({ text: "ORIGINAL", metadata })
  })

  test("legacy adoption never replays a mixed text and carrier pair", () => {
    const metadata = {
      relay: { reasoning_details: [{ type: "reasoning.text", text: "ORIGINAL", format: "unknown", index: 0 }] },
    }
    const legacy = { originalText: "ORIGINAL" }
    expect(reasoningForReplay({ text: "DISTILLED", metadata, distillation: legacy, enabled: true })).toEqual({
      text: "DISTILLED",
      metadata: {
        relay: { reasoning_details: [{ type: "reasoning.text", text: "DISTILLED", format: "unknown", index: 0 }] },
      },
    })
    expect(reasoningForReplay({ text: "DISTILLED", metadata, distillation: legacy, enabled: false })).toEqual({
      text: "ORIGINAL",
      metadata,
    })
    const protectedMetadata = {
      relay: { reasoning_details: [{ type: "reasoning.text", text: "ORIGINAL", signature: null }] },
    }
    expect(
      reasoningForReplay({ text: "DISTILLED", metadata: protectedMetadata, distillation: legacy, enabled: true }),
    ).toEqual({ text: "ORIGINAL", metadata: protectedMetadata })
  })
})
