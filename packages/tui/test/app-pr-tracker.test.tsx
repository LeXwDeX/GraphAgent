// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import type { GlobalEvent, PrWatchEntry, SessionReminder } from "@graphagent/sdk"
import { setLanguage, t } from "../src/i18n"
import { promptShown, runApp, waitForFrame } from "./fixture/run-app"
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
    await waitForFrame(app.setup, promptShown, "the prompt")
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
