// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { costLabel, unpriced } from "@graphagent/core/util/cost"
import type { Goal, LspStatus, Message, Session, SessionOverhead, SessionUsage, Todo } from "@graphagent/sdk"
import { formatDagTokens } from "../../dag/mode"
import { formatDagDuration } from "../../dag/model"
import { t, type MessageKey } from "../../i18n"
import { backgroundElapsed, type BackgroundItem, type BackgroundItems } from "../../session/background"
import { activeRuns, backgroundLabel } from "../../shell/background-mark"
import { DRAWER_WIDTH } from "../../shell/drawer"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../../ui/width"
import { contextShare, estimateMark, type ContextModel } from "../../util/context-window"
import { remoteLine } from "../../util/remote-text"
import { sessionTokenTotal } from "../../util/session-usage"

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

export interface ContextUsage {
  /** Tokens of the latest assistant message that produced output. */
  readonly used: number
  /** The window `used` is measured against, when there is one: the model's, or the default one when it declares none. */
  readonly limit?: number
  /** `used` of `limit`, rounded; undefined without a limit. */
  readonly percent?: number
  /** Set when `limit` is the default window the model declares none of, so the figures are estimates; absent otherwise. */
  readonly estimated?: boolean
}

/**
 * The context the session uses now: the token total of its latest assistant message with output, against the
 * model's compaction window (the algorithm of the old sidebar, now with the profile's window). Undefined before the
 * first such message.
 */
export function contextUsage(
  messages: readonly Message[],
  providers: readonly { readonly id: string; readonly models: Readonly<Record<string, ContextModel | undefined>> }[],
): ContextUsage | undefined {
  const last = messages.findLast((item) => item.role === "assistant" && item.tokens.output > 0)
  if (last?.role !== "assistant") return undefined
  const tokens = last.tokens
  const used = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  const share = contextShare(used, providers.find((item) => item.id === last.providerID)?.models[last.modelID])
  if (!share) return { used }
  const usage = { used, limit: share.window, percent: share.percent }
  return share.estimated ? { ...usage, estimated: true } : usage
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

// ── The cost section (#1475) ─────────────────────────────────────────────────

/** What the cost section reads of the session on screen: what it has used by itself. */
type OwnUsage = Pick<Session, "cost" | "tokens">

/**
 * The lines of the cost section, display only: the cost of the whole task tree the session on screen belongs to (the
 * root, its sub-agents and its DAG nodes), its tokens by kind, and, on a sub-agent's screen, what that session has used
 * by itself as a last line. A cost the tree has no price for reads `$x + unknown`, or `unknown` when nothing else
 * has a cost, and never `$0.00`. Before the usage is read the section is a dash and nothing else. Every line is cut
 * to the drawer's text width, measured with the user's `ambiguous_width`.
 */
export function usageLines(
  usage: SessionUsage | undefined,
  own: OwnUsage | undefined,
  onChild: boolean,
  ambiguousWidth: AmbiguousWidth = 1,
): string[] {
  const unknown = t("usage.unknown")
  const lines: string[] = []
  if (usage === undefined) lines.push("—")
  else {
    const { input, output, reasoning, cache } = usage.tokens
    lines.push(
      costLabel(usage.cost, usage.costUnknown, unknown),
      t("drawer.usage.io", { input: formatDagTokens(input), output: formatDagTokens(output) }),
      t("drawer.usage.reasoning", { n: formatDagTokens(reasoning) }),
      t("drawer.usage.cache", { read: formatDagTokens(cache.read), write: formatDagTokens(cache.write) }),
    )
    if (onChild) {
      const cost = own?.cost ?? 0
      const label = costLabel(cost, unpriced(cost, sessionTokenTotal(own?.tokens)), unknown)
      lines.push(t("drawer.cost.session", { cost: label }))
    }
  }
  return lines.map((line) => truncateCells(line, DRAWER_TEXT_CELLS, ambiguousWidth))
}

// ── The fixed-overhead section (#1461) ──────────────────────────────────────────

/** How many of the largest sources the fixed-overhead section lists. */
export const OVERHEAD_ROWS_MAX = 5

export interface OverheadSection {
  /** `≈{tokens} tokens · {percent}%` of the whole fixed overhead; the share has a `~` when the window is assumed. */
  readonly total: string
  /** The largest sources, largest first: `≈<tokens> <source> <label>`, each cut to the drawer's text width. */
  readonly rows: readonly string[]
}

/**
 * The fixed-overhead section (#1461), display only: what every request of the session carries besides its messages,
 * as one total with its share of the model's window and the largest sources under it. Undefined, and so hidden, until
 * the server reports an overhead (nothing is reported before the session's first request). A share that rests on the
 * assumed window, which the model does not declare, is marked `~`, as the context's is (`estimateMark`). A source's
 * label, the file an instructions section was read from, is remote text and goes through `remoteLine`.
 */
export function overheadSection(
  info: SessionOverhead | undefined,
  ambiguousWidth: AmbiguousWidth = 1,
): OverheadSection | undefined {
  if (info === undefined || info.tokens === 0) return undefined
  const percent = Math.round((info.ratio ?? 0) * 100)
  const total = t("drawer.overhead.total", {
    tokens: info.tokens.toLocaleString("en-US"),
    percent: `${estimateMark({ estimated: info.windowSource === "default" })}${percent}`,
  })
  const rows = info.sources
    .toSorted((a, b) => b.tokens - a.tokens)
    .slice(0, OVERHEAD_ROWS_MAX)
    .map((item) => {
      const label = item.label === undefined ? "" : remoteLine(item.label)
      const line = `≈${item.tokens.toLocaleString("en-US")} ${item.source}${label === "" ? "" : ` ${label}`}`
      return truncateCells(line, DRAWER_TEXT_CELLS, ambiguousWidth)
    })
  return { total: truncateCells(total, DRAWER_TEXT_CELLS, ambiguousWidth), rows }
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

// ── The background runs (#1058 5) ────────────────────────────────────────────

/** Cells a line of a section has: the drawer less its paddings and the column the scrollbar may take. */
export const DRAWER_TEXT_CELLS = DRAWER_WIDTH - 6

/** Runs the section lists; the rest are counted on its last line. */
export const BACKGROUND_ROWS_MAX = 3

/** One run of the section: still going, with the name it has in `/agents`. */
export interface BackgroundRunRow {
  readonly item: BackgroundItem
  readonly marker: "running" | "queued"
  readonly kind: string
  readonly description: string
}

export interface BackgroundSection {
  /** Running plus queued, as the title counts them. */
  readonly total: number
  /** At most `BACKGROUND_ROWS_MAX`: the running runs first, then the queued, each newest start first. */
  readonly rows: readonly BackgroundRunRow[]
  /** Runs the rows do not list. */
  readonly more: number
  /** A listed run is running, so its time moves: the section needs the one-second clock. */
  readonly running: boolean
}

/**
 * The background section of the root session's runs that are still going; undefined, and so hidden, while none is.
 * Runs that ended and runs nothing is known of are not listed: `/agents` has them.
 */
export function backgroundSection(
  items: Pick<BackgroundItems, "running" | "queued">,
  sessionOf: (sessionID: string) => Pick<Session, "title" | "agent"> | undefined,
): BackgroundSection | undefined {
  const active = activeRuns(items)
  if (active.length === 0) return undefined
  const rows = active.slice(0, BACKGROUND_ROWS_MAX).map((item): BackgroundRunRow => {
    const { kind, description } = backgroundLabel(item, sessionOf(item.sessionID))
    return { item, marker: item.status === "queued" ? "queued" : "running", kind, description }
  })
  return {
    total: active.length,
    rows,
    more: active.length - rows.length,
    running: rows.some((row) => row.marker === "running"),
  }
}

/** Whether two sections say the same; a run that only reports progress leaves the section as it was. */
export function sameBackgroundSection(a: BackgroundSection | undefined, b: BackgroundSection | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return (
    a.total === b.total &&
    a.more === b.more &&
    a.rows.length === b.rows.length &&
    a.rows.every(
      (row, index) =>
        row.item.sessionID === b.rows[index].item.sessionID &&
        row.marker === b.rows[index].marker &&
        row.kind === b.rows[index].kind &&
        row.description === b.rows[index].description &&
        row.item.entry.startedAt === b.rows[index].item.entry.startedAt,
    )
  )
}

export interface BackgroundRunLine {
  /** The marker and the space after it. */
  readonly marker: string
  /** The marker's color: the brand-derived running token, static, or the dim queued one. */
  readonly token: "statusRunning" | "statusQueued"
  /** `kind · description`, cut to the room the marker and the time leave. */
  readonly text: string
  /** Spaces that put the time at the right edge; empty without a time. */
  readonly pad: string
  /** How long a running run has run (`58s`, `2m 14s`); empty for a queued one and where no start is known. */
  readonly time: string
}

const RUN_MARKERS = {
  running: { glyph: "●", token: "statusRunning" },
  queued: { glyph: "○", token: "statusQueued" },
} as const

/** Cells the name of a run keeps before its time is left out of the line. */
const RUN_NAME_MIN_CELLS = 8

/**
 * One run as a line of `width` cells at most: its marker (`●` running, `○` queued, both static), `kind · description`
 * with the description cut first, and the time of a running run at the right edge. Only a running run has a time: a
 * queued one has not started, and the clock that moves it runs only while some listed run is running. A line too
 * narrow to keep the name beside its time drops the time.
 */
export function backgroundRunLine(
  row: BackgroundRunRow,
  now: number,
  width: number,
  ambiguousWidth: AmbiguousWidth = 1,
): BackgroundRunLine {
  const marker = RUN_MARKERS[row.marker]
  const elapsed = row.marker === "running" ? backgroundElapsed(row.item, now) : undefined
  const measured = elapsed === undefined ? "" : (formatDagDuration(0, elapsed) ?? "")
  const lead = `${marker.glyph} `
  const leadCells = cellWidth(lead, ambiguousWidth)
  const timeCells = measured === "" ? 0 : 1 + cellWidth(measured, ambiguousWidth)
  const time = width - leadCells - timeCells >= RUN_NAME_MIN_CELLS ? measured : ""
  const title = row.description === "" ? row.kind : `${row.kind} · ${row.description}`
  const text = truncateCells(title, Math.max(0, width - leadCells - (time === "" ? 0 : timeCells)), ambiguousWidth)
  const pad =
    time === ""
      ? ""
      : " ".repeat(Math.max(1, width - leadCells - cellWidth(text, ambiguousWidth) - cellWidth(time, ambiguousWidth)))
  return { marker: lead, token: marker.token, text, pad, time }
}
