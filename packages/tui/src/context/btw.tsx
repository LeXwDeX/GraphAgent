// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Identifier } from "@graphagent/core/id/id"
import { createEffect, onCleanup, useContext } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useEvent } from "./event"
import { useRoute } from "./route"
import { useSDK } from "./sdk"
import { errorMessage } from "../util/error"
import { TuiLog } from "../util/log"

/** Per-session side-question history is memory-only; the oldest entry is dropped on overflow. */
export const MAX_BTW_ENTRIES = 20

export type BtwModel = {
  providerID: string
  modelID: string
}

export type BtwEntry = {
  id: string
  sessionID: string
  question: string
  status: "pending" | "done" | "error" | "cancelled"
  answer?: string
  error?: string
  model?: BtwModel
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  context?: { messages: number; truncated: boolean; inFlightDropped: boolean }
  startedAt: number
  finishedAt?: number
}

export type BtwAnswer = {
  answer: string
  model: BtwModel
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  context: { messages: number; truncated: boolean; inFlightDropped: boolean }
}

export type BtwRequestInput = {
  sessionID: string
  id: string
  question: string
  model?: BtwModel
}

export type BtwRequestResult =
  { type: "answer"; data: BtwAnswer } | { type: "busy" } | { type: "cancelled" } | { type: "error"; error: unknown }

export type BtwAskResult =
  | { type: "entry"; entry: BtwEntry }
  | { type: "busy" }
  /** The session was deleted or the question was empty; nothing is left in the store. */
  | { type: "ignored" }

export type BtwControllerDependencies = {
  request(input: BtwRequestInput): Promise<BtwRequestResult>
  cancel(input: { sessionID: string; id: string }): Promise<void>
  now?(): number
  createID?(): string
}

export interface BtwController {
  ask(sessionID: string, question: string, options?: { model?: BtwModel }): Promise<BtwAskResult>
  cancel(sessionID: string): Promise<void>
  entries(sessionID: string): readonly BtwEntry[]
  latest(sessionID: string): BtwEntry | undefined
  dismiss(sessionID: string): void
  isDismissed(sessionID: string): boolean
  /** Reopens the answer panel for the latest entry; a no-op without history. */
  show(sessionID: string): void
  /** Drops a deleted session's history; exported for the `session.deleted` subscription. */
  forget(sessionID: string): void
}

/**
 * `/btw [-m provider/model] <question>`. Returns `undefined` when a `-m` flag
 * is present but its value is missing or not `provider/model`.
 */
export function parseBtwArgs(input: string): { question: string; model?: BtwModel } | undefined {
  // `resolveSlashInput` preserves the spaces between `/btw` and its arguments,
  // so a second space must not turn `-m` into part of the question.
  const args = input.trimStart()
  if (!args.startsWith("-m")) return { question: args.trim() }
  if (!/^-m(?:\s|$)/.test(args)) return { question: args.trim() }
  const rest = args.slice(2).trimStart()
  const split = rest.search(/\s/)
  const modelToken = split === -1 ? rest : rest.slice(0, split)
  const question = split === -1 ? "" : rest.slice(split + 1).trim()
  if (!modelToken) return undefined
  const slash = modelToken.indexOf("/")
  if (slash <= 0 || slash === modelToken.length - 1) return undefined
  return {
    question,
    model: { providerID: modelToken.slice(0, slash), modelID: modelToken.slice(slash + 1) },
  }
}

function isBusyName(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "BtwBusy"
}

function isCancelledName(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "BtwCancelled"
}

/**
 * Store-level side-question state. Dependencies are injected so the lifecycle
 * rules (overflow, cancel, late responses) are testable without a renderer.
 */
export function createBtwController(deps: BtwControllerDependencies): BtwController {
  const now = () => (deps.now ? deps.now() : Date.now())
  const createID = () => (deps.createID ? deps.createID() : Identifier.create("btw", "ascending"))
  const [store, setStore] = createStore({
    entries: {} as Record<string, BtwEntry[]>,
    dismissed: {} as Record<string, boolean>,
  })

  function entries(sessionID: string) {
    return store.entries[sessionID] ?? []
  }

  function indexOf(sessionID: string, id: string) {
    return entries(sessionID).findIndex((entry) => entry.id === id)
  }

  function snapshot(sessionID: string, id: string): BtwEntry | undefined {
    const index = indexOf(sessionID, id)
    if (index === -1) return undefined
    return structuredClone(unwrap(entries(sessionID)[index]))
  }

  function push(sessionID: string, entry: BtwEntry) {
    if (!store.entries[sessionID]) setStore("entries", sessionID, [])
    setStore(
      "entries",
      sessionID,
      produce((draft: BtwEntry[]) => {
        draft.push(entry)
        if (draft.length > MAX_BTW_ENTRIES) draft.splice(0, draft.length - MAX_BTW_ENTRIES)
      }),
    )
  }

  function remove(sessionID: string, id: string) {
    const index = indexOf(sessionID, id)
    if (index === -1) return
    setStore(
      "entries",
      sessionID,
      produce((draft: BtwEntry[]) => {
        draft.splice(index, 1)
      }),
    )
  }

  function finish(sessionID: string, id: string, patch: Partial<BtwEntry>) {
    const index = indexOf(sessionID, id)
    if (index === -1) return
    setStore("entries", sessionID, index, { ...patch, finishedAt: now() })
  }

  async function ask(sessionID: string, question: string, options: { model?: BtwModel } = {}): Promise<BtwAskResult> {
    const text = question.trim()
    if (!text) return { type: "ignored" }
    const entry: BtwEntry = {
      id: createID(),
      sessionID,
      question: text,
      status: "pending",
      model: options.model,
      startedAt: now(),
    }
    push(sessionID, entry)
    setStore("dismissed", sessionID, false)

    let result: BtwRequestResult
    try {
      result = await deps.request({ sessionID, id: entry.id, question: text, model: options.model })
    } catch (error) {
      result = { type: "error", error }
    }

    const index = indexOf(sessionID, entry.id)
    if (index === -1) return { type: "ignored" }
    // Cancelling or deleting the session marks the entry outside `pending`;
    // a response that arrives afterwards must not overwrite it.
    if (entries(sessionID)[index].status !== "pending") {
      return { type: "entry", entry: snapshot(sessionID, entry.id)! }
    }

    if (result.type === "busy") {
      // A busy server rejects the request atomically; no entry is kept.
      remove(sessionID, entry.id)
      return { type: "busy" }
    }
    if (result.type === "answer") {
      finish(sessionID, entry.id, {
        status: "done",
        answer: result.data.answer,
        model: result.data.model,
        usage: result.data.usage,
        context: result.data.context,
      })
    } else if (result.type === "cancelled") {
      finish(sessionID, entry.id, { status: "cancelled" })
    } else {
      finish(sessionID, entry.id, { status: "error", error: errorMessage(result.error) })
    }
    return { type: "entry", entry: snapshot(sessionID, entry.id)! }
  }

  async function cancel(sessionID: string) {
    const pending = entries(sessionID).filter((entry) => entry.status === "pending")
    if (pending.length === 0) return
    for (const entry of pending) finish(sessionID, entry.id, { status: "cancelled" })
    for (const entry of pending) {
      try {
        await deps.cancel({ sessionID, id: entry.id })
      } catch (error) {
        // The entry stays cancelled locally: the server treats an unknown id
        // as already cancelled, and the late-response guard keeps it stable.
        TuiLog.write("warn", "Failed to cancel side question", error)
      }
    }
  }

  function dismiss(sessionID: string) {
    setStore("dismissed", sessionID, true)
  }

  function isDismissed(sessionID: string) {
    return store.dismissed[sessionID] ?? false
  }

  function show(sessionID: string) {
    if (entries(sessionID).length === 0) return
    setStore("dismissed", sessionID, false)
  }

  function forget(sessionID: string) {
    setStore(
      "entries",
      produce((draft: Record<string, BtwEntry[]>) => {
        delete draft[sessionID]
      }),
    )
    setStore(
      "dismissed",
      produce((draft: Record<string, boolean>) => {
        delete draft[sessionID]
      }),
    )
  }

  return {
    ask,
    cancel,
    entries,
    latest: (sessionID) => entries(sessionID).at(-1),
    dismiss,
    isDismissed,
    show,
    forget,
  }
}

type Numeric = number | "Infinity" | "-Infinity" | "NaN"

type RawBtwAnswer = {
  answer: string
  model: BtwModel
  usage?: { inputTokens: Numeric; outputTokens: Numeric; cacheReadTokens?: Numeric }
  context: { messages: Numeric; estimatedTokens?: Numeric; truncated: boolean; inFlightDropped: boolean }
}

function toNumber(value: Numeric) {
  return typeof value === "number" ? value : Number(value)
}

function mapAnswer(raw: RawBtwAnswer): BtwAnswer {
  return {
    answer: raw.answer,
    model: raw.model,
    usage: raw.usage
      ? {
          inputTokens: toNumber(raw.usage.inputTokens),
          outputTokens: toNumber(raw.usage.outputTokens),
          cacheReadTokens: raw.usage.cacheReadTokens === undefined ? undefined : toNumber(raw.usage.cacheReadTokens),
        }
      : undefined,
    context: {
      messages: toNumber(raw.context.messages),
      truncated: raw.context.truncated,
      inFlightDropped: raw.context.inFlightDropped,
    },
  }
}

const btw = createSimpleContext({
  name: "Btw",
  init: () => {
    const sdk = useSDK()
    const controller = createBtwController({
      request: async (input) => {
        const result = await sdk.client.session.btw({
          sessionID: input.sessionID,
          id: input.id,
          question: input.question,
          model: input.model,
        })
        if (result.error) {
          if (result.response?.status === 409) {
            return isCancelledName(result.error) ? { type: "cancelled" } : { type: "busy" }
          }
          if (isBusyName(result.error)) return { type: "busy" }
          return { type: "error", error: result.error }
        }
        if (!result.data) return { type: "error", error: new Error("Side question returned no answer") }
        return { type: "answer", data: mapAnswer(result.data) }
      },
      cancel: async (input) => {
        const result = await sdk.client.session.btw2.cancel({
          sessionID: input.sessionID,
          btwID: input.id,
        })
        if (result.error) throw result.error
      },
    })
    const offDeleted = useEvent().on("session.deleted", (event) => controller.forget(event.properties.info.id))
    onCleanup(offDeleted)

    // A side question belongs to the session that asked it: leaving that
    // session or exiting the TUI cancels whatever is still in flight.
    const route = useRoute()
    let activeSessionID = route.data.type === "session" ? route.data.sessionID : undefined
    createEffect(() => {
      const next = route.data.type === "session" ? route.data.sessionID : undefined
      if (next === activeSessionID) return
      const previous = activeSessionID
      activeSessionID = next
      if (previous) void controller.cancel(previous)
    })
    onCleanup(() => {
      if (activeSessionID) void controller.cancel(activeSessionID)
    })
    return controller
  },
})

export const { use: useBtw, provider: BtwProvider } = btw

/** Optional accessor for views that can render without the provider (tests). */
export function useBtwOptional(): BtwController | undefined {
  return useContext(btw.context)
}
