// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import type { AssistantMessage, GlobalEvent, ToolPart } from "@graphagent/sdk"
import { setLanguage } from "../src/i18n"
import { cellWidth } from "../src/ui/width"
import { PROMPT_MARK, captureFrame, runApp, waitFor, waitForFrame, type Setup } from "./fixture/run-app"
import { assistantMessage, textPart, userMessage } from "./fixture/session-records"
import { directory, json, type FetchHandler } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

// The real app against a fake server: `/agents` in a main session and in a sub-agent view, what opening it asks the
// server, where its action leads, and the footer toast a sub-agent leaves when the user is not looking at it
// (#1033 5, 6; #1058 6, 7).

const rootID = "ses_agents_root"
const alphaID = "ses_agents_a"
const bravoID = "ses_agents_b"
const charlieID = "ses_agents_c"
const nodeID = "ses_agents_node"

afterEach(() => {
  setLanguage("zh-CN")
})

// `a` and `b` were created at the same instant, so their ids settle the order; `c` is the newest. The list is not in
// that order but in groups: `b` and `c` are background runs (no state is known for either, which is the cold-start
// look, and the background group holds them), then `a`, the foreground one, whose state is not known either.
const tree = [
  sessionFixture(rootID, { title: "发布准备" }),
  sessionFixture(alphaID, { parentID: rootID, time: { created: 10, updated: 11 } }),
  sessionFixture(bravoID, { parentID: rootID, time: { created: 10, updated: 12 } }),
  sessionFixture(charlieID, { parentID: rootID, time: { created: 20, updated: 21 } }),
]

const assistant: AssistantMessage = {
  id: "msg_agents_assistant",
  sessionID: rootID,
  parentID: "msg_agents_user",
  role: "assistant",
  // Not `build`: the transcript then does not say `Build · Test model`, which only the input does.
  agent: "plan",
  mode: "plan",
  modelID: "test-model",
  providerID: "test",
  path: { cwd: directory, root: directory },
  time: { created: 10, completed: 11 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

function taskPart(childID: string, description: string, background = false): ToolPart {
  return {
    id: `prt_${childID}`,
    sessionID: rootID,
    messageID: assistant.id,
    type: "tool",
    tool: "task",
    callID: `call_${childID}`,
    state: {
      status: "completed",
      input: { description, subagent_type: "explore" },
      output: "done",
      title: description,
      metadata: { sessionID: childID, ...(background ? { background: true } : {}) },
      time: { start: 10, end: 11 },
    },
  }
}

/**
 * The message the server adds to the main session when a background run ends: a synthetic text part whose metadata
 * names the child and how it ended.
 */
function resultMessage(childID: string, endedAt = 300) {
  return {
    id: `msg_agents_result_${childID}_${endedAt}`,
    sessionID: rootID,
    role: "user" as const,
    time: { created: endedAt },
    agent: "plan",
    model: { providerID: "test", modelID: "test-model" },
  }
}

function resultPart(childID: string, status: "completed" | "error" | "interrupted" = "completed", endedAt = 300) {
  return {
    id: `prt_agents_result_${childID}_${endedAt}`,
    sessionID: rootID,
    messageID: resultMessage(childID, endedAt).id,
    type: "text" as const,
    synthetic: true,
    text: `<task id="${childID}" state="${status}">\n<task_result>\nInspected.\n</task_result>\n</task>`,
    metadata: {
      backgroundResult: {
        childSessionID: childID,
        status,
        title: "Inspect",
        initiator: "agent",
        startedAt: 100,
        endedAt,
      },
    },
  }
}

/** The result as it arrives live: the event of the part the server just wrote. */
function resultEvent(
  childID: string,
  status: "completed" | "error" | "interrupted" = "completed",
  endedAt = 300,
): GlobalEvent {
  return {
    directory,
    payload: {
      id: `evt_agents_result_${childID}_${endedAt}`,
      type: "message.part.updated",
      properties: { sessionID: rootID, time: endedAt, part: resultPart(childID, status, endedAt) },
    },
  }
}

/**
 * The fake server's side: the root's transcript with the three Task links, and a record of the messages read. A
 * `snapshot` of results is in the transcript the server answers with: what a load, a hydration or a reconnect brings.
 */
function server(snapshot: readonly { childID: string; status?: "completed" | "error" | "interrupted" }[] = []) {
  const messageReads: string[] = []
  const handler: FetchHandler = (url, request) => {
    if ((request?.method ?? "GET") === "GET") {
      const read = url.pathname.match(/^\/session\/([^/]+)\/message$/)
      if (read) messageReads.push(read[1])
    }
    if (url.pathname === `/session/${rootID}/message`) {
      return json([
        {
          info: assistant,
          parts: [
            taskPart(alphaID, "Inspect alpha"),
            taskPart(bravoID, "Inspect bravo", true),
            taskPart(charlieID, "Inspect charlie", true),
          ],
        },
        ...snapshot.map((each) => ({
          info: resultMessage(each.childID),
          parts: [resultPart(each.childID, each.status)],
        })),
      ])
    }
    return undefined
  }
  return { handler, messageReads, childReads: () => messageReads.filter((id) => id !== rootID) }
}

const HEAD_TEXT = "HEAD-QUESTION"
const TAIL_TEXT = "TAIL-ANSWER"

/**
 * The fake server's side for a main session with a long transcript: a question at the head, the Task calls, answers,
 * the report of bravo's run (drawn as its result card) in the middle, then answers up to the last one. Long enough that
 * the head, the card and the last answer are never on screen together. Messages are ordered by id: the answers before
 * the report are `msg_agents_q_*`, the ones after it `msg_agents_z_*`.
 */
function longServer() {
  const messageReads: string[] = []
  const answers = Array.from({ length: 30 }, (_, index) => {
    const id = `msg_agents_${index < 15 ? "q" : "z"}_${String(index).padStart(2, "0")}`
    const text = `${index === 29 ? `${TAIL_TEXT}: nothing is left.` : `Answer ${index}`}\nsecond line\nthird line\nfourth line`
    return {
      info: assistantMessage(id, rootID, "msg_agents_000", 20 + index),
      parts: [textPart(id, rootID, `prt_${id}`, text)],
    }
  })
  const handler: FetchHandler = (url, request) => {
    if ((request?.method ?? "GET") === "GET") {
      const read = url.pathname.match(/^\/session\/([^/]+)\/message$/)
      if (read) messageReads.push(read[1])
    }
    if (url.pathname !== `/session/${rootID}/message`) return undefined
    return json([
      {
        info: userMessage("msg_agents_000", rootID, 5),
        parts: [textPart("msg_agents_000", rootID, "prt_agents_head", `${HEAD_TEXT}: what is left to review?`)],
      },
      {
        info: assistant,
        parts: [
          taskPart(alphaID, "Inspect alpha"),
          taskPart(bravoID, "Inspect bravo", true),
          taskPart(charlieID, "Inspect charlie", true),
        ],
      },
      { info: resultMessage(bravoID), parts: [resultPart(bravoID)] },
      ...answers,
    ])
  }
  return { handler, messageReads }
}

function english(inner: FetchHandler): FetchHandler {
  return (url, request) => (url.pathname === "/config" ? json({ language: "en" }) : inner(url, request))
}

function collect(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) collect(child, result)
  return result
}

function textareas(setup: Setup) {
  return collect(setup.renderer.root).filter((item): item is TextareaRenderable => item instanceof TextareaRenderable)
}

/** An unmounting prompt keeps a non-empty draft for the next prompt in the process; leave none behind. */
function clearDrafts(setup: Setup) {
  for (const input of textareas(setup)) if (!input.isDestroyed) input.setText("")
}

/** Opens `/agents` the way a user does in a main session: the command typed into the input. */
async function openByCommand(setup: Setup, popupText: string) {
  await setup.mockInput.typeText("/agents")
  await waitForFrame(setup, (frame) => frame.includes(popupText), "the command popup")
  setup.mockInput.pressEnter()
}

/**
 * Opens it through the command palette (in English), the only way in a sub-agent view, where there is no input to type
 * into. The palette lists more commands than it has rows for, so the command is found by typing its name.
 */
async function openByPalette(setup: Setup) {
  setup.mockInput.pressKey("p", { ctrl: true })
  await waitForFrame(setup, (frame) => frame.includes("Commands") && frame.includes("Filter…"), "the command palette")
  await setup.mockInput.typeText("Subagent")
  await waitForFrame(setup, (frame) => frame.includes("Subagent list"), "the filtered palette")
  setup.mockInput.pressEnter()
}

function sessionEvent(type: "busy" | "idle", sessionID: string): GlobalEvent {
  return {
    directory,
    payload: {
      id: `evt_agents_${type}_${sessionID}`,
      type: "session.status",
      properties: { sessionID, status: { type } },
    },
  }
}

function errorEvent(sessionID: string): GlobalEvent {
  return {
    directory,
    payload: {
      id: `evt_agents_error_${sessionID}`,
      type: "session.error",
      properties: { sessionID, error: { name: "UnknownError", data: { message: "boom" } } },
    },
  }
}

function permissionEvent(sessionID: string): GlobalEvent {
  return {
    directory,
    payload: {
      id: `evt_agents_permission_${sessionID}`,
      type: "permission.asked",
      properties: {
        id: "per_000000000001",
        sessionID,
        permission: "bash",
        patterns: ["npm publish"],
        metadata: {},
        always: [],
      },
    },
  }
}

test("/agents lists the sub-agents of the main session in the order of its groups and loads none of them", async () => {
  const fake = server()
  const app = await runApp({
    sessions: tree,
    args: { sessionID: rootID },
    width: 120,
    height: 30,
    handler: fake.handler,
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes(PROMPT_MARK), "the prompt")
    await waitFor(() => fake.messageReads.includes(rootID))
    await openByCommand(app.setup, "查看子会话与子 agent")

    const frame = await waitForFrame(
      app.setup,
      (value) => value.includes("explore · Inspect charlie"),
      "the sub-agent list",
    )
    expect(frame).not.toContain(PROMPT_MARK)
    // The two background runs first, newest start first (they began together: the id settles it), then the other.
    // (The transcript above the list names them too, in the order of the calls: only the list's own rows count.)
    const order = ["explore · Inspect bravo", "explore · Inspect charlie", "explore · Inspect alpha"].map((text) =>
      frame.indexOf(text),
    )
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(order.every((position) => position > 0)).toBe(true)
    expect(frame).toContain("后台")
    expect(frame).toContain("已结束")
    // No status was ever reported: no state to say, no tool count, and the time the session has.
    expect(frame).toContain("— · 工具 — ·")
    expect(frame).not.toContain("已完成")
    expect(frame).not.toContain("工具 0")
    // The list was made from what the app already held: not one sub-agent session was loaded for it.
    expect(fake.childReads()).toEqual([])

    app.setup.mockInput.pressEscape()
    await waitForFrame(app.setup, (value) => value.includes(PROMPT_MARK), "the input again")
    expect(fake.childReads()).toEqual([])
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("enter in the list goes into the chosen sub-agent, which only then is loaded, and sends nothing", async () => {
  const fake = server()
  const app = await runApp({
    sessions: tree,
    args: { sessionID: rootID },
    width: 120,
    height: 30,
    handler: fake.handler,
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes(PROMPT_MARK), "the prompt")
    await waitFor(() => fake.messageReads.includes(rootID))
    await openByCommand(app.setup, "查看子会话与子 agent")
    await waitForFrame(app.setup, (value) => value.includes("explore · Inspect bravo"), "the sub-agent list")
    expect(fake.childReads()).toEqual([])

    app.setup.mockInput.pressArrow("down")
    await app.setup.renderOnce()
    app.setup.mockInput.pressEnter()
    await waitFor(() => fake.childReads().includes(charlieID))
    const frame = await waitForFrame(
      app.setup,
      (value) => !value.includes(PROMPT_MARK) && !value.includes("筛选…"),
      "the sub-agent view",
    )
    // A sub-agent view has no input; the one the user chose is the only session that was loaded.
    expect(frame).not.toContain(PROMPT_MARK)
    expect(fake.childReads()).toEqual([charlieID])
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("asking the main agent adds to the draft instead of replacing it, and submits nothing", async () => {
  const fake = server()
  const app = await runApp({
    sessions: tree,
    args: { sessionID: rootID },
    width: 120,
    height: 30,
    handler: english(fake.handler),
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes(PROMPT_MARK), "the prompt")
    await waitFor(() => fake.messageReads.includes(rootID))
    await app.setup.mockInput.typeText("first, release notes")
    await openByPalette(app.setup)
    await waitForFrame(app.setup, (value) => value.includes("explore · Inspect charlie"), "the sub-agent list")

    app.setup.mockInput.pressArrow("down")
    await app.setup.renderOnce()
    app.setup.mockInput.pressKey("r", { ctrl: true })
    const frame = await waitForFrame(
      app.setup,
      (value) => value.includes(PROMPT_MARK) && value.includes("Please handle the subagent"),
      "the input with the request",
    )
    expect(frame).toContain("first, release notes")
    const [input] = textareas(app.setup)
    // The second row is a background run whose state nobody knows yet: the plain request, not a cancel.
    expect(input?.plainText).toBe("first, release notes\nPlease handle the subagent explore · Inspect charlie:")
    expect(app.setup.renderer.currentFocusedRenderable).toBe(input)
    // Nothing was sent, not the draft and not a stop: the user reads it, edits it and decides.
    expect(app.writes()).toEqual([])
    expect(fake.childReads()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("the list opens in a sub-agent view too, and asking from there ends in the main session's input", async () => {
  const fake = server()
  const app = await runApp({
    sessions: tree,
    args: { sessionID: bravoID },
    width: 120,
    height: 30,
    handler: english(fake.handler),
  })
  try {
    await waitFor(() => fake.messageReads.includes(bravoID))
    await waitFor(() => fake.messageReads.includes(rootID))
    for (let pass = 0; pass < 5; pass++) await app.setup.renderOnce()
    await openByPalette(app.setup)
    const listed = await waitForFrame(
      app.setup,
      (value) => value.includes("explore · Inspect charlie"),
      "the sub-agent list in a sub-agent view",
    )
    expect(listed).toContain("explore · Inspect alpha")
    expect(listed).not.toContain(PROMPT_MARK)

    app.setup.mockInput.pressKey("r", { ctrl: true })
    await waitForFrame(
      app.setup,
      (value) => value.includes(PROMPT_MARK) && value.includes("Please handle the subagent"),
      "the main session's input",
    )
    const [input] = textareas(app.setup)
    expect(input?.plainText).toBe("Please handle the subagent explore · Inspect bravo:")
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

// ── reminders ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The row of the frame that holds `text`, and the terminal column it starts at: what a click on that text needs. */
function locate(frame: string, text: string) {
  const rows = frame.split("\n")
  const row = rows.findIndex((line) => line.includes(text))
  // Wide characters before the text (the notice of a sub-agent footer is mostly Chinese) take two columns each.
  return { row, column: row < 0 ? -1 : cellWidth(rows[row].slice(0, rows[row].indexOf(text))) }
}

test("a background run that ends while the user is in the main session leaves a toast, which a click on leaves where it is", async () => {
  const fake = server()
  const app = await runApp({
    sessions: tree,
    args: { sessionID: rootID },
    width: 120,
    height: 30,
    handler: fake.handler,
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes(PROMPT_MARK), "the prompt")
    await waitFor(() => fake.messageReads.includes(rootID))
    for (let pass = 0; pass < 5; pass++) await app.setup.renderOnce()

    // The report arrives; the sub-agent's own status events are not what makes the toast.
    app.events.emit(sessionEvent("busy", charlieID))
    app.events.emit(sessionEvent("idle", charlieID))
    for (let pass = 0; pass < 5; pass++) await app.setup.renderOnce()
    expect(await captureFrame(app.setup)).not.toContain("explore 已完成")

    app.events.emit(resultEvent(charlieID))
    const frame = await waitForFrame(app.setup, (value) => value.includes("explore 已完成 · ⏎ 查看"), "the reminder")
    expect(fake.childReads()).toEqual([])

    // The result card is in the main session, where the user is: the click goes there, and not into the sub-agent.
    const { row, column } = locate(frame, "explore 已完成 · ⏎ 查看")
    await app.setup.mockMouse.click(column + 2, row)
    for (let pass = 0; pass < 5; pass++) await app.setup.renderOnce()
    expect(await captureFrame(app.setup)).toContain(PROMPT_MARK)
    expect(fake.childReads()).toEqual([])
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("a click on the toast takes the main session's transcript to the report's card; a later report keeps the toast, and a click on it goes where that report is", async () => {
  const fake = longServer()
  const app = await runApp({
    sessions: tree,
    args: { sessionID: rootID },
    width: 120,
    height: 30,
    handler: fake.handler,
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes(PROMPT_MARK), "the prompt")
    await waitFor(() => fake.messageReads.includes(rootID))
    await waitForFrame(app.setup, (frame) => frame.includes(TAIL_TEXT), "the end of the transcript")

    // The reader has gone back to the head of the transcript when the report arrives.
    const atHead = (frame: string) => frame.includes(HEAD_TEXT) && !frame.includes(TAIL_TEXT)
    const atEnd = (frame: string) => frame.includes(TAIL_TEXT) && !frame.includes(HEAD_TEXT)
    const atCard = (frame: string) =>
      frame.includes("Inspected.") && !frame.includes(HEAD_TEXT) && !frame.includes(TAIL_TEXT)
    const toast = "explore 已完成 · ⏎ 查看"
    app.setup.mockInput.pressKey("g", { ctrl: true })
    await waitForFrame(app.setup, atHead, "the head of the transcript")
    app.events.emit(resultEvent(bravoID))
    const first = await waitForFrame(app.setup, (value) => value.includes(toast) && atHead(value), "the reminder")
    const place = locate(first, toast)
    await app.setup.mockMouse.click(place.column + 2, place.row)
    await waitForFrame(app.setup, atCard, "the result card, where the click took the reader")

    // The reader goes back to the head. The same sub-agent reports again: one toast, which stays for another while. Only
    // the part of this report has arrived, not its message, so it has no card yet and the click takes the reader to
    // the end of the transcript, where it will be.
    app.setup.mockInput.pressKey("g", { ctrl: true })
    await waitForFrame(app.setup, atHead, "the head of the transcript again")
    app.events.emit(resultEvent(bravoID, "completed", 301))
    const second = await waitForFrame(
      app.setup,
      (value) => value.includes(toast) && atHead(value),
      "the reminder again",
    )
    expect(second.split(toast).length - 1).toBe(1)
    const again = locate(second, toast)
    await app.setup.mockMouse.click(again.column + 2, again.row)
    await waitForFrame(app.setup, atEnd, "the end of the transcript, a second time")
    expect(app.writes()).toEqual([])
    expect(fake.messageReads.filter((id) => id !== rootID)).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("from a sub-agent view a click on the toast goes to the main session, in both languages, and sends nothing", async () => {
  for (const language of ["zh-CN", "en"] as const) {
    const fake = server()
    const app = await runApp({
      sessions: tree,
      args: { sessionID: alphaID },
      width: 120,
      height: 30,
      handler: language === "en" ? english(fake.handler) : fake.handler,
    })
    try {
      await waitFor(() => fake.messageReads.includes(alphaID))
      await waitFor(() => fake.messageReads.includes(rootID))
      for (let pass = 0; pass < 5; pass++) await app.setup.renderOnce()

      app.events.emit(resultEvent(bravoID, "error"))
      const text = language === "en" ? "explore did not finish · ⏎ view" : "explore 未完成 · ⏎ 查看"
      const frame = await waitForFrame(app.setup, (value) => value.includes(text), "the reminder")
      expect(frame).not.toContain(PROMPT_MARK)

      const { row, column } = locate(frame, text)
      await app.setup.mockMouse.click(column + 2, row)
      await waitForFrame(app.setup, (value) => value.includes(PROMPT_MARK), "the main session")
      expect(app.writes()).toEqual([])
    } finally {
      clearDrafts(app.setup)
      await app.stop()
    }
  }
})

test("what a load or a reconnect brings is no event: a result already in the transcript leaves no toast, nor does it again", async () => {
  const fake = server([{ childID: charlieID }])
  const app = await runApp({
    sessions: tree,
    args: { sessionID: rootID },
    width: 120,
    height: 30,
    handler: fake.handler,
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes(PROMPT_MARK), "the prompt")
    await waitFor(() => fake.messageReads.includes(rootID))
    for (let pass = 0; pass < 10; pass++) await app.setup.renderOnce()
    // Loaded with the transcript: the data layer knows the run is over, and nobody says so in the footer.
    expect(await captureFrame(app.setup)).not.toContain("explore 已完成")

    // The connection drops and comes back; the transcript is read again.
    const reads = fake.messageReads.length
    app.events.reconnect()
    await waitFor(() => fake.messageReads.length > reads)
    for (let pass = 0; pass < 10; pass++) await app.setup.renderOnce()
    expect(await captureFrame(app.setup)).not.toContain("explore 已完成")

    // A result that arrives as an event is announced, once: the same part again (redelivered after the reconnect) is not.
    app.events.emit(resultEvent(bravoID, "completed", 700))
    const frame = await waitForFrame(app.setup, (value) => value.includes("explore 已完成 · ⏎ 查看"), "the reminder")
    expect(frame.split("explore 已完成 · ⏎ 查看").length - 1).toBe(1)
    app.events.reconnect()
    app.events.emit(resultEvent(bravoID, "completed", 700))
    for (let pass = 0; pass < 10; pass++) await app.setup.renderOnce()
    expect((await captureFrame(app.setup)).split("explore 已完成 · ⏎ 查看").length - 1).toBe(1)
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("a sub-agent that is waited for, or a DAG node, leaves no toast when it finishes or fails, but one when it asks", async () => {
  const fake = server()
  const app = await runApp({
    sessions: [
      ...tree,
      sessionFixture(nodeID, {
        parentID: rootID,
        title: "Inspect lockfile (DAG node)",
        time: { created: 30, updated: 31 },
      }),
    ],
    args: { sessionID: rootID },
    width: 120,
    height: 30,
    handler: fake.handler,
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes(PROMPT_MARK), "the prompt")
    await waitFor(() => fake.messageReads.includes(rootID))
    for (let pass = 0; pass < 5; pass++) await app.setup.renderOnce()

    // Alpha is one the main agent waits for; the node has no Task link at all. Both end, and one more fails.
    for (const id of [alphaID, nodeID]) {
      app.events.emit(sessionEvent("busy", id))
      app.events.emit(sessionEvent("idle", id))
    }
    app.events.emit(sessionEvent("busy", alphaID))
    app.events.emit(errorEvent(alphaID))
    for (let pass = 0; pass < 10; pass++) await app.setup.renderOnce()
    const quiet = await captureFrame(app.setup)
    expect(quiet).not.toContain("已完成")
    expect(quiet).not.toContain("失败")

    // A permission request is for the user whichever way the sub-agent runs: the toast comes, and it was the first.
    app.events.emit(permissionEvent(nodeID))
    const frame = await waitForFrame(app.setup, (value) => value.includes("agent 需要权限 · /agents"), "the reminder")
    expect(frame).not.toContain("已完成")
    const { row, column } = locate(frame, "agent 需要权限 · /agents")
    await app.setup.mockMouse.click(column + 2, row)
    await waitFor(() => fake.childReads().includes(nodeID))
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("a sub-agent that asks for permission leaves a toast too, in English as well", async () => {
  const fake = server()
  const app = await runApp({
    sessions: tree,
    args: { sessionID: rootID },
    width: 120,
    height: 30,
    handler: english(fake.handler),
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes(PROMPT_MARK), "the prompt")
    await waitFor(() => fake.messageReads.includes(rootID))
    for (let pass = 0; pass < 5; pass++) await app.setup.renderOnce()

    app.events.emit(permissionEvent(alphaID))
    const frame = await waitForFrame(
      app.setup,
      (value) => value.includes("explore needs permission · /agents"),
      "the reminder",
    )
    const { row, column } = locate(frame, "explore needs permission · /agents")
    await app.setup.mockMouse.click(column + 2, row)
    await waitFor(() => fake.childReads().includes(alphaID))
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("the sub-agent the user is looking at leaves no toast, and another one's result does", async () => {
  const fake = server()
  const app = await runApp({
    sessions: tree,
    args: { sessionID: charlieID },
    width: 120,
    height: 30,
    handler: fake.handler,
  })
  try {
    await waitFor(() => fake.messageReads.includes(charlieID))
    await waitFor(() => fake.messageReads.includes(rootID))
    for (let pass = 0; pass < 5; pass++) await app.setup.renderOnce()

    app.events.emit(resultEvent(charlieID))
    // Another background sub-agent that is not on screen does leave one: the reminder works, it is only quiet for this
    // one. Its toast would have come second, so the click below also shows the first never was.
    app.events.emit(resultEvent(bravoID))
    const frame = await waitForFrame(app.setup, (value) => value.includes("explore 已完成"), "the other reminder")
    expect(frame.split("explore 已完成").length - 1).toBe(1)
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})
