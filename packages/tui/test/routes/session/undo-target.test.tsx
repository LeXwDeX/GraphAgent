// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { setLanguage } from "../../../src/i18n"
import { Main } from "../../../src/routes/session"
import { assistantMessage, textPart, userMessage, type MessageEntry as Entry } from "../../fixture/session-records"
import { directory, json } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, waitFor } from "../dag-mode-harness"

/**
 * Undo goes back to what the user wrote (#1408). When a background run ends the server adds a user message of its own
 * to the session, and a command leaves text for the model in another: both are synthetic, neither is the user's, and
 * undo must not take either for the message to go back to. The keys are pressed on a mounted session route, so the
 * prompt that is filled afterwards is the one on screen.
 */

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const ROOT = "ses_undo_target"
const START = 1_000_000

/** A message the user wrote. */
function prompt(id: string, created: number, body: string): Entry {
  return { info: userMessage(id, ROOT, created), parts: [textPart(id, ROOT, `prt_${id}`, body)] }
}

function answer(id: string, parentID: string, created: number): Entry {
  return {
    info: assistantMessage(id, ROOT, parentID, created),
    parts: [textPart(id, ROOT, `prt_${id}`, `answer ${id}`)],
  }
}

/** The message the server adds when a background run ends: one synthetic text part with the result's metadata on it. */
function result(key: string, created: number): Entry {
  const id = `msg_result_${key}`
  return {
    info: userMessage(id, ROOT, created),
    parts: [
      {
        id: `prt_${id}`,
        sessionID: ROOT,
        messageID: id,
        type: "text",
        synthetic: true,
        text: [
          `<task id="ses_child_${key}" state="completed">`,
          `<summary>Background task completed: Scan ${key}</summary>`,
          "<task_result>",
          `RESULT-BODY-${key}`,
          "</task_result>",
          "</task>",
        ].join("\n"),
        metadata: {
          backgroundResult: {
            childSessionID: `ses_child_${key}`,
            initiator: "agent",
            title: `Scan ${key}`,
            status: "completed",
            startedAt: START,
            endedAt: START + 65_000,
          },
        },
      },
    ],
  }
}

/** The text a command leaves for the model: synthetic, with no metadata, and never drawn. */
function note(id: string, created: number): Entry {
  return {
    info: userMessage(id, ROOT, created),
    parts: [
      {
        id: `prt_${id}`,
        sessionID: ROOT,
        messageID: id,
        type: "text",
        synthetic: true,
        text: "Summarize the task tool output above and continue with your task.",
      },
    ],
  }
}

/** What a command leaves in the transcript: its line and its receipt, shown as the user's text but `ignored`. */
function echo(id: string, created: number): Entry {
  return {
    info: userMessage(id, ROOT, created),
    parts: [
      { ...textPart(id, ROOT, `prt_${id}_line`, "/dag-mode on"), ignored: true, metadata: { command: "dag-mode" } },
      { ...textPart(id, ROOT, `prt_${id}_receipt`, "ECHO-RECEIPT"), ignored: true },
    ],
  }
}

/** Assistant messages enough for the transcript to be taller than a short terminal: the end is far from the prompt. */
function bulk(messages: number): Entry[] {
  return Array.from({ length: messages }, (_, index) => answer(`msg_bulk_${index}`, "msg_prompt", 15 + index / 100))
}

async function mount(entries: Entry[], options: { revertTo?: string; height?: number } = {}) {
  const harness = await mountRoute({
    route: { type: "session", sessionID: ROOT },
    view: () => <Main />,
    frame: true,
    sessions: [sessionFixture(ROOT, options.revertTo ? { revert: { messageID: options.revertTo } } : {})],
    handler: (url) => {
      if (url.pathname === `/session/${ROOT}/message`) return json(entries)
      if (url.pathname === `/session/${ROOT}/abort`) return json(true)
      if (url.pathname === `/session/${ROOT}/revert`) return json({})
      return undefined
    },
    language: "en",
    width: 80,
    height: options.height ?? 30,
  })
  try {
    await waitFor(() => harness.sync().status === "complete", 10_000)
  } catch (error) {
    await harness.dispose()
    throw error
  }
  return harness
}

type Harness = Awaited<ReturnType<typeof mount>>

/** The leader key and `u`, which is what the default bindings run `session.undo` on. */
async function pressUndo(harness: Harness) {
  harness.app.mockInput.pressKey("x", { ctrl: true })
  await harness.app.renderOnce()
  harness.app.mockInput.pressKey("u")
}

const requests = (harness: Harness, name: "abort" | "revert") =>
  harness.sent.filter((request) => request.path === `/session/${ROOT}/${name}`)

test("undo after a background result goes back to what the user wrote and fills the prompt with it, not with the result", async () => {
  const harness = await mount([
    prompt("msg_prompt", 10, "scan everything"),
    answer("msg_answer", "msg_prompt", 20),
    result("a", 30),
  ])
  try {
    await pressUndo(harness)
    await waitFor(() => requests(harness, "revert").length > 0)
    await harness.settle()
    expect(requests(harness, "revert")).toHaveLength(1)
    expect(requests(harness, "revert")[0].body).toMatchObject({ messageID: "msg_prompt" })
    expect(harness.promptDraft()).toBe("scan everything")
    expect(harness.promptParts()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("undo passes over every result and the text a command left for the model, and takes the latest prompt of the user's", async () => {
  const harness = await mount([
    prompt("msg_first", 5, "first question"),
    answer("msg_first_answer", "msg_first", 6),
    prompt("msg_prompt", 10, "scan everything"),
    answer("msg_answer", "msg_prompt", 20),
    result("a", 30),
    result("b", 31),
    note("msg_note", 32),
  ])
  try {
    await pressUndo(harness)
    await waitFor(() => requests(harness, "revert").length > 0)
    await harness.settle()
    expect(requests(harness, "revert")[0].body).toMatchObject({ messageID: "msg_prompt" })
    expect(harness.promptDraft()).toBe("scan everything")
  } finally {
    await harness.dispose()
  }
})

test("undo from a session already reverted to a later prompt skips the result between the two prompts", async () => {
  const harness = await mount(
    [
      prompt("msg_prompt", 10, "scan everything"),
      answer("msg_answer", "msg_prompt", 20),
      result("a", 30),
      prompt("msg_second", 40, "now the second"),
      answer("msg_second_answer", "msg_second", 50),
      result("b", 60),
    ],
    { revertTo: "msg_second" },
  )
  try {
    await pressUndo(harness)
    await waitFor(() => requests(harness, "revert").length > 0)
    await harness.settle()
    expect(requests(harness, "revert")[0].body).toMatchObject({ messageID: "msg_prompt" })
    expect(harness.promptDraft()).toBe("scan everything")
  } finally {
    await harness.dispose()
  }
})

test("with only results and no prompt of the user's undo selects nothing: no revert is sent and the draft stays", async () => {
  const harness = await mount([answer("msg_answer", "msg_none", 20), result("a", 30), note("msg_note", 32)])
  try {
    await harness.app.mockInput.typeText("keep me")
    await harness.settle()
    expect(harness.promptDraft()).toBe("keep me")

    const ran: string[] = []
    harness.keymap().on("dispatch", (event) => {
      if (event.phase === "binding-execute" && typeof event.command === "string") ran.push(event.command)
    })
    await pressUndo(harness)
    // The key reached the command, which stops a session that is not idle and then looks for a target.
    await waitFor(() => ran.includes("session.undo"))
    await harness.settle()
    expect(requests(harness, "revert")).toEqual([])
    expect(harness.writes().every((request) => request.path.endsWith("/abort"))).toBe(true)
    expect(harness.promptDraft()).toBe("keep me")
  } finally {
    await harness.dispose()
  }
})

test("undo leaves out a message whose parts have not arrived: nothing says it is the user's, and it has no text to give back", async () => {
  const harness = await mount([prompt("msg_prompt", 10, "scan everything"), answer("msg_answer", "msg_prompt", 20)])
  try {
    // A message arrives before its parts.
    harness.events.emit({
      directory,
      payload: {
        id: "evt_new_message",
        type: "message.updated",
        properties: { sessionID: ROOT, info: userMessage("msg_new", ROOT, 40) },
      },
    })
    await waitFor(() => harness.sync().data.message[ROOT].some((message) => message.id === "msg_new"))
    expect(harness.sync().data.part["msg_new"]).toBeUndefined()

    await pressUndo(harness)
    await waitFor(() => requests(harness, "revert").length > 0)
    await harness.settle()
    expect(requests(harness, "revert")[0].body).toMatchObject({ messageID: "msg_prompt" })
    expect(harness.promptDraft()).toBe("scan everything")
  } finally {
    await harness.dispose()
  }
})

test("the jump to the last user message still passes over what a command echoed, and over a result", async () => {
  const harness = await mount(
    [prompt("msg_prompt", 10, "scan everything"), ...bulk(30), result("a", 50), echo("msg_echo", 60)],
    {
      height: 24,
    },
  )
  try {
    // The transcript follows its end: the prompt, the first message, is far above.
    const end = await harness.waitForFrame((value) => value.includes("ECHO-RECEIPT"), "the end")
    expect(end).not.toContain("scan everything")
    harness.keymap().dispatchCommand("session.messages_last_user")
    await harness.waitForFrame((value) => value.includes("scan everything"), "the prompt")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})
