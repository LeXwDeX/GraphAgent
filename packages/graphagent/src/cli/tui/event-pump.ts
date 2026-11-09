// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { encodeEvent } from "./event-encode"

/**
 * Worker-side event pipeline (#1013 5.6).
 *
 * GlobalBus events are filtered by session interest, merged within a frame and
 * posted to the TUI in batches. Durable `sync` frames are dropped: the client
 * already ignores them, so forwarding them only doubles the payload.
 */

export type EventScope = "global" | "session-summary" | "session-full"
export type GateDecision = "deliver" | "summary" | "drop"

export type PumpPayload = {
  id?: string
  type: string
  properties?: Record<string, any>
  syncEvent?: unknown
}

export type PumpEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: PumpPayload
}

export interface EventPumpOptions {
  emit: (events: PumpEvent[]) => void
  now?: () => number
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

/** Frame budget shared with the client transport. */
export const FRAME_MS = 16

/** Events only for sessions whose full message/part stream is requested. */
const SESSION_FULL_TYPES = new Set([
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
  "message.part.preview",
  "todo.updated",
  "session.diff",
  "session.hook.status",
  "session.hook.terminal",
  "session.hook.message",
  "dag.workflow.nodes.updated",
])

/** Small per-session events the TUI always needs, hydrated or not. */
const SESSION_SUMMARY_TYPES = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
  "session.idle",
  "session.error",
  "permission.asked",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.interacted",
  "question.timed_out",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
  "question.v2.interacted",
  "question.v2.timed_out",
  "goal.updated",
  "goal.cleared",
  "dag.workflow.summary.updated",
])

const ASK_TYPES = new Set(["permission.asked", "permission.v2.asked", "question.asked", "question.v2.asked"])

const SETTLED_TYPES = new Set([
  "permission.replied",
  "permission.v2.replied",
  "question.replied",
  "question.rejected",
  "question.timed_out",
  "question.v2.replied",
  "question.v2.rejected",
  "question.v2.timed_out",
])

/** Unlisted event types default to `global`, matching the schema inventory. */
export function eventScope(type: string): EventScope {
  if (SESSION_FULL_TYPES.has(type)) return "session-full"
  if (SESSION_SUMMARY_TYPES.has(type)) return "session-summary"
  return "global"
}

function sessionIDOf(event: PumpEvent) {
  const value = event.payload?.properties?.sessionID
  return typeof value === "string" ? value : undefined
}

/** The shape the TUI summary reducer consumes for invisible sessions. */
export function slimToolPart(part: Record<string, any>) {
  const state = part.state ?? {}
  const slimState: Record<string, unknown> = { status: state.status }
  if (state.title !== undefined) slimState.title = state.title
  if (state.time !== undefined) slimState.time = state.time
  if ((state.status === "pending" || state.status === "running") && state.input !== undefined) {
    slimState.input = state.input
  }
  return {
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: "tool",
    tool: part.tool,
    callID: part.callID,
    state: slimState,
  }
}

function deltaKey(event: PumpEvent) {
  const properties = event.payload?.properties
  if (!properties) return
  const { sessionID, messageID, partID, field } = properties
  if (typeof sessionID !== "string" || typeof messageID !== "string") return
  if (typeof partID !== "string" || typeof field !== "string") return
  return [event.directory ?? "", sessionID, messageID, partID, field].join("\u0000")
}

function previewKey(event: PumpEvent) {
  const properties = event.payload?.properties
  if (!properties) return
  const { sessionID, partID } = properties
  if (typeof sessionID !== "string" || typeof partID !== "string") return
  return [event.directory ?? "", sessionID, partID].join("\u0000")
}

export class EventPump {
  private readonly emit: (events: PumpEvent[]) => void
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => unknown
  private readonly cancel: (handle: unknown) => void

  private queue: PumpEvent[] = []
  private timer: unknown
  private lastFlush = -FRAME_MS
  private lastDelta: { key: string; event: PumpEvent } | undefined
  private pendingPreviews = new Map<string, PumpEvent>()

  /** Explicit full set, replaced wholesale by `setInterest`. */
  private interest = new Set<string>()
  /** Sessions with an unanswered permission/question, counted per request. */
  private pendingAsks = new Map<string, number>()

  constructor(options: EventPumpOptions) {
    this.emit = options.emit
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown as ReturnType<typeof setTimeout>)
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  /** Replace the explicit full set. Resolves after the new set is in effect. */
  async setInterest(input: { full: readonly string[] }) {
    this.interest = new Set(input.full)
  }

  /** Effective full set: explicit interest plus sessions with a pending ask. */
  fullSessions(): ReadonlySet<string> {
    if (this.pendingAsks.size === 0) return this.interest
    const effective = new Set(this.interest)
    for (const [sessionID, count] of this.pendingAsks) {
      if (count > 0) effective.add(sessionID)
    }
    return effective
  }

  push(event: PumpEvent) {
    const type = event?.payload?.type
    if (!type || type === "sync") return

    const sessionID = sessionIDOf(event)
    if (type === "session.deleted" && sessionID) {
      this.pendingAsks.delete(sessionID)
    }
    if (sessionID && ASK_TYPES.has(type)) {
      this.pendingAsks.set(sessionID, (this.pendingAsks.get(sessionID) ?? 0) + 1)
    }
    if (sessionID && SETTLED_TYPES.has(type)) {
      const count = (this.pendingAsks.get(sessionID) ?? 0) - 1
      if (count > 0) this.pendingAsks.set(sessionID, count)
      else this.pendingAsks.delete(sessionID)
    }

    const scope = eventScope(type)
    if (scope !== "session-full") {
      this.enqueue(event)
      return
    }

    const full = sessionID !== undefined && this.fullSessions().has(sessionID)
    if (!full) {
      if (type === "message.part.updated") {
        const part = event.payload.properties?.part
        if (part?.type === "tool") {
          this.enqueue({
            ...event,
            payload: {
              ...event.payload,
              properties: {
                ...event.payload.properties,
                part: slimToolPart(part),
              },
            },
          })
        }
      }
      return
    }

    if (type === "message.part.delta") {
      const key = deltaKey(event)
      if (key && this.lastDelta?.key === key) {
        const properties = this.lastDelta.event.payload.properties!
        properties.delta = String(properties.delta ?? "") + String(event.payload.properties?.delta ?? "")
        return
      }
      this.enqueue(event, key)
      return
    }

    if (type === "message.part.preview") {
      const key = previewKey(event)
      const previous = key ? this.pendingPreviews.get(key) : undefined
      if (key && previous) {
        // Latest-wins: keep the queue position, replace the payload.
        previous.payload = event.payload
        return
      }
      this.enqueue(event)
      if (key) this.pendingPreviews.set(key, this.queue[this.queue.length - 1]!)
      return
    }

    this.enqueue(event)
  }

  /** Send the current frame immediately. */
  flush() {
    if (this.timer !== undefined) {
      this.cancel(this.timer)
      this.timer = undefined
    }
    const events = this.queue
    this.queue = []
    this.lastDelta = undefined
    this.pendingPreviews.clear()
    this.lastFlush = this.now()
    if (events.length === 0) return
    this.emit(events.map((event) => encodeEvent(event)))
  }

  dispose() {
    if (this.timer !== undefined) {
      this.cancel(this.timer)
      this.timer = undefined
    }
    this.queue = []
    this.lastDelta = undefined
    this.pendingPreviews.clear()
  }

  private enqueue(event: PumpEvent, mergeKey?: string) {
    this.queue.push(event)
    this.lastDelta = mergeKey ? { key: mergeKey, event } : undefined
    this.arm()
  }

  private arm() {
    if (this.timer !== undefined) return
    if (this.now() - this.lastFlush >= FRAME_MS) {
      this.flush()
      return
    }
    this.timer = this.schedule(() => {
      this.timer = undefined
      this.flush()
    }, FRAME_MS)
  }
}
