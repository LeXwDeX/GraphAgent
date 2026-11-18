// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { setLanguage } from "../../../src/i18n"
import { Main } from "../../../src/routes/session"
import { assistantMessage, textPart, userMessage, type MessageEntry as Entry } from "../../fixture/session-records"
import { createEventSource, directory, json } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, waitFor, type Sent } from "../dag-mode-harness"

/**
 * Undo goes back to what the user wrote (#1408). When a background run ends the server adds a user message of its own
 * to the session, and a command leaves text for the model in another: both are synthetic, neither is the user's, and
 * undo must not take either for the message to go back to. Redo is the other half of the pair: it steps forward over
 * the same messages, so one redo after one undo restores what the undo took away, and a result is never where it stops.
 * The keys are pressed on a mounted session route, so the prompt that is filled afterwards is the one on screen.
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
  // The server's side of a revert: it keeps the point the session is reverted to, answers with the session, and says
  // so in an event, which is how the route learns where the next undo or redo starts from.
  let revertTo = options.revertTo
  let announced = 0
  const events = createEventSource()
  const info = () => sessionFixture(ROOT, revertTo ? { revert: { messageID: revertTo } } : {})
  const announce = () =>
    events.emit({
      directory,
      payload: {
        id: `evt_undo_session_${++announced}`,
        type: "session.updated",
        properties: { sessionID: ROOT, info: info() },
      },
    })
  const harness = await mountRoute({
    route: { type: "session", sessionID: ROOT },
    view: () => <Main />,
    frame: true,
    events,
    sessions: [info()],
    handler: async (url, request) => {
      if (url.pathname === `/session/${ROOT}/message`) return json(entries)
      if (url.pathname === `/session/${ROOT}/abort`) return json(true)
      if (url.pathname === `/session/${ROOT}/revert`) {
        const body: unknown = await request?.clone().json()
        if (typeof body === "object" && body !== null && "messageID" in body) revertTo = String(body.messageID)
        announce()
        return json(info())
      }
      if (url.pathname === `/session/${ROOT}/unrevert`) {
        revertTo = undefined
        announce()
        return json(info())
      }
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

/** The leader key and then `key`: the default bindings run `session.undo` on `u` and `session.redo` on `r`. */
async function pressLeader(harness: Harness, key: "u" | "r") {
  harness.app.mockInput.pressKey("x", { ctrl: true })
  await harness.app.renderOnce()
  harness.app.mockInput.pressKey(key)
}

const pressUndo = (harness: Harness) => pressLeader(harness, "u")
const pressRedo = (harness: Harness) => pressLeader(harness, "r")

const requests = (harness: Harness, name: "abort" | "revert" | "unrevert") =>
  harness.sent.filter((request) => request.path === `/session/${ROOT}/${name}`)

/** The message the session is reverted to, as the route has it: what the last `session.updated` said. */
const revertedTo = (harness: Harness) => harness.sync().data.session.find((item) => item.id === ROOT)?.revert?.messageID

function labelOf(request: Sent) {
  if (request.path.endsWith("/unrevert")) return "unrevert"
  const body = request.body
  return `revert ${typeof body === "object" && body !== null && "messageID" in body ? String(body.messageID) : "?"}`
}

/** What the presses asked the server to restore or take away, in order. */
const steps = (harness: Harness) =>
  harness.sent
    .filter((request) => request.path === `/session/${ROOT}/revert` || request.path === `/session/${ROOT}/unrevert`)
    .map(labelOf)

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

test("one redo after one undo restores everything, the result included: a result is not a place to stop", async () => {
  const harness = await mount([
    prompt("msg_prompt", 10, "scan everything"),
    answer("msg_answer", "msg_prompt", 20),
    result("a", 30),
  ])
  try {
    await harness.waitForFrame((value) => value.includes("RESULT-BODY-a"), "the result")

    await pressUndo(harness)
    await waitFor(() => revertedTo(harness) === "msg_prompt")
    await harness.waitForFrame((value) => !value.includes("RESULT-BODY-a"), "the result taken away with the prompt")
    expect(harness.promptDraft()).toBe("scan everything")

    await pressRedo(harness)
    await waitFor(() => revertedTo(harness) === undefined)
    await harness.waitForFrame((value) => value.includes("RESULT-BODY-a"), "the result back")
    expect(steps(harness)).toEqual(["revert msg_prompt", "unrevert"])
    expect(harness.promptDraft()).toBe("")
    expect(harness.promptParts()).toEqual([])

    // Nothing is left to redo: another press asks the server for nothing.
    await pressRedo(harness)
    await harness.settle()
    expect(steps(harness)).toEqual(["revert msg_prompt", "unrevert"])
  } finally {
    await harness.dispose()
  }
})

test("undo twice and redo twice step through the user's messages only, with a result between the prompts", async () => {
  const harness = await mount(
    [
      prompt("msg_prompt", 10, "scan everything"),
      answer("msg_answer", "msg_prompt", 20),
      result("a", 30),
      prompt("msg_second", 40, "now the second"),
      answer("msg_second_answer", "msg_second", 50),
      result("b", 60),
    ],
    { height: 44 },
  )
  try {
    await harness.waitForFrame((value) => value.includes("RESULT-BODY-a") && value.includes("RESULT-BODY-b"), "both")

    await pressUndo(harness)
    await waitFor(() => revertedTo(harness) === "msg_second")
    expect(harness.promptDraft()).toBe("now the second")
    // The banner counts the second prompt, not the result that stands after it.
    await harness.waitForFrame((value) => value.includes("1 message reverted"), "one message reverted")
    await pressUndo(harness)
    await waitFor(() => revertedTo(harness) === "msg_prompt")
    expect(harness.promptDraft()).toBe("scan everything")
    await harness.waitForFrame(
      (value) => !value.includes("RESULT-BODY-a") && value.includes("2 message reverted"),
      "the first result taken away, and two prompts reverted",
    )

    // The first redo goes forward to the second prompt, over the result that stands before it: the first result is
    // back with the first prompt, and the second one still waits behind the second.
    await pressRedo(harness)
    await waitFor(() => revertedTo(harness) === "msg_second")
    await harness.waitForFrame(
      (value) =>
        value.includes("RESULT-BODY-a") && !value.includes("RESULT-BODY-b") && value.includes("1 message reverted"),
      "the first result, and not the second",
    )

    // Nothing the user wrote stands after the second prompt, only a result: the second redo restores everything.
    await pressRedo(harness)
    await waitFor(() => revertedTo(harness) === undefined)
    await harness.waitForFrame((value) => value.includes("RESULT-BODY-b"), "the second result")
    expect(steps(harness)).toEqual(["revert msg_second", "revert msg_prompt", "revert msg_second", "unrevert"])
    expect(harness.promptDraft()).toBe("")
  } finally {
    await harness.dispose()
  }
})

test("the banner of a revert counts what the user wrote: a prompt with two results after it is one message reverted", async () => {
  const harness = await mount([
    prompt("msg_prompt", 10, "scan everything"),
    answer("msg_answer", "msg_prompt", 20),
    result("a", 30),
    result("b", 31),
  ])
  try {
    await pressUndo(harness)
    await waitFor(() => revertedTo(harness) === "msg_prompt")
    const frame = await harness.waitForFrame((value) => value.includes("message reverted"), "the banner")
    expect(frame).toContain("1 message reverted")
    expect(frame).not.toContain("3 message reverted")
  } finally {
    await harness.dispose()
  }
})

test("redo with nothing to redo does nothing: no request is sent and the draft stays", async () => {
  const harness = await mount([
    prompt("msg_prompt", 10, "scan everything"),
    answer("msg_answer", "msg_prompt", 20),
    result("a", 30),
  ])
  try {
    await harness.app.mockInput.typeText("keep me")
    await harness.settle()
    expect(harness.promptDraft()).toBe("keep me")

    // The key is not bound while the session is not reverted, so the command is run the way `/redo` runs it.
    await harness.registry().run("session.redo", { args: "", origin: "palette" })
    await harness.settle()
    expect(revertedTo(harness)).toBeUndefined()
    expect(harness.writes()).toEqual([])
    expect(harness.promptDraft()).toBe("keep me")
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
