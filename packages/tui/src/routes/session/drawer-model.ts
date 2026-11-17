// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Goal, LspStatus, Message, Todo } from "@graphagent/sdk"
import { t, type MessageKey } from "../../i18n"
import { remoteLine } from "../../util/remote-text"

/**
 * What the drawer's sections show (#1032 5.2), worked out from store data without touching the renderer. The
 * sections in `drawer.tsx` only draw these values.
 */

/** Cells of the context bar. */
export const CONTEXT_BAR_CELLS = 8
/** From this share of the context window the used part of the bar is a warning. */
export const CONTEXT_WARNING_PERCENT = 85
/** From this share it is an error. */
export const CONTEXT_ERROR_PERCENT = 95

export type ContextTone = "text" | "warning" | "error"

/** What the context needs of a model: its window. */
type ModelLimit = { readonly limit: { readonly context: number } }

export interface ContextUsage {
  /** Tokens of the latest assistant message that produced output. */
  readonly used: number
  /** The model's context window, when its provider reports one. */
  readonly limit?: number
  /** `used` of `limit`, rounded; undefined without a limit. */
  readonly percent?: number
}

/**
 * The context the session uses now: the token total of its latest assistant message with output, against the
 * model's context limit (the algorithm of the old sidebar). Undefined before the first such message.
 */
export function contextUsage(
  messages: readonly Message[],
  providers: readonly { readonly id: string; readonly models: Readonly<Record<string, ModelLimit | undefined>> }[],
): ContextUsage | undefined {
  const last = messages.findLast((item) => item.role === "assistant" && item.tokens.output > 0)
  if (last?.role !== "assistant") return undefined
  const tokens = last.tokens
  const used = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  const limit = providers.find((item) => item.id === last.providerID)?.models[last.modelID]?.limit.context
  if (!limit || !Number.isFinite(limit) || limit <= 0) return { used }
  return { used, limit, percent: Math.round((used / limit) * 100) }
}

export function contextTone(percent: number): ContextTone {
  if (percent >= CONTEXT_ERROR_PERCENT) return "error"
  if (percent >= CONTEXT_WARNING_PERCENT) return "warning"
  return "text"
}

/** How many of the bar's cells are used: rounded, and never all of them below 100% or none of them above 0%. */
export function contextBarCells(percent: number, cells = CONTEXT_BAR_CELLS) {
  if (percent <= 0) return 0
  if (percent >= 100) return cells
  return Math.min(cells - 1, Math.max(1, Math.round((percent / 100) * cells)))
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/** The session's cost in dollars, `$0.00` when it has none. */
export function costText(cost: number | undefined) {
  return money.format(typeof cost === "number" && Number.isFinite(cost) ? cost : 0)
}

const GOAL_STATUS: Readonly<Record<string, MessageKey>> = {
  active: "goal.status.active",
  waiting: "goal.status.waiting",
  paused: "goal.status.paused",
  done: "goal.status.done",
}

/** A finite number from an SDK number, or undefined for its sentinels (`"Infinity"`, `"NaN"`). */
function finite(value: number | string | undefined) {
  if (value === undefined) return undefined
  const count = Number(value)
  return Number.isFinite(count) ? count : undefined
}

export interface GoalLine {
  /** `第 n/m 轮`, or `第 n 轮` when the goal has no turn cap; undefined without a turn count. */
  readonly turns?: string
  /** The status label, or the reason a waiting or paused goal gives. */
  readonly state: string
  /** The state is a reason, drawn in the warning color. */
  readonly warning: boolean
}

/** The turns and state line of the goal section: `第 n/m 轮 · 状态/原因`. */
export function goalLine(goal: Goal): GoalLine {
  const used = finite(goal.turnsUsed)
  const max = finite(goal.maxTurns)
  const turns =
    used === undefined
      ? undefined
      : max === undefined
        ? t("dagmode.band.goal.turnsOpen", { used })
        : t("dagmode.band.goal.turns", { used, max })
  const reason =
    (goal.status === "waiting" || goal.status === "paused") && typeof goal.pausedReason === "string"
      ? remoteLine(goal.pausedReason)
      : ""
  if (reason !== "") return { turns, state: reason, warning: true }
  const key = GOAL_STATUS[goal.status]
  return { turns, state: key ? t(key) : remoteLine(goal.status), warning: false }
}

export type TodoMark = { readonly symbol: string; readonly tone: "textMuted" | "primary" | "textDim" }

/** Done `✓` in gray, in progress `●` in the brand color (static), anything else `○` dim (#1032 5.2). */
export function todoMark(status: string): TodoMark {
  if (status === "completed") return { symbol: "✓", tone: "textMuted" }
  if (status === "in_progress") return { symbol: "●", tone: "primary" }
  return { symbol: "○", tone: "textDim" }
}

/** `n/m`: finished of all items. A cancelled item counts as finished: nothing is left to do for it. */
export function todoCount(todos: readonly Pick<Todo, "status">[]) {
  const done = todos.filter((item) => item.status === "completed" || item.status === "cancelled").length
  return `${done}/${todos.length}`
}

export interface Services {
  readonly lsp: readonly { readonly id: string; readonly ok: boolean }[]
  /** Connected MCP servers, or undefined when the session has none configured beyond disabled ones. */
  readonly mcpConnected?: number
  /** MCP servers that should be up and are not: failed, or waiting for auth or a client registration. */
  readonly mcpFailed: readonly string[]
}

/** The services section; undefined, and so hidden, when there is neither an LSP nor an MCP server. */
export function services(
  lsp: readonly Pick<LspStatus, "id" | "status">[],
  mcp: Readonly<Record<string, { readonly status: string }>>,
): Services | undefined {
  const servers = Object.entries(mcp)
    .filter(([, item]) => item.status !== "disabled")
    .sort(([a], [b]) => a.localeCompare(b))
  if (lsp.length === 0 && servers.length === 0) return undefined
  return {
    lsp: lsp.map((item) => ({ id: item.id, ok: item.status === "connected" })),
    mcpConnected: servers.length === 0 ? undefined : servers.filter(([, item]) => item.status === "connected").length,
    mcpFailed: servers.filter(([, item]) => item.status !== "connected").map(([name]) => name),
  }
}
