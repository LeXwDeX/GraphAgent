// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What the PR line says about a watched pull request (#1036), read-only like everything else in `pr/`: the
 * line's text and colors, the short marks for narrow terminals, the toast for a transition, and the rule that
 * clears a sticky warning. Pure: no rendering, no state, no clock, no SDK access. The caller passes the entry as
 * the server reports it, the root session's status and assistant messages, and `now`. The result also says when
 * the clock alone will change it (`nextAt`), so the caller registers exactly one `ticker.at` per row.
 *
 * A line is made in two steps. `prLineFacts` decides what it is (kind, outcome, flags, the next clock boundary) and
 * says nothing in any language; `prLineWords` puts the facts into the sentence of the interface language at the
 * moment it is called. A caller that keeps a line keeps the facts and asks for the words when it draws or toasts,
 * so a kept line follows a language switch and two of them compare equal across one. `prLineState` is both at once.
 *
 * Only the PR number reaches the screen. The entry's `review` excerpt, `head` and `url` are not even part of the
 * input type; a later change that shows one of them must pass it through `remoteLine` (`util/remote-text`) first.
 *
 * Width: every string built here is ASCII plus `✓ ✗` (both East Asian Neutral), one cell per character at either
 * `ambiguous_width`. `ui/width.ts` is the one place that measures text and `pr/` may not import it, which is why
 * the widths are written down here; the tests compare every string with `cellWidth`, so a change on either side
 * fails.
 */

import type { PrWatchEntry } from "@graphagent/sdk"
import { t, type MessageKey } from "../i18n"

/** What the server concluded about a watch; present once a watch has left `watching`. */
export type PrOutcome = NonNullable<PrWatchEntry["outcome"]>

/** How long a notice may go unanswered before the line calls the agent unresponsive (the `≥` boundary). */
export const PR_UNRESPONSIVE_MS = 180_000

/** How long "agent handled it" stays on screen after the agent's last error-free turn ended. */
export const PR_HANDLED_VISIBLE_MS = 60_000

/** The fields of a watch entry the line reads. A full `PrWatchEntry` fits. */
export type PrLineEntry = Pick<PrWatchEntry, "phase" | "outcome" | "checks" | "updatedAt" | "delivery">

/** One assistant message of the root session, as the line needs it. */
export interface PrAssistant {
  /** Epoch milliseconds the message was created. */
  readonly created: number
  /** Epoch milliseconds it finished; absent while it is still being written. */
  readonly completed?: number
  /** It ended in an error. A message that only called tools has none and counts as an answer. */
  readonly error: boolean
}

/** The root session the watch belongs to. The caller passes every assistant message; the line picks the ones after the notice. */
export interface PrSession {
  /** `undefined` (no status known) is treated as idle; `busy` and `retry` both count as working. */
  readonly status: "idle" | "busy" | "retry" | undefined
  readonly assistants: readonly PrAssistant[]
  /**
   * The root's history is not loaded (never opened, or evicted from the cache): `assistants` holds only what was
   * last seen of it. An answer there still counts; a missing answer proves nothing, so the line neither reports a
   * failed turn nor runs the three-minute clock.
   */
  readonly partial?: boolean
}

/**
 * Which sentence the line says.
 *
 * - `watching`: CI is being watched (`CI 3/6`, or waiting for CI).
 * - `awaiting`: the outcome is known and the notice is not delivered yet.
 * - `notified`: delivered; the agent has not started on it yet.
 * - `working`: delivered; the session is busy.
 * - `handled`: delivered; the agent answered. Hidden a minute after that turn ended.
 * - `noReply`: delivered without a turn, the session was stopped. Warning, sticky.
 * - `turnError`: delivered; every turn since ended in an error. Warning, sticky.
 * - `unresponsive`: the agent did not pick the notice up for three minutes. Warning, sticky.
 * - `settled`: the watch ended and the server reported no delivery; the outcome alone.
 * - `removed`: cancelled; the caller drops the row and shows nothing.
 */
export type PrLineKind =
  | "watching"
  | "awaiting"
  | "notified"
  | "working"
  | "handled"
  | "noReply"
  | "turnError"
  | "unresponsive"
  | "settled"
  | "removed"

/** Theme tokens the outcome prefix is drawn in. Never the brand color. */
export type PrPrefixToken = "success" | "error" | "warning" | "textMuted"

/** Theme tokens the status sentence is drawn in. */
export type PrStatusToken = "textMuted" | "warning"

/**
 * What a line is, without a word of it: no text, no language. This is what a caller keeps (the tracker's held
 * warnings), compares (equal facts draw the same row in either language) and hands to the marks.
 */
export interface PrLineFacts {
  readonly kind: PrLineKind
  /** The entry's outcome, for the marks and for toast transitions. */
  readonly outcome?: PrOutcome
  /** `warning` for the three sticky kinds. The prefix has its own token, so a timed-out line is not warning as a whole. */
  readonly tone: "default" | "warning"
  /** A warning that stays until `prAlertDismissed` says so, and takes a row of its own. */
  readonly sticky: boolean
  /** Do not draw the row: removed, handled for over a minute, or an ended watch with nothing to say. */
  readonly hidden: boolean
  /** The next absolute time (epoch milliseconds) at which this result changes by the clock alone. */
  readonly nextAt?: number
}

/** The line in words, in the interface language of the moment it was made (`prLineWords`); never to be kept. */
export interface PrLineWords {
  /** The whole line without colors: `prefix · status`, or either piece alone. Empty when nothing is drawn. */
  readonly text: string
  /** The outcome (`✓ passed`, `merged`, ...); absent while watching and when the server gave none. */
  readonly prefix?: { readonly text: string; readonly token: PrPrefixToken }
  /** The sentence after it (`CI 3/6`, `agent working`, ...). */
  readonly status?: { readonly text: string; readonly token: PrStatusToken }
}

/** The facts and their words in one value. */
export interface PrLineState extends PrLineFacts, PrLineWords {}

/** The CI counts a `watching` line states; a full `PrWatchEntry["checks"]` fits. */
export type PrLineChecks = Pick<NonNullable<PrWatchEntry["checks"]>, "passed" | "total">

const SEPARATOR = " · "

const STICKY_KINDS: ReadonlySet<PrLineKind> = new Set(["noReply", "turnError", "unresponsive"])

interface Prefix {
  readonly text: string
  readonly token: PrPrefixToken
}

interface Status {
  readonly text: string
  readonly token: PrStatusToken
}

interface Extra {
  readonly outcome?: PrOutcome
  readonly hidden?: boolean
  readonly nextAt?: number
}

const OUTCOME_PREFIXES: ReadonlyMap<PrOutcome, { readonly key: MessageKey; readonly token: PrPrefixToken }> = new Map([
  ["success", { key: "pr.outcome.success", token: "success" }],
  ["failure", { key: "pr.outcome.failure", token: "error" }],
  ["merged", { key: "pr.outcome.merged", token: "textMuted" }],
  ["closed", { key: "pr.outcome.closed", token: "textMuted" }],
  ["review", { key: "pr.outcome.review", token: "textMuted" }],
  ["deadline", { key: "pr.outcome.deadline", token: "warning" }],
] as const)

/** An outcome a newer server adds has no entry and shows no prefix instead of breaking the row. */
function prefixOf(outcome: PrOutcome | undefined): Prefix | undefined {
  const spec = outcome === undefined ? undefined : OUTCOME_PREFIXES.get(outcome)
  return spec ? { text: t(spec.key), token: spec.token } : undefined
}

/** The sentence a kind says after the outcome. `watching` counts checks instead; `settled` and `removed` say none. */
const STATUSES: ReadonlyMap<PrLineKind, { readonly key: MessageKey; readonly token: PrStatusToken }> = new Map([
  ["awaiting", { key: "pr.status.awaiting", token: "textMuted" }],
  ["notified", { key: "pr.status.notified", token: "textMuted" }],
  ["working", { key: "pr.status.working", token: "textMuted" }],
  ["handled", { key: "pr.status.handled", token: "textMuted" }],
  ["noReply", { key: "pr.status.noReply", token: "warning" }],
  ["turnError", { key: "pr.status.turnError", token: "warning" }],
  ["unresponsive", { key: "pr.status.unresponsive", token: "warning" }],
] as const)

function statusOf(kind: PrLineKind, checks: PrLineChecks | undefined): Status | undefined {
  if (kind === "watching") {
    const text =
      checks !== undefined && checks.total > 0
        ? t("pr.ci", { passed: checks.passed, total: checks.total })
        : t("pr.ci.waiting")
    return { text, token: "textMuted" }
  }
  const spec = STATUSES.get(kind)
  return spec ? { text: t(spec.key), token: spec.token } : undefined
}

/**
 * The words of a line, in the language the interface has now: the outcome's prefix, the kind's sentence and the two
 * joined. Pure in its inputs and `t()`; the facts and the counts of a `watching` line are all it needs, so whoever
 * kept those can draw the line again after a language switch. `prLineState`, the toasts and the band's row share it.
 */
export function prLineWords(facts: Pick<PrLineFacts, "kind" | "outcome">, checks?: PrLineChecks): PrLineWords {
  const prefix = prefixOf(facts.outcome)
  const status = statusOf(facts.kind, checks)
  const text = [prefix?.text, status?.text].filter((piece) => piece !== undefined).join(SEPARATOR)
  return { text, ...(prefix ? { prefix } : {}), ...(status ? { status } : {}) }
}

/** Whether the outcome has a prefix to say; a newer server's outcome has none and an ended watch then draws nothing. */
function hasPrefix(outcome: PrOutcome | undefined): boolean {
  return outcome !== undefined && OUTCOME_PREFIXES.has(outcome)
}

function lineFacts(kind: PrLineKind, extra: Extra = {}): PrLineFacts {
  const sticky = STICKY_KINDS.has(kind)
  return {
    kind,
    ...(extra.outcome !== undefined ? { outcome: extra.outcome } : {}),
    tone: sticky ? "warning" : "default",
    sticky,
    hidden: extra.hidden ?? false,
    ...(extra.nextAt !== undefined && Number.isFinite(extra.nextAt) ? { nextAt: extra.nextAt } : {}),
  }
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

/**
 * When the three minutes of a notice started: the write that made it owed (`delivering`), or the moment it was
 * delivered. A watch that is owed and later delivered has two of them, and ends in an unresponsive line for each, so
 * this is what tells one such warning from the next. `awaiting` and `notified` carry `prNoticeAt + PR_UNRESPONSIVE_MS`
 * as their `nextAt`.
 */
export function prNoticeAt(entry: Pick<PrWatchEntry, "phase" | "updatedAt" | "delivery">): number {
  const owed = entry.phase === "delivering" || entry.delivery?.state === "pending"
  return owed ? entry.updatedAt : finiteOr(entry.delivery?.deliveredAt, entry.updatedAt)
}

/** The outcome is known: the notice is owed, delivered, or (after a restart) unaccounted for. */
function settling(entry: PrLineEntry, session: PrSession, now: number): PrLineFacts {
  const { outcome, delivery } = entry
  const make = (kind: PrLineKind, extra: Omit<Extra, "outcome"> = {}) => lineFacts(kind, { ...extra, outcome })

  // Owed: the clock starts when the watch entered `delivering`, which is the entry's last write.
  if (entry.phase === "delivering" || delivery?.state === "pending") {
    const unresponsiveAt = entry.updatedAt + PR_UNRESPONSIVE_MS
    if (now >= unresponsiveAt) return make("unresponsive")
    return make("awaiting", { nextAt: unresponsiveAt })
  }

  // A settled watch the server reports no delivery for: nothing is known about the agent.
  if (delivery?.state !== "delivered") return make("settled", { hidden: !hasPrefix(outcome) })

  if (delivery.noReply) return make("noReply")
  if (session.status === "busy" || session.status === "retry") return make("working")

  const deliveredAt = finiteOr(delivery.deliveredAt, entry.updatedAt)
  const since = session.assistants.filter((message) => message.created > deliveredAt)
  const answers = since.filter((message) => !message.error)
  if (answers.length > 0) {
    const last = answers.reduce((latest, message) => (message.created >= latest.created ? message : latest))
    const hideAt = (last.completed ?? last.created) + PR_HANDLED_VISIBLE_MS
    return now >= hideAt ? make("handled", { hidden: true }) : make("handled", { nextAt: hideAt })
  }
  if (session.partial) return make("notified")
  if (since.length > 0) return make("turnError")

  const unresponsiveAt = deliveredAt + PR_UNRESPONSIVE_MS
  if (now >= unresponsiveAt) return make("unresponsive")
  return make("notified", { nextAt: unresponsiveAt })
}

/**
 * The facts of the line for one watch, first match wins:
 *
 * - `removed`: the watch was cancelled.
 * - `watching`: the watch is still running.
 * - `noReply`: delivered, and the notice did not start a turn.
 * - `working`: delivered, the session is busy.
 * - `handled`: delivered, idle, and an assistant message after the notice did not end in an error.
 * - `turnError`: delivered, idle, and every assistant message after the notice ended in an error.
 * - `unresponsive`: delivered, idle, nothing after the notice for 3 minutes; or owed for 3 minutes.
 * - `notified`: delivered, idle, nothing after the notice yet; or the root's history is not loaded (`partial`) and
 *   holds no answer to the notice.
 * - `awaiting`: owed (`delivering`) for under 3 minutes.
 * - `settled`: ended, and the server reported no delivery.
 *
 * Every time boundary is `>=`: at exactly 3 minutes the agent is unresponsive, and at exactly 60 seconds after
 * its last error-free turn ended the handled line is hidden, so a callback registered at `nextAt` sees the new
 * result.
 *
 * No language is involved: the result is the same in every language, and no `t()` is read here, so a reactive
 * caller does not depend on the language signal through this.
 */
export function prLineFacts(entry: PrLineEntry, session: PrSession, now: number): PrLineFacts {
  if (entry.phase === "cancelled") return lineFacts("removed", { hidden: true })
  if (entry.phase === "watching") return lineFacts("watching")
  return settling(entry, session, now)
}

/** The facts of `prLineFacts` and their words (`prLineWords`) in the language of the moment, for a caller that draws at once. */
export function prLineState(entry: PrLineEntry, session: PrSession, now: number): PrLineState {
  const line = prLineFacts(entry, session, now)
  return { ...line, ...prLineWords(line, entry.checks) }
}

// ---------------------------------------------------------------------------
// Short marks
// ---------------------------------------------------------------------------

const MARKS = ["!", ">", "?", "~", "✓", "✗", "M", "C", "R", "T"] as const

/**
 * The one-cell marks of the compressed forms: `!` warning, `>` the agent is working, `?` waiting for the agent,
 * `~` CI running or waiting, then the outcome (`✓` passed, `✗` failed, `M` merged, `C` closed, `R` review
 * changed, `T` timed out).
 */
export type PrMark = (typeof MARKS)[number]

/**
 * Every character a mark can be: ASCII plus `✓ ✗`, all East Asian Neutral, so one cell at either
 * `ambiguous_width`. A mark outside this set would make the cell counts below wrong.
 */
export const PR_MARK_CHARS: ReadonlySet<string> = new Set<string>(MARKS)

const OUTCOME_MARKS: ReadonlyMap<PrOutcome, PrMark> = new Map<PrOutcome, PrMark>([
  ["success", "✓"],
  ["failure", "✗"],
  ["merged", "M"],
  ["closed", "C"],
  ["review", "R"],
  ["deadline", "T"],
])

/**
 * The one-cell mark of a row, by priority: `!` for a sticky warning, `>` working, `?` waiting for the agent
 * (awaiting, notified), `~` watching, else the outcome's mark (`handled` and `settled` keep theirs). A row that
 * is not drawn (`hidden`) has none.
 */
export function prMark(state: PrLineFacts): PrMark | undefined {
  if (state.hidden) return undefined
  if (state.sticky) return "!"
  switch (state.kind) {
    case "working":
      return ">"
    case "awaiting":
    case "notified":
      return "?"
    case "watching":
      return "~"
    default:
      return state.outcome === undefined ? undefined : OUTCOME_MARKS.get(state.outcome)
  }
}

/**
 * Cells of text built only from ASCII and `PR_MARK_CHARS`: one per character. The tests compare the compressed
 * forms with `cellWidth` at both `ambiguous_width` settings.
 */
function narrowCells(text: string): number {
  return text.length
}

export interface PrCompactItem {
  readonly mark: PrMark
  readonly number: number
  readonly sticky: boolean
}

export interface PrCompact {
  /** `PR ~#1036 ✓#1035 +2`; empty when there are no items or not even `PR +n` fits the budget. */
  readonly text: string
  /** Items written out. */
  readonly shown: number
  /** Items left out and counted in the `+k`. */
  readonly hidden: number
}

/**
 * Several PRs in one line: the label, then `mark#number` per PR, sticky first and the rest in input order. When
 * that is wider than `budget` cells, PRs are dropped from the end and the rest is counted in a trailing `+k`, so
 * the whole text always fits.
 */
export function prCompact(items: readonly PrCompactItem[], budget: number): PrCompact {
  if (items.length === 0) return { text: "", shown: 0, hidden: 0 }
  const ordered = [...items.filter((item) => item.sticky), ...items.filter((item) => !item.sticky)]
  const label = t("pr.label")
  const entries = ordered.map((item) => `${item.mark}${t("pr.number", { number: item.number })}`)

  // widths[k]: the label and the first k entries, each after a space.
  const widths = [narrowCells(label)]
  for (const entry of entries) widths.push(widths[widths.length - 1] + 1 + narrowCells(entry))

  for (let shown = ordered.length; shown >= 0; shown--) {
    const hidden = ordered.length - shown
    const suffix = hidden > 0 ? ` +${hidden}` : ""
    // Written so that a budget that is not a number fits nothing.
    if (!(widths[shown] + narrowCells(suffix) <= budget)) continue
    return { text: [label, ...entries.slice(0, shown)].join(" ") + suffix, shown, hidden }
  }
  return { text: "", shown: 0, hidden: ordered.length }
}

/** Cells the DAG row gives the PR mark at its tail. */
export const PR_TAIL_BUDGET = 14

export interface PrTailRow {
  readonly state: PrLineFacts
  readonly entry: Pick<PrWatchEntry, "number" | "checks">
}

/**
 * The PR text at the tail of the DAG row, at most `PR_TAIL_BUDGET` cells, for the rows that are drawn (hidden
 * ones are skipped). One PR: `PR ~4/6` while its CI counts are known, `PR ~` while waiting for CI, otherwise
 * `PR ` and its mark (`PR ✓`, `PR >`, `PR ?`). Several: `prCompact` at that budget. Empty when nothing is drawn.
 */
export function prTailMark(rows: readonly PrTailRow[]): string {
  const drawn = rows.flatMap((row) => {
    const mark = prMark(row.state)
    return mark === undefined ? [] : [{ row, mark }]
  })
  if (drawn.length === 0) return ""
  if (drawn.length > 1) {
    const items = drawn.map(({ row, mark }) => ({ mark, number: row.entry.number, sticky: row.state.sticky }))
    return prCompact(items, PR_TAIL_BUDGET).text
  }

  const { row, mark } = drawn[0]
  const label = t("pr.label")
  const checks = row.entry.checks
  if (row.state.kind === "watching" && checks !== undefined && checks.total > 0) {
    const counted = `${label} ${mark}${checks.passed}/${checks.total}`
    if (narrowCells(counted) <= PR_TAIL_BUDGET) return counted
  }
  return `${label} ${mark}`
}

// ---------------------------------------------------------------------------
// Toasts and dismissal
// ---------------------------------------------------------------------------

/** The levels of `ui/toast.tsx` `ToastLevel`; `pr/` may not import it. */
export type PrToastLevel = "info" | "success" | "warning" | "error"

export interface PrToast {
  /** The toast's `dedupeKey`: one watch and one outcome or warning kind. */
  readonly key: string
  readonly text: string
  readonly level: PrToastLevel
}

const OUTCOME_LEVELS: ReadonlyMap<PrOutcome, PrToastLevel> = new Map<PrOutcome, PrToastLevel>([
  ["success", "success"],
  ["failure", "error"],
  ["merged", "info"],
  ["closed", "info"],
  ["review", "info"],
  ["deadline", "warning"],
])

/**
 * The toast for a transition from `previous` to `next`, if one is due: the outcome appearing (or changing), or
 * a sticky warning kind being entered. A warning wins when both happen at once. Nothing for a removed row, for
 * an unchanged state, or for any other change. `previous` is `undefined` for a watch seen the first time; a
 * caller that is loading a snapshot or refreshing after a reconnect does not call this at all. Both states are
 * facts: only the kind and the outcome are compared, and the toast is worded now, in the current language.
 */
export function prToastFor(
  previous: PrLineFacts | undefined,
  next: PrLineFacts,
  entry: Pick<PrWatchEntry, "watchID" | "number">,
): PrToast | undefined {
  if (next.kind === "removed") return undefined
  if (next.sticky && previous?.kind !== next.kind) {
    const { status } = prLineWords(next)
    if (status) {
      return {
        key: `pr:${entry.watchID}:${next.kind}`,
        text: t("pr.toast", { number: entry.number, text: status.text }),
        level: "warning",
      }
    }
  }
  if (next.outcome !== undefined && previous?.outcome !== next.outcome) {
    const { prefix } = prLineWords(next)
    if (prefix) {
      return {
        key: `pr:${entry.watchID}:${next.outcome}`,
        text: t("pr.toast", { number: entry.number, text: prefix.text }),
        level: OUTCOME_LEVELS.get(next.outcome) ?? "info",
      }
    }
  }
  return undefined
}

/**
 * Whether `next` is what the clock alone made of `previous` at `now`: a notice that was waiting for its three minutes
 * (`awaiting` or `notified`, whose `nextAt` is that boundary) is `unresponsive` now that the boundary has passed, for
 * the same outcome. That is the one move time makes by itself. A read can bring much more in the same gap (a delivery
 * that stopped, a failed turn, another outcome, an older notice), and none of that is time passing, so none of it
 * counts. The caller also checks that it is the same entry and the same notice (`prNoticeAt`).
 */
export function prClockMoved(previous: PrLineFacts | undefined, next: PrLineFacts, now: number): boolean {
  return (
    previous !== undefined &&
    (previous.kind === "awaiting" || previous.kind === "notified") &&
    previous.nextAt !== undefined &&
    previous.nextAt <= now &&
    next.kind === "unresponsive" &&
    next.outcome === previous.outcome
  )
}

/** A sticky warning on screen: the PR it is about, the watch that raised it, and when it was raised. */
export interface PrAlert {
  readonly url: string
  /** Epoch milliseconds the alert was raised; only later messages and watches count. */
  readonly since: number
  readonly watchID: string
}

export interface PrDismissContext {
  /** The root session's user messages; `synthetic` ones (a notice, a hook) are not the user. */
  readonly userMessages: readonly { readonly created: number; readonly synthetic: boolean }[]
  /** Every watch the session knows, any phase. */
  readonly watches: readonly { readonly watchID: string; readonly url: string; readonly startedAt: number }[]
}

/**
 * A sticky warning is cleared by the user acting after it: a user message of their own, or a newer watch on the
 * same pull request (compared by exact URL string, another watch ID) started after it was raised.
 */
export function prAlertDismissed(alert: PrAlert, ctx: PrDismissContext): boolean {
  if (ctx.userMessages.some((message) => !message.synthetic && message.created > alert.since)) return true
  return ctx.watches.some(
    (watch) => watch.url === alert.url && watch.watchID !== alert.watchID && watch.startedAt > alert.since,
  )
}
