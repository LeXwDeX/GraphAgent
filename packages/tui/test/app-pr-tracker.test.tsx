// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import type { GlobalEvent, Message, Part, PrWatchEntry, SessionReminder, SessionStatus } from "@graphagent/sdk"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { setLanguage, t } from "../src/i18n"
import { createPrTracker } from "../src/shell/pr-tracker"
import type { ToastOptions } from "../src/ui/toast"
import { footerRow, PROMPT_MARK, runApp, waitFor, waitForFrame } from "./fixture/run-app"
import { directory, json, type FetchHandler } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

// The real app against a fake server: one PR tracker is mounted for the life of the app (#1036 F6). It listens to
// `pr.watch.updated` for the toast, and the status band reads the same tracker for the PR and reminder rows.

afterEach(() => {
  setLanguage("zh-CN")
})

const mainID = "ses_pr_main"
const childID = "ses_pr_child"
const sessions = [
  sessionFixture(mainID),
  sessionFixture(childID, { parentID: mainID, title: "scan (@explore subagent)" }),
]

let sequence = 0

function watch(over: Partial<PrWatchEntry> = {}): PrWatchEntry {
  const now = Date.now()
  return {
    sessionID: mainID,
    watchID: "w1",
    url: "https://forge.test/acme/app/pull/7",
    provider: "github",
    number: 7,
    phase: "watching",
    startedAt: now - 60_000,
    updatedAt: now,
    deadlineAt: now + 3_600_000,
    ...over,
  }
}

function prEvent(entry: PrWatchEntry): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return {
    directory,
    payload: { id: `evt_app_pr_${++sequence}`, type: "pr.watch.updated", properties: entry },
  } as GlobalEvent
}

function serverToast(message: string): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return {
    directory,
    payload: { id: `evt_app_pr_${++sequence}`, type: "tui.toast.show", properties: { message, variant: "info" } },
  } as GlobalEvent
}

/** The server's side of the two reads the tree's root gets on entry. */
function served(entries: PrWatchEntry[], reminders: SessionReminder[] = []): FetchHandler {
  return (url) => {
    if (url.pathname === `/session/${mainID}/pr-watch`) return json({ entries })
    if (url.pathname === `/session/${mainID}/reminder`) return json({ entries: reminders })
    return undefined
  }
}

/** The outcome is known and the notice is owed: the toast is the outcome's, not a warning. */
const passed = () => watch({ phase: "delivering", outcome: "success", delivery: { state: "pending" } })

test("a PR event for the root session toasts in the footer", async () => {
  const app = await runApp({ sessions, args: { continue: true }, width: 120, height: 30, handler: served([]) })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes(PROMPT_MARK), "the prompt")
    app.events.emit(prEvent(watch()))
    app.events.emit(prEvent(passed()))
    const toast = t("pr.toast", { number: 7, text: t("pr.outcome.success") })
    await waitForFrame(app.setup, (frame) => frame.includes(toast), "the toast")
  } finally {
    await app.stop()
  }
})

test("a sub-agent view gets the toast of its root's PR", async () => {
  const app = await runApp({ sessions, args: { sessionID: childID }, width: 120, height: 30, handler: served([]) })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("scan"), "the sub-agent view")
    app.events.emit(prEvent(watch()))
    app.events.emit(prEvent(passed()))
    const toast = t("pr.toast", { number: 7, text: t("pr.outcome.success") })
    await waitForFrame(app.setup, (frame) => frame.includes(toast), "the toast")
  } finally {
    await app.stop()
  }
})

test("the first read of the tree toasts nothing, and neither does the same state arriving as an event", async () => {
  const entry = passed()
  const app = await runApp({ sessions, args: { continue: true }, width: 120, height: 30, handler: served([entry]) })
  try {
    // The read has landed once the band draws the PR.
    await waitForFrame(app.setup, (frame) => frame.includes("#7"), "the PR row")
    app.events.emit(prEvent(entry))
    // Toasts are shown in order: the marker is behind a PR toast if there was one, so the frames up to it say.
    app.events.emit(serverToast("marker"))
    const toast = t("pr.toast", { number: 7, text: t("pr.outcome.success") })
    let seen = false
    await waitForFrame(
      app.setup,
      (frame) => {
        seen ||= frame.includes(toast)
        return frame.includes("marker")
      },
      "the marker",
    )
    expect(seen).toBe(false)
  } finally {
    await app.stop()
  }
})

test("the status band reads the tracker the app mounts: the PR of the root and its reminder", async () => {
  const app = await runApp({
    sessions,
    args: { continue: true },
    width: 120,
    height: 30,
    handler: served(
      [watch({ checks: { total: 6, pending: 2, failed: 0, passed: 4 } })],
      [
        {
          id: "rem_1",
          sessionID: mainID,
          text: "check the deploy",
          fireAt: Date.now() + 90 * 60_000,
          everyMs: null,
          status: "scheduled",
          createdAt: Date.now(),
        },
      ],
    ),
  })
  try {
    const frame = await waitForFrame(app.setup, (current) => current.includes("CI 4/6"), "the PR row")
    expect(frame).toContain("#7")
    await waitForFrame(app.setup, (current) => current.includes("check the deploy"), "the reminder row")
  } finally {
    await app.stop()
  }
})

// ── Esc leaves the PR row alone (#1620, #1036 acceptance 8) ─────────────────────────────────────────────────────────
//
// Since W1 (#1035) an interrupt only stops the turn: the watch goes on, and a watch is cancelled only by a deleted
// session or a disposed instance. Nothing in the interrupt path is wired to the tracker, so the stop, the abort error
// the server answers it with and the idle status after it must change neither the PR row, nor the band around it,
// nor the footer.

function statusEvent(type: "busy" | "idle"): GlobalEvent {
  return {
    directory,
    payload: {
      id: `evt_app_pr_${++sequence}`,
      type: "session.status",
      properties: { sessionID: mainID, status: { type } },
    },
  }
}

/** The error a stopped turn ends in. The shell shows nothing for it. */
function abortedEvent(): GlobalEvent {
  return {
    directory,
    payload: {
      id: `evt_app_pr_${++sequence}`,
      type: "session.error",
      properties: {
        sessionID: mainID,
        error: { name: "MessageAbortedError", data: { message: "The operation was aborted." } },
      },
    },
  }
}

/** The server accepts the stop an interrupt sends; one it refused would put an error toast in the footer. */
function stoppable(handler: FetchHandler): FetchHandler {
  return (url, request) => (url.pathname === `/session/${mainID}/abort` ? json(true) : handler(url, request))
}

/** The one write a stop makes. */
const abort = { method: "POST", path: `/session/${mainID}/abort`, body: undefined }

/** The rows the band can take (at most two), right above the first row of the prompt. */
function bandOf(frame: string) {
  const rows = frame.split("\n").map((row) => row.trimEnd())
  const first = rows.findIndex((row, index) => index > 2 && row.trimStart().startsWith("┃"))
  if (first < 0) throw new Error(`no prompt in the frame:\n${frame}`)
  return rows.slice(first - 2, first).join("\n")
}

test("Esc stops a busy session and leaves the watching PR row, the band and the footer as they were", async () => {
  const app = await runApp({
    sessions,
    args: { continue: true },
    width: 120,
    height: 30,
    handler: stoppable(served([watch()])),
  })
  // The footer of every frame looked at once the baseline is taken: a toast takes the place of its idle hints there.
  const footers = new Set<string>()
  const next = (predicate: (frame: string) => boolean, label: string) =>
    waitForFrame(
      app.setup,
      (frame) => {
        footers.add(footerRow(frame))
        return predicate(frame)
      },
      label,
    )
  try {
    await next((frame) => frame.includes(PROMPT_MARK), "the prompt")
    app.events.emit(prEvent(watch()))
    const idle = await next((frame) => frame.includes("PR #7"), "the PR row")
    const before = bandOf(idle)
    const footer = footerRow(idle)
    footers.clear()
    expect(before).toContain(t("pr.ci.waiting"))
    // The idle hints are on the footer: there is no toast to start from.
    expect(footer).toContain(t("shell.footer.commands"))

    // The turn runs, so Esc is the interrupt: the first press arms it, the second sends the stop.
    app.events.emit(statusEvent("busy"))
    await next((frame) => frame.includes("esc interrupt"), "the interrupt hint")
    const sent = app.writes().length
    app.setup.mockInput.pressEscape()
    await next((frame) => frame.includes("again to interrupt"), "the hint for the second press")
    expect(app.writes()).toHaveLength(sent)
    app.setup.mockInput.pressEscape()
    await waitFor(() => app.writes().length > sent)
    await next((frame) => frame.includes("Stopping"), "the stop under way")
    expect(app.writes().slice(sent)).toEqual([abort])

    // The server's side of it: the turn's error is an abort, then the session is idle.
    app.events.emit(abortedEvent())
    app.events.emit(statusEvent("idle"))
    const after = await next((frame) => !frame.includes("Stopping"), "the session idle")
    expect(bandOf(after)).toBe(before)
    expect(app.writes().slice(sent)).toEqual([abort])

    // The same watch is still live: its next update reaches the row.
    app.events.emit(prEvent(watch({ checks: { total: 6, pending: 2, failed: 0, passed: 4 } })))
    const updated = await next((frame) => frame.includes(t("pr.ci", { passed: 4, total: 6 })), "the CI counts")
    expect(bandOf(updated)).toContain("PR #7")

    // The control: a cancelled watch (the state a deleted session or a disposed instance gives it) does take the row
    // away, and takes it without a toast. The interrupt did not go that way.
    app.events.emit(prEvent(watch({ phase: "cancelled" })))
    const cancelled = await next((frame) => !frame.includes("PR #7"), "the row gone")
    expect(bandOf(cancelled)).not.toContain("PR #7")

    // Not one frame of it all had a toast where the hints are, and the stop is the only request that was written.
    expect([...footers]).toEqual([footer])
    expect(app.writes()).toEqual([abort])
  } finally {
    await app.stop()
  }
})

interface TrackedData {
  pr_watch: Record<string, Record<string, PrWatchEntry>>
  reminder: Record<string, SessionReminder[]>
  session_status: Record<string, SessionStatus>
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  hydrated: string[]
}

/** The assistant message of the turn the stop interrupts; once stopped it ends in the abort error. */
function interruptedTurn(stopped: boolean): Message {
  return {
    id: "msg_pr_turn",
    sessionID: mainID,
    role: "assistant",
    time: { created: 1_700_000_000_000, ...(stopped ? { completed: 1_700_000_001_000 } : {}) },
    ...(stopped
      ? { error: { name: "MessageAbortedError" as const, data: { message: "The operation was aborted." } } }
      : {}),
    parentID: "msg_pr_user",
    modelID: "test-model",
    providerID: "test",
    mode: "build",
    agent: "build",
    path: { cwd: "/work", root: "/work" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

test("the tracker lists the same PR rows through an interrupt, and neither toasts nor starts a timer", () => {
  createRoot((dispose) => {
    try {
      const toasts: ToastOptions[] = []
      const timers: number[] = []
      const [data, setData] = createStore<TrackedData>({
        pr_watch: {},
        reminder: {},
        session_status: {},
        message: {},
        part: {},
        hydrated: [mainID],
      })
      // The tracker as `app.tsx` wires it, over a store of its own and a clock that stands still.
      const tracker = createPrTracker({
        data,
        ticker: {
          now: () => 1_700_000_000_000,
          at(time) {
            timers.push(time)
            return () => {}
          },
        },
        toast: { show: (options) => void toasts.push(options) },
        onPrWatchEvent: () => () => {},
        currentRoot: () => mainID,
      })
      setData("pr_watch", mainID, { w1: watch({ checks: { total: 6, pending: 2, failed: 0, passed: 4 } }) })
      // Plain copies: what was listed before must not move with the later reads.
      const before = structuredClone(tracker.items(mainID))
      expect(before.map((item) => `${item.watchID}:${item.state.kind}`)).toEqual(["w1:watching"])

      // What the store holds of an interrupt, in order: the turn runs, it is stopped with an abort error, it is idle.
      const steps: ReadonlyArray<readonly [string, () => void]> = [
        [
          "the turn runs",
          () => {
            setData("session_status", mainID, { type: "busy" })
            setData("message", mainID, [interruptedTurn(false)])
          },
        ],
        ["the turn is stopped", () => setData("message", mainID, [interruptedTurn(true)])],
        ["the session is idle", () => setData("session_status", mainID, { type: "idle" })],
      ]
      for (const [label, step] of steps) {
        step()
        expect(structuredClone(tracker.items(mainID)), label).toEqual(before)
      }
      expect(toasts).toEqual([])
      expect(timers).toEqual([])
    } finally {
      dispose()
    }
  })
})
