// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * How a provider carries a reasoning part when it is replayed, decided by the engine that defines the metadata.
 *
 * - `plain`: the text is the only carrier; replacing it changes what the provider receives and nothing else.
 * - `mirror`: plaintext copies of the text live in metadata at `paths` and must change together with it.
 * - `opaque`: the provider verifies or references the original (signature, encrypted payload, stored item); the text
 *   must not be rewritten.
 * - `unknown`: unrecognized, inconsistent or oversized metadata; callers must fail closed.
 */
export type ReasoningCarrier =
  | Readonly<{ kind: "plain" }>
  | Readonly<{ kind: "mirror"; paths: readonly (readonly (string | number)[])[] }>
  | Readonly<{ kind: "opaque"; reason: "signed" | "encrypted" | "reference" }>
  | Readonly<{ kind: "unknown"; reason: "unrecognized" | "mismatch" | "bounds" }>

/**
 * Metadata keys that bind a reasoning part to its original bytes, wherever they appear. Presence alone protects the
 * part, even with an empty value: providers may fill or check them later.
 */
const OPAQUE_KEYS: Readonly<Record<string, "signed" | "encrypted" | "reference">> = {
  // anthropic-messages and bedrock-converse thinking blocks
  signature: "signed",
  redactedData: "signed",
  // gemini thought parts
  thoughtSignature: "signed",
  // GitHub Copilot opaque reasoning
  reasoningOpaque: "signed",
  // openai-responses reasoning items: encrypted state, or a stored item replayed by id
  reasoningEncryptedContent: "encrypted",
  encryptedContent: "encrypted",
  encrypted_content: "encrypted",
  itemId: "reference",
  // opaque payloads (redacted thinking, `reasoning.encrypted` details)
  data: "encrypted",
}

const MAX_DEPTH = 8
const MAX_NODES = 512
const MAX_TEXT = 1_000_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const scan = (value: unknown): ReasoningCarrier | undefined => {
  const ancestors = new Set<object>()
  let nodes = 0
  let text = 0
  const visit = (item: unknown, depth: number): ReasoningCarrier | undefined => {
    if (typeof item === "string") {
      text += item.length
      return text > MAX_TEXT ? { kind: "unknown", reason: "bounds" } : undefined
    }
    if (item === null || item === undefined || typeof item === "number" || typeof item === "boolean") return undefined
    if (typeof item !== "object" || depth > MAX_DEPTH || ancestors.has(item) || ++nodes > MAX_NODES)
      return { kind: "unknown", reason: "bounds" }
    ancestors.add(item)
    for (const [key, child] of Object.entries(item)) {
      const opaque = OPAQUE_KEYS[key]
      if (opaque) return { kind: "opaque", reason: opaque }
      const nested = visit(child, depth + 1)
      if (nested) return nested
    }
    ancestors.delete(item)
    return undefined
  }
  return visit(value, 0)
}

/**
 * OpenRouter-style chat `reasoning_details`: exactly one plaintext `reasoning.text` detail mirroring the part.
 * AI SDK providers and relays file it under their own provider namespace, so the shape, not the name, is matched.
 */
const detailsMirror = (
  namespace: string,
  carrier: Record<string, unknown>,
  text: string,
): ReasoningCarrier | undefined => {
  if (Object.keys(carrier).length !== 1 || !Array.isArray(carrier.reasoning_details)) return undefined
  const details = carrier.reasoning_details
  if (details.length !== 1 || !isRecord(details[0])) return { kind: "unknown", reason: "unrecognized" }
  const detail = details[0]
  if (
    Object.keys(detail).some((key) => !["type", "text", "format", "index"].includes(key)) ||
    detail.type !== "reasoning.text" ||
    (detail.format !== undefined && detail.format !== "unknown") ||
    (detail.index !== undefined && detail.index !== 0)
  )
    return { kind: "unknown", reason: "unrecognized" }
  if (detail.text !== text) return { kind: "unknown", reason: "mismatch" }
  return { kind: "mirror", paths: [[namespace, "reasoning_details", 0, "text"]] }
}

/** Classify a reasoning part's provider metadata for replay. Never guesses: anything unrecognized is `unknown`. */
export const classify = (metadata: unknown, text: string): ReasoningCarrier => {
  if (metadata === undefined) return { kind: "plain" }
  if (!isRecord(metadata)) return { kind: "unknown", reason: "unrecognized" }
  const scanned = scan(metadata)
  if (scanned) return scanned
  const paths: (readonly (string | number)[])[] = []
  for (const [namespace, carrier] of Object.entries(metadata)) {
    if (!isRecord(carrier)) return { kind: "unknown", reason: "unrecognized" }
    if (Object.keys(carrier).length === 0) continue
    const mirror = detailsMirror(namespace, carrier, text)
    if (!mirror) return { kind: "unknown", reason: "unrecognized" }
    if (mirror.kind !== "mirror") return mirror
    paths.push(...mirror.paths)
  }
  return paths.length === 0 ? { kind: "plain" } : { kind: "mirror", paths }
}

export * as ReasoningCarrier from "./reasoning-carrier"
