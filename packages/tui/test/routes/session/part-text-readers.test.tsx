// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { AssistantMessage, TextPart, UserMessage } from "@graphagent/sdk"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { setLanguage } from "../../../src/i18n"
import { tmpdir } from "../../fixture/fixture"
import { directory, json } from "../../fixture/tui-sdk"
import { sessionFixture, waitFor } from "../dag-mode-harness"
import { mountSessionShell, type SessionShellOptions } from "../session-shell"

/**
 * #886 5.3 keeps streaming text in a buffer next to the store, so the store can be behind what
 * is on screen. Copy, transcript and export must read the text through `sync.readPartText`
 * (buffer included), or a copy taken while the answer streams would silently lose its tail.
 * These tests stream an answer, leave the store snapshot behind on purpose, and drive each
 * command through its default key. `test/util/transcript.test.ts` covers the `readText` option
 * of the transcript formatter on its own.
 */

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

// The default export file name is `session-<first eight characters of the id>.md`.
const sessionID = "ses_export_stream"
const exportFile = "session-ses_expo.md"

const STORED = "已落库的开头"
const TAIL = "，加上还没落库的流式增量"

const user: UserMessage = {
  id: "msg_stream_user",
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "test", modelID: "test-model" },
}

const assistant: AssistantMessage = {
  id: "msg_stream_assistant",
  sessionID,
  parentID: user.id,
  role: "assistant",
  agent: "build",
  mode: "build",
  modelID: "test-model",
  providerID: "test",
  path: { cwd: directory, root: directory },
  time: { created: 2 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

const question: TextPart = {
  id: "prt_stream_user",
  sessionID,
  messageID: user.id,
  type: "text",
  text: "把结果导出",
}

// Still running: no end time, so the part keeps listening to its buffer.
const answer: TextPart = {
  id: "prt_stream_answer",
  sessionID,
  messageID: assistant.id,
  type: "text",
  text: STORED,
  time: { start: 2 },
}

/** Mounts the session with a half-streamed answer: the store holds the head, the buffer the tail. */
async function mountStreaming(extra: Pick<SessionShellOptions, "clipboard" | "cwd" | "keybinds"> = {}) {
  const shell = await mountSessionShell({
    sessionID,
    sessions: [sessionFixture(sessionID, { title: "流式会话" })],
    handler: (url) => {
      if (url.pathname !== `/session/${sessionID}/message`) return undefined
      return json([
        { info: user, parts: [question] },
        { info: assistant, parts: [answer] },
      ])
    },
    ...extra,
  })
  // A setup that fails must not leave its renderer running into the tests that follow.
  try {
    await shell.waitForFrame((frame) => frame.includes(STORED), "the stored head of the answer")

    shell.events.emit({
      directory,
      payload: {
        id: "evt_stream_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID: assistant.id, partID: answer.id, field: "text", delta: TAIL },
      },
    })
    await shell.waitForFrame((frame) => frame.includes(STORED + TAIL), "the streamed tail of the answer")

    // The store never saw the tail: only the buffer did.
    expect(shell.sync().data.part[assistant.id]?.[0]).toMatchObject({ text: STORED })
    return shell
  } catch (error) {
    await shell.dispose()
    throw error
  }
}

function recordingClipboard() {
  const written: string[] = []
  return {
    written,
    service: {
      write: async (text: string) => {
        written.push(text)
      },
    },
  }
}

test("copying the last assistant message includes the streamed tail", async () => {
  const clipboard = recordingClipboard()
  const shell = await mountStreaming({ clipboard: clipboard.service })
  try {
    // <leader>y
    shell.app.mockInput.pressKey("x", { ctrl: true })
    await shell.app.renderOnce()
    shell.app.mockInput.pressKey("y")
    await waitFor(() => clipboard.written.length > 0, 10_000)

    expect(clipboard.written).toEqual([STORED + TAIL])
  } finally {
    await shell.dispose()
  }
})

test("copying the session transcript includes the streamed tail", async () => {
  const clipboard = recordingClipboard()
  const shell = await mountStreaming({
    clipboard: clipboard.service,
    keybinds: { keybinds: { session_copy: "f9" } },
  })
  try {
    shell.app.mockInput.pressKey("F9")
    await waitFor(() => clipboard.written.length > 0, 10_000)

    const [transcript] = clipboard.written
    expect(transcript).toContain("# 流式会话")
    expect(transcript).toContain("## User\n\n把结果导出")
    expect(transcript).toContain(`${STORED}${TAIL}\n`)
    expect(clipboard.written).toHaveLength(1)
  } finally {
    await shell.dispose()
  }
})

test("exporting the session writes the streamed tail", async () => {
  await using out = await tmpdir()
  // `openEditor` hands the transcript to $VISUAL or $EDITOR when one is set; keep the test away from it.
  const editor = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR }
  delete process.env.VISUAL
  delete process.env.EDITOR
  let shell: Awaited<ReturnType<typeof mountStreaming>> | undefined
  try {
    shell = await mountStreaming({ cwd: out.path })
    // <leader>x opens the export panel; the action row is the sixth.
    shell.app.mockInput.pressKey("x", { ctrl: true })
    await shell.app.renderOnce()
    shell.app.mockInput.pressKey("x")
    await shell.settle()
    expect(shell.bottomZone().host.depth()).toBe(1)
    for (let row = 0; row < 5; row++) shell.app.mockInput.pressArrow("down")
    await shell.settle()
    shell.app.mockInput.pressEnter()

    const file = path.join(out.path, exportFile)
    await waitFor(() => Bun.file(file).size > 0, 10_000)
    const exported = await readFile(file, "utf8")
    expect(exported).toContain("# 流式会话")
    expect(exported).toContain("## User\n\n把结果导出")
    expect(exported).toContain(`${STORED}${TAIL}\n`)
  } finally {
    await shell?.dispose()
    for (const [key, value] of Object.entries(editor)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
