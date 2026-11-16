// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { DagWorkflowSummary, Goal } from "@graphagent/sdk"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, For, on, onCleanup, Show, type ParentProps } from "solid-js"
import { resolveRootSessionID, sessionTree } from "../ask/ask-queue"
import { useCommands } from "../commands/context"
import { useKV } from "../context/kv"
import { useRoute } from "../context/route"
import { useSync, type DagWatch } from "../context/sync"
import { useTheme } from "../context/theme"
import { layoutDagBar, type DagBarNode } from "../dag/bar"
import {
  dagCurrentWave,
  dagWorkflowView,
  formatDagProgress,
  selectMainWorkflow,
  type DagStatusToken,
} from "../dag/model"
import type { DagWaveNode } from "../dag/waves"
import { t, type MessageKey } from "../i18n"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { TuiLog } from "../util/log"
import { remoteLine } from "../util/remote-text"
import { useBottomZoneOptional } from "./bottom-zone"

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
  /** Cells the row may use. */
  readonly width: number
  readonly ambiguousWidth?: AmbiguousWidth
}

/**
 * What a row keeps. The levels run from everything to the least a row may be
 * (F4 1): the hint goes first, then the folded count, the wave, the counts
 * squeezed to `n/m`, and the title cut short. The last two go beyond the spec,
 * for a terminal so narrow that not even that leaves room for the bar.
 */
interface DagLevel {
  readonly hint: boolean
  readonly more: boolean
  readonly wave: boolean
  readonly counts: "full" | "compact" | "none"
  /** How much of the title shows. */
  readonly name: "full" | "short" | "none"
}

const DAG_LEVELS: readonly DagLevel[] = [
  { hint: true, more: true, wave: true, counts: "full", name: "full" },
  { hint: false, more: true, wave: true, counts: "full", name: "full" },
  { hint: false, more: false, wave: true, counts: "full", name: "full" },
  { hint: false, more: false, wave: false, counts: "full", name: "full" },
  { hint: false, more: false, wave: false, counts: "compact", name: "full" },
  { hint: false, more: false, wave: false, counts: "compact", name: "short" },
  { hint: false, more: false, wave: false, counts: "none", name: "short" },
  { hint: false, more: false, wave: false, counts: "none", name: "none" },
]

/** The least text the spec allows; the bar is sized against it. */
const DAG_MINIMAL_LEVEL = 5

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

  const parts = DAG_LEVELS.map((level) => {
    const name = level.name === "none" ? "" : level.name === "short" ? shortTitle : title
    const head: BandSpan[] = [...lead, ...(name === "" ? [] : [{ text: name, token: "text" as const }, blank(1)])]
    const counts = dagCounts(summary, wave, level)
    const right: BandSpan[] = []
    if (level.more && more > 0) right.push({ text: t("dagmode.band.more", { count: more }), token: "textMuted" })
    if (level.hint) {
      if (right.length > 0) right.push({ text: HINT_GAP, token: "textMuted" })
      right.push({ text: DAG_HINT, token: "textDim" })
    }
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
  let base = DAG_MINIMAL_LEVEL
  let bar = barIn(width - parts[base].fixed)
  // Too little text for the room: the bar got none although there are nodes, or the text alone is too wide.
  const cramped = () => (hasBar && bar.cells === 0) || parts[base].fixed + bar.cells > width
  while (base < DAG_LEVELS.length - 1 && cramped()) {
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

/** The row `always` shows while the session tree has no workflow at all. */
function layoutEmptyRow(input: { width: number; ambiguousWidth?: AmbiguousWidth }): BandRow {
  const aw = input.ambiguousWidth ?? 1
  const width = whole(input.width)
  const lead: BandSpan[] = [
    { text: "◆", token: "primary" },
    { text: " ", token: "textMuted" },
  ]
  const room = width - cellsOf(lead, aw)
  if (room < 0) return EMPTY_ROW
  const left = [...lead, { text: truncateCells(t("dagmode.band.empty"), room, aw), token: "textMuted" as const }]
  const hint: BandSpan = { text: DAG_HINT, token: "textDim" }
  const fits = cellsOf(left, aw) + MIN_GAP + cellsOf([hint], aw) <= width
  return aligned(left, fits ? [hint] : [], width, aw)
}

// ── The goal row ─────────────────────────────────────────────────────────────

export interface GoalRowInput {
  readonly goal: Goal
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
 * cuts the goal text, then drops the subgoal count and last the turns.
 */
export function layoutGoalRow(input: GoalRowInput): BandRow {
  const aw = input.ambiguousWidth ?? 1
  const width = whole(input.width)
  const { goal } = input
  const mark: BandSpan = { text: "◎ ", token: "textMuted" }
  const lead: BandSpan[] = [mark, { text: t("goal.title"), token: "textMuted" }, blank(2)]
  const text = remoteLine(goal.goal)

  const reason =
    goal.status === "waiting" || goal.status === "paused"
      ? truncateCells(remoteLine(goal.pausedReason ?? ""), GOAL_STATUS_MAX_CELLS, aw)
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
  const subgoals = goal.subgoals?.length ?? 0

  /** The row with the goal text cut to `room` cells. */
  const row = (kept: readonly BandSpan[], room: number, right: readonly BandSpan[]) => {
    const cut = room > 0 ? truncateCells(text, room, aw) : ""
    return aligned(cut === "" ? kept : [...kept, { text: cut, token: "text" }], right, width, aw)
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
    if (index === GOAL_LEVELS.length - 1 ? room >= 0 : room >= needed) return row(lead, room, right)
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

function BandLine(props: { row: BandRow; onClick?: () => void }) {
  const { theme } = useTheme()
  return (
    <box height={1} flexShrink={0} paddingLeft={BAND_PADDING} paddingRight={BAND_PADDING} onMouseUp={props.onClick}>
      <text wrapMode="none">
        <For each={props.row.spans}>{(span) => <span style={{ fg: theme[span.token] }}>{span.text}</span>}</For>
      </text>
    </box>
  )
}

/**
 * The band's content on a session route: the workflow row and the goal row of
 * the root session's tree, whichever view of the tree is on screen (F4 1).
 * Read-only: a click on the workflow row only opens `/dag`.
 *
 * It shows what `sync.data` holds and keeps no state of its own. The one thing
 * it does besides drawing is declaring the workflow it shows to `sync.dag.watch`,
 * which registers the owner session and loads the node table; the declaration
 * ends when the row goes away and when the band unmounts.
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

  const dagRow = createMemo<BandRow | undefined>(() => {
    const shown = target()
    if (shown === undefined) return undefined
    if (shown === "empty") return layoutEmptyRow({ width: width(), ambiguousWidth: aw() })
    const { summary } = shown.entry
    return layoutDagRow({
      summary,
      nodes: sync.dag.nodes(summary.id),
      more: workflows().length - 1,
      width: width(),
      ambiguousWidth: aw(),
    })
  })

  const goalRow = createMemo<BandRow | undefined>(() => {
    const root = rootID()
    const goal = root === undefined ? undefined : sync.data.goal[root]
    return goal ? layoutGoalRow({ goal, width: width(), ambiguousWidth: aw() }) : undefined
  })

  // Below the narrow limit the two rows merge into one: the workflow's, else the goal's.
  const rows = createMemo(() => {
    const dag = dagRow()
    return { dag, goal: narrow() && dag ? undefined : goalRow() }
  })

  const watched = createMemo<readonly DagWatch[]>(() => {
    const shown = target()
    return shown === undefined || shown === "empty"
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

  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={rows().dag}>{(row) => <BandLine row={row()} onClick={openDag} />}</Show>
      <Show when={rows().goal}>{(row) => <BandLine row={row()} />}</Show>
    </box>
  )
}
