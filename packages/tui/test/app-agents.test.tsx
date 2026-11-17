// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import type { AssistantMessage, GlobalEvent, ToolPart } from "@graphagent/sdk"
import { setLanguage } from "../src/i18n"
import { PROMPT_MARK, runApp, waitFor, waitForFrame, type Setup } from "./fixture/run-app"
import { directory, json, type FetchHandler } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

// The real app against a fake server: `/agents` in a main session and in a sub-agent view, what opening it asks the
// server, where its action leads, and the footer toast a sub-agent leaves when the user is not looking at it
// (#1033 5, 6).

const rootID = "ses_agents_root"
const alphaID = "ses_agents_a"
const bravoID = "ses_agents_b"
const charlieID = "ses_agents_c"

afterEach(() => {
  setLanguage("zh-CN")
})

// `a` and `b` were created at the same instant, so their ids settle the order; `c` is the newest.
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

function taskPart(childID: string, description: string): ToolPart {
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
      metadata: { sessionID: childID },
      time: { start: 10, end: 11 },
    },
  }
}

/** The fake server's side: the root's transcript with the three Task links, and a record of the messages read. */
function server() {
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
            taskPart(bravoID, "Inspect bravo"),
            taskPart(charlieID, "Inspect charlie"),
          ],
        },
      ])
    }
    return undefined
  }
  return { handler, messageReads, childReads: () => messageReads.filter((id) => id !== rootID) }
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

test("/agents lists the sub-agents of the main session in walking order and loads none of them", async () => {
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
    const order = ["Inspect alpha", "Inspect bravo", "Inspect charlie"].map((text) => frame.indexOf(text))
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(order.every((position) => position > 0)).toBe(true)
    // Nothing was ever reported busy, so each reads as done, with no tool count and the time the session has.
    expect(frame).toContain("已完成 · 工具 — ·")
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
    await waitFor(() => fake.childReads().includes(bravoID))
    const frame = await waitForFrame(
      app.setup,
      (value) => !value.includes(PROMPT_MARK) && !value.includes("explore · Inspect bravo"),
      "the sub-agent view",
    )
    // A sub-agent view has no input; the one the user chose is the only session that was loaded.
    expect(frame).not.toContain(PROMPT_MARK)
    expect(fake.childReads()).toEqual([bravoID])
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
    expect(input?.plainText).toBe("first, release notes\nPlease handle the subagent explore · Inspect bravo:")
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
    expect(input?.plainText).toBe("Please handle the subagent explore · Inspect alpha:")
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

// ── reminders ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The row of the frame that holds `text`, and where in it: what a click on that text needs. */
function locate(frame: string, text: string) {
  const rows = frame.split("\n")
  const row = rows.findIndex((line) => line.includes(text))
  return { row, column: row < 0 ? -1 : rows[row].indexOf(text) }
}

test("a sub-agent that finishes while the user is in the main session leaves a toast that goes into it", async () => {
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

    app.events.emit(sessionEvent("busy", charlieID))
    app.events.emit(sessionEvent("idle", charlieID))
    const frame = await waitForFrame(app.setup, (value) => value.includes("explore 已完成"), "the reminder")
    expect(fake.childReads()).toEqual([])

    const { row, column } = locate(frame, "explore 已完成")
    await app.setup.mockMouse.click(column + 2, row)
    await waitFor(() => fake.childReads().includes(charlieID))
    await waitForFrame(app.setup, (value) => !value.includes(PROMPT_MARK), "the sub-agent view")
    expect(app.writes()).toEqual([])
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

test("the sub-agent the user is looking at leaves no toast", async () => {
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

    app.events.emit(sessionEvent("busy", charlieID))
    app.events.emit(sessionEvent("idle", charlieID))
    // Another sub-agent that is not on screen does leave one: the reminder works, it is only quiet for this one.
    app.events.emit(sessionEvent("busy", alphaID))
    app.events.emit(sessionEvent("idle", alphaID))
    const frame = await waitForFrame(app.setup, (value) => value.includes("explore 已完成"), "the other reminder")
    expect(frame.split("explore 已完成").length - 1).toBe(1)
    const { row, column } = locate(frame, "explore 已完成")
    await app.setup.mockMouse.click(column + 2, row)
    await waitFor(() => fake.childReads().includes(alphaID))
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})
