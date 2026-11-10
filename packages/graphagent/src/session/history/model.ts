// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ModelMessage } from "ai"
import type { WithParts } from "@graphagent/core/v1/session"
import { createHash } from "node:crypto"
import type { Provider } from "@/provider/provider"
import type { MessageID, SessionID } from "../schema"

/**
 * Content-addressed cache for the per-message model conversion (Issue #1022,
 * H4/PR4).
 *
 * The conversion of one persisted message depends on its wire content, the
 * request model, the five conversion options and one compaction-boundary bit.
 * Everything else about the request (system prompt, tool definitions, folding
 * state) is applied downstream and must never be baked into a cached fragment.
 *
 * Entries are keyed by `(sessionID, messageID, bucket)`. The bucket carries the
 * request model and option digest; the entry carries a content digest and the
 * boundary bit. Hits return a structural copy so the request path can mutate
 * the result without touching the cached template.
 */

export const MODEL_HISTORY_BYTES = 32 * 1024 * 1024
export const MODEL_HISTORY_ENTRY_BYTES = 1024 * 1024

const CACHE_VERSION = "model-history-v1"

export interface ModelHistoryEntry {
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly bucket: string
  readonly effect: number
  /** Identity token of the message object the fragment was built from. */
  token: number
  /** Wire-content digest, used when the message object was replaced. */
  readonly digest: string
  readonly fragment: ModelMessage[]
  readonly bytes: number
}

export interface ModelHistoryState {
  /** Insertion order doubles as the LRU order; hits move entries to the tail. */
  readonly entries: Map<string, ModelHistoryEntry>
  bytes: number
  readonly limit: number
  readonly identities: WeakMap<WithParts, number>
  nextIdentity: number
  readonly metrics: { conversions: number }
}

export function makeModelHistoryState(limit = MODEL_HISTORY_BYTES): ModelHistoryState {
  return {
    entries: new Map(),
    bytes: 0,
    limit,
    identities: new WeakMap(),
    nextIdentity: 0,
    metrics: { conversions: 0 },
  }
}

const entryKey = (sessionID: SessionID, messageID: MessageID, bucket: string) =>
  `${sessionID}\u0000${messageID}\u0000${bucket}`

function identity(state: ModelHistoryState, message: WithParts) {
  const existing = state.identities.get(message)
  if (existing !== undefined) return existing
  const token = ++state.nextIdentity
  state.identities.set(message, token)
  return token
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortValue((value as Record<string, unknown>)[key])
    return sorted
  }
  return value
}

/** Stable JSON used by the cache keys and the `verify` comparison. */
export function canonicalJson(value: unknown) {
  return JSON.stringify(sortValue(value))
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

/** Model and option identity of one conversion request. */
export function bucket(
  model: Provider.Model,
  options?: {
    stripMedia?: boolean
    toolOutputMaxChars?: number
    reasoningDistillationEnabled?: boolean
    stripSignedThinking?: boolean
    stripOpaqueReasoning?: boolean
  },
) {
  return sha256(
    canonicalJson({
      version: CACHE_VERSION,
      providerID: model.providerID,
      modelID: model.id,
      apiNpm: model.api.npm,
      apiID: model.api.id,
      options: {
        stripMedia: options?.stripMedia === true,
        toolOutputMaxChars: options?.toolOutputMaxChars || undefined,
        reasoningDistillationEnabled: options?.reasoningDistillationEnabled === true,
        stripSignedThinking: options?.stripSignedThinking === true,
        stripOpaqueReasoning: options?.stripOpaqueReasoning === true,
      },
    }),
  )
}

/**
 * Digest of everything the conversion can read from a message. Conservatively
 * includes fields the conversion does not use (ids, timestamps): an extra change
 * only causes a miss, never a stale hit.
 */
export function contentDigest(message: WithParts) {
  return sha256(canonicalJson({ info: message.info, parts: message.parts }))
}

/** Only frozen messages are safe to cache: their nested objects must be immutable. */
export function trusted(message: WithParts) {
  return Object.isFrozen(message) && Object.isFrozen(message.info) && Object.isFrozen(message.parts)
}

export function countConversion(state: ModelHistoryState) {
  state.metrics.conversions++
}

/**
 * Returns a structural copy of the cached fragment, or `undefined` on a miss.
 * Identity is the fast path; a replaced message object falls back to the wire
 * digest so a process reload does not force a reconversion.
 */
export function lookup(
  state: ModelHistoryState,
  sessionID: SessionID,
  requestBucket: string,
  message: WithParts,
  effect: number,
): ModelMessage[] | undefined {
  const key = entryKey(sessionID, message.info.id, requestBucket)
  const entry = state.entries.get(key)
  if (!entry || entry.effect !== effect) return undefined
  if (entry.token !== identity(state, message)) {
    if (entry.digest !== contentDigest(message)) return undefined
    entry.token = identity(state, message)
  }
  state.entries.delete(key)
  state.entries.set(key, entry)
  return structuredClone(entry.fragment)
}

export function store(
  state: ModelHistoryState,
  sessionID: SessionID,
  requestBucket: string,
  message: WithParts,
  effect: number,
  fragment: ModelMessage[],
) {
  if (!trusted(message)) return
  const serialized = JSON.stringify(fragment)
  // Base64 media would be multiplied across model buckets; leave those
  // messages uncached instead of letting one attachment dominate the budget.
  if (serialized.includes("data:")) return
  const bytes = Buffer.byteLength(serialized)
  if (bytes > MODEL_HISTORY_ENTRY_BYTES) return

  const key = entryKey(sessionID, message.info.id, requestBucket)
  const previous = state.entries.get(key)
  if (previous) {
    state.bytes -= previous.bytes
    state.entries.delete(key)
  }
  state.entries.set(key, {
    sessionID,
    messageID: message.info.id,
    bucket: requestBucket,
    effect,
    token: identity(state, message),
    digest: contentDigest(message),
    fragment: structuredClone(fragment),
    bytes,
  })
  state.bytes += bytes
  enforceBudget(state, key)
}

function enforceBudget(state: ModelHistoryState, keep: string) {
  if (state.limit <= 0) return
  for (const [key, entry] of state.entries) {
    if (state.bytes <= state.limit) return
    if (key === keep) continue
    state.entries.delete(key)
    state.bytes -= entry.bytes
  }
}

/** Drop every cached fragment for one session (session deletion or directory disposal). */
export function forgetSession(state: ModelHistoryState, sessionID: SessionID) {
  for (const [key, entry] of state.entries) {
    if (entry.sessionID !== sessionID) continue
    state.entries.delete(key)
    state.bytes -= entry.bytes
  }
}

export function size(state: ModelHistoryState) {
  return { entries: state.entries.size, bytes: state.bytes }
}

export * as ModelHistory from "./model"
