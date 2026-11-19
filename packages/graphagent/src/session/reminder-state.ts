// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The state reminders a user turn still owes (Issue #1456, PR3).
 *
 * The todo, plan and DAG notes tell the model what the engine's state is. Each is one text part of the user message
 * that opens a turn, written only when that state differs from what the history already says: a state that did not
 * change adds nothing, so the request prefix of the next turn is the one of the last. A state that went away adds one
 * note that withdraws the earlier one, since the earlier one stays in the history.
 *
 * A reminder part carries `metadata[KEY] = { kind, digest }`: the kind it speaks for and the digest of its text
 * (`CLEARED` for a withdrawal). The history is the only memory, so the decision survives a restart, a fork and a
 * compaction: a note the compaction took away is sent again.
 *
 * Pure: `pending` reads the history it is given and decides; writing the parts is `SessionReminders.settle`'s.
 */
import { Hash } from "@graphagent/core/util/hash"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { isRecord } from "@/util/record"

/**
 * The key of a reminder part's `metadata`. It must not be `reminder`: `MessageV2.isAutomationMessage` reads that key
 * to tell a message an automation wrote from the user's own.
 */
export const KEY = "stateReminder"

/** The states that have a reminder. */
export type Kind = "plan" | "todo" | "dag"

/** The order the notes of one turn are written in. */
export const ORDER: readonly Kind[] = ["plan", "todo", "dag"]

/** What a kind wants this turn: no decision is possible now, so leave its note as it is. */
export const SKIP = "skip"

/** The digest a withdrawal carries, so the next turn can tell that nothing of the kind is in force. */
export const CLEARED = "cleared"

/** What a kind wants: its note's text, `undefined` for no note at all, or `SKIP`. */
export type Desired = string | undefined

/** One note to write: the kind it speaks for, its text and the digest the part is marked with. */
export interface Entry {
  readonly kind: Kind
  readonly text: string
  readonly digest: string
}

/** The digest of a note's text: enough to tell two texts apart, short enough to keep in a part. */
export const digest = (text: string): string => Hash.sha256(text).slice(0, 16)

function markOf(part: SessionV1.Part): { readonly kind: string; readonly digest: string } | undefined {
  if (part.type !== "text") return undefined
  const mark = part.metadata?.[KEY]
  if (!isRecord(mark) || typeof mark.kind !== "string" || typeof mark.digest !== "string") return undefined
  return { kind: mark.kind, digest: mark.digest }
}

/** The digest of the newest note of `kind` in the history; `undefined` when the history has none. */
export function lastDigest(messages: readonly SessionV1.WithParts[], kind: Kind): string | undefined {
  for (let at = messages.length - 1; at >= 0; at--) {
    const parts = messages[at].parts
    for (let index = parts.length - 1; index >= 0; index--) {
      const mark = markOf(parts[index])
      if (mark?.kind === kind) return mark.digest
    }
  }
  return undefined
}

/**
 * The notes to write, in `ORDER`. A kind that wants a text is written when the history's newest note of that kind
 * says something else. A kind that wants none is written as its `cleared` text when the history has a note of it that
 * is still in force. A kind to `SKIP` is left alone.
 */
export function pending(input: {
  readonly messages: readonly SessionV1.WithParts[]
  readonly desired: Readonly<Record<Kind, Desired>>
  readonly cleared: Readonly<Record<Kind, string>>
}): Entry[] {
  return ORDER.flatMap((kind): Entry[] => {
    const want = input.desired[kind]
    if (want === SKIP) return []
    const last = lastDigest(input.messages, kind)
    if (want === undefined) {
      const inForce = last !== undefined && last !== CLEARED
      return inForce ? [{ kind, text: input.cleared[kind], digest: CLEARED }] : []
    }
    const next = digest(want)
    return next === last ? [] : [{ kind, text: want, digest: next }]
  })
}

export * as ReminderState from "./reminder-state"
