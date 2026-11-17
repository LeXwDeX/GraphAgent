// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What DAG mode adds to the display (#1032 7), read-only like everything else in `dag/`: the budget band, the
 * usage the status band and the `/dag` title line show, the review quality row, the nodes a workflow left
 * uncovered, and the conditions for the band's mode mark and for "waiting for the main agent". Pure: no
 * rendering, no state, no SDK access. The figures come from the workflow summaries (`tokens`,
 * `concurrencyRunning`, `coverageCount`, `checkpointPending`, `quality`) and from the session's mode snapshot
 * (`GET /session/:id/dag-mode`: the budget, its warning ratio and the limits); nothing is recomputed that the
 * server already worked out, and a figure no source gave is left out rather than guessed.
 */

import type { DagWorkflowQuality, DagWorkflowSummary, SessionDagMode } from "@graphagent/sdk"
import { t } from "../i18n"
import { remoteLine } from "../util/remote-text"
import { dagDisplayState, formatDagError, type DagDisplayState, type DagNodeRow } from "./model"

/** The part of the mode snapshot the display reads; the stored snapshot has more. */
export type DagModeSnapshot = Pick<SessionDagMode, "budget" | "limits">

/** Where the usage stands against the session's budget: quiet, warning, or used up. */
export type DagBudgetTier = "normal" | "warn" | "exhausted"

/** The server's default for `dag.budget.warn_ratio`, for a snapshot that carries none. */
const DEFAULT_WARN_RATIO = 0.8

/**
 * The band the usage is in. The same cut the server makes before it announces one: used up from the budget on,
 * warning from the budget times the ratio, rounded down to whole tokens, so the colors here agree with the
 * server's toast. No budget, or a budget that is not positive, is never anything but normal.
 */
export function dagBudgetTier(used: number, budget: number | null | undefined, warnRatio: number): DagBudgetTier {
  if (budget === null || budget === undefined || !(budget > 0)) return "normal"
  if (used >= budget) return "exhausted"
  return used >= Math.floor(budget * warnRatio) ? "warn" : "normal"
}

const UNITS = [
  { size: 1e9, suffix: "B" },
  { size: 1e6, suffix: "M" },
  { size: 1e3, suffix: "K" },
] as const

/**
 * A token count as the band writes it: whole below 1000, then one decimal below ten of the unit and none above
 * (940, 1.2K, 12K, 1.2M). A count that rounds up to the next unit says so, not `1000K`.
 */
export function formatDagTokens(tokens: number): string {
  const count = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0
  for (const [index, unit] of UNITS.entries()) {
    if (count < unit.size) continue
    const value = count / unit.size
    const shown = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
    if (shown >= 1000 && index > 0) return `1${UNITS[index - 1].suffix}`
    return `${shown}${unit.suffix}`
  }
  return String(count)
}

/** What the session's workflows have used, and what that is measured against. */
export interface DagUsage {
  /** DAG slots running in the whole process, the sessions' together. */
  readonly running?: number
  /** The most slots the process may run at once. */
  readonly cap?: number
  /** Input, cache write, output and reasoning tokens of every attempt; cache reads do not count. */
  readonly tokens?: number
  /** The session's token budget; none when it is unlimited. */
  readonly budget?: number
  /** Whole percent of the budget used. It may pass 100 once running nodes finish after the budget was reached. */
  readonly percent?: number
  readonly tier: DagBudgetTier
}

export interface DagUsageInput {
  /** The session's mode snapshot, once it has been read. */
  readonly snapshot?: DagModeSnapshot
  /** The workflows the session itself owns (the budget is the main session's, not its sub-agents'). */
  readonly workflows?: readonly Pick<DagWorkflowSummary, "tokens" | "concurrencyRunning">[]
  /**
   * The slots running in the whole process, as the latest report of any source says: any session's workflow
   * summary or any snapshot read. The count belongs to the process, but a summary event carries it only for the
   * session it is about, so the session's own summaries can hold an older figure than another session's event
   * just brought. When given it is the newest figure there is, and it wins over both other sources.
   */
  readonly running?: number
}

/**
 * The usage to show. The workflows' summaries are newer than the snapshot: while any of them reports its tokens
 * their sum stands for the session's usage (the same sum the server's snapshot is made of), the snapshot's figure
 * only before that. The slot count is the process's latest report (`running`) when the caller has one, else the
 * first of the session's own summaries that carries one, else the snapshot's. The cap and the budget only the
 * snapshot knows. Undefined while nothing at all is known.
 */
export function dagUsage(input: DagUsageInput): DagUsage | undefined {
  const { snapshot, workflows } = input
  const reporting = workflows?.filter((workflow) => workflow.tokens !== undefined) ?? []
  const tokens =
    reporting.length > 0 ? reporting.reduce((sum, workflow) => sum + (workflow.tokens ?? 0), 0) : snapshot?.budget.used
  const reported = workflows?.find((workflow) => workflow.concurrencyRunning !== undefined)?.concurrencyRunning
  const slots = input.running ?? reported ?? snapshot?.limits.running
  const cap = snapshot?.limits.concurrency
  if (tokens === undefined && slots === undefined && cap === undefined) return undefined

  const limit = snapshot?.budget.tokens
  const budget = typeof limit === "number" && limit > 0 ? limit : undefined
  return {
    ...(slots !== undefined ? { running: slots } : {}),
    ...(cap !== undefined ? { cap } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(budget !== undefined && tokens !== undefined ? { percent: Math.floor((tokens * 100) / budget) } : {}),
    tier:
      tokens === undefined ? "normal" : dagBudgetTier(tokens, budget, snapshot?.budget.warnRatio ?? DEFAULT_WARN_RATIO),
  }
}

/** The mode mark on the band: on, or the dim off mark. */
export type DagModeMarker = "on" | "off"

/**
 * The mark the band carries. With the mode on it always says so; with it off only while a workflow still runs
 * (it continues to its end), since a band with nothing running and the mode off has nothing to qualify.
 */
export function dagModeMarker(
  on: boolean,
  workflows: readonly Pick<DagWorkflowSummary, "status">[],
): DagModeMarker | undefined {
  if (on) return "on"
  return workflows.some((workflow) => workflow.status === "running" || workflow.status === "stepping")
    ? "off"
    : undefined
}

export interface DagWaitingInput {
  /** The workflows of the session tree. */
  readonly workflows: readonly Pick<DagWorkflowSummary, "checkpointPending">[]
  /** The root session has no turn running. */
  readonly idle: boolean
  /** How its latest settled turn ended (`session.turn.settled`), if one has. */
  readonly lastTurn?: string
}

/**
 * A durable checkpoint is waiting for the main agent and the main agent is not at work on it: its session is idle,
 * or its latest turn ended in an error. The error counts on its own because the status can lag the turn that just
 * failed; an error with no checkpoint waiting is nothing to wait for.
 */
export function dagWaitingForMainAgent(input: DagWaitingInput): boolean {
  if (!input.workflows.some((workflow) => workflow.checkpointPending === true)) return false
  return input.idle || input.lastTurn === "error"
}

/**
 * The review quality of one workflow on a line: how many reviews completed, how many findings the latest round of
 * each chain left open, and how many of the acceptance items the completeness lanes covered. The counts are the
 * server's (per workflow, the same ones `inspect` reports); nothing is added up here. Undefined for a workflow
 * without a review decision.
 */
export function dagQualityText(quality: DagWorkflowQuality | null | undefined): string | undefined {
  if (!quality) return undefined
  const parts = [
    t("dagmode.panel.quality.reviews", { n: quality.reviews }),
    t("dagmode.panel.quality.open", { n: quality.stillOpen }),
  ]
  const completeness = quality.completeness
  if (completeness) {
    const { covered, total, unlisted } = completeness
    parts.push(
      unlisted > 0
        ? t("dagmode.panel.quality.completenessUnlisted", { covered, total, unlisted })
        : t("dagmode.panel.quality.completeness", { covered, total }),
    )
  }
  return parts.join(" · ")
}

/** How a node the work did not cover ended: it failed, was cancelled or aborted, or never ran. */
export type DagCoverageState = Extract<DagDisplayState, "failed" | "cancelled" | "aborted" | "skipped">

export interface DagCoverageEntry {
  readonly id: string
  /** The node's name, cleaned for one line. */
  readonly name: string
  readonly state: DagCoverageState
  /** Why it failed, when the server said; the other states carry none and speak for themselves. */
  readonly reason?: string
}

function isCoverageState(state: DagDisplayState | undefined): state is DagCoverageState {
  return state === "failed" || state === "cancelled" || state === "aborted" || state === "skipped"
}

/**
 * The nodes of a loaded table that count as a gap in the work: failed, cancelled, aborted and skipped ones, in the
 * order the table gives. The server's `coverageCount` also counts things that are not nodes (a declined fan-out, a
 * lane gap, a safety denial, a budget pause), so this list is a subset of it; the caller says how many are left.
 */
export function dagCoverageEntries(
  nodes: readonly Pick<DagNodeRow, "id" | "name" | "status" | "error_class" | "error_reason">[],
): DagCoverageEntry[] {
  const entries: DagCoverageEntry[] = []
  for (const node of nodes) {
    const state = dagDisplayState(node.status, node.error_class)
    if (!isCoverageState(state)) continue
    const reason = state === "failed" && node.error_reason ? remoteLine(formatDagError(node.error_reason)) : ""
    entries.push({ id: node.id, name: remoteLine(node.name), state, ...(reason !== "" ? { reason } : {}) })
  }
  return entries
}

/** Theme token a piece of the mode line is drawn in. */
export type DagModePieceToken = "text" | "textMuted" | "warning" | "error"

export interface DagModePiece {
  readonly text: string
  readonly token: DagModePieceToken
}

const TIER_TOKEN: Readonly<Record<DagBudgetTier, DagModePieceToken>> = {
  normal: "textMuted",
  warn: "warning",
  exhausted: "error",
}

/** The token a budget band is drawn in. */
export function dagTierToken(tier: DagBudgetTier): DagModePieceToken {
  return TIER_TOKEN[tier]
}

/**
 * The line above a workflow in the `/dag` panel: the mode, the slots of the whole process, the node cap of a
 * workflow, and the tokens against the budget (or alone when there is none). A piece whose source has not answered
 * is left out; the mode is the session's own and always there. The tokens take the color of the budget band.
 */
export function dagModeLine(input: {
  readonly on: boolean
  readonly snapshot?: DagModeSnapshot
  readonly usage?: DagUsage
}): DagModePiece[] {
  const { snapshot, usage } = input
  const pieces: DagModePiece[] = [
    { text: t(input.on ? "dagmode.panel.mode.on" : "dagmode.panel.mode.off"), token: input.on ? "text" : "textMuted" },
  ]
  if (usage?.running !== undefined && usage.cap !== undefined) {
    pieces.push({
      text: t("dagmode.panel.mode.running", { running: usage.running, cap: usage.cap }),
      token: "textMuted",
    })
  }
  if (snapshot) {
    pieces.push({ text: t("dagmode.panel.mode.nodes", { max: snapshot.limits.maxTotalNodes }), token: "textMuted" })
  }
  if (usage?.tokens !== undefined) {
    const used = formatDagTokens(usage.tokens)
    pieces.push({
      text:
        usage.budget === undefined
          ? t("dagmode.panel.mode.tokensOpen", { used })
          : t("dagmode.panel.mode.tokens", { used, budget: formatDagTokens(usage.budget) }),
      token: dagTierToken(usage.tier),
    })
  }
  return pieces
}
