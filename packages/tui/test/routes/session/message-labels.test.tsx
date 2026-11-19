// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import type { AssistantMessage, Part } from "@graphagent/sdk"
import { setLanguage } from "../../../src/i18n"
import { AppRoutes } from "../../fixture/route-frame"
import { assistantMessage, textPart, userMessage, type MessageEntry } from "../../fixture/session-records"
import { json } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, waitFor } from "../dag-mode-harness"

/**
 * The words the message rows used to hard-code in English (#1615 PR A): the badge of a queued message, the labels of
 * an attached file and directory, the divider of a compaction, the mark of an interrupted turn, and the note of a turn
 * that could not be replayed. They come from the message tables now, in the reader's language; English reads as it did.
 */

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const ROOT = "ses_label_root"
const root = sessionFixture(ROOT, { title: "root", time: { created: 1, updated: 2 } })

type Language = "en" | "zh-CN"

async function mount(entries: MessageEntry[], language: Language) {
  const harness = await mountRoute({
    route: { type: "session", sessionID: ROOT },
    view: () => <AppRoutes />,
    frame: true,
    sessions: [root],
    handler: (url) => (url.pathname === `/session/${ROOT}/message` ? json(entries) : undefined),
    language,
    width: 120,
    height: 40,
  })
  try {
    await waitFor(() => harness.sync().status === "complete", 10_000)
  } catch (error) {
    await harness.dispose()
    throw error
  }
  return harness
}

const user = (id: string, created: number, parts: Part[]): MessageEntry => ({
  info: userMessage(id, ROOT, created),
  parts,
})

const says = (text: string) => (frame: string) => frame.includes(text)

const LABELS = {
  en: {
    queued: " QUEUED ",
    file: " File  a.ts ",
    directory: " Directory  src ",
    compaction: " Compaction ",
    interrupted: "· interrupted",
    retry: "Tools started in this turn, so it was not replayed automatically. Retry manually.",
  },
  "zh-CN": {
    queued: " 排队中 ",
    file: " 文件  a.ts ",
    directory: " 目录  src ",
    compaction: " 压缩 ",
    interrupted: "· 已中断",
    retry: "本回合已启动工具，因此没有自动重放，请手动重试。",
  },
} as const

for (const language of ["en", "zh-CN"] as const) {
  const label = LABELS[language]

  test(`a message sent while a reply is still being written carries the queued badge, in ${language}`, async () => {
    // The reply has no completion time, so it is the pending turn; the second prompt came after it and is not consumed.
    const pending: AssistantMessage = {
      ...assistantMessage("msg_label_pending", ROOT, "msg_label_first", 20),
      time: { created: 20 },
      finish: undefined,
    }
    const harness = await mount(
      [
        user("msg_label_first", 10, [textPart("msg_label_first", ROOT, "prt_label_first", "first prompt")]),
        { info: pending, parts: [] },
        user("msg_label_second", 30, [textPart("msg_label_second", ROOT, "prt_label_second", "second prompt")]),
      ],
      language,
    )
    try {
      const frame = await harness.waitForFrame(says(label.queued), "the badge")
      const rows = frame.split("\n")
      // One badge, on the message that waits: under its text, and not on the first prompt.
      expect(rows.filter((row) => row.includes(label.queued))).toHaveLength(1)
      const second = rows.findIndex((row) => row.includes("second prompt"))
      const badge = rows.findIndex((row) => row.includes(label.queued))
      expect(second).toBeGreaterThanOrEqual(0)
      expect(badge).toBeGreaterThan(second)
      expect(rows.findIndex((row) => row.includes("first prompt"))).toBeLessThan(second)
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test(`an attached file and directory are labelled, in ${language}`, async () => {
    const harness = await mount(
      [
        user("msg_label_files", 10, [
          textPart("msg_label_files", ROOT, "prt_label_text", "look at these"),
          {
            id: "prt_label_file",
            sessionID: ROOT,
            messageID: "msg_label_files",
            type: "file",
            mime: "text/plain",
            filename: "a.ts",
            url: "file:///repo/a.ts",
          },
          {
            id: "prt_label_dir",
            sessionID: ROOT,
            messageID: "msg_label_files",
            type: "file",
            mime: "application/x-directory",
            filename: "src",
            url: "file:///repo/src",
          },
        ]),
      ],
      language,
    )
    try {
      const frame = await harness.waitForFrame(says(label.file), "the file label")
      expect(frame).toContain(label.directory)
      // The text of the message is above its labels.
      const rows = frame.split("\n")
      expect(rows.findIndex((row) => row.includes("look at these"))).toBeLessThan(
        rows.findIndex((row) => row.includes(label.file)),
      )
    } finally {
      await harness.dispose()
    }
  })

  test(`a compaction is a divider with its name in the middle, in ${language}`, async () => {
    const harness = await mount(
      [
        user("msg_label_compact", 10, [
          {
            id: "prt_label_compaction",
            sessionID: ROOT,
            messageID: "msg_label_compact",
            type: "compaction",
            auto: false,
          },
        ]),
      ],
      language,
    )
    try {
      const frame = await harness.waitForFrame(says(label.compaction), "the divider")
      const row = frame.split("\n").find((line) => line.includes(label.compaction))!
      // A rule on both sides of the name.
      const [before, after] = row.split(label.compaction)
      expect(before).toMatch(/─{3,}\s*$/)
      expect(after).toMatch(/^\s*─{3,}/)
    } finally {
      await harness.dispose()
    }
  })

  test(`an interrupted turn says so on the line that closes it, in ${language}`, async () => {
    const aborted: AssistantMessage = {
      ...assistantMessage("msg_label_aborted", ROOT, "msg_label_first", 20),
      error: { name: "MessageAbortedError", data: { message: "Aborted" } },
    }
    const harness = await mount(
      [
        user("msg_label_first", 10, [textPart("msg_label_first", ROOT, "prt_label_first", "first prompt")]),
        { info: aborted, parts: [textPart("msg_label_aborted", ROOT, "prt_label_answer", "half an answer")] },
      ],
      language,
    )
    try {
      const frame = await harness.waitForFrame(says(label.interrupted), "the mark")
      const row = frame.split("\n").find((line) => line.includes(label.interrupted))!
      expect(row).toContain("▣")
      expect(row).toContain("Explore")
    } finally {
      await harness.dispose()
    }
  })

  test(`a turn that could not be replayed says to retry by hand, in ${language}`, async () => {
    const blocked: AssistantMessage = {
      ...assistantMessage("msg_label_blocked", ROOT, "msg_label_first", 20),
      finish: undefined,
      error: {
        name: "APIError",
        data: { message: "Provider returned 503", isRetryable: false, metadata: { retryBlockedBy: "tool-executed" } },
      },
    }
    const harness = await mount(
      [
        user("msg_label_first", 10, [textPart("msg_label_first", ROOT, "prt_label_first", "first prompt")]),
        { info: blocked, parts: [] },
      ],
      language,
    )
    try {
      const frame = await harness.waitForFrame(says(label.retry), "the note")
      const rows = frame.split("\n")
      // Under the error, in its block.
      expect(rows.findIndex((row) => row.includes("Provider returned 503"))).toBeLessThan(
        rows.findIndex((row) => row.includes(label.retry)),
      )
    } finally {
      await harness.dispose()
    }
  })
}

test("an error that did not block a replay has no note about one", async () => {
  const failed: AssistantMessage = {
    ...assistantMessage("msg_label_failed", ROOT, "msg_label_first", 20),
    finish: undefined,
    error: { name: "APIError", data: { message: "Provider returned 500", isRetryable: false } },
  }
  const harness = await mount(
    [
      user("msg_label_first", 10, [textPart("msg_label_first", ROOT, "prt_label_first", "first prompt")]),
      { info: failed, parts: [] },
    ],
    "en",
  )
  try {
    const frame = await harness.waitForFrame(says("Provider returned 500"), "the error")
    expect(frame).not.toContain("Retry manually")
  } finally {
    await harness.dispose()
  }
})
