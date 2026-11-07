// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

// Runtime-initiated session cancellations carry a named reason and actor.
// SessionPrompt stores the reason in-process before interrupting the run, and
// the interrupted turn writes it into its durable MessageAbortedError. DAG
// recovery can then report why a child stopped without guessing afterwards.
export interface Info {
  readonly reason: string
  readonly actor: string
}

export type Origin = "runtime" | "provider" | "legacy"

const encoder = /^[a-z][a-z0-9-]*$/
const providerPrefix = "provider aborted"
const pending = new Map<string, Info>()

export function make(reason: string, actor: string): Info {
  if (!encoder.test(reason) || !encoder.test(actor)) throw new Error("invalid session abort reason or actor")
  return { reason, actor }
}

export function format(info: Info): string {
  return `child session interrupted [reason=${info.reason} actor=${info.actor}]`
}

export function parse(message: string | undefined): Info | undefined {
  if (!message) return undefined
  const match = /^child session interrupted \[reason=([a-z][a-z0-9-]*) actor=([a-z][a-z0-9-]*)\]$/.exec(message)
  if (!match) return undefined
  return { reason: match[1], actor: match[2] }
}

/** Mark an AbortError raised by the provider boundary, not by runtime cancellation. */
export function provider(message: string | undefined): string {
  if (!message) return providerPrefix
  if (origin(message) !== "legacy") return message
  return `${providerPrefix}: ${message}`
}

export function origin(message: string | undefined): Origin {
  if (parse(message)) return "runtime"
  if (message === providerPrefix || message?.startsWith(`${providerPrefix}: `)) return "provider"
  return "legacy"
}

/** Only an unmarked abort record may be upgraded by a runtime cancellation. */
export function replaceableByCancellation(message: string | undefined): boolean {
  return origin(message) === "legacy"
}

/** Remember the reason until the interrupted turn finalizes its durable error. */
export function set(sessionID: string, info: Info): void {
  pending.set(sessionID, info)
}

/** Multiple interrupted owners may need the same reason. */
export function peek(sessionID: string): Info | undefined {
  return pending.get(sessionID)
}

export function take(sessionID: string): Info | undefined {
  const info = pending.get(sessionID)
  if (info) pending.delete(sessionID)
  return info
}

/** Clear only our own entry, never a newer cancellation's reason. */
export function clear(sessionID: string, info: Info): void {
  if (pending.get(sessionID) === info) pending.delete(sessionID)
}

export * as SessionAbortReason from "./abort-reason"
