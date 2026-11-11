// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeContext } from "./runtime-context"
import type { SessionID } from "./schema"

/**
 * Per-session state that travels in runtime-context blocks instead of the
 * system prompt (Issue #1019, PR10).
 *
 * The system prompt must stay byte-identical for the life of a conversation:
 * providers cache it as the request prefix. State that changes between
 * requests, or that differs between directories, therefore lives in slots and
 * is appended to the history only when its content changes.
 *
 * Goal, memory, environment and date are computed by the request builder.
 * Tool and feature owners register additional slots (for example DAG mode)
 * through `Slots.set`; they never write the system prompt or the tool list.
 */
export type Slot = RuntimeContext.State

/** Slot keys the request builder owns. Owners cannot replace them. */
const RESERVED = new Set(["goal", "memory", "env", "date"])

export const cleared = {
  goal: "No autonomous goal is active.",
  memory: "No project memory data applies to the current request.",
  env: "No environment information is available.",
  date: "The current date is unavailable.",
} as const

export function goal(parts: readonly string[]): Slot {
  return { key: "goal", parts, cleared: cleared.goal }
}

export function memory(parts: readonly string[]): Slot {
  return { key: "memory", parts, cleared: cleared.memory }
}

export type Environment = {
  readonly directory: string
  readonly root: string
  readonly git: boolean
}

/**
 * Working directory and repository facts. They depend on where the session
 * runs, so they cannot stay in the cached system prefix; the date is a separate
 * slot because it changes without the environment changing.
 */
export function environment(info: Environment): Slot {
  return {
    key: "env",
    parts: [
      [
        "<env>",
        `  Working directory: ${info.directory}`,
        `  Workspace root folder: ${info.root}`,
        `  Is directory a git repo: ${info.git ? "yes" : "no"}`,
        "</env>",
      ].join("\n"),
    ],
    cleared: cleared.env,
  }
}

export function date(now: Date): Slot {
  return { key: "date", parts: [`Today's date: ${now.toDateString()}`], cleared: cleared.date }
}

/** Ordered state array for one request. Goal and memory keep their original order. */
export function state(input: {
  readonly goal: readonly string[]
  readonly memory: readonly string[]
  readonly environment?: Environment
  readonly now?: Date
  readonly custom?: readonly Slot[]
}): Slot[] {
  return [
    goal(input.goal),
    memory(input.memory),
    ...(input.environment ? [environment(input.environment)] : []),
    ...(input.now ? [date(input.now)] : []),
    ...(input.custom ?? []),
  ]
}

export interface Slots {
  /** Register or replace one owner's slot for a session. */
  readonly set: (
    sessionID: SessionID,
    key: string,
    value: { readonly parts: readonly string[]; readonly cleared: string },
  ) => void
  /** Drop one owner's slot without announcing a cleared state. */
  readonly delete: (sessionID: SessionID, key: string) => void
  readonly list: (sessionID: SessionID) => readonly Slot[]
  /** Drop every slot of one session. */
  readonly forget: (sessionID: SessionID) => void
}

/**
 * Registry for owner-contributed slots. It stores values only; the request
 * builder decides where they enter the history. Reserved keys are programming
 * errors: allowing them would let two owners write the same fact.
 */
export function make(): Slots {
  const sessions = new Map<SessionID, Map<string, Slot>>()
  return {
    set(sessionID, key, value) {
      if (RESERVED.has(key)) throw new Error(`Runtime slot "${key}" is owned by the request builder`)
      const current = sessions.get(sessionID) ?? new Map<string, Slot>()
      current.set(key, { ...value, key })
      sessions.set(sessionID, current)
    },
    delete(sessionID, key) {
      const current = sessions.get(sessionID)
      if (!current) return
      current.delete(key)
      if (current.size === 0) sessions.delete(sessionID)
    },
    list(sessionID) {
      return [...(sessions.get(sessionID)?.values() ?? [])]
    },
    forget(sessionID) {
      sessions.delete(sessionID)
    },
  }
}

export * as RuntimeSlots from "./runtime-slots"
