// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ModelProfile } from "@graphagent/core/model-profile"
import { Hash } from "@graphagent/core/util/hash"
import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai"

/**
 * Tool call ids projected onto the `toolCallId` constraint of a model's profile.
 *
 * An id that meets the constraint stays as it is. One that does not becomes a deterministic form of the id and its
 * SHA-256 digest, so two different ids do not become one: padding and cutting made `functions.bash:0` and
 * `functions.read:1` the same nine-character id. Within one request, a result that another id already holds is
 * replaced by the next numbered candidate. The mapping reads only the ids of the request and the order in which
 * they first appear.
 */
export type Constraint = ModelProfile["toolCallId"]

const DASH = /^[A-Za-z0-9_-]+$/
const BARE = /^[A-Za-z0-9]+$/

/** The length an `alnum` constraint asks for; a value that is not a positive integer means none. */
function lengthOf(c: Constraint): number | undefined {
  const length = c.length
  return length !== undefined && Number.isInteger(length) && length > 0 ? length : undefined
}

/** Whether the whole id meets the constraint. `alnum` with a length asks for exactly that length. */
export function compliant(id: string, c: Constraint): boolean {
  if (c.charset === "any") return true
  if (c.charset === "alnum_dash") return DASH.test(id)
  const length = lengthOf(c)
  return BARE.test(id) && (length === undefined || id.length === length)
}

/** The form of an id that does not meet the constraint. Candidate 0 hashes `id`, candidate `n` hashes `id#n`. */
function render(id: string, c: Constraint, n: number): string {
  if (c.charset === "any") return id
  const digest = Hash.sha256(n === 0 ? id : `${id}#${n}`)
  if (c.charset === "alnum_dash") return `${id.replace(/[^A-Za-z0-9_-]/g, "_")}_${digest.slice(0, 8)}`
  const length = lengthOf(c)
  if (length !== undefined) return digest.repeat(Math.ceil(length / digest.length)).slice(0, length)
  return `${id.replace(/[^A-Za-z0-9]/g, "")}${digest.slice(0, 8)}`
}

/** The id the constraint allows: the id itself when it meets the constraint, its digest form otherwise. */
export function project(id: string, c: Constraint): string {
  return compliant(id, c) ? id : render(id, c, 0)
}

/**
 * The mapping for the ids of one request, `ids` in the order they first appear. An id that meets the constraint maps
 * to itself and is taken first; every other id takes its first candidate that no result holds yet. An id that is
 * appended later changes an earlier result only when it meets the constraint and equals that result.
 */
export function plan(ids: readonly string[], c: Constraint): Map<string, string> {
  const taken = new Set(ids.filter((id) => compliant(id, c)))
  const mapped = new Map<string, string>()
  for (const id of ids) {
    if (mapped.has(id)) continue
    if (taken.has(id)) {
      mapped.set(id, id)
      continue
    }
    let n = 0
    let candidate = render(id, c, n)
    while (taken.has(candidate)) candidate = render(id, c, ++n)
    taken.add(candidate)
    mapped.set(id, candidate)
  }
  return mapped
}

/** The parts that name a tool call: the call and the result. */
const naming = (part: { type: string }): part is ToolCallPart | ToolResultPart =>
  part.type === "tool-call" || part.type === "tool-result"

/** The tool call ids of the request, each once, in the order they first appear. */
function idsOf(msgs: readonly ModelMessage[]): string[] {
  const ids = new Set<string>()
  for (const msg of msgs) {
    if ((msg.role !== "assistant" && msg.role !== "tool") || !Array.isArray(msg.content)) continue
    for (const part of msg.content) if (naming(part)) ids.add(part.toolCallId)
  }
  return [...ids]
}

/** The content with the ids replaced, or `undefined` when no id changes. */
function withIds<T extends { type: string }>(content: T[], mapped: ReadonlyMap<string, string>): T[] | undefined {
  let changed = false
  const next = content.map((part) => {
    if (!naming(part)) return part
    const toolCallId = mapped.get(part.toolCallId) ?? part.toolCallId
    if (toolCallId === part.toolCallId) return part
    changed = true
    return { ...part, toolCallId }
  })
  return changed ? next : undefined
}

/**
 * The messages with the id of every tool call and tool result projected onto the constraint. A call and its result
 * keep the same id, because the mapping is made once over all the ids of the request. A message that has nothing to
 * change is returned as it is; the input is not modified.
 */
export function remap(msgs: ModelMessage[], c: Constraint): ModelMessage[] {
  if (c.charset === "any") return msgs
  const mapped = plan(idsOf(msgs), c)
  return msgs.map((msg) => {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const content = withIds(msg.content, mapped)
      return content ? { ...msg, content } : msg
    }
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      const content = withIds(msg.content, mapped)
      return content ? { ...msg, content } : msg
    }
    return msg
  })
}

export * as ToolCallId from "./tool-call-id"
