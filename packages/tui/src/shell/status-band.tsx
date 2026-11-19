// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { DagWorkflowSummary, Goal } from "@graphagent/sdk"
import type { Renderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import open from "open"
import { createEffect, createMemo, For, Index, on, onCleanup, type ParentProps } from "solid-js"
import { resolveRootSessionID, sessionTree } from "../ask/ask-queue"
import { useCommands } from "../commands/context"
import { useKV } from "../context/kv"
import { lifecycleKey } from "../context/lifecycle-mirror"
import { useRoute } from "../context/route"
import { useSync, type DagWatch } from "../context/sync"
import { useTheme } from "../context/theme"
import { layoutDagBar, type DagBarNode } from "../dag/bar"
import {
  dagModeMarker,
  dagTierToken,
  dagUsage,
  dagWaitingForMainAgent,
  formatDagTokens,
  type DagModeMarker,
  type DagUsage,
} from "../dag/mode"
import {
  dagCurrentWave,
  dagWorkflowView,
  formatDagProgress,
  selectMainWorkflow,
  type DagStatusToken,
} from "../dag/model"
import type { DagWaveNode } from "../dag/waves"
import { t, type MessageKey } from "../i18n"
import { backgroundItems } from "../session/background"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { TuiLog } from "../util/log"
import { remoteLine } from "../util/remote-text"
import {
  backgroundBand,
  backgroundMark,
  backgroundMarkSpan,
  layoutBackgroundRow,
  sameBackgroundBand,
  type BackgroundBand,
} from "./background-mark"
import { useBottomZoneOptional } from "./bottom-zone"
import {
  chooseBandRows,
  layoutPrRow,
  layoutReminderRow,
  prHasWarning,
  prOpenUrl,
  prTailText,
  type BandRowKind,
} from "./pr-line"
import { usePrTracker } from "./pr-tracker-context"
import { layoutTrustRow, trustChangeCount } from "./trust-line"

/** Status band slot: zero to two lines above the bottom zone (F4). */
export function StatusBand(props: ParentProps) {
  return (
    <box flexShrink={0} flexDirection="column">
      {props.children}
    </box>
  )
}

/** Below this terminal width the band merges into one row and the goal is left to the drawer (F4 1). */
export const BAND_NARROW_WIDTH = 100

/** The `/dag` panel's id in the panel host. The band leaves its workflow row to the panel while one is open. */
export const DAG_PANEL_ID = "dag"

/** The source name the band declares its workflow under (`sync.dag.watch`). */
const WATCH_SOURCE = "status-band"

/** Columns kept clear at either edge, in line with the transcript and the prompt. */
const BAND_PADDING = 2

/** Display policy of the workflow row (kv `dag_band`); the goal row does not follow it. */
export type DagBandMode = "auto" | "always" | "hidden"

/** The policy a stored value stands for; anything else is `auto`. */
export function dagBandMode(value: unknown): DagBandMode {
  return value === "always" || value === "hidden" ? value : "auto"
}

/** Theme color a piece of a row is drawn in; the component looks it up in the active theme. */
export type BandToken = DagStatusToken | "primary" | "textDim" | "warning"

export interface BandSpan {
  readonly text: string
  readonly token: BandToken
  /**
   * What a click on this piece does instead of what a click on its row does. Only the background mark has one: it
   * opens the list of sub-agents, `/agents`, and the row's own click (`/dag`, the PR page) stays with the rest of it.
   */
  readonly action?: "agents"
}

export interface BandRow {
  readonly spans: readonly BandSpan[]
  /** Cells the spans take under the ambiguous width the row was laid out for; never more than its width. */
  readonly cells: number
}

/** The row without colors. */
export function bandRowText(row: BandRow): string {
  return row.spans.map((span) => span.text).join("")
}

/** The node fields a row reads; the stored row and the schema's node both fit. */
export interface BandNode extends DagWaveNode, DagBarNode {}

const EMPTY_ROW: BandRow = { spans: [], cells: 0 }

const SEPARATOR = " · "
const DAG_HINT = "/dag"
const GOAL_HINT = "/goal"
/** Between a row's last piece and its hint. */
const HINT_GAP = "  "
/** Spaces kept between what a row says on the left and what it says on the right. */
const MIN_GAP = 2
/** Cells a title keeps on a tight row. */
const TITLE_SHORT_CELLS = 12
/** Cells a node takes in the bar before the layout narrows it. */
const SLOTS_PER_NODE = 3
/** Nodes a bar drawn from counts shows at most; the server caps a workflow far below it. */
const FALLBACK_NODES_MAX = 500
/** Cells of goal text kept before the counts after it give way. */
const GOAL_TEXT_MIN_CELLS = 12
/** Cells a status reason may take. */
const GOAL_STATUS_MAX_CELLS = 32

/** A whole count from an SDK number; its non-finite string sentinels read as none. */
function whole(value: number | string | undefined): number {
  const count = Number(value ?? 0)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

/** A finite number from an SDK number, or undefined for its sentinels. */
function finite(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined
  const count = Number(value)
  return Number.isFinite(count) ? count : undefined
}

function cellsOf(spans: readonly BandSpan[], ambiguousWidth: AmbiguousWidth) {
  return spans.reduce((sum, span) => sum + cellWidth(span.text, ambiguousWidth), 0)
}

function separated(pieces: readonly BandSpan[]): BandSpan[] {
  return pieces.flatMap((piece, index) =>
    index === 0 ? [piece] : [{ text: SEPARATOR, token: "textDim" as const }, piece],
  )
}

function blank(cells: number): BandSpan {
  return { text: " ".repeat(Math.max(0, cells)), token: "textMuted" }
}

/** Left and right pieces as one row of `width` cells: the right ones at the edge, if there are any. */
function aligned(left: readonly BandSpan[], right: readonly BandSpan[], width: number, ambiguousWidth: AmbiguousWidth) {
  const spans =
    right.length > 0
      ? [...left, blank(width - cellsOf(left, ambiguousWidth) - cellsOf(right, ambiguousWidth)), ...right]
      : left
  return { spans, cells: cellsOf(spans, ambiguousWidth) }
}

// ── The workflow row ─────────────────────────────────────────────────────────

export interface DagRowInput {
  readonly summary: DagWorkflowSummary
  /** The loaded node table; the bar is drawn from the summary's counts while there is none. */
  readonly nodes?: readonly BandNode[]
  /** Workflows the band does not show, folded into `+N`. */
  readonly more?: number
  /** The mode mark (F4 7.1): on, or the dim off mark while a workflow runs; none draws none. */
  readonly mode?: DagModeMarker
  /** What the session's workflows have used; each piece it carries is drawn, and the budget in its band's color. */
  readonly usage?: DagUsage
  /** A checkpoint waits for the main agent and it is not at work on it. */
  readonly waiting?: boolean
  /**
   * The short mark of the tracked PRs at the row's tail (`PR ~4/6`, at most 14 cells, F6 2.2). It stays with the bar
   * and the mode mark at every level of the spec, so it does not give way on a narrow row.
   */
  readonly pr?: string
  /**
   * The mark of the background runs (`◇ 后台 3`, at most 12 cells) after the PR mark. It is the first thing the row
   * gives up, before the `/dag` hint, and a row whose budget is at its warning or exhausted band takes none.
   */
  readonly background?: string
  /** Cells the row may use. */
  readonly width: number
  readonly ambiguousWidth?: AmbiguousWidth
}

/**
 * What a row keeps. The levels run from everything to the least a row may be
 * (F4 1, 7.1): the background mark goes first (#1058 4), then the hint, then the budget,
 * the tokens and the concurrency of the usage, the folded count, the wave, the wait, the
 * counts squeezed to `n/m`, and the title cut short. The mode mark stays with the bar
 * (it is at most 8 cells): only the last level, beyond the spec and for a
 * terminal so narrow that not even the bar fits with it, lets go of it. The PR
 * mark at the tail (at most 14 cells) stays with it the same way. The levels
 * after the title cut go beyond the spec too.
 */
interface DagLevel {
  readonly background: boolean
  readonly hint: boolean
  readonly budget: boolean
  readonly tokens: boolean
  readonly concurrency: boolean
  readonly more: boolean
  readonly wave: boolean
  readonly waiting: boolean
  readonly counts: "full" | "compact" | "none"
  /** How much of the title shows. */
  readonly name: "full" | "short" | "none"
  readonly mark: boolean
}

/** The levels a row steps down through, richest first, and the one the bar is sized against. */
interface DagChain {
  readonly levels: readonly DagLevel[]
  /** The least text the spec allows: counts squeezed to `n/m`, a short title, no wait and no budget. */
  readonly minimal: number
}

const FULL_LEVEL: DagLevel = {
  background: true,
  hint: true,
  budget: true,
  tokens: true,
  concurrency: true,
  more: true,
  wave: true,
  waiting: true,
  counts: "full",
  name: "full",
  mark: true,
}

/** Each step is what the next level gives up on top of what the one before it did. */
function chainOf(steps: readonly Partial<DagLevel>[]): DagChain {
  const levels: DagLevel[] = [FULL_LEVEL]
  for (const step of steps) levels.push({ ...levels[levels.length - 1], ...step })
  const minimal = levels.findIndex(
    (level) => level.counts === "compact" && level.name === "short" && !level.waiting && !level.budget,
  )
  return { levels, minimal }
}

/**
 * The order of a quiet budget (F4 1, 7.1): the background mark goes first (#1058 4), then the hint, and the budget is
 * the first of the usage to give way after it.
 */
const DAG_CHAIN = chainOf([
  { background: false },
  { hint: false },
  { budget: false },
  { tokens: false },
  { concurrency: false },
  { more: false },
  { wave: false },
  { waiting: false },
  { counts: "compact" },
  { name: "short" },
  { counts: "none" },
  { name: "none" },
  { mark: false },
])

/**
 * The order of a budget at its warning or exhausted band: the budget, and the wait that may be on the row with it,
 * are what the row should still say when room is short, so they give way after the counts and the title. The tokens,
 * the concurrency, the folded count and the wave go as before, only without the budget between them. Of the two the
 * wait goes first: the bar and the mark still reserve their room first, so a quiet row's least text is the same
 * here and the bar is never narrowed for either. The background mark leads the order here as well, though a row at
 * this band is a warning row and takes none (`dagUsageAlert`).
 */
const DAG_ALERT_CHAIN = chainOf([
  { background: false },
  { hint: false },
  { tokens: false },
  { concurrency: false },
  { more: false },
  { wave: false },
  { counts: "compact" },
  { name: "short" },
  { waiting: false },
  { budget: false },
  { counts: "none" },
  { name: "none" },
  { mark: false },
])

/**
 * Whether the usage is at the warning or exhausted band of its budget: the row then keeps the budget and the wait
 * longest (`DAG_ALERT_CHAIN`), and counts as a warning row, so the background mark does not ride on it (#1058 4).
 */
export function dagUsageAlert(usage: DagUsage | undefined): boolean {
  return usage !== undefined && usage.tier !== "normal" && usage.percent !== undefined
}

/** A bar's worth of nodes drawn from the summary's counts, for a workflow whose table is not loaded. */
function nodesFromCounts(summary: DagWorkflowSummary): DagBarNode[] {
  const total = Math.min(whole(summary.nodeCount), FALLBACK_NODES_MAX)
  const groups: ReadonlyArray<readonly [string, number]> = [
    ["completed", whole(summary.completedNodes)],
    ["skipped", whole(summary.skippedNodes)],
    ["aborted", whole(summary.abortedNodes)],
    ["failed", whole(summary.failedNodes)],
    ["running", whole(summary.runningNodes)],
    ["queued", whole(summary.queuedNodes)],
  ]
  const nodes: DagBarNode[] = []
  let placed = 0
  for (const [status, count] of groups) {
    for (let index = 0; index < count && placed < total; index++, placed++) nodes.push({ status })
  }
  for (; placed < total; placed++) nodes.push({ status: "pending" })
  return nodes
}

/** The usage pieces a level keeps, in the order they are drawn; the budget is colored by its band. */
function usagePieces(usage: DagUsage | undefined, level: DagLevel): BandSpan[] {
  if (!usage) return []
  const pieces: BandSpan[] = []
  if (level.concurrency && usage.running !== undefined && usage.cap !== undefined) {
    pieces.push({ text: t("dagmode.band.concurrency", { running: usage.running, cap: usage.cap }), token: "textMuted" })
  }
  if (level.tokens && usage.tokens !== undefined) {
    pieces.push({ text: t("dagmode.band.tokens", { tokens: formatDagTokens(usage.tokens) }), token: "textMuted" })
  }
  if (level.budget && usage.percent !== undefined) {
    pieces.push({ text: t("dagmode.band.budget", { percent: usage.percent }), token: dagTierToken(usage.tier) })
  }
  return pieces
}

function dagCounts(
  summary: DagWorkflowSummary,
  wave: { current: number; total: number } | undefined,
  level: DagLevel,
): BandSpan[] {
  if (level.counts === "none") return []
  const total = whole(summary.nodeCount)
  const skipped = whole(summary.skippedNodes)
  const aborted = whole(summary.abortedNodes)
  const settled = whole(summary.completedNodes) + skipped
  if (level.counts === "compact") return [{ text: `${settled}/${total}`, token: "textMuted" }]
  // The split stays whenever something was skipped or aborted, so 8/8 cannot hide seven skipped nodes.
  const progress = skipped + aborted > 0 ? formatDagProgress(summary) : `${settled}/${total}`
  const pieces: BandSpan[] = [{ text: t("dagmode.band.done", { progress }), token: "textMuted" }]
  if (level.wave && wave) pieces.push({ text: t("dagmode.panel.count.wave", wave), token: "textMuted" })
  const running = whole(summary.runningNodes)
  if (summary.status === "paused" || summary.status === "stepping") {
    const text = running > 0 ? t("dagmode.band.paused", { count: running }) : t("dagmode.panel.status.paused")
    pieces.push({ text, token: "statusPaused" })
  } else if (running > 0) {
    pieces.push({ text: t("dagmode.panel.count.running", { n: running }), token: "textMuted" })
  }
  const failed = whole(summary.failedNodes)
  if (failed > 0) pieces.push({ text: t("dagmode.panel.count.failed", { n: failed }), token: "error" })
  return separated(pieces)
}

/**
 * One workflow as a row of `width` cells at most: its title, a bar with a
 * segment per node (grouped by wave, colored by state), the counts, and at the
 * right edge the folded workflows and the hint. When the row is too wide the
 * text gives way first; the bar narrows only once the least text leaves it no
 * room, and then it takes everything left after that text (F4 1, 2.3).
 */
export function layoutDagRow(input: DagRowInput): BandRow {
  const aw = input.ambiguousWidth ?? 1
  const width = whole(input.width)
  const { summary } = input
  const lead: BandSpan[] = [
    { text: "◆", token: "primary" },
    { text: " ", token: "textMuted" },
  ]
  if (cellsOf(lead, aw) > width) return EMPTY_ROW

  const view = dagWorkflowView<BandNode>(summary, input.nodes)
  const loaded = view.nodes.length > 0
  const waves: readonly (readonly DagBarNode[])[] = loaded ? view.waves : [nodesFromCounts(summary)]
  const unplaced: readonly DagBarNode[] = loaded ? view.unplaced : []
  const hasBar = waves.some((group) => group.length > 0) || unplaced.length > 0
  const current = loaded ? dagCurrentWave(view.waves) : undefined
  const wave = current === undefined ? undefined : { current: current + 1, total: view.waves.length }
  const title = remoteLine(summary.title)
  const shortTitle = truncateCells(title, TITLE_SHORT_CELLS, aw)
  const more = whole(input.more)

  // A budget at its warning or exhausted band has the order that keeps it; any other has the quiet one.
  const alert = dagUsageAlert(input.usage)
  const { levels, minimal } = alert ? DAG_ALERT_CHAIN : DAG_CHAIN
  // A warning row takes no background mark.
  const background = alert ? undefined : input.background

  const parts = levels.map((level) => {
    const name = level.name === "none" ? "" : level.name === "short" ? shortTitle : title
    const head: BandSpan[] = [...lead, ...(name === "" ? [] : [{ text: name, token: "text" as const }, blank(1)])]
    const counts = dagCounts(summary, wave, level)
    // At the right edge, from the counts outward: the wait, the mode mark, the usage, the folded workflows, the hint,
    // the PR mark, the background mark.
    const groups: BandSpan[][] = []
    if (level.waiting && input.waiting) groups.push([{ text: t("dagmode.band.waiting"), token: "warning" }])
    if (level.mark && input.mode) {
      groups.push([
        input.mode === "on"
          ? { text: t("dagmode.band.mode.on"), token: "text" }
          : { text: t("dagmode.band.mode.off"), token: "textDim" },
      ])
    }
    const usage = usagePieces(input.usage, level)
    if (usage.length > 0) groups.push(separated(usage))
    if (level.more && more > 0) groups.push([{ text: t("dagmode.band.more", { count: more }), token: "textMuted" }])
    if (level.hint) groups.push([{ text: DAG_HINT, token: "textDim" }])
    // The PR mark does not give way with the text: it goes with the mode mark, at the last level only.
    if (level.mark && input.pr) groups.push([{ text: input.pr, token: "textMuted" }])
    // The background mark is the last group and the first to go: it has a level ahead of the hint.
    if (level.background && background) groups.push([backgroundMarkSpan(background)])
    const right = groups.flatMap((group, index) =>
      index === 0 ? group : [{ text: HINT_GAP, token: "textMuted" as const }, ...group],
    )
    // The space between the bar and the counts is counted in; the bar itself is not.
    const fixed =
      cellsOf(head, aw) +
      (hasBar && counts.length > 0 ? 1 : 0) +
      cellsOf(counts, aw) +
      (right.length > 0 ? MIN_GAP + cellsOf(right, aw) : 0)
    return { head, counts, right, fixed }
  })

  const barIn = (room: number) =>
    layoutDagBar({ waves, unplaced, width: room, ambiguousWidth: aw, per: SLOTS_PER_NODE })

  // The bar is sized against the least text, and the text then takes what the bar leaves.
  let base = minimal
  let bar = barIn(width - parts[base].fixed)
  // Too little text for the room: the bar got none although there are nodes, or the text alone is too wide.
  const cramped = () => (hasBar && bar.cells === 0) || parts[base].fixed + bar.cells > width
  while (base < levels.length - 1 && cramped()) {
    base++
    bar = barIn(width - parts[base].fixed)
  }
  let chosen = base
  for (let index = 0; index < base; index++) {
    if (parts[index].fixed + bar.cells <= width) {
      chosen = index
      break
    }
  }

  const { head, counts, right } = parts[chosen]
  const left: BandSpan[] = [
    ...head,
    ...bar.segments.map((segment): BandSpan => ({ text: segment.text, token: segment.token ?? "textMuted" })),
    ...(bar.cells > 0 && counts.length > 0 ? [blank(1)] : []),
    ...counts,
  ]
  return aligned(left, right, width, aw)
}

/**
 * The row `always` shows while the session tree has no workflow at all. A quiet PR's mark (`pr`) rides at its tail
 * as on a workflow row: this is the row the PR would otherwise be left out of, so the text gives way to the mark.
 * The background mark follows it and gives way first, as on a workflow row: it is drawn only while the hint and the PR
 * mark are, too.
 */
export function layoutEmptyRow(input: {
  width: number
  ambiguousWidth?: AmbiguousWidth
  pr?: string
  background?: string
}): BandRow {
  const aw = input.ambiguousWidth ?? 1
  const width = whole(input.width)
  const lead: BandSpan[] = [
    { text: "◆", token: "primary" },
    { text: " ", token: "textMuted" },
  ]
  const room = width - cellsOf(lead, aw)
  if (room < 0) return EMPTY_ROW
  const mark: BandSpan[] = input.pr ? [{ text: input.pr, token: "textMuted" }] : []
  const markRoom = mark.length > 0 ? MIN_GAP + cellsOf(mark, aw) : 0
  // A mark that does not fit beside the lead is left out.
  const edge = markRoom <= room ? mark : []
  const reserved = edge.length > 0 ? markRoom : 0
  const left = [
    ...lead,
    { text: truncateCells(t("dagmode.band.empty"), room - reserved, aw), token: "textMuted" as const },
  ]
  const hint: BandSpan = { text: DAG_HINT, token: "textDim" }
  const hinted = edge.length > 0 ? [hint, { text: HINT_GAP, token: "textMuted" as const }, ...edge] : [hint]
  const fits = cellsOf(left, aw) + MIN_GAP + cellsOf(hinted, aw) <= width
  if (fits && input.background) {
    const marked = [...hinted, { text: HINT_GAP, token: "textMuted" as const }, backgroundMarkSpan(input.background)]
    if (cellsOf(left, aw) + MIN_GAP + cellsOf(marked, aw) <= width) return aligned(left, marked, width, aw)
  }
  return aligned(left, fits ? hinted : edge, width, aw)
}

// ── The goal row ─────────────────────────────────────────────────────────────

/**
 * Whether a goal body can be drawn: it has its text and its status. The wire type promises both, but a body that is
 * not a goal must cost the band its goal row and nothing else: an error thrown while a row is laid out stalls the
 * updates of every row after it.
 */
export function isGoalShown(goal: Goal | null | undefined): goal is Goal {
  // The store types an absent goal as undefined, but a server that answers "no goal" with null puts null there.
  return typeof goal === "object" && goal !== null && typeof goal.goal === "string" && typeof goal.status === "string"
}

export interface GoalRowInput {
  readonly goal: Goal
  /**
   * The mark of the background runs (`◇ 后台 3`), after the hint at the right edge. It is drawn only where the row has
   * room for it left over: the layout below is the one the row has without it, and the mark is the first to give up.
   */
  readonly background?: string
  /** Cells the row may use. */
  readonly width: number
  readonly ambiguousWidth?: AmbiguousWidth
}

const GOAL_STATUS: Readonly<Record<Goal["status"], { readonly key: MessageKey; readonly token: BandToken }>> = {
  active: { key: "goal.status.active", token: "text" },
  waiting: { key: "goal.status.waiting", token: "textMuted" },
  paused: { key: "goal.status.paused", token: "warning" },
  done: { key: "goal.status.done", token: "success" },
}

/** What a goal row keeps, from everything to the status alone (F4 3). */
interface GoalLevel {
  readonly hint: boolean
  readonly subgoals: boolean
  readonly turns: boolean
  /** Whether the goal text has to fit whole; the levels after the first may cut it. */
  readonly whole: boolean
}

const GOAL_LEVELS: readonly GoalLevel[] = [
  { hint: true, subgoals: true, turns: true, whole: true },
  { hint: false, subgoals: true, turns: true, whole: false },
  { hint: false, subgoals: false, turns: true, whole: false },
  { hint: false, subgoals: false, turns: false, whole: false },
]

/**
 * The goal as a row of `width` cells at most: the goal text on the left and, at
 * the right edge, the turns, the status (or the reason it waits or paused, in
 * warning color), the subgoal count and the hint. A narrow row gives up the hint,
 * cuts the goal text, then drops the subgoal count and last the turns. The background mark is not part of that
 * order: it is added after the hint when the row has room left for it, and never takes any from the text.
 */
export function layoutGoalRow(input: GoalRowInput): BandRow {
  const aw = input.ambiguousWidth ?? 1
  const width = whole(input.width)
  const { goal } = input
  if (!isGoalShown(goal)) return EMPTY_ROW
  const mark: BandSpan = { text: "◎ ", token: "textMuted" }
  const lead: BandSpan[] = [mark, { text: t("goal.title"), token: "textMuted" }, blank(2)]
  const text = remoteLine(goal.goal)

  const reason =
    goal.status === "waiting" || goal.status === "paused"
      ? truncateCells(
          remoteLine(typeof goal.pausedReason === "string" ? goal.pausedReason : ""),
          GOAL_STATUS_MAX_CELLS,
          aw,
        )
      : ""
  const known = GOAL_STATUS[goal.status]
  const status: BandSpan =
    reason !== ""
      ? { text: reason, token: "warning" }
      : known
        ? { text: t(known.key), token: known.token }
        : { text: truncateCells(remoteLine(goal.status), GOAL_STATUS_MAX_CELLS, aw), token: "textMuted" }
  const used = finite(goal.turnsUsed)
  const max = finite(goal.maxTurns)
  const turns =
    used === undefined
      ? undefined
      : max === undefined
        ? t("dagmode.band.goal.turnsOpen", { used })
        : t("dagmode.band.goal.turns", { used, max })
  const subgoals = Array.isArray(goal.subgoals) ? goal.subgoals.length : 0

  /** The row with the goal text cut to `room` cells, and the background mark at the edge when it fits beside both. */
  const row = (kept: readonly BandSpan[], room: number, right: readonly BandSpan[], mark?: string) => {
    const cut = room > 0 ? truncateCells(text, room, aw) : ""
    const left = cut === "" ? kept : [...kept, { text: cut, token: "text" as const }]
    const tail: BandSpan[] = mark ? [{ text: HINT_GAP, token: "textMuted" }, backgroundMarkSpan(mark)] : []
    const marked = tail.length > 0 && cellsOf(left, aw) + MIN_GAP + cellsOf(right, aw) + cellsOf(tail, aw) <= width
    return aligned(left, marked ? [...right, ...tail] : right, width, aw)
  }

  for (const [index, level] of GOAL_LEVELS.entries()) {
    const pieces: BandSpan[] = []
    if (level.turns && turns !== undefined) pieces.push({ text: turns, token: "textMuted" })
    pieces.push(status)
    if (level.subgoals && subgoals > 0) {
      pieces.push({ text: t("dagmode.band.goal.subgoals", { count: subgoals }), token: "textMuted" })
    }
    const right = separated(pieces)
    if (level.hint) right.push({ text: HINT_GAP, token: "textMuted" }, { text: GOAL_HINT, token: "textDim" })
    const room = width - cellsOf(lead, aw) - MIN_GAP - cellsOf(right, aw)
    const needed = level.whole ? cellWidth(text, aw) : Math.min(cellWidth(text, aw), GOAL_TEXT_MIN_CELLS)
    // The last level takes whatever room is left, however little.
    if (index === GOAL_LEVELS.length - 1 ? room >= 0 : room >= needed) return row(lead, room, right, input.background)
  }
  // Not even the status fits beside the lead: the goal text alone, in what the mark leaves.
  const room = width - cellsOf([mark], aw)
  return room < 0 ? EMPTY_ROW : row([mark], room, [])
}

// ── The band ─────────────────────────────────────────────────────────────────

/** A workflow of the session tree and the session that owns it. */
interface OwnedWorkflow {
  readonly summary: DagWorkflowSummary
  readonly sessionID: string
}

function sameStrings(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** A row's spans cut into runs that share an action, in order: the pieces of the background mark are one run. */
function partsOf(spans: readonly BandSpan[]) {
  const parts: Array<{ action: BandSpan["action"]; spans: BandSpan[] }> = []
  for (const span of spans) {
    const last = parts.at(-1)
    if (last && last.action === span.action) last.spans.push(span)
    else parts.push({ action: span.action, spans: [span] })
  }
  return parts
}

function BandLine(props: { row: BandRow; onClick?: () => void; onAgents?: () => void }) {
  const { theme } = useTheme()
  const parts = createMemo(() => partsOf(props.row.spans))
  // The texts that have a click of their own. A click that lands on one is theirs: it still bubbles up the frame (an
  // open drawer closes on any click outside itself), but the row's own click does not run as well.
  const own = new Set<Renderable>()
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      paddingLeft={BAND_PADDING}
      paddingRight={BAND_PADDING}
      onMouseUp={(event) => {
        if (event.target && own.has(event.target)) return
        props.onClick?.()
      }}
    >
      <For each={parts()}>
        {(part) => (
          <text
            wrapMode="none"
            ref={(node) => {
              if (!part.action) return
              own.add(node)
              onCleanup(() => own.delete(node))
            }}
            onMouseUp={part.action ? () => props.onAgents?.() : undefined}
          >
            <For each={part.spans}>{(span) => <span style={{ fg: theme[span.token] }}>{span.text}</span>}</For>
          </text>
        )}
      </For>
    </box>
  )
}

/**
 * The band's content on a session route: the rows of the root session's tree, whichever view of the tree is on
 * screen: the PR row, the workflow row, the goal row and the reminder row (F4 1, F6 2), and the background runs (#1058
 * 4): a mark at the tail of the first quiet row, or a row of their own when there is no other. The project-trust row
 * (#1618) is the exception to "the root session's": project trust belongs to the project, so the row is the same in
 * every view and ahead of all the others. Which rows are drawn is `chooseBandRows`. Read-only: a click on the
 * workflow row only opens `/dag`, a click on the PR row only opens the pull request in the system browser, a click on
 * the background mark or its row only opens `/agents`, a click on the trust row only opens `/trust`.
 *
 * It shows what `sync.data` and the PR tracker hold and keeps no state of its own; it subscribes to no clock, all
 * the timing of PRs and reminders being the tracker's, and the background runs show no time at all. The one thing it
 * does besides drawing is declaring the workflow it shows to `sync.dag.watch`, which registers the owner session and
 * loads the node table; the declaration ends when the row goes away and when the band unmounts.
 *
 * The app hands it to the frame's `statusBand` slot, which builds it inside the
 * bottom zone's provider: that is where it reads the panel stack, to leave the
 * workflow to `/dag` while that is open.
 */
export function SessionStatusBand() {
  const route = useRoute()
  const sync = useSync()
  const kv = useKV()
  const commands = useCommands()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const zone = useBottomZoneOptional()
  // Absent where no tracker is provided (a band mounted alone): then there is no PR and no reminder to draw.
  const tracker = usePrTracker()

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const rootID = createMemo(() => {
    const id = sessionID()
    return id === undefined ? undefined : resolveRootSessionID(sync.data.session, id)
  })
  const mode = createMemo(() => dagBandMode(kv.get("dag_band", "auto")))
  const aw = createMemo((): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1))
  const width = createMemo(() => Math.max(0, dimensions().width - 2 * BAND_PADDING))
  const narrow = createMemo(() => dimensions().width < BAND_NARROW_WIDTH)
  // The panel shows the workflow in full, so the band does not say it twice.
  const panelOpen = createMemo(() => zone?.host.stack().some((spec) => spec.id === DAG_PANEL_ID) ?? false)

  const treeIDs = createMemo(
    () => {
      const root = rootID()
      return root === undefined ? [] : sessionTree(sync.data.session, root)
    },
    [],
    { equals: sameStrings },
  )
  /** Every workflow of the root session's tree, the root's first; each session's own are newest first. */
  const workflows = createMemo<readonly OwnedWorkflow[]>(() =>
    treeIDs().flatMap((owner) => (sync.data.dag[owner] ?? []).map((summary) => ({ summary, sessionID: owner }))),
  )

  /** The workflow the panel starts on: the one the user picked, else a running one, else a failed one not yet opened. */
  const selection = createMemo(() => {
    const root = rootID()
    return selectMainWorkflow(
      workflows().map((entry) => entry.summary),
      {
        chosen: root === undefined ? undefined : sync.dag.focus.chosen(root),
        acknowledged: root === undefined ? undefined : sync.dag.focus.acknowledged(root),
      },
    )
  })

  /** What the workflow row is about: a workflow, the empty state of `always`, or nothing. */
  const target = createMemo<{ entry: OwnedWorkflow } | "empty" | undefined>(() => {
    if (mode() === "hidden" || panelOpen()) return undefined
    const picked = selection()
    if (mode() === "always" && !picked.main) {
      const newest = workflows().at(0)
      return newest ? { entry: newest } : "empty"
    }
    if (mode() === "auto" && !picked.attention) return undefined
    const main = picked.main
    const entry = main ? workflows().find((candidate) => candidate.summary === main) : undefined
    return entry ? { entry } : undefined
  })

  // DAG mode (F4 7.1), all of it derived from what the data layer holds: the mode is the session's own field, the
  // usage follows the workflows' summaries over the mode snapshot (the slots of the whole process being the latest
  // report of any session), and the wait follows the checkpoints, the root session's status and how its latest turn
  // ended.
  const modeMark = createMemo(() => {
    const root = rootID()
    const on = root !== undefined && sync.session.get(root)?.dagMode === "on"
    return dagModeMarker(
      on,
      workflows().map((entry) => entry.summary),
    )
  })
  const usage = createMemo(() => {
    const root = rootID()
    return root === undefined
      ? undefined
      : dagUsage({ snapshot: sync.data.dagMode[root], workflows: sync.data.dag[root], running: sync.data.dagRunning })
  })
  const waiting = createMemo(() => {
    const root = rootID()
    if (root === undefined) return false
    return dagWaitingForMainAgent({
      workflows: workflows().map((entry) => entry.summary),
      idle: (sync.data.session_status[root]?.type ?? "idle") === "idle",
      lastTurn: sync.data.turn_settled[root]?.outcome,
    })
  })

  // The tracked PRs and the nearest reminder of the root session, as the tracker lists them (sticky warnings first).
  const prItems = createMemo(() => {
    const root = rootID()
    return root === undefined ? [] : (tracker?.items(root) ?? [])
  })
  const prWarning = createMemo(() => prHasWarning(prItems()))

  // The background runs of the root session that are still going (#1058 4), counted from the Task links, the jobs
  // they own and the child summaries the data layer already holds. The view equals itself while a run only reports
  // progress, so the rows are laid out again only when a count or a name changes.
  const background = createMemo<BackgroundBand | undefined>(
    () => {
      const root = rootID()
      if (root === undefined) return undefined
      return backgroundBand(
        backgroundItems({
          taskIndex: sync.data.taskIndex,
          rootID: root,
          job: (id) => sync.data.lifecycle[lifecycleKey({ domain: "job", id })],
          summary: (id) => sync.data.summary[id],
        }),
        (id) => sync.session.get(id),
      )
    },
    undefined,
    { equals: sameBackgroundBand },
  )
  const backgroundText = createMemo(() => {
    const band = background()
    return band === undefined ? undefined : backgroundMark(band, aw()) || undefined
  })

  // Each row is laid out as the band draws it, and again with the background mark at its tail when it is the row the
  // mark goes to (`chooseBandRows` asks for that one only).
  const dagRowWith = (mark?: string): BandRow | undefined => {
    const shown = target()
    if (shown === undefined) return undefined
    // A quiet PR rides at the tail of this row; a warning has a row of its own, so the tail is empty then.
    const pr = prTailText(prItems())
    if (shown === "empty") return layoutEmptyRow({ width: width(), ambiguousWidth: aw(), pr, background: mark })
    const { summary } = shown.entry
    return layoutDagRow({
      summary,
      nodes: sync.dag.nodes(summary.id),
      more: workflows().length - 1,
      mode: modeMark(),
      usage: usage(),
      waiting: waiting(),
      pr,
      background: mark,
      width: width(),
      ambiguousWidth: aw(),
    })
  }
  const dagRow = createMemo(() => dagRowWith())
  // A workflow row whose budget is at its warning or exhausted band is a warning row: it takes no background mark.
  const dagAlert = createMemo(() => {
    const shown = target()
    return shown !== undefined && shown !== "empty" && dagUsageAlert(usage())
  })

  const goalRowWith = (mark?: string): BandRow | undefined => {
    const root = rootID()
    const goal = root === undefined ? undefined : sync.data.goal[root]
    // A body that is not a goal takes no row, instead of throwing out of a memo the whole band depends on.
    return isGoalShown(goal)
      ? layoutGoalRow({ goal, background: mark, width: width(), ambiguousWidth: aw() })
      : undefined
  }
  const goalRow = createMemo(() => goalRowWith())

  const prRowWith = (mark?: string): BandRow | undefined => {
    const items = prItems()
    return items.length > 0 ? layoutPrRow(items, width(), aw(), mark) : undefined
  }
  const prRow = createMemo(() => prRowWith())

  const reminderRowWith = (mark?: string): BandRow | undefined => {
    const root = rootID()
    const item = root === undefined ? undefined : tracker?.reminder(root)
    return item === undefined ? undefined : layoutReminderRow(item, width(), aw(), mark)
  }
  const reminderRow = createMemo(() => reminderRowWith())

  // The project commands that changed since the last decision and wait for a new one (#1618): the count is all the row
  // needs, so a store write that changes no entry's state or change flag lays nothing out again. Zero draws no row.
  const trustChanged = createMemo(() => trustChangeCount(sync.data.trust))
  const trustRow = createMemo(() => {
    const count = trustChanged()
    return count > 0 ? layoutTrustRow(count, width(), aw()) : undefined
  })

  // At most two rows, one below the narrow limit: the trust warning, a PR warning, the workflow, a quiet PR (only when
  // there is no workflow row), the goal, the reminder, in that order. The background mark rides on the first of them
  // that is not a warning row; the runs have a row of their own only while there is none (neither is drawn below the
  // narrow limit).
  const chosen = createMemo(() => {
    const pr = prRow()
    const band = background()
    const mark = backgroundText()
    return chooseBandRows(
      {
        trust: trustRow(),
        pr: pr === undefined ? undefined : { row: pr, warning: prWarning() },
        dag: dagRow(),
        dagAlert: dagAlert(),
        goal: goalRow(),
        reminder: reminderRow(),
        background:
          band === undefined || mark === undefined
            ? undefined
            : {
                marked: (kind) =>
                  ({ dag: dagRowWith, pr: prRowWith, goal: goalRowWith, reminder: reminderRowWith })[kind](mark),
                own: () => layoutBackgroundRow({ band, width: width(), ambiguousWidth: aw() }),
              },
      },
      narrow(),
    )
  })
  const dagShown = createMemo(() => chosen().some((choice) => choice.kind === "dag"))

  const watched = createMemo<readonly DagWatch[]>(() => {
    const shown = target()
    // A workflow whose row a warning (the trust row, a PR warning) pushed out of a narrow band is not on screen, so it
    // is not declared.
    return shown === undefined || shown === "empty" || !dagShown()
      ? []
      : [{ workflowID: shown.entry.summary.id, sessionID: shown.entry.sessionID }]
  })
  const watchedKey = createMemo(() =>
    watched()
      .map((item) => `${item.sessionID}\u0000${item.workflowID}`)
      .join("\u0001"),
  )

  // Declaring what is on screen is a side effect on the data layer, which registers the owner session and reads
  // the node table; nothing is written to a store from here.
  createEffect(
    on(watchedKey, () => {
      void sync.dag.watch(WATCH_SOURCE, watched())
    }),
  )
  onCleanup(() => {
    void sync.dag.watch(WATCH_SOURCE, [])
  })

  function openDag() {
    // A drag that ended on the row selected text; it is not a click.
    if (renderer.getSelection()?.getSelectedText()) return
    // A click picks the command the way the palette does, so it runs under that origin.
    void commands.run("dag.open", { args: "", origin: "palette" }).catch((error) => {
      TuiLog.write("error", "Command failed", error)
    })
  }

  function openAgents() {
    // A drag that ended on the row selected text; it is not a click.
    if (renderer.getSelection()?.getSelectedText()) return
    // The list of sub-agents, as the palette opens it; the panel is read-only like the band.
    void commands.run("agent.subagents", { args: "", origin: "palette" }).catch((error) => {
      TuiLog.write("error", "Command failed", error)
    })
  }

  function openTrust() {
    // A drag that ended on the row selected text; it is not a click.
    if (renderer.getSelection()?.getSelectedText()) return
    // The project-trust panel, as `/trust` opens it from the palette: it lists every entry and writes nothing until a
    // decision is submitted there, so the click itself sends no request.
    void commands.run("trust.open", { args: "", origin: "palette" }).catch((error) => {
      TuiLog.write("error", "Command failed", error)
    })
  }

  function openPr() {
    // A drag that ended on the row selected text; it is not a click.
    if (renderer.getSelection()?.getSelectedText()) return
    const url = prOpenUrl(prItems())
    if (url === undefined) return
    // A browser that cannot start (no display, no opener) has no place to be reported from a click, and the band
    // writes no toast: the row stays as it is. Same as `ui/link.tsx`.
    open(url).catch(() => {})
  }

  const clickOf = (kind: BandRowKind) =>
    kind === "dag"
      ? openDag
      : kind === "pr"
        ? openPr
        : kind === "background"
          ? openAgents
          : kind === "trust"
            ? openTrust
            : undefined

  return (
    <box flexDirection="column" flexShrink={0}>
      <Index each={chosen()}>
        {(choice) => <BandLine row={choice().row} onClick={clickOf(choice().kind)} onAgents={openAgents} />}
      </Index>
    </box>
  )
}
