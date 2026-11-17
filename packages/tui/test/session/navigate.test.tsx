// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import type { AssistantMessage, Session, SessionStatus, ToolPart } from "@graphagent/sdk"
import { setLanguage } from "../../src/i18n"
import type { Route } from "../../src/context/route"
import { createSummary } from "../../src/context/session-summary"
import { openSubAgent, returnToParent } from "../../src/session/navigate"
import type { ToastOptions } from "../../src/ui/toast"
import { AppRoutes } from "../fixture/route-frame"
import { directory, json, type FetchHandler } from "../fixture/tui-sdk"
import { mountRoute, sessionFixture, waitFor } from "../routes/dag-mode-harness"

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

// Every way into a sub-agent goes through `openSubAgent`, and the sibling keys walk the order of the `/agents` list
// (`subagentSiblings`). These tests use the real session route inside the app frame, the way `app.tsx` mounts it, and
// assert that nothing is written to the server on the way (a sub-agent view is read-only).

const rootID = "ses_nav_root"
const firstID = "ses_nav_a"
const secondID = "ses_nav_b"
const thirdID = "ses_nav_c"
const otherID = "ses_nav_other"
const strangerID = "ses_nav_stranger"
const soloID = "ses_nav_solo"

// `a` and `b` were created at the same instant, so their ids settle a tie, and `c` is the newest. The stranger belongs
// to another tree and was created between `b` and `c`: it must never show up in the walk. `solo` has no sub-agents at
// all.
const tree: Session[] = [
  sessionFixture(rootID),
  sessionFixture(firstID, { parentID: rootID, time: { created: 10, updated: 11 } }),
  sessionFixture(secondID, { parentID: rootID, time: { created: 10, updated: 12 } }),
  sessionFixture(thirdID, { parentID: rootID, time: { created: 20, updated: 21 } }),
  sessionFixture(otherID),
  sessionFixture(strangerID, { parentID: otherID, time: { created: 15, updated: 16 } }),
  sessionFixture(soloID),
]

type Harness = Awaited<ReturnType<typeof mountTree>>

async function mountTree(
  options: { route?: Route; sessions?: readonly Session[]; handler?: FetchHandler; language?: "zh-CN" | "en" } = {},
) {
  const harness = await mountRoute({
    route: options.route ?? { type: "session", sessionID: rootID },
    view: () => <AppRoutes />,
    frame: true,
    sessions: options.sessions ?? tree,
    handler: options.handler,
    language: options.language,
  })
  try {
    await waitFor(() => harness.sync().status === "complete", 10_000)
  } catch (error) {
    await harness.dispose()
    throw error
  }
  return harness
}

/**
 * The states the list is ordered by: `b` is a background run that goes on, `a` a foreground one that runs, and nothing
 * is known of `c`. The list is `b`, `a`, `c`: background, foreground, then the rest.
 */
function seedStates(harness: Harness) {
  const sync = harness.sync()
  const byID = (id: string) => tree.find((each) => each.id === id)!
  sync.set("summary", secondID, { ...createSummary(byID(secondID), { type: "busy" }), toolCalls: 2 })
  sync.set("summary", firstID, { ...createSummary(byID(firstID), { type: "busy" }), toolCalls: 1 })
  sync.set("taskIndex", secondID, {
    parentSessionID: rootID,
    parentMessageID: "msg_nav",
    partID: "prt_nav_b",
    background: true,
    startedAt: 11,
  })
  sync.set("lifecycle", `job:${secondID}`, { domain: "job", id: secondID, value: "running", phase: "running", at: 1 })
}

/** The session on screen, or the route type when it is not a session. */
function viewing(harness: Harness) {
  const data = harness.route().data
  return data.type === "session" ? data.sessionID : data.type
}

async function arrow(harness: Harness, key: "left" | "right") {
  harness.app.mockInput.pressArrow(key)
  await harness.settle()
}

/** The default key of `session.child.first`, a leader sequence. */
async function leaderDown(harness: Harness) {
  harness.app.mockInput.pressKey("x", { ctrl: true })
  await harness.app.renderOnce()
  harness.app.mockInput.pressArrow("down")
  await harness.settle()
}

function toastText(harness: Harness) {
  return harness.toast().currentToast?.text
}

test("right and left walk the sub-agents of one parent in the order of the list and wrap at both ends", async () => {
  const harness = await mountTree({ route: { type: "session", sessionID: firstID } })
  try {
    expect(viewing(harness)).toBe(firstID)
    seedStates(harness)
    await harness.settle()

    // The list is `b` (background), `a` (foreground), `c` (the rest); the stranger of the other tree is skipped.
    // After the last comes the first. The top bar's `i/N` counts the same sequence (test/app-subagent-view.test.tsx).
    const forward: string[] = []
    for (let step = 0; step < 4; step++) {
      await arrow(harness, "right")
      forward.push(viewing(harness))
    }
    expect(forward).toEqual([thirdID, secondID, firstID, thirdID])

    const backward: string[] = []
    for (let step = 0; step < 4; step++) {
      await arrow(harness, "left")
      backward.push(viewing(harness))
    }
    expect(backward).toEqual([firstID, secondID, thirdID, firstID])

    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("with no state known, the walk is newest first: ties by id, the other tree's session skipped", async () => {
  const harness = await mountTree({ route: { type: "session", sessionID: thirdID } })
  try {
    // The list is `c`, `a`, `b`.
    const forward: string[] = []
    for (let step = 0; step < 4; step++) {
      await arrow(harness, "right")
      forward.push(viewing(harness))
    }
    expect(forward).toEqual([firstID, secondID, thirdID, firstID])
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a sub-agent that is alone under its parent stays where it is", async () => {
  const harness = await mountTree({ route: { type: "session", sessionID: strangerID } })
  try {
    await arrow(harness, "right")
    expect(viewing(harness)).toBe(strangerID)
    await arrow(harness, "left")
    expect(viewing(harness)).toBe(strangerID)
    expect(toastText(harness)).toBeUndefined()
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("the key that opens the first sub-agent opens the first one of the list: the background run", async () => {
  const harness = await mountTree()
  try {
    seedStates(harness)
    await harness.settle()
    await leaderDown(harness)
    expect(viewing(harness)).toBe(secondID)
    // From there the sibling keys carry on in the same order.
    await arrow(harness, "right")
    expect(viewing(harness)).toBe(firstID)
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("inside a sub-agent the first-sub-agent key goes to the first of its siblings", async () => {
  const harness = await mountTree({ route: { type: "session", sessionID: thirdID } })
  try {
    seedStates(harness)
    await harness.settle()
    await leaderDown(harness)
    expect(viewing(harness)).toBe(secondID)
    // Already on the first: nothing to move to, and nothing to say.
    await leaderDown(harness)
    expect(viewing(harness)).toBe(secondID)
    expect(toastText(harness)).toBeUndefined()
  } finally {
    await harness.dispose()
  }
})

test("without sub-agents the first-sub-agent key stays put and says so in the footer, in both languages", async () => {
  for (const [language, text] of [
    ["zh-CN", "当前会话没有子 agent"],
    ["en", "This session has no subagents"],
  ] as const) {
    const harness = await mountTree({ route: { type: "session", sessionID: soloID }, language })
    try {
      await leaderDown(harness)
      expect(viewing(harness)).toBe(soloID)
      expect(harness.toast().currentToast).toMatchObject({ level: "info", text })
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  }
})

const assistant: AssistantMessage = {
  id: "msg_nav_assistant",
  sessionID: rootID,
  parentID: "msg_nav_user",
  role: "assistant",
  agent: "build",
  mode: "build",
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

/** The root's transcript: one answer that started three sub-agents, listed here out of creation order. */
const taskRows: FetchHandler = (url) => {
  if (url.pathname !== `/session/${rootID}/message`) return undefined
  return json([
    {
      info: assistant,
      parts: [
        taskPart(thirdID, "Inspect charlie"),
        taskPart(firstID, "Inspect alpha"),
        taskPart(secondID, "Inspect bravo"),
      ],
    },
  ])
}

async function clickRow(harness: Harness, text: string) {
  const frame = await harness.waitForFrame((current) => current.includes(text), `the row "${text}"`)
  const rows = frame.split("\n")
  const row = rows.findIndex((line) => line.includes(text))
  await harness.app.mockMouse.click(rows[row].indexOf(text) + 2, row)
}

test("clicking a Task row opens the sub-agent that row started", async () => {
  const harness = await mountTree({ handler: taskRows })
  try {
    await clickRow(harness, "Task — Inspect bravo")
    await waitFor(() => viewing(harness) === secondID)
    await harness.settle()
    expect(viewing(harness)).toBe(secondID)
    // Not retrying, so the way in said nothing.
    expect(toastText(harness)).toBeUndefined()
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("clicking the Task row of a sub-agent that is retrying says why in the footer", async () => {
  const harness = await mountTree({ handler: taskRows })
  try {
    const retrying: SessionStatus = { type: "retry", attempt: 3, message: "rate limited", next: 0 }
    harness.sync().set("session_status", thirdID, retrying)
    await clickRow(harness, "Task — Inspect charlie")
    await waitFor(() => viewing(harness) === thirdID)
    expect(harness.toast().currentToast).toMatchObject({ level: "warning", text: "子 agent 正在重试：rate limited" })
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

const notFoundBody = { name: "NotFoundError", data: { message: "disk gone" } }

/** A fake server that answers `GET /session/:id` with a chosen reply, from the moment a test breaks that id. */
function brokenSessions() {
  const replies = new Map<string, () => Response>()
  const handler: FetchHandler = (url, request) => {
    const id = url.pathname.match(/^\/session\/([^/]+)$/)?.[1]
    const reply = id ? replies.get(id) : undefined
    return reply && (request?.method ?? "GET") === "GET" ? reply() : undefined
  }
  return { handler, break: (id: string, reply: () => Response) => replies.set(id, reply) }
}

test("a sub-agent the server has no record of sends the user back to its parent session", async () => {
  const server = brokenSessions()
  const harness = await mountTree({ handler: server.handler })
  try {
    server.break(secondID, () => json(null))
    harness.route().navigate({ type: "session", sessionID: secondID })
    await waitFor(() => viewing(harness) === rootID)
    expect(harness.toast().currentToast).toMatchObject({
      level: "error",
      text: "找不到这个子 agent 会话，已回到父会话",
    })
    await harness.settle()
    // The user stays in the parent session: no detour through home.
    expect(viewing(harness)).toBe(rootID)
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a sub-agent that fails to load sends the user back to its parent session with the reason", async () => {
  const server = brokenSessions()
  const harness = await mountTree({ handler: server.handler, language: "en" })
  try {
    server.break(thirdID, () => json(notFoundBody, { status: 404 }))
    harness.route().navigate({ type: "session", sessionID: thirdID })
    await waitFor(() => viewing(harness) === rootID)
    expect(harness.toast().currentToast).toMatchObject({
      level: "error",
      text: "Could not open the subagent session; back in the parent session: disk gone",
    })
    await harness.settle()
    expect(viewing(harness)).toBe(rootID)
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a main session the server has no record of still goes home with its old message", async () => {
  const server = brokenSessions()
  const harness = await mountTree({ handler: server.handler })
  try {
    server.break(soloID, () => json(null))
    harness.route().navigate({ type: "session", sessionID: soloID })
    await waitFor(() => viewing(harness) === "home")
    expect(harness.toast().currentToast).toMatchObject({ level: "error", text: `Session not found: ${soloID}` })
  } finally {
    await harness.dispose()
  }
})

test("a main session that fails to load still goes home with the error", async () => {
  const server = brokenSessions()
  const harness = await mountTree({ handler: server.handler })
  try {
    server.break(soloID, () => json(notFoundBody, { status: 404 }))
    harness.route().navigate({ type: "session", sessionID: soloID })
    await waitFor(() => viewing(harness) === "home")
    expect(harness.toast().currentToast).toMatchObject({ level: "error", text: "disk gone" })
  } finally {
    await harness.dispose()
  }
})

// `openSubAgent` and `returnToParent` with fakes: what they do to the route and the footer, in both languages.

function fakes(status: Record<string, SessionStatus | undefined> = {}) {
  const routes: Route[] = []
  const toasts: ToastOptions[] = []
  return {
    routes,
    toasts,
    input: {
      route: { navigate: (route: Route) => routes.push(route) },
      sync: { data: { session_status: status } },
      toast: { show: (options: ToastOptions) => toasts.push(options) },
    },
  }
}

test("openSubAgent moves to the session and stays quiet when it is not retrying", () => {
  const { routes, toasts, input } = fakes({ [firstID]: { type: "busy" }, [secondID]: { type: "idle" } })
  openSubAgent(firstID, input)
  openSubAgent(secondID, input)
  openSubAgent(thirdID, input)
  expect(routes).toEqual([
    { type: "session", sessionID: firstID },
    { type: "session", sessionID: secondID },
    { type: "session", sessionID: thirdID },
  ])
  expect(toasts).toEqual([])
})

test("openSubAgent says that the session is retrying, in either language, with the message made safe to show", () => {
  const status: SessionStatus = {
    type: "retry",
    attempt: 1,
    message: "\u001b[31mrate\u001b[0m limited\nretry in 5s",
    next: 0,
  }
  for (const [language, text] of [
    ["zh-CN", "子 agent 正在重试：rate limited retry in 5s"],
    ["en", "The subagent is retrying: rate limited retry in 5s"],
  ] as const) {
    setLanguage(language)
    const { routes, toasts, input } = fakes({ [firstID]: status })
    openSubAgent(firstID, input)
    expect(routes).toEqual([{ type: "session", sessionID: firstID }])
    expect(toasts).toEqual([{ text, level: "warning", dedupeKey: "subagent.retry" }])
  }
})

test("returnToParent goes to the parent session and says why, in either language", () => {
  const cases = [
    [
      { kind: "notFound" },
      "error",
      "找不到这个子 agent 会话，已回到父会话",
      "Subagent session not found; back in the parent session",
    ],
    [
      { kind: "deleted" },
      "info",
      "这个子 agent 会话已被删除，已回到父会话",
      "The subagent session was deleted; back in the parent session",
    ],
    [
      { kind: "failed", message: "boom\nsecond line" },
      "error",
      "无法打开这个子 agent 会话，已回到父会话：boom second line",
      "Could not open the subagent session; back in the parent session: boom second line",
    ],
  ] as const
  for (const [loss, level, zh, en] of cases) {
    for (const [language, text] of [
      ["zh-CN", zh],
      ["en", en],
    ] as const) {
      setLanguage(language)
      const { routes, toasts, input } = fakes()
      returnToParent(rootID, loss, input)
      expect(routes).toEqual([{ type: "session", sessionID: rootID }])
      expect(toasts).toMatchObject([{ text, level, dedupeKey: "subagent.unavailable" }])
    }
  }
})
