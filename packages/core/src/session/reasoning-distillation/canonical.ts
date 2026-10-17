import { ReasoningCarrier } from "@opencode-ai/llm"
import { Hash } from "../../util/hash"

/** Pure editability contract for a persisted reasoning part. */
export type CanonicalReasoning = Readonly<{
  text: string
  metadata?: Record<string, unknown>
  settled: boolean
  distilled: boolean
}>

export type CanonicalProtection =
  | "empty-source"
  | "unsettled-source"
  | "already-distilled"
  | "protected-carrier"
  | "unknown-carrier"
  | "metadata-mismatch"

export type CanonicalEditability =
  | Readonly<{ editable: false; reason: CanonicalProtection }>
  | Readonly<{ editable: true; aliasPaths: readonly (readonly (string | number)[])[] }>

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Editability is policy owned here; which metadata binds the provider to the original text is decided by the engine
 * that defines that metadata (`ReasoningCarrier`). Unknown carriers are never edited by guessing.
 */
export const assessCanonicalReasoning = (source: CanonicalReasoning): CanonicalEditability => {
  if (!source.text.trim()) return { editable: false, reason: "empty-source" }
  if (!source.settled) return { editable: false, reason: "unsettled-source" }
  if (source.distilled) return { editable: false, reason: "already-distilled" }
  const carrier = ReasoningCarrier.classify(source.metadata, source.text)
  if (carrier.kind === "plain") return { editable: true, aliasPaths: [] }
  if (carrier.kind === "mirror") return { editable: true, aliasPaths: carrier.paths }
  if (carrier.kind === "opaque") return { editable: false, reason: "protected-carrier" }
  return { editable: false, reason: carrier.reason === "mismatch" ? "metadata-mismatch" : "unknown-carrier" }
}

/** Edit a private copy and verify every declared alias changed with the authoritative text. */
export const replaceCanonicalReasoning = (
  source: CanonicalReasoning,
  after: string,
):
  | Readonly<{ text: string; metadata?: Record<string, unknown>; originalMetadata?: Record<string, unknown> }>
  | undefined => {
  const assessment = assessCanonicalReasoning(source)
  if (!assessment.editable || after === source.text) return undefined
  if (source.metadata === undefined || Object.keys(source.metadata).length === 0)
    return { text: after, metadata: source.metadata }
  let copy: Record<string, unknown>
  try {
    copy = structuredClone(source.metadata)
  } catch {
    return undefined
  }
  for (const path of assessment.aliasPaths) {
    let current: unknown = copy
    for (const segment of path.slice(0, -1)) {
      if (Array.isArray(current) && typeof segment === "number") current = current[segment]
      else if (record(current) && typeof segment === "string") current = current[segment]
      else return undefined
    }
    const last = path[path.length - 1]
    if (typeof last === "number" && Array.isArray(current)) {
      if (current[last] !== source.text) return undefined
      current[last] = after
    } else if (typeof last === "string" && record(current)) {
      if (current[last] !== source.text) return undefined
      current[last] = after
    } else return undefined
  }
  return { text: after, metadata: copy, originalMetadata: source.metadata }
}

/** Resolve one authoritative text/carrier pair for replay; legacy adoption never changed its carrier. */
export const reasoningForReplay = (input: {
  text: string
  metadata?: Record<string, unknown>
  distillation?: {
    originalText: string
    sourceFingerprint?: string
    version?: 2
    originalMetadata?: Record<string, unknown>
  }
  enabled: boolean
}): Readonly<{ text: string; metadata?: Record<string, unknown> }> => {
  const saved = input.distillation
  if (!saved) return { text: input.text, metadata: input.metadata }
  if (input.enabled && saved.version === 2) {
    // A V2 provenance must describe the stored original. If the mirror or fingerprint no longer matches, replay the
    // known original pair instead of sending contradictory text and metadata.
    if (saved.sourceFingerprint !== undefined && saved.sourceFingerprint !== Hash.sha256(saved.originalText))
      return { text: saved.originalText, metadata: saved.originalMetadata ?? input.metadata }
    // The current metadata belongs to the adopted mirror, not to the original source. Validate against the
    // provenance's original carrier so a legitimate adoption is not mistaken for corruption.
    const originalMetadata = saved.originalMetadata ?? input.metadata
    if (originalMetadata === undefined || Object.keys(originalMetadata).length === 0)
      return { text: input.text, metadata: input.metadata }
    const edited = replaceCanonicalReasoning(
      {
        text: saved.originalText,
        metadata: originalMetadata,
        settled: true,
        distilled: false,
      },
      input.text,
    )
    return edited
      ? { text: input.text, metadata: input.metadata }
      : { text: saved.originalText, metadata: originalMetadata }
  }
  if (input.enabled) {
    // Legacy adoption changed only text. Reconstruct an exact plaintext mirror for send when possible;
    // otherwise preserve the known original pair instead of emitting contradictory text and metadata.
    if (input.metadata === undefined || Object.keys(input.metadata).length === 0)
      return { text: input.text, metadata: input.metadata }
    const edited = replaceCanonicalReasoning(
      {
        text: saved.originalText,
        metadata: input.metadata,
        settled: true,
        distilled: false,
      },
      input.text,
    )
    return edited
      ? { text: edited.text, metadata: edited.metadata }
      : { text: saved.originalText, metadata: input.metadata }
  }
  if (saved.version === 2) return { text: saved.originalText, metadata: saved.originalMetadata }
  // Legacy adoption changed only text; its stored metadata is still the original carrier.
  return { text: saved.originalText, metadata: input.metadata }
}
