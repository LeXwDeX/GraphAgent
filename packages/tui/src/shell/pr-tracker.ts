// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What the status band shows about tracked PRs and reminders, and the toasts that go with it (#1036 F6).
 *
 * The tracker is the one owner of everything that moves with time or events: the hand-off judgement
 * (`prLineFacts`), the sticky warnings it keeps on screen after the server dropped their entries, the pending
 * `ticker.at` and the toasts. The band only lays out what `items` and `reminder` return.
 *
 * Language. The tracker keeps and compares facts (kind, outcome, flags, the PR number and its CI counts) and never a
 * translated word: a held warning is a plain copy of the facts it had, and the band puts them into the words of
 * the interface language each time it draws (`prLineWords`). The tracker reads no `t()` while it judges, so a
 * language switch re-runs nothing here: no row changes, no hold or dismissal moves, no toast is shown. A toast is
 * worded when it is shown, in the language of that moment.
 *
 * Time. The tracker subscribes to neither `frame` nor `second`. Every state carries the next moment the clock alone
 * changes it, and the tracker keeps exactly one `ticker.at`, at the earliest of those (reminder minute boundaries
 * included). The callback bumps a signal and the derived state is evaluated again; each evaluation reads
 * `ticker.now()` itself, so a state that appears with a stale entry (a snapshot, a reconnect) is judged at the
 * time it appears, not at the last boundary.
 *
 * Toasts. A toast is a reaction to an event, never to a read:
 * - a `pr.watch.updated` event for the root of the route on screen compares the watch's previous state with the
 *   one the event gives it (`prToastFor`);
 * - the clock alone can enter a sticky warning (notified, then unresponsive at three minutes): that one transition
 *   toasts from the effect below, which the callback of the pending `ticker.at` wakes. The callback runs a little
 *   after the boundary, so a read or another watch's event can evaluate the rows first; whoever evaluates first
 *   says it. Only the clock's own move counts (`announceClock`): the very notice that was waiting (same entry, same
 *   `prNoticeAt`) is now unresponsive. Anything else a read brings in that gap (another entry, outcome, delivery or
 *   CI counts) is folded in silently like any read.
 * Snapshot loads and reconnect reads replace the store's entries without a word; the effect below folds them into
 * the "previous state" so a later event does not toast what was already on screen. The store does not say where a
 * change came from, so the event listener relies on the order of the SDK's dispatch: a frame of events runs in one
 * `batch`, the store's own handler first (its write has landed, nothing derived has run), then this listener, then
 * the effect. A listener called outside a batch, after the effect has already folded the write in, would read the
 * event as a read.
 */

import type { Message, Part, PrWatchEntry, SessionReminder, SessionStatus } from "@graphagent/sdk"
import {
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  untrack,
  type Accessor,
} from "solid-js"
import type { Ticker } from "../context/ticker"
import { formatReminderIn, reminderNextAt } from "../pr/reminder"
import {
  prAlertDismissed,
  prClockMoved,
  prLineFacts,
  prNoticeAt,
  prToastFor,
  type PrAlert,
  type PrAssistant,
  type PrDismissContext,
  type PrLineFacts,
  type PrLineKind,
  type PrSession,
  type PrToast,
} from "../pr/state"
import type { ToastOptions } from "../ui/toast"
import { remoteLine } from "../util/remote-text"
import type { PrBandItem, PrTracker, ReminderBandItem } from "./pr-tracker-context"

/** What the tracker reads of the sync store (`sync.data` fits). Every read is reactive. */
export interface PrTrackerData {
  readonly pr_watch: { readonly [rootSessionID: string]: { readonly [watchID: string]: PrWatchEntry } | undefined }
  readonly reminder: { readonly [sessionID: string]: readonly SessionReminder[] | undefined }
  readonly session_status: { readonly [sessionID: string]: Pick<SessionStatus, "type"> | undefined }
  readonly message: { readonly [sessionID: string]: readonly Message[] | undefined }
  /** The sessions whose full history is loaded; another session's `message` list is absent or partial. */
  readonly hydrated: readonly string[]
  readonly part: { readonly [messageID: string]: readonly Part[] | undefined }
}

export interface PrTrackerDeps {
  readonly data: PrTrackerData
  /** Only the one-shot callback and the clock: the tracker never subscribes to `frame` or `second`. */
  readonly ticker: Pick<Ticker, "at" | "now">
  readonly toast: { show(options: ToastOptions): void }
  /**
   * Subscribe to `pr.watch.updated`. The listener gets the entry the event carries, and runs after the store has
   * taken the event in, in the same dispatch (see the header). Returns the unsubscribe function.
   */
  readonly onPrWatchEvent: (listener: (entry: PrWatchEntry) => void) => () => void
  /** The root session of the route on screen; undefined on the home page and the diff view. Toasts only name this one. */
  readonly currentRoot: () => string | undefined
  /** Opens a PR in the system browser. When given, a PR toast opens its PR on a click; only http(s) URLs are opened. */
  readonly openUrl?: (url: string) => void
}

/** A shown row with the start time the order needs; the item itself stays what the band reads. */
interface Row {
  readonly item: PrBandItem
  readonly startedAt: number
}

/** A sticky warning the tracker keeps: it outlives its entry until the user acts on it. */
interface Held {
  readonly alert: PrAlert
  readonly kind: PrLineKind
  /** The last row drawn: shown again once the entry is gone. */
  readonly row: Row
  /** The user already acted on it: it stays hidden while its entry and state stay as they are. */
  readonly dismissed: boolean
}

/** What the tracker remembers of a watch after it last folded the store in: the state, and which notice it is about. */
interface Committed {
  readonly state: PrLineFacts
  /** When the three minutes of its notice started (`prNoticeAt`): which warning of the watch an unresponsive row is. */
  readonly noticeAt: number
  /** What names its entry apart from the state (`identityOf`): a read that changes it brought another entry. */
  readonly identity: string
}

/** A watch's state and what a toast about it needs, for every watch whether it is drawn or not. */
interface WatchState extends Committed {
  readonly root: string
  readonly url: string
  readonly number: number
}

interface Core {
  readonly items: ReadonlyMap<string, readonly PrBandItem[]>
  readonly reminders: ReadonlyMap<string, ReminderBandItem>
  readonly states: ReadonlyMap<string, WatchState>
  readonly held: ReadonlyMap<string, ReadonlyMap<string, Held>>
  /** The earliest moment the clock alone changes any of the above. */
  readonly nextAt: number | undefined
}

const EMPTY: Core = { items: new Map(), reminders: new Map(), states: new Map(), held: new Map(), nextAt: undefined }
const NO_ITEMS: readonly PrBandItem[] = []
const NO_ASSISTANTS: readonly PrAssistant[] = []

/** The toasts shown are remembered by key so that one watch never says the same thing twice; this bounds the memory. */
const TOASTED_MAX = 256

function rowOf(entry: PrWatchEntry, state: PrLineFacts): Row {
  const checks = entry.checks
  return {
    startedAt: entry.startedAt,
    item: {
      watchID: entry.watchID,
      url: entry.url,
      number: entry.number,
      // Plain copies: the store's nodes are rewritten in place, and a held row must not follow them. Facts only: a held
      // row keeps no word, so it is worded again, in the language of the day, every time the band draws it.
      entry: {
        number: entry.number,
        ...(checks
          ? { checks: { total: checks.total, pending: checks.pending, failed: checks.failed, passed: checks.passed } }
          : {}),
      },
      state,
    },
  }
}

/** Sticky first, then the newest watch first; the ID only makes the order total. */
function byPriority(a: Row, b: Row): number {
  return (
    Number(b.item.state.sticky) - Number(a.item.state.sticky) ||
    b.startedAt - a.startedAt ||
    (a.item.watchID < b.item.watchID ? -1 : a.item.watchID > b.item.watchID ? 1 : 0)
  )
}

function sameItem(a: PrBandItem, b: PrBandItem): boolean {
  const x = a.entry.checks
  const y = b.entry.checks
  return (
    a.watchID === b.watchID &&
    a.url === b.url &&
    a.number === b.number &&
    (x === y ||
      (x !== undefined &&
        y !== undefined &&
        x.total === y.total &&
        x.pending === y.pending &&
        x.failed === y.failed &&
        x.passed === y.passed)) &&
    // Kind and outcome decide every token, flag and word the state carries (the CI counts are compared above): a
    // language switch changes none of them, so it is not a change of the row.
    a.state.kind === b.state.kind &&
    a.state.outcome === b.state.outcome
  )
}

/**
 * What names the entry a state was made from, apart from the state: its PR and its CI counts. A read that changes any
 * of them brought another entry, which is not something the clock did.
 */
function identityOf(entry: PrWatchEntry): string {
  const checks = entry.checks
  return JSON.stringify([entry.url, entry.number, checks?.total, checks?.pending, checks?.failed, checks?.passed])
}

function sameItems(a: readonly PrBandItem[], b: readonly PrBandItem[]): boolean {
  return a.length === b.length && a.every((item, index) => sameItem(item, b[index]))
}

function sameReminder(a: ReminderBandItem | undefined, b: ReminderBandItem | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.when === b.when && a.text === b.text && a.due === b.due)
}

/** A toast only opens what a browser should: the URL comes from the server. */
function openable(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function isTextPart(part: Part): part is Extract<Part, { type: "text" }> {
  return part.type === "text"
}

export function createPrTracker(deps: PrTrackerDeps): PrTracker {
  const [tick, setTick] = createSignal(0)
  // The state each watch had when it was last folded in: what an event is compared with.
  const committed = new Map<string, Committed>()
  const toasted = new Set<string>()
  // The assistant messages of each root as last seen while its history was loaded: the evidence of an answer that
  // outlives the history cache. Kept for the roots that still have watches or held warnings.
  const seen = new Map<string, readonly PrAssistant[]>()
  let armed: { readonly time: number; readonly cancel: () => void } | undefined

  // Getters: a root whose watches are all still `watching` reads neither its status nor a single message.
  function sessionOf(root: string): PrSession {
    return {
      get status() {
        return deps.data.session_status[root]?.type
      },
      get partial() {
        return !deps.data.hydrated.includes(root)
      },
      get assistants() {
        // Without the history, what was seen of it before: an answer there is still an answer.
        if (!deps.data.hydrated.includes(root)) return seen.get(root) ?? NO_ASSISTANTS
        const assistants: PrAssistant[] = []
        for (const message of deps.data.message[root] ?? []) {
          if (message.role !== "assistant") continue
          assistants.push({
            created: message.time.created,
            ...(message.time.completed !== undefined ? { completed: message.time.completed } : {}),
            error: message.error !== undefined,
          })
        }
        seen.set(root, assistants)
        return assistants
      },
    }
  }

  /**
   * The user's messages of the root and its watches: what clears a sticky warning. A notice is not the user: its
   * text parts are all synthetic. A message arrives before its parts, so one whose parts are not in the store yet is
   * left out until they are; read as a message with no text, it would pass for the user's and clear a warning for good.
   */
  function dismissContext(root: string, entries: Readonly<Record<string, PrWatchEntry>> | undefined): PrDismissContext {
    const userMessages: { created: number; synthetic: boolean }[] = []
    for (const message of deps.data.message[root] ?? []) {
      if (message.role !== "user") continue
      const parts = deps.data.part[message.id]
      if (parts === undefined) continue
      const texts = parts.filter(isTextPart)
      userMessages.push({
        created: message.time.created,
        synthetic: texts.length > 0 && texts.every((part) => part.synthetic === true),
      })
    }
    const watches = Object.values(entries ?? {}).map((entry) => ({
      watchID: entry.watchID,
      url: entry.url,
      startedAt: entry.startedAt,
    }))
    return { userMessages, watches }
  }

  const core = createMemo<Core>((prev) => {
    tick()
    const now = deps.ticker.now()
    const items = new Map<string, readonly PrBandItem[]>()
    const reminders = new Map<string, ReminderBandItem>()
    const states = new Map<string, WatchState>()
    const held = new Map<string, ReadonlyMap<string, Held>>()
    const wakes: number[] = []

    for (const root of new Set([...Object.keys(deps.data.pr_watch), ...prev.held.keys()])) {
      const entries = deps.data.pr_watch[root]
      const session = sessionOf(root)
      const before = prev.held.get(root)
      const keep = new Map<string, Held>()
      const shown: Row[] = []
      // Only a sticky warning reads the messages.
      let context: PrDismissContext | undefined
      const cleared = (alert: PrAlert) => prAlertDismissed(alert, (context ??= dismissContext(root, entries)))

      for (const entry of Object.values(entries ?? {})) {
        const state = prLineFacts(entry, session, now)
        states.set(entry.watchID, {
          root,
          url: entry.url,
          number: entry.number,
          state,
          noticeAt: prNoticeAt(entry),
          identity: identityOf(entry),
        })
        if (state.nextAt !== undefined) wakes.push(state.nextAt)
        if (state.hidden) continue
        const row = rowOf(entry, state)
        if (!state.sticky) {
          shown.push(row)
          continue
        }
        // The same warning keeps the time it was first seen; another kind of warning is a new one.
        const old = before?.get(entry.watchID)
        const same = old !== undefined && old.kind === state.kind
        const alert: PrAlert = same ? old.alert : { url: entry.url, since: now, watchID: entry.watchID }
        const dismissed = (same && old.dismissed) || cleared(alert)
        keep.set(entry.watchID, { alert, kind: state.kind, row, dismissed })
        if (!dismissed) shown.push(row)
      }

      // A warning whose entry is gone (the server dropped it, a read replaced the map) stays until the user acts.
      // An entry that is still there and no longer sticky has moved on: the hold ended with its state.
      for (const [watchID, old] of before ?? []) {
        if (entries?.[watchID] !== undefined || old.dismissed || cleared(old.alert)) continue
        keep.set(watchID, old)
        shown.push(old.row)
      }

      if (keep.size > 0) held.set(root, keep)
      if (shown.length > 0)
        items.set(
          root,
          shown.sort(byPriority).map((row) => row.item),
        )
    }

    for (const root of Object.keys(deps.data.reminder)) {
      const first = deps.data.reminder[root]?.[0]
      if (!first) continue
      const due = first.status === "due" || now >= first.fireAt
      reminders.set(root, {
        when: due ? undefined : formatReminderIn(first.fireAt - now),
        text: remoteLine(first.text),
        due,
      })
      const boundary = due ? undefined : reminderNextAt(first.fireAt, now)
      if (boundary !== undefined) wakes.push(boundary)
    }

    for (const root of seen.keys()) if (deps.data.pr_watch[root] === undefined && !held.has(root)) seen.delete(root)

    return { items, reminders, states, held, nextAt: wakes.length > 0 ? Math.min(...wakes) : undefined }
  }, EMPTY)

  // What a consumer reads is a memo per root with a structural `equals`: a change in another root, or a recompute
  // that draws the same thing (a reminder boundary of a session off screen), wakes nobody.
  const owner = getOwner()
  const itemViews = new Map<string, Accessor<readonly PrBandItem[]>>()
  const reminderViews = new Map<string, Accessor<ReminderBandItem | undefined>>()

  function itemsOf(root: string): Accessor<readonly PrBandItem[]> {
    let view = itemViews.get(root)
    if (!view) {
      const read = () => core().items.get(root) ?? NO_ITEMS
      view = runWithOwner(owner, () => createMemo(read, NO_ITEMS, { equals: sameItems })) ?? read
      itemViews.set(root, view)
    }
    return view
  }

  function reminderOf(root: string): Accessor<ReminderBandItem | undefined> {
    let view = reminderViews.get(root)
    if (!view) {
      const read = () => core().reminders.get(root)
      view = runWithOwner(owner, () => createMemo(read, undefined, { equals: sameReminder })) ?? read
      reminderViews.set(root, view)
    }
    return view
  }

  /**
   * `episode` is given for the warning of an unanswered notice: one watch says each thing once, except that a notice
   * owed for three minutes and then delivered and left unanswered for three more is two warnings, one per notice.
   * The toast's own key stays the same, so the footer still merges a repeat within ten seconds.
   */
  function announce(toast: PrToast | undefined, url: string, episode?: number) {
    if (!toast) return
    const said = episode === undefined ? toast.key : `${toast.key}@${episode}`
    if (toasted.has(said)) return
    toasted.add(said)
    if (toasted.size > TOASTED_MAX) {
      const oldest = toasted.values().next()
      if (!oldest.done) toasted.delete(oldest.value)
    }
    const open = deps.openUrl
    deps.toast.show({
      text: toast.text,
      level: toast.level,
      dedupeKey: toast.key,
      ...(open && openable(url) ? { onActivate: () => open(url) } : {}),
    })
  }

  /** The pending callback has run: evaluate again. What only the clock changed is said by the effect below. */
  function onClock() {
    armed = undefined
    setTick((count) => count + 1)
  }

  /**
   * Say what the clock alone did: the notice that was waiting for its three minutes, the same entry and the same
   * notice (`prNoticeAt`), is unresponsive now that its boundary has passed (`prClockMoved`). The callback is not the
   * only way to get here: it runs a little after the boundary, and a read or another watch's event that lands in
   * that gap evaluates the rows first. Nothing else is the clock's, and that read may bring anything: another entry,
   * another outcome, a delivery that stopped, a failed turn, other CI counts. Those are folded in silently, as every
   * read is; an event has its own listener. `committed` still holds the states from before this evaluation.
   */
  function announceClock(states: ReadonlyMap<string, WatchState>) {
    const now = deps.ticker.now()
    const root = deps.currentRoot()
    for (const [watchID, watch] of states) {
      const before = committed.get(watchID)
      if (before === undefined || watch.root !== root) continue
      if (before.noticeAt !== watch.noticeAt || before.identity !== watch.identity) continue
      if (!prClockMoved(before.state, watch.state, now)) continue
      announce(prToastFor(before.state, watch.state, { watchID, number: watch.number }), watch.url, watch.noticeAt)
    }
  }

  function arm(time: number | undefined) {
    if (armed?.time === time) return
    const previous = armed
    armed = undefined
    // The ticker reads its own signals (animations, focus) while it re-arms its timer; this effect is not theirs.
    if (previous) untrack(() => previous.cancel())
    if (time === undefined) return
    const cancel = untrack(() => deps.ticker.at(time, onClock))
    armed = { time, cancel }
  }

  // The one effect. It says what the clock did (`announceClock`), folds what the store holds into `committed` (reads
  // move states without a toast; the listener compared before this ran) and keeps the single pending `ticker.at` at
  // the earliest boundary. It writes no signal and no data store (a toast is all it shows); the route and the toast
  // store it reads are not its dependencies, so they are read untracked.
  createEffect(() => {
    tick()
    const current = core()
    untrack(() => {
      announceClock(current.states)
      committed.clear()
      for (const [watchID, watch] of current.states) committed.set(watchID, watch)
    })
    arm(current.nextAt)
  })

  const offEvents = deps.onPrWatchEvent((entry) => {
    // The store drops an event older than the entry it holds; so does this.
    const held = deps.data.pr_watch[entry.sessionID]?.[entry.watchID]
    if (held && held.updatedAt > entry.updatedAt) return
    const next = prLineFacts(entry, sessionOf(entry.sessionID), deps.ticker.now())
    const previous = committed.get(entry.watchID)?.state
    const noticeAt = prNoticeAt(entry)
    committed.set(entry.watchID, { state: next, noticeAt, identity: identityOf(entry) })
    // A watch of a root off screen is remembered, not announced: the line it feeds is not drawn.
    if (entry.sessionID !== deps.currentRoot()) return
    announce(prToastFor(previous, next, entry), entry.url, next.kind === "unresponsive" ? noticeAt : undefined)
  })

  onCleanup(() => {
    offEvents()
    const pending = armed
    armed = undefined
    if (pending) untrack(() => pending.cancel())
  })

  return {
    items: (root) => (root === undefined ? NO_ITEMS : itemsOf(root)()),
    reminder: (root) => (root === undefined ? undefined : reminderOf(root)()),
  }
}
