import { createHash } from "node:crypto"
import type { LLMEvent } from "@opencode-ai/llm"
import { isRecord } from "@/util/record"

const key = "thinkingReplay"
const digestPattern = /^[a-f0-9]{64}$/
type Origin = {
  version: 1
  prefix: string
  block: string
  previous: string | null
  invalidated?: boolean
  forceInvalidation?: boolean
}

export function origin(metadata: unknown): Origin | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.opencode)) return undefined
  const value = metadata.opencode[key]
  if (!isRecord(value) || value.version !== 1) return undefined
  if (typeof value.prefix !== "string" || !digestPattern.test(value.prefix)) return undefined
  if (typeof value.block !== "string" || !digestPattern.test(value.block)) return undefined
  if (value.previous !== null && (typeof value.previous !== "string" || !digestPattern.test(value.previous)))
    return undefined
  return {
    version: 1,
    prefix: value.prefix,
    block: value.block,
    previous: value.previous,
    ...(value.invalidated === true ? { invalidated: true } : {}),
    ...(value.forceInvalidation === true ? { forceInvalidation: true } : {}),
  }
}

function local(metadata: unknown, value: Origin) {
  const current = isRecord(metadata) ? metadata : {}
  return { ...current, opencode: { ...(isRecord(current.opencode) ? current.opencode : {}), [key]: value } }
}

export function invalidate(metadata: unknown) {
  const value = origin(metadata)
  return value ? local(metadata, { ...value, invalidated: true }) : undefined
}

export function forceInvalidation(metadata: unknown) {
  const value = origin(metadata)
  return value ? local(metadata, { ...value, forceInvalidation: true }) : undefined
}

function withoutLocal(metadata: unknown): unknown {
  if (!isRecord(metadata)) return metadata
  const copy = { ...metadata }
  if (isRecord(copy.opencode)) {
    const value = { ...copy.opencode }
    delete value[key]
    if (Object.keys(value).length) copy.opencode = value
    else delete copy.opencode
  }
  return Object.keys(copy).length ? copy : undefined
}

const metadata = (part: Record<string, unknown>) => part.providerMetadata ?? part.providerOptions

function carrier(value: unknown) {
  if (!isRecord(value)) return undefined
  for (const name of ["anthropic", "bedrock"]) {
    const item = value[name]
    if (!isRecord(item)) continue
    if (typeof item.signature === "string") return { signature: item.signature }
    if (typeof item.redactedData === "string") return { redacted: item.redactedData }
    if (typeof item.redactedContent === "string") return { redacted: item.redactedContent }
  }
  return undefined
}

/** Snapshot identities before a transform can remove signed carriers. This does not compare prefixes. */
export function replayOrigins(messages: readonly unknown[]): string[] {
  const result = new Set<string>()
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "reasoning") continue
      const value = metadata(part)
      const saved = origin(value)
      if (saved && !saved.invalidated && carrier(value)) result.add(saved.block)
    }
  }
  return [...result]
}

function clean(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("base64") }
  if (value instanceof URL) return value.href
  if (Array.isArray(value)) return value.map(clean)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .flatMap((name) => {
        const item = clean(value[name])
        return item === undefined ? [] : [[name, item]]
      }),
  )
}

// Cache annotations are transport hints only in provider metadata, never business content.
function withoutCaching(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCaching)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, item]) => {
      if (["cache_control", "cacheControl", "cachePoint", "copilot_cache_control"].includes(name)) return []
      return [[name, withoutCaching(item)]]
    }),
  )
}

const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(clean(value)))
    .digest("hex")

export function block(text: string, value: unknown): string | undefined {
  const item = carrier(value)
  return item ? hash({ text, ...item }) : undefined
}

function prefixMetadata(value: unknown) {
  const stripped = withoutLocal(value)
  if (!isRecord(stripped)) return undefined
  const result = Object.fromEntries(
    Object.entries(stripped).flatMap(([name, item]) => {
      if (name === "opencode") return []
      const value = clean(withoutCaching(item))
      return isRecord(value) && Object.keys(value).length === 0 ? [] : [[name, value]]
    }),
  )
  return Object.keys(result).length ? result : undefined
}

function canonical(part: Record<string, unknown>) {
  const native = prefixMetadata(metadata(part))
  if (part.type === "reasoning") return undefined
  if (part.type === "text") return { type: "text", text: part.text, metadata: native }
  if (part.type === "tool-call")
    return {
      type: "tool-call",
      id: part.toolCallId ?? part.id,
      name: part.toolName ?? part.name,
      input: part.input,
      ...(part.providerExecuted === true ? { providerExecuted: true } : {}),
      metadata: native,
    }
  if (part.type === "tool-result")
    return {
      type: "tool-result",
      id: part.toolCallId ?? part.id,
      name: part.toolName ?? part.name,
      output: part.output ?? { type: part.resultType === "error" ? "error-text" : part.resultType, value: part.result },
      ...(part.providerExecuted === true ? { providerExecuted: true } : {}),
      metadata: native,
    }
  return { ...part, providerOptions: undefined, providerMetadata: undefined, metadata: native }
}

/** Final client projection provenance, never a claim about a relay's hidden account or route. */
export function project<T>(input: {
  messages: readonly T[]
  system?: readonly unknown[]
  tools?: readonly unknown[]
  context?: unknown
  sourceOrigins?: readonly string[]
}) {
  let prefix = hash({
    version: 1,
    context: input.context,
    tools: [...(input.tools ?? [])].map(clean),
  })
  let previous: string | undefined
  let gap = false
  const surviving = new Set(replayOrigins(input.messages))
  const removed = (input.sourceOrigins ?? []).filter((id) => !surviving.has(id))
  const invalidated = new Set(removed)
  const diagnostic = {
    removedBeforeProjection: invalidated.size,
    carriers: 0,
    knownOrigins: 0,
    unknownLegacy: 0,
    retained: 0,
    alreadyInvalidated: 0,
    prefixChanged: 0,
    chainChanged: 0,
    blockChanged: 0,
    compactionInvalidated: 0,
    unknownAfterGap: 0,
    newlyInvalidated: 0,
  }

  const append = (role: string, part: Record<string, unknown>) => {
    const value = canonical(part)
    if (value !== undefined) prefix = hash({ prefix, role: role === "tool" ? "user" : role, content: value })
  }
  for (const item of input.system ?? []) {
    if (isRecord(item)) append("system", item)
    else append("system", { type: "text", text: item })
  }
  const messages: T[] = []
  for (const message of input.messages) {
    if (!isRecord(message) || typeof message.role !== "string") throw new Error("Invalid thinking replay message")
    const source =
      typeof message.content === "string"
        ? [
            {
              type: "text",
              text: message.content,
              providerOptions: message.providerOptions,
              providerMetadata: message.providerMetadata,
            },
          ]
        : message.content
    if (!Array.isArray(source)) throw new Error("Invalid thinking replay content")
    const parts: unknown[] = []
    for (const part of source) {
      if (!isRecord(part)) throw new Error("Invalid thinking replay part")
      const value = metadata(part)
      const identity = part.type === "reasoning" && typeof part.text === "string" ? block(part.text, value) : undefined
      if (identity) {
        const saved = origin(value)
        diagnostic.carriers++
        if (saved) diagnostic.knownOrigins++
        else diagnostic.unknownLegacy++
        // Official preserved-thinking contract (platform.claude.com/docs/en/
        // build-with-claude/preserved-thinking): removing thinking blocks from
        // the START of a history, from the END, or removing all of them is
        // valid — only removing blocks from the MIDDLE while keeping later
        // blocks invalidates those later blocks. The chain check therefore
        // compares against the immediately preceding RETAINED block:
        // `previous === undefined` means no retained predecessor, so a leading
        // removal must not invalidate. Do not tighten this to the absolute
        // chain start: that would tombstone legal histories.
        const mismatch =
          saved &&
          (saved.forceInvalidation ||
            saved.block !== identity ||
            saved.prefix !== prefix ||
            (previous !== undefined && saved.previous !== previous))
        if (saved?.invalidated || mismatch || (!saved && gap)) {
          gap = true
          if (saved?.invalidated) diagnostic.alreadyInvalidated++
          else if (saved) {
            if (saved.forceInvalidation) diagnostic.compactionInvalidated++
            if (saved.prefix !== prefix) diagnostic.prefixChanged++
            if (saved.block !== identity) diagnostic.blockChanged++
            if (previous !== undefined && saved.previous !== previous) diagnostic.chainChanged++
          } else diagnostic.unknownAfterGap++
          if (saved && !saved.invalidated) invalidated.add(saved.block)
          continue
        }
        diagnostic.retained++
        previous = identity
        gap = false
      } else append(message.role, part)
      parts.push({
        ...part,
        ...(part.providerOptions !== undefined ? { providerOptions: withoutLocal(part.providerOptions) } : {}),
        ...(part.providerMetadata !== undefined ? { providerMetadata: withoutLocal(part.providerMetadata) } : {}),
      })
    }
    if (parts.length)
      messages.push(
        Object.assign({}, message, { content: typeof message.content === "string" ? message.content : parts }),
      )
  }

  const reasoning = new Map<string, { text: string; metadata: unknown }>()
  const text = new Map<string, { text: string; metadata: unknown }>()
  const bind = (event: LLMEvent): LLMEvent => {
    switch (event.type) {
      case "reasoning-start":
        reasoning.set(event.id, { text: "", metadata: event.providerMetadata })
        break
      case "reasoning-delta": {
        const item = reasoning.get(event.id)
        if (item) {
          item.text += event.text
          if (event.providerMetadata) item.metadata = event.providerMetadata
        }
        break
      }
      case "reasoning-end": {
        const item = reasoning.get(event.id)
        reasoning.delete(event.id)
        const value = event.providerMetadata ?? item?.metadata
        const identity = item && block(item.text, value)
        if (!identity) break
        const bound = local(value, { version: 1, prefix, block: identity, previous: previous ?? null })
        previous = identity
        return { ...event, providerMetadata: bound }
      }
      case "text-start":
        text.set(event.id, { text: "", metadata: event.providerMetadata })
        break
      case "text-delta": {
        const item = text.get(event.id)
        if (item) item.text += event.text
        break
      }
      case "text-end": {
        const item = text.get(event.id)
        text.delete(event.id)
        if (item)
          append("assistant", {
            type: "text",
            text: item.text,
            providerMetadata: event.providerMetadata ?? item.metadata,
          })
        break
      }
      case "tool-call":
        append("assistant", { ...event, type: "tool-call" })
        break
      case "tool-result":
        append(event.providerExecuted ? "assistant" : "tool", { ...event, type: "tool-result" })
        break
    }
    return event
  }
  diagnostic.newlyInvalidated = invalidated.size
  return { messages, invalidated: [...invalidated], diagnostic, bind }
}

/** Static, bounded diagnostics only. Never return error bodies, messages, headers, or opaque signatures. */
export function errorDiagnostic(error: unknown): {
  classification: string
  status?: number
  upstreamRequestID?: string
} {
  try {
    let current = error
    const seen = new Set<unknown>()
    let status: number | undefined
    let upstreamRequestID: string | undefined
    let signature = false
    let prefix = false
    for (let depth = 0; depth < 8 && isRecord(current) && !seen.has(current); depth++) {
      seen.add(current)
      const http = isRecord(current.http) ? current.http : undefined
      const response = http && isRecord(http.response) ? http.response : undefined
      const code = current.statusCode ?? response?.status
      if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) status = code
      const headers = isRecord(current.responseHeaders) ? current.responseHeaders : undefined
      const id =
        http?.requestId ?? headers?.["request-id"] ?? headers?.["x-request-id"] ?? headers?.["x-amzn-requestid"]
      if (typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id)) upstreamRequestID = id
      for (const value of [current.message, current.responseBody, http?.body]) {
        if (typeof value !== "string") continue
        const text = value.slice(0, 16_384).toLowerCase()
        prefix ||= text.includes("bound to a different conversation") || text.includes("prefix mismatch")
        signature ||= text.includes("signature")
      }
      current = current.cause ?? current.reason ?? current.error
    }
    return {
      classification: prefix ? "conversation_prefix_binding" : signature ? "signature_other" : "other",
      status,
      upstreamRequestID,
    }
  } catch {
    return { classification: "unavailable" }
  }
}

export * as ThinkingReplay from "./thinking-replay"
