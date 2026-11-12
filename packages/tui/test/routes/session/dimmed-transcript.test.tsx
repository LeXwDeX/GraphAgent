// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import type { AssistantMessage, PermissionRequest, TextPart, UserMessage } from "@graphagent/sdk"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { setLanguage } from "../../../src/i18n"
import { directory, json } from "../../fixture/tui-sdk"
import { sessionFixture } from "../dag-mode-harness"
import { mountSessionShell } from "../session-shell"

/**
 * While a panel or an ask is open the frame dims the main area. Dimming used to blank every
 * wide character in it, so a Chinese transcript went empty the moment a panel opened (#886 3.1).
 * These tests mount the real session view with a Chinese transcript and open a panel and an ask
 * over it; `test/shell/app-frame.test.tsx` covers the frame itself.
 */

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const sessionID = "ses_dimmed_transcript"

const user: UserMessage = {
  id: "msg_dimmed_user",
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "test", modelID: "test-model" },
}

const assistant: AssistantMessage = {
  id: "msg_dimmed_assistant",
  sessionID,
  parentID: user.id,
  role: "assistant",
  agent: "build",
  mode: "build",
  modelID: "test-model",
  providerID: "test",
  path: { cwd: directory, root: directory },
  time: { created: 2, completed: 3 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

const question: TextPart = {
  id: "prt_dimmed_user",
  sessionID,
  messageID: user.id,
  type: "text",
  text: "请解释一下 CJK 宽字符",
}

const answer: TextPart = {
  id: "prt_dimmed_assistant",
  sessionID,
  messageID: assistant.id,
  type: "text",
  text: "你好，世界。这是一段 **中文** 回答 with ASCII.\n\n```ts\nconst 名字 = 1\n```",
  time: { start: 2, end: 3 },
}

const permission: PermissionRequest = {
  id: "per_000000000001",
  sessionID,
  permission: "bash",
  patterns: ["npm publish"],
  metadata: {},
  always: ["npm publish"],
}

/** Lines of the transcript, as the frame shows them. */
const LINES = ["请解释一下 CJK 宽字符", "你好，世界。这是一段 中文 回答 with ASCII.", "const 名字 = 1"]

async function mountTranscript() {
  const shell = await mountSessionShell({
    sessionID,
    sessions: [sessionFixture(sessionID)],
    handler: (url) => {
      if (url.pathname !== `/session/${sessionID}/message`) return undefined
      return json([
        { info: user, parts: [question] },
        { info: assistant, parts: [answer] },
      ])
    },
  })
  try {
    await shell.waitForFrame((frame) => LINES.every((line) => frame.includes(line)), "the transcript")
    return shell
  } catch (error) {
    await shell.dispose()
    throw error
  }
}

type Shell = Awaited<ReturnType<typeof mountTranscript>>

/** Foreground of the first span holding `text`. */
async function fgOf(shell: Shell, text: string) {
  for (const line of (await shell.spans()).lines) {
    for (const span of line.spans) if (span.text.includes(text)) return span.fg.toInts().slice(0, 3)
  }
  throw new Error(`no span holds ${text}:\n${await shell.frame()}`)
}

async function expectAllShown(shell: Shell) {
  const frame = await shell.frame()
  for (const line of LINES) expect(frame).toContain(line)
}

function expectDimmer(after: number[], before: number[]) {
  after.forEach((value, index) => expect(value).toBeLessThan(before[index] ?? 0))
}

test("the Chinese transcript stays on screen, dimmed, while a panel is open", async () => {
  const shell = await mountTranscript()
  try {
    await expectAllShown(shell)
    const before = await fgOf(shell, "你好，世界")

    shell.bottomZone().host.push({ id: "panel", render: () => <text>面板内容</text> })
    await shell.settle()
    expect(shell.bottomZone().dimmed()).toBe(true)
    expect(await shell.frame()).toContain("面板内容")
    await expectAllShown(shell)
    expectDimmer(await fgOf(shell, "你好，世界"), before)

    shell.bottomZone().host.pop()
    await shell.settle()
    expect(shell.bottomZone().dimmed()).toBe(false)
    await expectAllShown(shell)
    expect(await fgOf(shell, "你好，世界")).toEqual(before)
  } finally {
    await shell.dispose()
  }
})

test("the Chinese transcript stays on screen, dimmed, while an ask is open", async () => {
  const shell = await mountTranscript()
  try {
    const before = await fgOf(shell, "请解释一下")

    shell.sync().set("permission", sessionID, [permission])
    await shell.settle()
    expect(shell.bottomZone().state().kind).toBe("ask")
    await expectAllShown(shell)
    expectDimmer(await fgOf(shell, "请解释一下"), before)
  } finally {
    await shell.dispose()
  }
})
