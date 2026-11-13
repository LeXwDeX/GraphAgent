// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Cause, Effect } from "effect"
import { EngineProcess } from "../engine-process"
import type { RuntimeSlots } from "../runtime-slots"
import type { SessionID } from "../schema"
import { ChildRegistry as Registry } from "./registry"
import type { ChildRunsInterface, ChildRunView } from "./types"

/**
 * The `delegations` runtime slot (Issue #1026, PR3b): what a parent session
 * has delegated, for the model only. It lists the runs that are still going,
 * the finished background runs whose result has not reached the parent yet, and
 * the few that ended last, so the model knows which task ids it can resume or
 * cancel without asking.
 *
 * Like every owner slot it travels in runtime-context blocks, never in the
 * system prompt or the tool list, and a block is appended only when the
 * rendered content changes (`RuntimeContext.place`). Two rules keep that cheap
 * for the cached request prefix:
 * - the content is a function of the runs alone: no clock, no counters, and a
 *   queued run reads like a running one, so a run's start of work writes no new
 *   block;
 * - it is bounded: a few entries, short descriptions, and a byte budget, so a
 *   long session of delegations cannot grow the block.
 *
 * Reading the runs costs one query, and only for a parent this process
 * registered a run for (`ChildRegistry.delegated`): a session that never
 * delegated costs nothing, and its requests carry no slot.
 */

export const KEY = "delegations"
export const CLEARED = "No delegated child runs are tracked for this conversation."

/** How many of the parent's newest runs are read; an older run that is still going is not listed. */
export const WINDOW = 40
/** Runs that ended and owe nothing more, listed next to the live ones. */
export const MAX_RECENT = 5
export const MAX_LISTED = 20
const MAX_DESCRIPTION = 80
/** Bytes (UTF-8) of the rendered block. */
export const MAX_BYTES = 4096

type State = "running" | "completed" | "failed" | "cancelled" | "interrupted"

const stateOf = (run: ChildRunView): State => {
  // A queued run is waiting for its slot: to the model it is already running.
  if (run.state !== "ended") return "running"
  switch (run.outcome?.type) {
    case "completed":
      return "completed"
    case "error":
      return "failed"
    case "cancelled":
      return "cancelled"
    default:
      return "interrupted"
  }
}

/** The ledger's condition (`ChildStore`): a finished background task whose result has not reached the parent. */
const pending = (run: ChildRunView) =>
  run.state === "ended" && run.detached && run.reportedAt === undefined && run.ownerKind === "task"

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const attribute = (text: string) => escape(text).replace(/"/g, "&quot;")

// The task tool titles a child session "<description> (@<agent> subagent)": the description is what the model wrote.
const SUFFIX = / \(@[^)]*subagent\)$/

function describe(run: ChildRunView): string {
  const flat = (run.title ?? "").replace(SUFFIX, "").replace(/\s+/g, " ").trim()
  const chars = Array.from(flat)
  return escape(chars.length > MAX_DESCRIPTION ? `${chars.slice(0, MAX_DESCRIPTION - 3).join("")}...` : flat)
}

function line(run: ChildRunView): string {
  const attributes = [
    `id="${run.childSessionID}"`,
    ...(run.agent ? [`agent="${attribute(run.agent)}"`] : []),
    `state="${stateOf(run)}"`,
    `background="${run.detached}"`,
    ...(pending(run) ? ['delivery="pending"'] : []),
  ]
  return `<task ${attributes.join(" ")}>${describe(run)}</task>`
}

const HEADER =
  'Child runs this conversation delegated, newest first. delivery="pending": the run finished and its result has not been delivered to you yet; it arrives as a notice.'

function block(shown: ReadonlyArray<ChildRunView>, omitted: number): string {
  return [
    "<delegations>",
    HEADER,
    ...shown.map(line),
    ...(omitted > 0 ? [`(${omitted} more runs not listed)`] : []),
    "</delegations>",
  ].join("\n")
}

/**
 * The block for the runs of one parent, newest first, or nothing when there are none.
 * Live runs and runs still owed to the ledger always come first in the choice;
 * the oldest are dropped when the entry cap or the byte budget bites.
 */
export function render(runs: ReadonlyArray<ChildRunView>): string | undefined {
  const keep = new Set<string>()
  let recent = 0
  for (const run of runs) {
    if (run.state !== "ended" || pending(run)) keep.add(run.id)
    else if (recent < MAX_RECENT) {
      recent += 1
      keep.add(run.id)
    }
  }
  const chosen = runs.filter((run) => keep.has(run.id))
  if (chosen.length === 0) return undefined
  let shown = chosen.slice(0, MAX_LISTED)
  while (shown.length > 1 && Buffer.byteLength(block(shown, chosen.length - shown.length)) > MAX_BYTES) {
    // The oldest entry that owes the model nothing goes first.
    const index = shown.findLastIndex((run) => run.state === "ended" && !pending(run))
    shown = shown.filter((_, at) => at !== (index === -1 ? shown.length - 1 : index))
  }
  return block(shown, chosen.length - shown.length)
}

export function slot(runs: ReadonlyArray<ChildRunView>): RuntimeSlots.Slot {
  const text = render(runs)
  return { key: KEY, parts: text === undefined ? [] : [text], cleared: CLEARED }
}

/**
 * The delegations slot of one parent: none for a parent that never delegated in
 * this process, otherwise the slot, empty when its runs are gone. A read that
 * fails costs the request this slot and nothing else.
 */
export const delegations = (
  children: Pick<ChildRunsInterface, "listByParent">,
  sessionID: SessionID,
): Effect.Effect<ReadonlyArray<RuntimeSlots.Slot>> =>
  Registry.delegated(sessionID)
    ? children.listByParent(sessionID, { limit: WINDOW }).pipe(
        Effect.map((runs) => [slot(runs)]),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("delegations slot was not read", { sessionID, cause: Cause.pretty(cause) }).pipe(
                Effect.as([]),
              ),
        ),
      )
    : Effect.succeed([])

/**
 * The owner slots of one request: what features registered for the session,
 * then the parent's delegations.
 */
export const custom = (children: Pick<ChildRunsInterface, "listByParent">, sessionID: SessionID) =>
  delegations(children, sessionID).pipe(
    Effect.map((runs) => [...EngineProcess.runtimes.runtimeSlots.list(sessionID), ...runs]),
  )

export * as ChildSlot from "./slot"
