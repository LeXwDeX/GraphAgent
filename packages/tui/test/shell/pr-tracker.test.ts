// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Message, Part, PrWatchEntry, SessionReminder, SessionStatus } from "@graphagent/sdk"
import { batch, createEffect, createRoot } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { setLanguage } from "../../src/i18n"
import { reminderNextAt } from "../../src/pr/reminder"
import { PR_HANDLED_VISIBLE_MS, PR_UNRESPONSIVE_MS, prLineWords } from "../../src/pr/state"
import { createPrTracker } from "../../src/shell/pr-tracker"
import type { PrBandItem } from "../../src/shell/pr-tracker-context"
import { FooterToastProvider, useToast, type FooterToasts, type ToastOptions } from "../../src/ui/toast"

// The tracker is driven directly, with no app around it: a fake ticker that only has `at` and `now` (the tracker
// has no other clock to reach for, so a `second` or `frame` call would be a TypeError here), a fake toast, a fake
// event emitter and a Solid store standing in for `sync.data`. No test waits for a duration.

const T0 = 1_700_000_000_000
const SECOND = 1_000
const MINUTE = 60_000
const ROOT = "ses_root"
const OTHER = "ses_other"
const URL = "https://forge.test/acme/app/pull/7"

beforeEach(() => {
  setLanguage("en")
})

const disposers: Array<() => void> = []
const tickers: Array<{ readonly widest: number }> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  setLanguage("zh-CN")
  // Whatever a test did, the tracker never had two callbacks waiting at once.
  for (const clock of tickers.splice(0)) expect(clock.widest).toBeLessThanOrEqual(1)
})

function entry(over: Partial<PrWatchEntry> = {}): PrWatchEntry {
  return {
    sessionID: ROOT,
    watchID: "w1",
    url: URL,
    provider: "github",
    number: 7,
    phase: "watching",
    startedAt: T0 - MINUTE,
    updatedAt: T0,
    deadlineAt: T0 + 60 * MINUTE,
    ...over,
  }
}

/** A watch that ended in `success` and whose notice reached the session at `at`. */
function delivered(at: number, over: Partial<PrWatchEntry> = {}): PrWatchEntry {
  return entry({
    phase: "succeeded",
    outcome: "success",
    updatedAt: at,
    delivery: { state: "delivered", deliveredAt: at },
    ...over,
  })
}

function reminder(over: Partial<SessionReminder> = {}): SessionReminder {
  return {
    id: "rem_1",
    sessionID: ROOT,
    text: "check the deploy",
    fireAt: T0 + 5 * MINUTE + 30 * SECOND,
    everyMs: null,
    status: "scheduled",
    createdAt: T0,
    ...over,
  }
}

/** An assistant message; `failed` ends its turn in an error, `"aborted"` in the user's own stop (Esc). */
function assistant(id: string, created: number, completed?: number, failed: boolean | "aborted" = false): Message {
  const error =
    failed === "aborted"
      ? { name: "MessageAbortedError" as const, data: { message: "Aborted" } }
      : failed
        ? { name: "UnknownError" as const, data: { message: "failed" } }
        : undefined
  return {
    id,
    sessionID: ROOT,
    role: "assistant",
    time: { created, ...(completed !== undefined ? { completed } : {}) },
    ...(error ? { error } : {}),
    parentID: "msg_user",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/work", root: "/work" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function user(id: string, created: number): Message {
  return {
    id,
    sessionID: ROOT,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
  }
}

function text(id: string, messageID: string, synthetic?: boolean): Part {
  return {
    id,
    sessionID: ROOT,
    messageID,
    type: "text",
    text: "hello",
    ...(synthetic !== undefined ? { synthetic } : {}),
  }
}

interface TestData {
  pr_watch: Record<string, Record<string, PrWatchEntry>>
  reminder: Record<string, SessionReminder[]>
  session_status: Record<string, SessionStatus>
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  hydrated: string[]
}

/** The ticker the tracker gets (`at`, `now`) and the controls only the test has. */
function fakeTicker(start: number) {
  let current = start
  const pending = new Set<{ time: number; cb: () => void }>()
  let widest = 0
  function runDue() {
    for (const timer of [...pending].toSorted((a, b) => a.time - b.time)) {
      if (timer.time > current || !pending.delete(timer)) continue
      timer.cb()
    }
  }
  return {
    ticker: {
      now: () => current,
      at(time: number, cb: () => void) {
        const timer = { time, cb }
        pending.add(timer)
        widest = Math.max(widest, pending.size)
        return () => {
          pending.delete(timer)
        }
      },
    },
    /** The times of the callbacks waiting to run. */
    pending: () => [...pending].map((timer) => timer.time).toSorted((a, b) => a - b),
    /** The most callbacks that were ever waiting at once. */
    get widest() {
      return widest
    },
    /** The clock reaches `time`; what is due runs once, earliest first, like the real ticker's loop. */
    advanceTo(time: number) {
      current = time
      runDue()
    },
    /**
     * The clock passes `time` and no timer has run yet: a timer fires a little after its time (a busy frame, the
     * loop's own order), and whatever else runs in that gap reads a clock that is already past the boundary.
     */
    passTo(time: number) {
      current = time
    },
    /** The late timers run: everything due, earliest first. */
    runDue,
  }
}

function mount(options: { start?: number; toast?: (toast: ToastOptions) => void } = {}) {
  const clock = fakeTicker(options.start ?? T0)
  tickers.push(clock)
  const toasts: ToastOptions[] = []
  const listeners = new Set<(entry: PrWatchEntry) => void>()
  let current: string | undefined = ROOT
  const opened: string[] = []

  return createRoot((dispose) => {
    disposers.push(dispose)
    const [data, setData] = createStore<TestData>({
      pr_watch: {},
      reminder: {},
      session_status: {},
      message: {},
      part: {},
      hydrated: [ROOT],
    })
    const tracker = createPrTracker({
      data,
      ticker: clock.ticker,
      toast: {
        show: (toast) => {
          toasts.push(toast)
          options.toast?.(toast)
        },
      },
      onPrWatchEvent(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      currentRoot: () => current,
      openUrl: (url) => {
        opened.push(url)
      },
    })

    /** What the sync store does with an event: an entry older than the one held is dropped, the rest replace it. */
    function upsert(next: PrWatchEntry) {
      const map = data.pr_watch[next.sessionID]
      const held = map?.[next.watchID]
      if (held && held.updatedAt > next.updatedAt) return
      if (map) setData("pr_watch", next.sessionID, next.watchID, reconcile(next))
      else setData("pr_watch", next.sessionID, { [next.watchID]: next })
    }

    return {
      tracker,
      clock,
      toasts,
      opened,
      data,
      listeners: () => listeners.size,
      dispose,
      setCurrentRoot(root: string | undefined) {
        current = root
      },
      /**
       * A frame of events as the SDK dispatches it: one batch, the store's own handler first, then the subscribers.
       * The effect that folds the store into the tracker has not run when the listener does.
       */
      deliver(next: PrWatchEntry) {
        batch(() => {
          upsert(next)
          for (const listener of listeners) listener(next)
        })
      },
      /** A read (entry into a tree, a reconnect): the root's map is replaced, and no event runs. */
      replace(root: string, entries: PrWatchEntry[]) {
        const map = Object.fromEntries(entries.map((item) => [item.watchID, item]))
        if (data.pr_watch[root]) setData("pr_watch", root, reconcile(map))
        else setData("pr_watch", root, map)
      },
      setStatus(type: "idle" | "busy") {
        setData("session_status", ROOT, { type })
      },
      /** A message comes first; its parts arrive in later events (`setParts`). */
      addMessage(message: Message) {
        setData("message", ROOT, (list = []) => [...list, message])
      },
      /** A message as the server rewrites it when its turn ends (or is stopped): the same id with the new content. */
      updateMessage(message: Message) {
        setData("message", ROOT, (list = []) => list.map((held) => (held.id === message.id ? message : held)))
      },
      /** The history cache: an evicted root loses its messages and leaves `hydrated`. */
      evict(root = ROOT) {
        setData("hydrated", (list) => list.filter((id) => id !== root))
        setData("message", root, undefined!)
      },
      hydrate(root: string, messages: Message[]) {
        setData("message", root, messages)
        setData("hydrated", (list) => [root, ...list.filter((id) => id !== root)])
      },
      setParts(messageID: string, parts: Part[]) {
        setData("part", messageID, parts)
      },
      setReminders(root: string, list: SessionReminder[]) {
        if (data.reminder[root]) setData("reminder", root, reconcile(list))
        else setData("reminder", root, list)
      },
    }
  })
}

type Harness = ReturnType<typeof mount>

/** A user message with its parts, the way a snapshot delivers it. */
function say(h: Harness, id: string, created: number, ...parts: Part[]) {
  h.addMessage(user(id, created))
  h.setParts(id, parts)
}

function kinds(h: Harness, root = ROOT) {
  return h.tracker.items(root).map((item) => `${item.watchID}:${item.state.kind}`)
}

/** What the band says of a row, in the current language: the tracker lists facts and keeps no words. */
function said(item: PrBandItem) {
  return prLineWords(item.state, item.entry.checks).text
}

describe("pr tracker: rows", () => {
  test("a watching entry shows its CI counts and starts no timer", () => {
    const h = mount()
    h.replace(ROOT, [entry({ checks: { total: 6, pending: 2, failed: 0, passed: 4 } })])

    const [item, ...rest] = h.tracker.items(ROOT)
    expect(rest).toEqual([])
    expect(item.state.kind).toBe("watching")
    expect(said(item)).toBe("CI 4/6")
    expect(item.number).toBe(7)
    expect(item.url).toBe(URL)
    expect(item.entry).toEqual({ number: 7, checks: { total: 6, pending: 2, failed: 0, passed: 4 } })
    expect(h.clock.pending()).toEqual([])
    expect(h.toasts).toEqual([])
  })

  test("a root with nothing, an unknown root and no root show nothing", () => {
    const h = mount()
    h.replace(ROOT, [entry()])
    expect(h.tracker.items(OTHER)).toEqual([])
    expect(h.tracker.items(undefined)).toEqual([])
    expect(h.tracker.reminder(OTHER)).toBeUndefined()
    expect(h.tracker.reminder(undefined)).toBeUndefined()
  })

  test("a notice nobody answers turns unresponsive at exactly three minutes, once, by the one pending callback", () => {
    const h = mount()
    h.deliver(entry({ checks: { total: 6, pending: 2, failed: 0, passed: 4 } }))
    expect(kinds(h)).toEqual(["w1:watching"])
    expect(h.toasts).toEqual([])

    // The outcome is known; the notice is owed.
    h.clock.advanceTo(T0 + SECOND)
    h.deliver(
      entry({ phase: "delivering", outcome: "success", updatedAt: T0 + SECOND, delivery: { state: "pending" } }),
    )
    expect(kinds(h)).toEqual(["w1:awaiting"])
    expect(h.clock.pending()).toEqual([T0 + SECOND + PR_UNRESPONSIVE_MS])
    expect(h.toasts.map((toast) => toast.text)).toEqual(["PR #7 ✓ passed"])

    // Delivered: the callback moves to the new boundary, and there is still only one.
    h.clock.advanceTo(T0 + 2 * SECOND)
    h.deliver(delivered(T0 + 2 * SECOND))
    expect(kinds(h)).toEqual(["w1:notified"])
    expect(h.clock.pending()).toEqual([T0 + 2 * SECOND + PR_UNRESPONSIVE_MS])
    expect(h.toasts).toHaveLength(1)

    h.clock.advanceTo(T0 + 2 * SECOND + PR_UNRESPONSIVE_MS - 1)
    expect(kinds(h)).toEqual(["w1:notified"])
    expect(h.toasts).toHaveLength(1)

    h.clock.advanceTo(T0 + 2 * SECOND + PR_UNRESPONSIVE_MS)
    const [item] = h.tracker.items(ROOT)
    expect(item.state).toMatchObject({ kind: "unresponsive", sticky: true, tone: "warning" })
    expect(h.toasts).toHaveLength(2)
    expect(h.toasts[1]).toMatchObject({
      text: "PR #7 agent not responding",
      level: "warning",
      dedupeKey: "pr:w1:unresponsive",
    })
    // A warning has no boundary of its own: nothing is left to wake.
    expect(h.clock.pending()).toEqual([])
    expect(h.clock.widest).toBe(1)
  })

  test("a handled row is hidden a minute after the agent's last error-free turn ended", () => {
    const h = mount({ start: T0 + 30 * SECOND })
    say(h, "msg_u1", T0 + 2 * SECOND, text("prt_1", "msg_u1", true))
    h.addMessage(assistant("msg_a1", T0 + 5 * SECOND, T0 + 20 * SECOND))
    h.replace(ROOT, [delivered(T0)])

    expect(kinds(h)).toEqual(["w1:handled"])
    expect(h.clock.pending()).toEqual([T0 + 20 * SECOND + PR_HANDLED_VISIBLE_MS])

    h.clock.advanceTo(T0 + 20 * SECOND + PR_HANDLED_VISIBLE_MS - 1)
    expect(kinds(h)).toEqual(["w1:handled"])

    h.clock.advanceTo(T0 + 20 * SECOND + PR_HANDLED_VISIBLE_MS)
    expect(h.tracker.items(ROOT)).toEqual([])
    expect(h.clock.pending()).toEqual([])
    // The row going away is the clock's doing, and says nothing.
    expect(h.toasts).toEqual([])
  })

  test("a busy session is working; a notice that started no turn is a sticky warning", () => {
    const h = mount()
    h.setStatus("busy")
    h.replace(ROOT, [delivered(T0)])
    expect(kinds(h)).toEqual(["w1:working"])

    h.setStatus("idle")
    h.replace(ROOT, [delivered(T0, { delivery: { state: "delivered", deliveredAt: T0, noReply: true } })])
    const [item] = h.tracker.items(ROOT)
    expect(item.state).toMatchObject({ kind: "noReply", sticky: true, tone: "warning" })
  })

  test("sticky rows come first, then the newest watch", () => {
    const h = mount()
    h.replace(ROOT, [
      entry({ watchID: "old", number: 1, startedAt: T0 - 30 * MINUTE }),
      entry({ watchID: "new", number: 3, startedAt: T0 - MINUTE }),
      delivered(T0 - 10 * MINUTE, {
        watchID: "warn",
        number: 2,
        startedAt: T0 - 40 * MINUTE,
        delivery: { state: "delivered", deliveredAt: T0 - 10 * MINUTE, noReply: true },
      }),
    ])
    expect(kinds(h)).toEqual(["warn:noReply", "new:watching", "old:watching"])
  })

  test("a snapshot is judged at the time it appears: an old notice is unresponsive at once, without a word", () => {
    const h = mount({ start: T0 + 10 * MINUTE })
    h.replace(ROOT, [delivered(T0)])

    expect(kinds(h)).toEqual(["w1:unresponsive"])
    expect(h.clock.pending()).toEqual([])
    expect(h.toasts).toEqual([])
  })

  test("the rows are copies: a later write to the store does not move a row already handed out", () => {
    const h = mount()
    h.deliver(entry({ checks: { total: 6, pending: 2, failed: 0, passed: 4 } }))
    const [before] = h.tracker.items(ROOT)

    h.deliver(entry({ updatedAt: T0 + SECOND, checks: { total: 6, pending: 1, failed: 0, passed: 5 } }))
    expect(before.entry.checks?.passed).toBe(4)
    expect(said(h.tracker.items(ROOT)[0])).toBe("CI 5/6")
  })
})

// The user pressing Esc on the agent's turn is the user taking over, not a turn that failed (#1641): the row goes,
// with no warning, no toast and no callback left behind. The message ends in a stop and the session goes idle; the
// tests do not assume which of the two the client sees first.
describe("pr tracker: a turn the user stopped", () => {
  const stop = assistant("msg_a1", T0 + 2 * SECOND, T0 + 9 * SECOND, "aborted")

  /** The notice is delivered and the agent has started on it: the row says so, and no callback is pending. */
  function working() {
    const h = mount()
    h.deliver(delivered(T0))
    expect(kinds(h)).toEqual(["w1:notified"])
    expect(h.clock.pending()).toEqual([T0 + PR_UNRESPONSIVE_MS])

    h.clock.advanceTo(T0 + 5 * SECOND)
    h.setStatus("busy")
    h.addMessage(assistant("msg_a1", T0 + 2 * SECOND))
    expect(kinds(h)).toEqual(["w1:working"])
    expect(h.clock.pending()).toEqual([])
    return h
  }

  /** Nothing was said but the outcome the delivery brought. */
  const quiet = (h: Harness) => expect(h.toasts.map((toast) => toast.dedupeKey)).toEqual(["pr:w1:success"])

  test("busy, stopped, idle: the row goes, with no warning, no toast and no callback", () => {
    const h = working()
    h.clock.advanceTo(T0 + 9 * SECOND)
    h.updateMessage(stop)
    expect(kinds(h)).toEqual(["w1:working"])
    h.setStatus("idle")

    expect(h.tracker.items(ROOT)).toEqual([])
    expect(h.clock.pending()).toEqual([])
    quiet(h)
  })

  test("idle before the stop reaches the store: the row is never a warning, and goes once it does", () => {
    const h = working()
    h.clock.advanceTo(T0 + 9 * SECOND)
    h.setStatus("idle")
    // The message has no error yet, so for a moment it is an answer.
    expect(kinds(h)).toEqual(["w1:handled"])
    h.updateMessage(stop)

    expect(h.tracker.items(ROOT)).toEqual([])
    expect(h.clock.pending()).toEqual([])
    quiet(h)
  })

  test("the stop and a watch event in one frame do not toast a failed turn", () => {
    const h = working()
    h.clock.advanceTo(T0 + 9 * SECOND)
    // One frame: the store takes the events in, then the listener judges, then the effect folds the result in.
    batch(() => {
      h.updateMessage(stop)
      h.setStatus("idle")
      h.deliver(delivered(T0, { updatedAt: T0 + 9 * SECOND }))
    })

    quiet(h)
    expect(h.tracker.items(ROOT)).toEqual([])
    expect(h.clock.pending()).toEqual([])
  })

  test("a failed turn after the stop is a warning again", () => {
    const h = working()
    h.clock.advanceTo(T0 + 9 * SECOND)
    h.updateMessage(stop)
    h.setStatus("idle")
    expect(h.tracker.items(ROOT)).toEqual([])

    h.clock.advanceTo(T0 + 20 * SECOND)
    h.setStatus("busy")
    h.addMessage(assistant("msg_a2", T0 + 12 * SECOND))
    expect(kinds(h)).toEqual(["w1:working"])
    h.updateMessage(assistant("msg_a2", T0 + 12 * SECOND, T0 + 19 * SECOND, true))
    h.setStatus("idle")

    const [item] = h.tracker.items(ROOT)
    expect(item.state).toMatchObject({ kind: "turnError", sticky: true, tone: "warning" })
  })

  test("a stop seen before the history was evicted still counts after it", () => {
    const h = working()
    h.clock.advanceTo(T0 + 9 * SECOND)
    h.updateMessage(stop)
    h.setStatus("idle")
    expect(h.tracker.items(ROOT)).toEqual([])

    // Without the history only what was seen of it is left: the row stays away, and no three minutes start.
    h.evict()
    expect(h.tracker.items(ROOT)).toEqual([])
    expect(h.clock.pending()).toEqual([])
    quiet(h)
  })
})

describe("pr tracker: held warnings", () => {
  /** A warning first seen at `T0 + 200s`, three minutes after a notice nobody answered. */
  function warned() {
    const h = mount({ start: T0 + 200 * SECOND })
    h.replace(ROOT, [delivered(T0)])
    expect(kinds(h)).toEqual(["w1:unresponsive"])
    return h
  }

  test("a warning outlives its entry: a read that drops the watch does not clear it", () => {
    const h = warned()
    h.replace(ROOT, [])

    const [item] = h.tracker.items(ROOT)
    expect(item.watchID).toBe("w1")
    expect(item.number).toBe(7)
    expect(item.state).toMatchObject({ kind: "unresponsive", sticky: true })
  })

  test("a user message after the warning clears it", () => {
    const h = warned()
    h.replace(ROOT, [])
    say(h, "msg_u1", T0 + 200 * SECOND + 1, text("prt_1", "msg_u1", false))
    expect(h.tracker.items(ROOT)).toEqual([])
  })

  test("a user message from before the warning does not clear it", () => {
    const h = warned()
    h.replace(ROOT, [])
    say(h, "msg_u1", T0 + 100 * SECOND, text("prt_1", "msg_u1"))
    expect(kinds(h)).toEqual(["w1:unresponsive"])
  })

  test("a synthetic message is not the user: a notice or a hook leaves the warning on screen", () => {
    const h = warned()
    h.replace(ROOT, [])
    say(h, "msg_u1", T0 + 201 * SECOND, text("prt_1", "msg_u1", true), text("prt_2", "msg_u1", true))
    expect(kinds(h)).toEqual(["w1:unresponsive"])

    // One text of their own among the synthetic ones makes it theirs.
    say(h, "msg_u2", T0 + 202 * SECOND, text("prt_3", "msg_u2", true), text("prt_4", "msg_u2"))
    expect(h.tracker.items(ROOT)).toEqual([])
  })

  test("a message arrives before its parts: until they do it is not judged, and a notice never clears the warning", () => {
    const h = warned()
    h.replace(ROOT, [])
    h.addMessage(user("msg_u1", T0 + 201 * SECOND))
    expect(kinds(h)).toEqual(["w1:unresponsive"])

    h.setParts("msg_u1", [text("prt_1", "msg_u1", true)])
    expect(kinds(h)).toEqual(["w1:unresponsive"])

    h.addMessage(user("msg_u2", T0 + 202 * SECOND))
    h.setParts("msg_u2", [text("prt_2", "msg_u2")])
    expect(h.tracker.items(ROOT)).toEqual([])
  })

  test("a user message with no text part counts as the user's", () => {
    const h = warned()
    h.replace(ROOT, [])
    say(h, "msg_u1", T0 + 201 * SECOND)
    expect(h.tracker.items(ROOT)).toEqual([])
  })

  test("a newer watch on the same pull request clears it; one on another pull request does not", () => {
    const h = warned()
    h.replace(ROOT, [
      entry({ watchID: "w2", number: 8, url: "https://forge.test/acme/app/pull/8", startedAt: T0 + 201 * SECOND }),
    ])
    expect(kinds(h)).toEqual(["w1:unresponsive", "w2:watching"])

    h.replace(ROOT, [entry({ watchID: "w3", startedAt: T0 + 201 * SECOND })])
    expect(kinds(h)).toEqual(["w3:watching"])
  })

  test("a warning whose entry is still there is cleared the same way, and stays cleared", () => {
    const h = mount({ start: T0 + 200 * SECOND })
    const stopped = delivered(T0, { delivery: { state: "delivered", deliveredAt: T0, noReply: true } })
    h.replace(ROOT, [stopped])
    expect(kinds(h)).toEqual(["w1:noReply"])

    say(h, "msg_u1", T0 + 201 * SECOND, text("prt_1", "msg_u1"))
    expect(h.tracker.items(ROOT)).toEqual([])

    // The entry keeps saying noReply; the read that brings it again is not a new warning.
    h.replace(ROOT, [stopped])
    expect(h.tracker.items(ROOT)).toEqual([])
  })

  test("an entry that is back in another state ends the hold", () => {
    const h = warned()
    h.replace(ROOT, [])
    expect(kinds(h)).toEqual(["w1:unresponsive"])

    h.replace(ROOT, [entry()])
    expect(kinds(h)).toEqual(["w1:watching"])

    h.replace(ROOT, [])
    expect(h.tracker.items(ROOT)).toEqual([])
  })

  test("another kind of warning on the same watch is a new one, raised when it appears", () => {
    const h = mount({ start: T0 + 200 * SECOND })
    h.replace(ROOT, [delivered(T0)])
    say(h, "msg_u1", T0 + 201 * SECOND, text("prt_1", "msg_u1"))
    expect(h.tracker.items(ROOT)).toEqual([])

    // The agent picked the notice up and failed: its turn ended in an error. The earlier message predates this warning.
    h.clock.advanceTo(T0 + 210 * SECOND)
    h.addMessage(assistant("msg_a1", T0 + 205 * SECOND, T0 + 206 * SECOND, true))
    expect(kinds(h)).toEqual(["w1:turnError"])

    say(h, "msg_u2", T0 + 211 * SECOND, text("prt_2", "msg_u2"))
    expect(h.tracker.items(ROOT)).toEqual([])
  })

  test("a held warning of another root waits for its root", () => {
    const h = mount({ start: T0 + 200 * SECOND })
    h.hydrate(OTHER, [])
    h.replace(OTHER, [delivered(T0, { sessionID: OTHER, watchID: "w9" })])
    h.replace(OTHER, [])
    expect(kinds(h, OTHER)).toEqual(["w9:unresponsive"])
    expect(h.tracker.items(ROOT)).toEqual([])
  })
})

// The tracker keeps and compares facts and never a word (#1409): a warning it holds after the server dropped its entry
// is worded by the band each time it draws, so it follows the language, and a switch is not an event for the tracker.
describe("pr tracker: language", () => {
  /** A warning first seen at `T0 + 200s` whose entry is then gone: only the tracker's held copy is on screen. */
  function held() {
    const h = mount({ start: T0 + 200 * SECOND })
    h.replace(ROOT, [delivered(T0)])
    h.replace(ROOT, [])
    expect(kinds(h)).toEqual(["w1:unresponsive"])
    return h
  }

  test("a held row is facts and the PR's own numbers; it keeps no word", () => {
    const h = held()
    const [item] = h.tracker.items(ROOT)
    expect(item.state).toEqual({
      kind: "unresponsive",
      outcome: "success",
      tone: "warning",
      sticky: true,
      hidden: false,
    })
    expect(item).toMatchObject({ watchID: "w1", number: 7, url: URL, entry: { number: 7 } })
    // The band words it, and says it in the language it has at that moment.
    expect(said(item)).toBe("✓ passed · agent not responding")
    setLanguage("zh-CN")
    expect(said(item)).toBe("✓ 通过 · agent 未响应")
  })

  test("a switch changes nothing the tracker lists or does: the same rows, no reader woken, no toast, no timer", () => {
    const h = held()
    let runs = 0
    createRoot((dispose) => {
      disposers.push(dispose)
      createEffect(() => {
        h.tracker.items(ROOT)
        runs++
      })
    })
    const before = h.tracker.items(ROOT)
    const timers = h.clock.pending()
    expect(runs).toBe(1)

    for (const language of ["zh-CN", "en", "zh-CN"] as const) {
      setLanguage(language)
      expect(h.tracker.items(ROOT)).toBe(before)
    }
    expect(runs).toBe(1)
    expect(h.toasts).toEqual([])
    expect(h.clock.pending()).toEqual(timers)
  })

  test("a switch does not move the hold: only the user clears the warning, and a cleared one stays cleared", () => {
    const h = held()
    setLanguage("zh-CN")
    say(h, "msg_u1", T0 + 201 * SECOND, text("prt_1", "msg_u1", true))
    expect(kinds(h)).toEqual(["w1:unresponsive"])

    setLanguage("en")
    say(h, "msg_u2", T0 + 202 * SECOND, text("prt_2", "msg_u2"))
    expect(h.tracker.items(ROOT)).toEqual([])

    setLanguage("zh-CN")
    expect(h.tracker.items(ROOT)).toEqual([])
    setLanguage("en")
    expect(h.tracker.items(ROOT)).toEqual([])
  })

  test("a warning cleared while its entry is still there stays cleared when the switch and the same entry come again", () => {
    const h = mount({ start: T0 + 200 * SECOND })
    const stopped = delivered(T0, { delivery: { state: "delivered", deliveredAt: T0, noReply: true } })
    h.replace(ROOT, [stopped])
    say(h, "msg_u1", T0 + 201 * SECOND, text("prt_1", "msg_u1"))
    expect(h.tracker.items(ROOT)).toEqual([])

    setLanguage("zh-CN")
    h.replace(ROOT, [stopped])
    expect(h.tracker.items(ROOT)).toEqual([])
    expect(h.toasts).toEqual([])
  })

  test("a switch is not a transition: the next outcome and the clock's warning each toast once, in the language of that moment", () => {
    const h = mount()
    h.deliver(entry())
    setLanguage("zh-CN")
    expect(h.toasts).toEqual([])

    h.clock.advanceTo(T0 + SECOND)
    h.deliver(delivered(T0 + SECOND))
    expect(h.toasts.map((toast) => toast.text)).toEqual(["PR #7 ✓ 通过"])

    setLanguage("en")
    expect(h.toasts).toHaveLength(1)
    h.clock.advanceTo(T0 + SECOND + PR_UNRESPONSIVE_MS)
    expect(h.toasts.map((toast) => toast.text)).toEqual(["PR #7 ✓ 通过", "PR #7 agent not responding"])
    expect(h.toasts[1]).toMatchObject({ level: "warning", dedupeKey: "pr:w1:unresponsive" })
  })
})

describe("pr tracker: toasts", () => {
  const done = () => delivered(T0 + SECOND)

  test("an event's outcome toasts once, and the same event again does not", () => {
    const h = mount()
    h.deliver(entry())
    expect(h.toasts).toEqual([])

    h.clock.advanceTo(T0 + SECOND)
    h.deliver(done())
    expect(h.toasts).toEqual([
      { text: "PR #7 ✓ passed", level: "success", dedupeKey: "pr:w1:success", onActivate: expect.any(Function) },
    ])

    h.deliver(done())
    h.deliver(done())
    expect(h.toasts).toHaveLength(1)
  })

  test("a watch a read dropped and a late event brings back does not say its outcome twice", () => {
    const h = mount()
    h.clock.advanceTo(T0 + SECOND)
    h.deliver(done())
    expect(h.toasts).toHaveLength(1)

    // A read: the watch ended for good and the map is replaced. A redelivered event then finds nothing known of it.
    h.replace(ROOT, [])
    h.deliver(done())
    expect(kinds(h)).toEqual(["w1:notified"])
    expect(h.toasts).toHaveLength(1)
  })

  test("a read with a new outcome is silent, and so is the identical event after it", () => {
    const h = mount()
    h.deliver(entry())

    // A reconnect read: the map is replaced and no event runs.
    h.clock.advanceTo(T0 + SECOND)
    h.replace(ROOT, [done()])
    expect(kinds(h)).toEqual(["w1:notified"])
    expect(h.toasts).toEqual([])

    h.deliver(done())
    expect(h.toasts).toEqual([])
  })

  test("the first read of a tree is silent too, whatever it holds", () => {
    const h = mount({ start: T0 + 10 * MINUTE })
    h.replace(ROOT, [delivered(T0), entry({ watchID: "w2", phase: "failed", outcome: "failure", updatedAt: T0 })])
    expect(h.toasts).toEqual([])
  })

  test("an event for another root is not announced, and not announced later either", () => {
    const h = mount()
    const other = delivered(T0 + SECOND, { sessionID: OTHER, watchID: "w9", number: 9 })
    h.deliver(entry({ sessionID: OTHER, watchID: "w9", number: 9 }))
    h.clock.advanceTo(T0 + SECOND)
    h.deliver(other)
    expect(h.toasts).toEqual([])
    expect(kinds(h, OTHER)).toEqual(["w9:notified"])

    h.setCurrentRoot(OTHER)
    h.deliver(other)
    expect(h.toasts).toEqual([])
  })

  test("no route, no toast", () => {
    const h = mount()
    h.setCurrentRoot(undefined)
    h.deliver(entry())
    h.deliver(done())
    expect(h.toasts).toEqual([])
  })

  test("a cancelled watch is removed and never toasts", () => {
    const h = mount()
    h.deliver(entry())
    expect(kinds(h)).toEqual(["w1:watching"])

    h.clock.advanceTo(T0 + SECOND)
    h.deliver(entry({ phase: "cancelled", updatedAt: T0 + SECOND }))
    expect(h.tracker.items(ROOT)).toEqual([])
    expect(h.toasts).toEqual([])
  })

  test("an event older than the entry the store holds is ignored", () => {
    const h = mount()
    h.clock.advanceTo(T0 + SECOND)
    h.deliver(done())
    expect(h.toasts).toHaveLength(1)

    // It arrives late: the store drops it, and so does the tracker.
    h.deliver(entry({ updatedAt: T0 }))
    expect(kinds(h)).toEqual(["w1:notified"])
    expect(h.toasts).toHaveLength(1)
  })

  test("a warning an event brings toasts at once, as a warning", () => {
    const h = mount({ start: T0 + 10 * MINUTE })
    h.deliver(
      delivered(T0 + 9 * MINUTE, { delivery: { state: "delivered", deliveredAt: T0 + 9 * MINUTE, noReply: true } }),
    )
    expect(h.toasts.map((toast) => [toast.level, toast.dedupeKey])).toEqual([["warning", "pr:w1:noReply"]])
  })

  test("a click on the toast opens the pull request, but only a web address", () => {
    const h = mount()
    h.clock.advanceTo(T0 + SECOND)
    h.deliver(done())
    h.toasts[0].onActivate?.()
    expect(h.opened).toEqual([URL])

    h.deliver(delivered(T0 + SECOND, { watchID: "w2", url: "file:///etc/hosts" }))
    expect(h.toasts).toHaveLength(2)
    expect(h.toasts[1].onActivate).toBeUndefined()
  })

  test("without a way to open a URL a toast has no click", () => {
    const clock = fakeTicker(T0)
    tickers.push(clock)
    const toasts: ToastOptions[] = []
    createRoot((dispose) => {
      disposers.push(dispose)
      const [data] = createStore<TestData>({
        pr_watch: { [ROOT]: { w1: delivered(T0) } },
        reminder: {},
        session_status: {},
        message: {},
        part: {},
        hydrated: [ROOT],
      })
      let listener: ((entry: PrWatchEntry) => void) | undefined
      createPrTracker({
        data,
        ticker: clock.ticker,
        toast: { show: (toast) => toasts.push(toast) },
        onPrWatchEvent: (next) => {
          listener = next
          return () => {}
        },
        currentRoot: () => ROOT,
      })
      listener?.(entry({ watchID: "w1", phase: "failed", outcome: "failure", updatedAt: T0 + SECOND }))
    })
    expect(toasts).toHaveLength(1)
    expect(toasts[0].onActivate).toBeUndefined()
  })
})

// The warning for a notice nobody answers comes from the clock alone, from one callback at the boundary (#1410). A
// callback is a timer: it runs a little after the boundary, and whatever else reads the rows in that gap already sees
// the state after it. Whoever sees it first has to say it, or nobody does.
describe("pr tracker: the unresponsive warning around its boundary", () => {
  const BOUNDARY = T0 + PR_UNRESPONSIVE_MS
  const unresponsive = (h: Harness) => h.toasts.filter((toast) => toast.dedupeKey === "pr:w1:unresponsive")
  /** A watch of the same session, for the events and reads that are not about the notice. */
  const other = (over: Partial<PrWatchEntry> = {}) =>
    entry({ watchID: "w2", number: 8, url: "https://forge.test/acme/app/pull/8", updatedAt: BOUNDARY, ...over })

  /** A notice delivered at `T0` and not answered: the one pending callback waits for three minutes on. */
  function waiting() {
    const h = mount()
    h.deliver(delivered(T0))
    expect(kinds(h)).toEqual(["w1:notified"])
    expect(h.clock.pending()).toEqual([BOUNDARY])
    return h
  }

  test("the callback at the boundary toasts it once", () => {
    const h = waiting()
    h.clock.advanceTo(BOUNDARY)
    expect(unresponsive(h)).toHaveLength(1)
    expect(h.clock.pending()).toEqual([])
  })

  test("an event of another PR in the gap between the boundary and the late callback does not swallow it", () => {
    const h = waiting()
    h.clock.passTo(BOUNDARY)
    h.deliver(other({ checks: { total: 2, pending: 1, failed: 0, passed: 1 } }))
    expect(kinds(h)).toEqual(["w1:unresponsive", "w2:watching"])
    h.clock.runDue()
    expect(unresponsive(h)).toHaveLength(1)
    expect(unresponsive(h)[0]).toMatchObject({ text: "PR #7 agent not responding", level: "warning" })
    expect(h.clock.pending()).toEqual([])
    expect(h.clock.widest).toBe(1)
  })

  test("a change of the session's status in that gap does not swallow it", () => {
    const h = waiting()
    h.clock.passTo(BOUNDARY)
    h.setStatus("idle")
    expect(kinds(h)).toEqual(["w1:unresponsive"])
    h.clock.runDue()
    expect(unresponsive(h)).toHaveLength(1)
  })

  test("a read of another tree in that gap does not swallow it", () => {
    const h = waiting()
    h.clock.passTo(BOUNDARY)
    h.replace(OTHER, [entry({ sessionID: OTHER, watchID: "w9", number: 9 })])
    h.clock.runDue()
    expect(unresponsive(h)).toHaveLength(1)
  })

  test("an event of the same watch in that gap toasts it once, and the late callback adds nothing", () => {
    const h = waiting()
    h.clock.passTo(BOUNDARY)
    h.deliver(delivered(T0, { updatedAt: BOUNDARY }))
    expect(unresponsive(h)).toHaveLength(1)
    h.clock.runDue()
    expect(unresponsive(h)).toHaveLength(1)
  })

  test("an event and the callback in one frame toast it once, whichever runs first", () => {
    for (const eventFirst of [true, false]) {
      const h = waiting()
      h.clock.passTo(BOUNDARY)
      batch(() => {
        if (eventFirst) h.deliver(other())
        h.clock.runDue()
        if (!eventFirst) h.deliver(other())
      })
      expect(unresponsive(h), `event first: ${eventFirst}`).toHaveLength(1)
      expect(h.clock.pending()).toEqual([])
    }
  })

  test("two notices that cross the boundary together toast once each", () => {
    const h = mount()
    h.deliver(delivered(T0))
    h.deliver(delivered(T0, { watchID: "w2", number: 8, url: "https://forge.test/acme/app/pull/8" }))
    h.clock.passTo(BOUNDARY)
    h.setStatus("idle")
    h.clock.runDue()
    expect(h.toasts.map((toast) => toast.dedupeKey).filter((key) => key?.endsWith(":unresponsive"))).toEqual([
      "pr:w1:unresponsive",
      "pr:w2:unresponsive",
    ])
  })

  test("a reconnect read that lands after the boundary of a known notice lets the clock say it, once", () => {
    const h = mount()
    h.replace(ROOT, [delivered(T0)])
    expect(h.clock.pending()).toEqual([BOUNDARY])
    h.clock.passTo(BOUNDARY + MINUTE)
    // The read itself says nothing new; the boundary it came after is the clock's, and that is what is announced.
    h.replace(ROOT, [delivered(T0, { updatedAt: T0 + 1 })])
    h.clock.runDue()
    expect(unresponsive(h)).toHaveLength(1)
  })

  // A read that lands after the boundary may bring anything. Only the clock's own move of the very notice that was
  // waiting is announced; whatever else the read changed is folded in without a word, like every read (F6 2.4).
  const owedEntry = (over: Partial<PrWatchEntry> = {}) =>
    entry({ phase: "delivering", outcome: "success", updatedAt: T0, delivery: { state: "pending" }, ...over })

  /** A tree read with a notice owed since `T0`, and the clock past its boundary before the callback has run. */
  function owedAndLate(over: Partial<PrWatchEntry> = {}) {
    const h = mount()
    h.replace(ROOT, [owedEntry(over)])
    expect(kinds(h)).toEqual(["w1:awaiting"])
    expect(h.clock.pending()).toEqual([BOUNDARY])
    h.clock.passTo(BOUNDARY)
    return h
  }

  test("a reconnect read after the boundary that replaces the entry with a stopped delivery says nothing", () => {
    const h = owedAndLate()
    h.replace(ROOT, [
      delivered(T0, { delivery: { state: "delivered", deliveredAt: BOUNDARY - SECOND, noReply: true } }),
    ])
    h.clock.runDue()
    expect(kinds(h)).toEqual(["w1:noReply"])
    expect(h.toasts).toEqual([])
  })

  test("a reconnect read after the boundary that brings another outcome says nothing", () => {
    const h = owedAndLate()
    h.replace(ROOT, [owedEntry({ outcome: "failure" })])
    h.clock.runDue()
    expect(kinds(h)).toEqual(["w1:unresponsive"])
    expect(h.toasts).toEqual([])
  })

  test("a reconnect read after the boundary that brings other CI counts says nothing", () => {
    const h = owedAndLate({ checks: { total: 6, pending: 2, failed: 0, passed: 4 } })
    h.replace(ROOT, [owedEntry({ checks: { total: 6, pending: 0, failed: 0, passed: 6 } })])
    h.clock.runDue()
    expect(kinds(h)).toEqual(["w1:unresponsive"])
    expect(h.toasts).toEqual([])
  })

  test("a reconnect read after the boundary that brings an older notice says nothing: it is another notice, not time", () => {
    const h = mount()
    // Delivered a minute in: its three minutes end at `T0 + 4m`.
    h.replace(ROOT, [delivered(T0 + MINUTE)])
    expect(h.clock.pending()).toEqual([T0 + 4 * MINUTE])
    h.clock.passTo(T0 + 4 * MINUTE)
    // The read says it was delivered at `T0`: those three minutes ended a minute ago.
    h.replace(ROOT, [delivered(T0)])
    h.clock.runDue()
    expect(kinds(h)).toEqual(["w1:unresponsive"])
    expect(h.toasts).toEqual([])
  })

  test("a failed turn that arrives after the boundary is not the clock either", () => {
    const h = mount()
    h.replace(ROOT, [delivered(T0)])
    expect(kinds(h)).toEqual(["w1:notified"])
    h.clock.passTo(BOUNDARY)
    h.addMessage(assistant("msg_a", T0 + SECOND, T0 + 2 * SECOND, true))
    h.clock.runDue()
    expect(kinds(h)).toEqual(["w1:turnError"])
    expect(h.toasts).toEqual([])
  })

  test("a reconnect read that only refreshes an owed notice after the boundary lets the clock say it, once", () => {
    const h = owedAndLate()
    // Nothing the line or its identity reads changes: the same notice, the same outcome, the same counts.
    h.replace(ROOT, [owedEntry({ startedAt: T0 - 2 * MINUTE })])
    expect(unresponsive(h)).toHaveLength(1)
    h.clock.runDue()
    expect(unresponsive(h)).toHaveLength(1)
    expect(h.toasts).toHaveLength(1)
  })

  test("a read that brings a notice in already unresponsive stays silent, whatever the clock says", () => {
    const h = mount({ start: BOUNDARY + MINUTE })
    h.replace(ROOT, [delivered(T0)])
    h.replace(OTHER, [entry({ sessionID: OTHER, watchID: "w9", number: 9 })])
    h.clock.runDue()
    expect(kinds(h)).toEqual(["w1:unresponsive"])
    expect(h.toasts).toEqual([])
  })

  test("a notice owed for three minutes and then delivered and left unanswered for three more is two warnings, once each", () => {
    const h = mount()
    h.deliver(entry())
    h.clock.advanceTo(T0 + SECOND)
    h.deliver(
      entry({ phase: "delivering", outcome: "success", updatedAt: T0 + SECOND, delivery: { state: "pending" } }),
    )
    h.clock.advanceTo(T0 + SECOND + PR_UNRESPONSIVE_MS)
    expect(unresponsive(h)).toHaveLength(1)

    const delivery = T0 + 4 * MINUTE
    h.clock.advanceTo(delivery)
    h.deliver(delivered(delivery))
    expect(kinds(h)).toEqual(["w1:notified"])
    h.clock.advanceTo(delivery + PR_UNRESPONSIVE_MS - 1)
    expect(unresponsive(h)).toHaveLength(1)
    h.clock.advanceTo(delivery + PR_UNRESPONSIVE_MS)
    expect(unresponsive(h)).toHaveLength(2)
    expect(kinds(h)).toEqual(["w1:unresponsive"])

    // The same warning again (a late event, a redelivery) is not a third.
    h.deliver(delivered(delivery, { updatedAt: delivery + 1 }))
    h.clock.advanceTo(delivery + 2 * PR_UNRESPONSIVE_MS)
    expect(unresponsive(h)).toHaveLength(2)
  })

  test("the same warning brought back by a late event after a read dropped the watch is not said twice", () => {
    const h = mount({ start: BOUNDARY })
    h.deliver(delivered(T0))
    expect(unresponsive(h)).toHaveLength(1)
    h.replace(ROOT, [])
    h.deliver(delivered(T0, { updatedAt: T0 + 1 }))
    expect(unresponsive(h)).toHaveLength(1)
  })

  test("a boundary passed while another root is on screen is not announced, then or when the user comes back", () => {
    const h = waiting()
    h.setCurrentRoot(OTHER)
    h.clock.advanceTo(BOUNDARY)
    expect(kinds(h)).toEqual(["w1:unresponsive"])
    h.setCurrentRoot(ROOT)
    h.deliver(other())
    h.clock.advanceTo(BOUNDARY + MINUTE)
    expect(unresponsive(h)).toEqual([])
  })
})

// The real footer store behind the tracker, on the same clock (#1410): the toasts a watch raises do not merge into one
// another, because a merge needs the same key and every transition has its own.
describe("pr tracker: the warning in the footer's toast store", () => {
  const BOUNDARY = T0 + PR_UNRESPONSIVE_MS
  let clock: { mockRestore(): void } | undefined

  afterEach(() => {
    clock?.mockRestore()
    clock = undefined
  })

  function footer(): FooterToasts {
    let store: FooterToasts | undefined
    createRoot((dispose) => {
      disposers.push(dispose)
      FooterToastProvider({
        get children() {
          store = useToast()
          return undefined
        },
      })
    })
    if (!store) throw new Error("the toast store was not created")
    return store
  }

  /** The tracker over the real store, with the store's own clock (`Date.now`, its ten-second window) on the test's. */
  function wired() {
    const store = footer()
    const h = mount({ toast: (toast) => store.show(toast) })
    clock = spyOn(Date, "now").mockImplementation(() => h.clock.ticker.now())
    return { h, store }
  }

  test("an outcome that changes five seconds before the boundary shows next to the warning, not in its place", () => {
    const { h, store } = wired()
    h.deliver(delivered(T0))
    // The toast of the first outcome has been shown and taken down by the footer's timer.
    store.dismiss()
    h.clock.advanceTo(BOUNDARY - 5 * SECOND)
    h.deliver(delivered(T0, { outcome: "review", updatedAt: BOUNDARY - 5 * SECOND }))
    expect(store.currentToast).toMatchObject({ dedupeKey: "pr:w1:review", level: "info" })

    h.clock.advanceTo(BOUNDARY)
    expect(store.currentToast?.dedupeKey).toBe("pr:w1:review")
    expect(store.queued.map((toast) => [toast.dedupeKey, toast.level])).toEqual([["pr:w1:unresponsive", "warning"]])

    // The footer's timer takes the first one down; the warning is next, whole.
    store.dismiss()
    expect(store.currentToast).toMatchObject({ dedupeKey: "pr:w1:unresponsive", text: "PR #7 agent not responding" })
  })

  test("the warning behind other toasts of the same watch keeps its place in the queue", () => {
    const { h, store } = wired()
    h.deliver(entry())
    h.clock.advanceTo(T0 + SECOND)
    h.deliver(delivered(T0 + SECOND))
    store.show({ text: "something else", level: "info", dedupeKey: "other.1" })
    store.show({ text: "something more", level: "info", dedupeKey: "other.2" })
    h.clock.advanceTo(T0 + SECOND + PR_UNRESPONSIVE_MS)
    expect(store.currentToast?.dedupeKey).toBe("pr:w1:success")
    expect(store.queued.map((toast) => toast.dedupeKey)).toEqual(["other.1", "other.2", "pr:w1:unresponsive"])
  })
})

describe("pr tracker: reminders", () => {
  test("the nearest reminder counts down by the minute, with one callback per step", () => {
    const h = mount()
    const fireAt = T0 + 5 * MINUTE + 30 * SECOND
    h.setReminders(ROOT, [reminder({ fireAt }), reminder({ id: "rem_2", fireAt: fireAt + MINUTE, text: "later" })])

    expect(h.tracker.reminder(ROOT)).toEqual({ when: "5m", text: "check the deploy", due: false })
    expect(h.clock.pending()).toEqual([T0 + 30 * SECOND + 1])
    expect(h.clock.pending()).toEqual([reminderNextAt(fireAt, T0)!])

    h.clock.advanceTo(T0 + 30 * SECOND + 1)
    expect(h.tracker.reminder(ROOT)?.when).toBe("4m")
    expect(h.clock.pending()).toEqual([T0 + 90 * SECOND + 1])

    // In the last minute the text stays `<1m`; the next change is the reminder itself.
    h.clock.advanceTo(fireAt - 59 * SECOND)
    expect(h.tracker.reminder(ROOT)?.when).toBe("<1m")
    expect(h.clock.pending()).toEqual([fireAt])

    h.clock.advanceTo(fireAt)
    expect(h.tracker.reminder(ROOT)).toEqual({ when: undefined, text: "check the deploy", due: true })
    expect(h.clock.pending()).toEqual([])
    expect(h.clock.widest).toBe(1)
  })

  test("a reminder the server calls due is due at once, with no callback", () => {
    const h = mount()
    h.setReminders(ROOT, [reminder({ status: "due", fireAt: T0 + 10 * MINUTE })])
    expect(h.tracker.reminder(ROOT)).toEqual({ when: undefined, text: "check the deploy", due: true })
    expect(h.clock.pending()).toEqual([])
  })

  test("a reminder removed from the store goes away with its callback", () => {
    const h = mount()
    h.setReminders(ROOT, [reminder()])
    expect(h.clock.pending()).toHaveLength(1)

    h.setReminders(ROOT, [])
    expect(h.tracker.reminder(ROOT)).toBeUndefined()
    expect(h.clock.pending()).toEqual([])
  })

  test("the text passes through remoteLine", () => {
    const h = mount()
    h.setReminders(ROOT, [reminder({ text: "ship\u001b[31m it\nnow\u0007" })])
    expect(h.tracker.reminder(ROOT)?.text).toBe("ship it now")
  })
})

describe("pr tracker: one clock", () => {
  test("one callback at the earliest boundary of the rows and the reminders, moved as they change", () => {
    const h = mount()
    h.clock.advanceTo(T0 + 10 * SECOND)
    h.replace(ROOT, [delivered(T0 + 5 * SECOND), delivered(T0 + 8 * SECOND, { watchID: "w2", number: 8 })])
    h.setReminders(ROOT, [reminder({ fireAt: T0 + 10 * SECOND + 20 * SECOND })])

    // The reminder is due at 30 s, before either notice has waited three minutes.
    expect(h.clock.pending()).toEqual([T0 + 30 * SECOND])

    h.clock.advanceTo(T0 + 30 * SECOND)
    expect(h.tracker.reminder(ROOT)?.due).toBe(true)
    expect(h.clock.pending()).toEqual([T0 + 5 * SECOND + PR_UNRESPONSIVE_MS])

    h.clock.advanceTo(T0 + 5 * SECOND + PR_UNRESPONSIVE_MS)
    expect(kinds(h)).toEqual(["w1:unresponsive", "w2:notified"])
    expect(h.clock.pending()).toEqual([T0 + 8 * SECOND + PR_UNRESPONSIVE_MS])

    h.clock.advanceTo(T0 + 8 * SECOND + PR_UNRESPONSIVE_MS)
    expect(kinds(h)).toEqual(["w1:unresponsive", "w2:unresponsive"])
    expect(h.clock.pending()).toEqual([])
    expect(h.clock.widest).toBe(1)
  })

  test("a row that was rewritten before its boundary does not leave the old callback behind", () => {
    const h = mount()
    h.deliver(delivered(T0))
    expect(h.clock.pending()).toEqual([T0 + PR_UNRESPONSIVE_MS])

    h.setStatus("busy")
    expect(kinds(h)).toEqual(["w1:working"])
    expect(h.clock.pending()).toEqual([])
    expect(h.clock.widest).toBe(1)
  })

  test("a change in another root does not wake a reader of this one", () => {
    const h = mount()
    h.replace(ROOT, [entry()])
    let runs = 0
    createRoot((dispose) => {
      disposers.push(dispose)
      createEffect(() => {
        h.tracker.items(ROOT)
        h.tracker.reminder(ROOT)
        runs++
      })
    })
    expect(runs).toBe(1)

    h.replace(OTHER, [entry({ sessionID: OTHER, watchID: "w9" })])
    h.setReminders(OTHER, [reminder({ sessionID: OTHER })])
    expect(runs).toBe(1)

    // The boundary of the other root's reminder moves a callback; this root still draws the same.
    h.clock.advanceTo(T0 + 30 * SECOND + 1)
    expect(h.tracker.reminder(OTHER)?.when).toBe("4m")
    expect(runs).toBe(1)

    h.deliver(entry({ updatedAt: T0 + SECOND, checks: { total: 2, pending: 1, failed: 0, passed: 1 } }))
    expect(runs).toBe(2)
  })

  test("cleanup cancels the pending callback and stops listening", () => {
    const h = mount()
    h.deliver(delivered(T0))
    h.setReminders(ROOT, [reminder()])
    expect(h.clock.pending()).toHaveLength(1)
    expect(h.listeners()).toBe(1)

    h.dispose()
    expect(h.clock.pending()).toEqual([])
    expect(h.listeners()).toBe(0)
  })
})

describe("pr tracker: a root whose history is not loaded", () => {
  test("a notice is not called unresponsive while the history is absent; loading it judges the notice", () => {
    const h = mount()
    h.evict()
    h.deliver(delivered(T0))
    expect(kinds(h)).toEqual(["w1:notified"])
    // No three-minute clock without the history.
    expect(h.clock.pending()).toEqual([])
    h.clock.advanceTo(T0 + 4 * MINUTE)
    expect(kinds(h)).toEqual(["w1:notified"])
    expect(h.toasts.map((toast) => toast.dedupeKey)).toEqual(["pr:w1:success"])

    // The history shows the notice was answered.
    h.hydrate(ROOT, [assistant("msg_a", T0 + SECOND, T0 + 2 * SECOND)])
    expect(kinds(h)).toEqual([])
  })

  test("the history arriving without an answer turns an old notice unresponsive", () => {
    const h = mount()
    h.evict()
    h.deliver(delivered(T0))
    h.clock.advanceTo(T0 + 4 * MINUTE)
    h.hydrate(ROOT, [])
    expect(kinds(h)).toEqual(["w1:unresponsive"])
  })

  test("an answer seen before the history was evicted still counts after it", () => {
    const h = mount()
    h.deliver(delivered(T0))
    h.addMessage(assistant("msg_a", T0 + SECOND, T0 + 2 * SECOND))
    expect(kinds(h)).toEqual(["w1:handled"])
    h.evict()
    h.clock.advanceTo(T0 + 5 * MINUTE)
    expect(kinds(h)).toEqual([])
    // A reconnect that drops the watch leaves no warning behind.
    h.replace(ROOT, [])
    h.hydrate(ROOT, [assistant("msg_a", T0 + SECOND, T0 + 2 * SECOND)])
    expect(kinds(h)).toEqual([])
    expect(h.toasts.some((toast) => toast.dedupeKey === "pr:w1:unresponsive")).toBe(false)
  })
})
