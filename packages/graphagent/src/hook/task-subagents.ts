/**
 * Process-local registry of child sessions currently driven in the foreground by
 * the task tool. task.ts fires `SubagentStop` (and drives its continuation) for
 * those sessions, so the child's prompt loop must not also fire the main-agent
 * `Stop` hook on a clean exit. Every other child session (SDK-created
 * `POST /session {parentID}`, DAG nodes, background tasks) keeps firing Stop.
 *
 * Entries are reference-counted and released by the task tool (at promotion to
 * background or when the foreground wait ends), so the registry never outlives
 * the task call that populated it. A child that delegated its Stop is recorded,
 * so a task promoted after that exit can still deliver the stop event.
 */
import { Effect } from "effect"

interface Entry {
  count: number
  delegated: boolean
}

const active = new Map<string, Entry>()

export interface Registration {
  /** Release this registration (idempotent). */
  readonly release: Effect.Effect<void>
  /** True once the child's loop skipped its own Stop for this task call. */
  readonly stopDelegated: Effect.Effect<boolean>
}

/**
 * Called by the child's prompt loop at a clean exit. True while a foreground
 * task-tool call owns SubagentStop for this session; records the delegation.
 */
export function delegateStop(sessionID: string): boolean {
  const entry = active.get(sessionID)
  if (!entry || entry.count <= 0) return false
  entry.delegated = true
  return true
}

/** Register `sessionID` for a foreground task call. */
export function register(sessionID: string): Effect.Effect<Registration> {
  return Effect.sync(() => {
    const entry = active.get(sessionID) ?? { count: 0, delegated: false }
    entry.count += 1
    active.set(sessionID, entry)
    let released = false
    let delegatedAtRelease = false
    return {
      release: Effect.sync(() => {
        if (released) return
        released = true
        delegatedAtRelease = entry.delegated
        entry.count -= 1
        if (entry.count <= 0 && active.get(sessionID) === entry) active.delete(sessionID)
      }),
      stopDelegated: Effect.sync(() => (released ? delegatedAtRelease : entry.delegated)),
    }
  })
}

export * as TaskSubagents from "./task-subagents"
