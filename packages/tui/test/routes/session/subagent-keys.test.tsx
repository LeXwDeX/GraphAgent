// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { AppRoutes } from "../../fixture/route-frame"
import {
  assistantMessage,
  textPart,
  userMessage,
  type MessageEntry,
  type TaskStatus,
} from "../../fixture/session-records"
import { json, type FetchHandler } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, waitFor } from "../dag-mode-harness"

/**
 * The keys that change a session or send it a request (undo, redo, compact, background, rename) work in a main
 * session and do nothing in a sub-agent view (#1033 3.3). Each main-session run is the positive control of the
 * sub-agent run next to it: a key that writes there but not here is a key the view has switched off.
 */

const rootID = "ses_keys_root"
const childID = "ses_keys_child"

/**
 * A session whose transcript is a prompt, an answer with a Task call that still runs in the foreground, and a second
 * prompt that the session is reverted to: the undo, redo and background keys each have something to act on.
 */
function transcript(sessionID: string): MessageEntry[] {
  return [
    {
      info: userMessage(`msg_${sessionID}_user`, sessionID, 1),
      parts: [textPart(`msg_${sessionID}_user`, sessionID, `prt_${sessionID}_prompt`, "扫描全部变更")],
    },
    {
      info: {
        ...assistantMessage(`msg_${sessionID}_assistant`, sessionID, `msg_${sessionID}_user`, 2),
        finish: "tool-calls",
      },
      parts: [
        textPart(`msg_${sessionID}_assistant`, sessionID, `prt_${sessionID}_answer`, "正在处理。"),
        {
          id: `prt_${sessionID}_nested`,
          sessionID,
          messageID: `msg_${sessionID}_assistant`,
          type: "tool",
          callID: `call_${sessionID}_nested`,
          tool: "task",
          state: {
            status: "running" satisfies TaskStatus,
            input: { description: "嵌套任务", subagent_type: "explore", prompt: "x" },
            title: "嵌套任务",
            metadata: {},
            time: { start: 1 },
          },
        },
      ],
    },
    {
      info: userMessage(`msg_${sessionID}_user_2`, sessionID, 3),
      parts: [textPart(`msg_${sessionID}_user_2`, sessionID, `prt_${sessionID}_prompt_2`, "继续处理")],
    },
  ]
}

const transcripts: FetchHandler = (url) => {
  for (const id of [rootID, childID]) {
    if (url.pathname === `/session/${id}/message`) return json(transcript(id))
  }
  return undefined
}

/** Both sessions are reverted to their second prompt, so the redo key has something to redo. */
const revert = (sessionID: string) => ({ messageID: `msg_${sessionID}_user_2` })
const root = sessionFixture(rootID, { revert: revert(rootID) })
const child = sessionFixture(childID, { parentID: rootID, agent: "explore", revert: revert(childID) })

async function mount(sessionID: string) {
  const harness = await mountRoute({
    route: { type: "session", sessionID },
    view: () => <AppRoutes />,
    frame: true,
    sessions: [root, child],
    handler: transcripts,
    withAgentAndModel: true,
  })
  try {
    await waitFor(() => harness.sync().status === "complete", 10_000)
    await harness.waitForFrame((frame) => frame.includes("正在处理"), "the transcript")
  } catch (error) {
    await harness.dispose()
    throw error
  }
  return harness
}

type Harness = Awaited<ReturnType<typeof mount>>

/** The requests one key press wrote. */
async function written(harness: Harness, press: () => void) {
  const before = harness.writes().length
  press()
  await harness.settle()
  return harness.writes().slice(before)
}

const leader = (harness: Harness, key: string) => () => {
  harness.app.mockInput.pressKey("x", { ctrl: true })
  harness.app.mockInput.pressKey(key)
}

const KEYS = [
  { name: "undo", press: (harness: Harness) => leader(harness, "u"), path: "/abort" },
  { name: "redo", press: (harness: Harness) => leader(harness, "r"), path: "revert" },
  { name: "compact", press: (harness: Harness) => leader(harness, "c"), path: "/summarize" },
  { name: "background", press: (harness: Harness) => leader(harness, "w"), path: "background" },
] as const

for (const key of KEYS) {
  test(`${key.name}: the key writes in a main session`, async () => {
    const harness = await mount(rootID)
    try {
      const requests = await written(harness, key.press(harness))
      expect(requests.some((request) => request.path.includes(key.path))).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test(`${key.name}: the same key writes nothing in a sub-agent view`, async () => {
    const harness = await mount(childID)
    try {
      expect(await written(harness, key.press(harness))).toEqual([])
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
}

test("rename: the key edits nothing and writes nothing in a sub-agent view", async () => {
  const harness = await mount(childID)
  try {
    expect(
      await written(harness, () => {
        harness.app.mockInput.pressKey("r", { ctrl: true })
      }),
    ).toEqual([])
    // There is no prompt for the title to be edited in.
    expect(harness.promptDraft()).toBeUndefined()
  } finally {
    await harness.dispose()
  }
})
