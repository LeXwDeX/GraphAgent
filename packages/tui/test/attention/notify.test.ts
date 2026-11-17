import { beforeEach, describe, expect, test } from "bun:test"
import { createTuiNotifications, type SubagentReminders } from "../../src/attention/notify"
import { setLanguage } from "../../src/i18n"
import type { ToastOptions } from "../../src/ui/toast"
import type { Event, PermissionRequest, QuestionRequest, Session } from "@graphagent/sdk"

function setup(subagent?: SubagentReminders) {
  const notifications: {
    title?: string
    message: string
    notification: false | { when: "blurred" }
    sound: { name: string; when: "always" }
  }[] = []
  const handlers = new Map<Event["type"], ((event: Event) => void)[]>()
  const session = (id: string, title: string, parentID?: string): Session => ({
    id,
    title,
    slug: id,
    projectID: "project",
    directory: "/workspace",
    ...(parentID && { parentID }),
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  })
  const sessions: Record<string, Session> = {
    session: session("session", "Demo session"),
    subagent: session("subagent", "Subagent session", "session"),
    foreground: session("foreground", "Foreground session", "session"),
    node: session("node", "Inspect lockfile (DAG node)", "session"),
    agented: { ...session("agented", "Agented session", "session"), agent: "build" },
    plain: session("plain", "Plain session", "session"),
    abort: session("abort", "Abort session"),
    timeout: session("timeout", "Timeout session"),
  }

  const dispose = createTuiNotifications({
    event: {
      on: <Type extends Event["type"]>(type: Type, handler: (event: Extract<Event, { type: Type }>) => void) => {
        const list = handlers.get(type) ?? []
        const wrapped = handler as (event: Event) => void
        list.push(wrapped)
        handlers.set(type, list)
        return () => {
          handlers.set(
            type,
            (handlers.get(type) ?? []).filter((item) => item !== wrapped),
          )
        }
      },
    },
    sessions: {
      get: (sessionID: string) => sessions[sessionID],
    },
    attention: {
      async notify(input) {
        notifications.push(input)
        return { ok: true, notification: true, sound: true }
      },
    },
    subagent,
  })

  return {
    notifications,
    dispose,
    emit(event: Event) {
      for (const handler of handlers.get(event.type) ?? []) handler(event)
    },
  }
}

function question(id: string, sessionID = "session"): QuestionRequest {
  return {
    id,
    sessionID,
    questions: [],
  }
}

function permission(id: string, sessionID = "session"): PermissionRequest {
  return {
    id,
    sessionID,
    permission: "edit",
    patterns: [],
    metadata: {},
    always: [],
  }
}

const questionNotification = {
  title: "Demo session",
  message: "Question needs input",
  notification: { when: "blurred" as const },
  sound: { name: "question", when: "always" as const },
}

const permissionNotification = {
  title: "Demo session",
  message: "Permission needs input",
  notification: { when: "blurred" as const },
  sound: { name: "permission", when: "always" as const },
}

beforeEach(() => {
  setLanguage("en")
})

describe("internal attention notifications", () => {
  test("notifies for question and permission requests with blurred notifications and always-on sounds", () => {
    const harness = setup()

    harness.emit({ id: "event-1", type: "question.asked", properties: question("question-1") })
    harness.emit({ id: "event-2", type: "permission.asked", properties: permission("permission-1") })

    expect(harness.notifications).toEqual([questionNotification, permissionNotification])
  })

  test("dedupes pending questions and permissions until they are resolved", () => {
    const harness = setup()

    harness.emit({ id: "event-1", type: "question.asked", properties: question("question-1") })
    harness.emit({ id: "event-2", type: "question.asked", properties: question("question-1") })
    harness.emit({
      id: "event-3",
      type: "question.replied",
      properties: { sessionID: "session", requestID: "question-1", answers: [] },
    })
    harness.emit({ id: "event-4", type: "question.asked", properties: question("question-1") })

    harness.emit({ id: "event-5", type: "permission.asked", properties: permission("permission-1") })
    harness.emit({ id: "event-6", type: "permission.asked", properties: permission("permission-1") })
    harness.emit({
      id: "event-7",
      type: "permission.replied",
      properties: { sessionID: "session", requestID: "permission-1", reply: "once" },
    })
    harness.emit({ id: "event-8", type: "permission.asked", properties: permission("permission-1") })

    expect(harness.notifications).toEqual([
      questionNotification,
      questionNotification,
      permissionNotification,
      permissionNotification,
    ])
  })

  test("notifies when an active session becomes idle and suppresses no-op idle", () => {
    const harness = setup()

    harness.emit({
      id: "event-1",
      type: "session.status",
      properties: { sessionID: "session", status: { type: "idle" } },
    })
    harness.emit({
      id: "event-2",
      type: "session.status",
      properties: { sessionID: "session", status: { type: "busy" } },
    })
    harness.emit({
      id: "event-3",
      type: "session.status",
      properties: { sessionID: "session", status: { type: "idle" } },
    })

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("uses sound-only notifications and subagent_done sound for subagent sessions", () => {
    const harness = setup()

    harness.emit({ id: "event-1", type: "question.asked", properties: question("question-1", "subagent") })
    harness.emit({
      id: "event-2",
      type: "session.status",
      properties: { sessionID: "subagent", status: { type: "busy" } },
    })
    harness.emit({
      id: "event-3",
      type: "session.status",
      properties: { sessionID: "subagent", status: { type: "idle" } },
    })

    expect(harness.notifications).toEqual([
      {
        title: "Subagent session",
        message: "Question needs input",
        notification: false,
        sound: { name: "question", when: "always" },
      },
      {
        title: "Subagent session",
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
    ])
  })

  test("notifies session errors once and suppresses the following idle done notification", () => {
    const harness = setup()

    harness.emit({
      id: "event-1",
      type: "session.status",
      properties: { sessionID: "session", status: { type: "busy" } },
    })
    harness.emit({
      id: "event-2",
      type: "session.error",
      properties: { sessionID: "session", error: { name: "UnknownError", data: { message: "boom" } } },
    })
    harness.emit({
      id: "event-3",
      type: "session.status",
      properties: { sessionID: "session", status: { type: "idle" } },
    })

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session error",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
    ])
  })

  test("special-cases aborts and model response timeouts", () => {
    const harness = setup()

    harness.emit({
      id: "event-1",
      type: "session.status",
      properties: { sessionID: "abort", status: { type: "busy" } },
    })
    harness.emit({
      id: "event-2",
      type: "session.error",
      properties: { sessionID: "abort", error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
    })
    harness.emit({
      id: "event-3",
      type: "session.status",
      properties: { sessionID: "timeout", status: { type: "busy" } },
    })
    harness.emit({
      id: "event-4",
      type: "session.error",
      properties: { sessionID: "timeout", error: { name: "UnknownError", data: { message: "SSE read timed out" } } },
    })

    expect(harness.notifications).toEqual([
      {
        title: "Abort session",
        message: "Session aborted",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
      {
        title: "Timeout session",
        message: "Model stopped responding",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
    ])
  })

  test("dispose unsubscribes every handler", () => {
    const harness = setup()

    harness.dispose()
    harness.emit({ id: "event-1", type: "question.asked", properties: question("question-1") })

    expect(harness.notifications).toEqual([])
  })
})

/** The parent's Task links, as the data layer keeps them: one background sub-agent, one that is waited for. */
const links: Record<string, { kind: string; background: boolean }> = {
  subagent: { kind: "explore", background: true },
  foreground: { kind: "explore", background: false },
}

/**
 * The footer and the route as the reminders see them: the toasts shown, the sessions entered, the sessions the result
 * cards were asked for, the session on screen and the root of its tree.
 */
function reminders(viewing?: string, root: string | undefined = viewing === undefined ? undefined : "session") {
  const toasts: ToastOptions[] = []
  const opened: string[] = []
  /** The session and the message each click on a result toast goes to. */
  const results: [string, string][] = []
  let current = viewing
  let currentRoot = root
  const value: SubagentReminders = {
    toast: { show: (options) => void toasts.push(options) },
    viewing: () => current,
    currentRoot: () => currentRoot,
    task: (sessionID) => links[sessionID],
    open: (sessionID) => void opened.push(sessionID),
    openResult: (sessionID, messageID) => void results.push([sessionID, messageID]),
  }
  return {
    value,
    toasts,
    opened,
    results,
    view(sessionID?: string, root?: string) {
      current = sessionID
      currentRoot = root
    },
  }
}

const busy = (sessionID: string): Event => ({
  id: `busy-${sessionID}`,
  type: "session.status",
  properties: { sessionID, status: { type: "busy" } },
})
const idle = (sessionID: string): Event => ({
  id: `idle-${sessionID}`,
  type: "session.status",
  properties: { sessionID, status: { type: "idle" } },
})
const failed = (sessionID: string, name: "UnknownError" | "MessageAbortedError" = "UnknownError"): Event => ({
  id: `error-${sessionID}`,
  type: "session.error",
  properties: { sessionID, error: { name, data: { message: "boom" } } },
})

/**
 * The message the server adds to the session that started a background run once it ended: a synthetic text part whose
 * metadata names the child and how it ended.
 */
function report(
  childSessionID: string,
  status: "completed" | "error" | "interrupted" = "completed",
  options: { endedAt?: number; sessionID?: string; synthetic?: boolean } = {},
): Event {
  const { endedAt = 200, sessionID = "session", synthetic = true } = options
  return {
    id: `report-${childSessionID}-${endedAt}`,
    type: "message.part.updated",
    properties: {
      sessionID,
      time: endedAt,
      part: {
        id: `prt-${childSessionID}-${endedAt}`,
        sessionID,
        messageID: `msg-${childSessionID}-${endedAt}`,
        type: "text",
        text: "<task_result>done</task_result>",
        synthetic,
        metadata: {
          backgroundResult: { childSessionID, status, title: "scan", initiator: "agent", startedAt: 100, endedAt },
        },
      },
    },
  }
}

describe("sub-agent reminders", () => {
  test("a permission request from a sub-agent leaves a warning toast that goes into it", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit({ id: "event-1", type: "permission.asked", properties: permission("permission-1", "subagent") })

    expect(footer.toasts).toHaveLength(1)
    // Clicking it is the way in: `openSubAgent` of the app, with the session this toast is about.
    footer.toasts[0]?.onActivate?.()
    expect(footer.opened).toEqual(["subagent"])
    expect(footer.results).toEqual([])
  })

  test("says the Chinese text when the interface is Chinese", () => {
    setLanguage("zh-CN")
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(report("subagent", "completed", { endedAt: 1 }))
    harness.emit({ id: "event-3", type: "permission.asked", properties: permission("permission-1", "subagent") })
    harness.emit(report("subagent", "error", { endedAt: 2 }))
    harness.emit(report("subagent", "interrupted", { endedAt: 3 }))

    expect(footer.toasts.map((toast) => [toast.text, toast.level])).toEqual([
      ["explore 已完成 · ⏎ 查看", "success"],
      ["explore 需要权限 · /agents", "warning"],
      ["explore 未完成 · ⏎ 查看", "error"],
      ["explore 未完成 · ⏎ 查看", "error"],
    ])
  })

  test("a sub-agent that asks for permission leaves a warning toast, once per request", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit({ id: "event-1", type: "permission.asked", properties: permission("permission-1", "subagent") })
    harness.emit({ id: "event-2", type: "permission.asked", properties: permission("permission-1", "subagent") })

    expect(footer.toasts).toHaveLength(1)
    expect(footer.toasts[0]).toMatchObject({
      text: "explore needs permission · /agents",
      level: "warning",
      dedupeKey: "subagent.permission.subagent",
    })
    footer.toasts[0]?.onActivate?.()
    expect(footer.opened).toEqual(["subagent"])
    expect(harness.notifications).toEqual([
      {
        title: "Subagent session",
        message: "Permission needs input",
        notification: false,
        sound: { name: "permission", when: "always" },
      },
    ])
  })

  test("the sub-agent the user is looking at leaves no toast for a permission request, and the sound still plays", () => {
    const footer = reminders("subagent", "session")
    const harness = setup(footer.value)

    harness.emit({ id: "event-1", type: "permission.asked", properties: permission("permission-1", "subagent") })
    harness.emit(busy("subagent"))
    harness.emit(idle("subagent"))
    harness.emit(busy("subagent"))
    harness.emit(failed("subagent"))

    expect(footer.toasts).toEqual([])
    expect(harness.notifications.map((each) => each.sound.name)).toEqual(["permission", "subagent_done", "error"])

    // Once the user leaves it, the next reminder comes.
    footer.view("session", "session")
    harness.emit({ id: "event-2", type: "permission.asked", properties: permission("permission-2", "subagent") })
    expect(footer.toasts).toHaveLength(1)
  })

  test("a stopped main agent aborts its sub-agents without a failure toast for each", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(busy("subagent"))
    harness.emit(failed("subagent", "MessageAbortedError"))

    expect(footer.toasts).toEqual([])
    expect(harness.notifications.map((each) => each.message)).toEqual(["Session aborted"])
  })

  test("a main session never leaves a sub-agent toast", () => {
    const footer = reminders("subagent")
    const harness = setup(footer.value)

    harness.emit(busy("session"))
    harness.emit(idle("session"))
    harness.emit({ id: "event-1", type: "permission.asked", properties: permission("permission-1") })
    harness.emit(busy("abort"))
    harness.emit(failed("abort"))

    expect(footer.toasts).toEqual([])
    expect(harness.notifications).toHaveLength(3)
  })

  test("a sub-agent's question is a sound and nothing else: sub-agents have no question tool to leave a toast for", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit({ id: "event-1", type: "question.asked", properties: question("question-1", "subagent") })

    expect(footer.toasts).toEqual([])
    expect(harness.notifications.map((each) => each.sound.name)).toEqual(["question"])
  })

  test("names a sub-agent without a Task link by its own agent, or plainly", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit({ id: "event-1", type: "permission.asked", properties: permission("permission-1", "agented") })
    harness.emit({ id: "event-2", type: "permission.asked", properties: permission("permission-2", "plain") })

    expect(footer.toasts.map((toast) => [toast.text, toast.dedupeKey])).toEqual([
      ["build needs permission · /agents", "subagent.permission.agented"],
      ["agent needs permission · /agents", "subagent.permission.plain"],
    ])
  })

  test("a permission request leaves a toast whichever way the sub-agent runs", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit({ id: "event-1", type: "permission.asked", properties: permission("permission-1", "foreground") })
    harness.emit({ id: "event-2", type: "permission.asked", properties: permission("permission-2", "node") })
    harness.emit({ id: "event-3", type: "permission.asked", properties: permission("permission-3", "subagent") })

    expect(footer.toasts.map((toast) => [toast.text, toast.level, toast.dedupeKey])).toEqual([
      ["explore needs permission · /agents", "warning", "subagent.permission.foreground"],
      ["agent needs permission · /agents", "warning", "subagent.permission.node"],
      ["explore needs permission · /agents", "warning", "subagent.permission.subagent"],
    ])
    // Each toast goes into the sub-agent that asked.
    for (const toast of footer.toasts) toast.onActivate?.()
    expect(footer.opened).toEqual(["foreground", "node", "subagent"])
    // And the one the user is looking at is quiet, whichever way it runs.
    footer.view("node", "session")
    harness.emit({ id: "event-4", type: "permission.asked", properties: permission("permission-4", "node") })
    expect(footer.toasts).toHaveLength(3)
  })

  test("without reminders a sub-agent only plays its sound", () => {
    const harness = setup()

    harness.emit(busy("subagent"))
    harness.emit(idle("subagent"))
    harness.emit(report("subagent"))

    expect(harness.notifications).toHaveLength(1)
  })
})

// ── the end of a background run (#1058 7) ─────────────────────────────────────────────────────────────────────────

describe("the result of a background run", () => {
  test("a result that arrives leaves a success toast that brings the user to the card in the main session", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(report("subagent"))

    expect(footer.toasts).toHaveLength(1)
    expect(footer.toasts[0]).toMatchObject({
      text: "explore finished · ⏎ view",
      level: "success",
      dedupeKey: "subagent",
    })
    // Clicking it is not the way into the sub-agent: it goes to the session that holds the result, and to the message
    // the server added there.
    footer.toasts[0]?.onActivate?.()
    expect(footer.results).toEqual([["session", "msg-subagent-200"]])
    expect(footer.opened).toEqual([])
  })

  test("a run that failed or was interrupted leaves an error toast, and one that finished a success one", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(report("subagent", "error", { endedAt: 1 }))
    harness.emit(report("subagent", "interrupted", { endedAt: 2 }))
    harness.emit(report("subagent", "completed", { endedAt: 3 }))

    expect(footer.toasts.map((toast) => [toast.text, toast.level, toast.dedupeKey])).toEqual([
      ["explore did not finish · ⏎ view", "error", "subagent"],
      ["explore did not finish · ⏎ view", "error", "subagent"],
      ["explore finished · ⏎ view", "success", "subagent"],
    ])
  })

  test("the status of the child no longer makes the toast: finishing, failing and the idle after it leave none", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(busy("subagent"))
    harness.emit(idle("subagent"))
    harness.emit(busy("subagent"))
    harness.emit(failed("subagent"))
    harness.emit(idle("subagent"))

    expect(footer.toasts).toEqual([])
    // The sound and the no-system-notification rule stay as they were.
    expect(harness.notifications).toEqual([
      {
        title: "Subagent session",
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
      {
        title: "Subagent session",
        message: "Session error",
        notification: false,
        sound: { name: "error", when: "always" },
      },
    ])
  })

  test("is announced once: the same result arriving again, after a reconnect say, leaves no second toast", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(report("subagent", "completed", { endedAt: 200 }))
    harness.emit(report("subagent", "completed", { endedAt: 200 }))
    // The toast was shown and has long gone: the repeat is still the same result.
    footer.toasts.length = 0
    harness.emit(report("subagent", "completed", { endedAt: 200 }))
    expect(footer.toasts).toEqual([])

    // A task that is resumed and ends again is a new result.
    harness.emit(report("subagent", "completed", { endedAt: 900 }))
    expect(footer.toasts).toHaveLength(1)
  })

  test("a result is announced for the main session's tree and for no other", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    // The user is in another tree: its root is `abort`.
    footer.view("abort", "abort")
    harness.emit(report("subagent", "completed", { endedAt: 1 }))
    // On home there is no tree at all.
    footer.view(undefined, undefined)
    harness.emit(report("subagent", "completed", { endedAt: 2 }))
    expect(footer.toasts).toEqual([])

    // Back in the tree: the next result is announced.
    footer.view("session", "session")
    harness.emit(report("subagent", "completed", { endedAt: 3 }))
    expect(footer.toasts).toHaveLength(1)
  })

  test("a sub-agent view is in the tree: the toast comes while the user is in another sub-agent", () => {
    const footer = reminders("plain", "session")
    const harness = setup(footer.value)

    harness.emit(report("subagent"))

    expect(footer.toasts).toHaveLength(1)
  })

  test("a run that a sub-agent started reports into that sub-agent, which is in the tree too", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(report("node", "completed", { sessionID: "subagent" }))

    expect(footer.toasts).toHaveLength(1)
    // The report is in the sub-agent's transcript: that is where the click goes.
    footer.toasts[0]?.onActivate?.()
    expect(footer.results).toEqual([["subagent", "msg-node-200"]])
  })

  test("the sub-agent the user is looking at leaves no toast, now or when its result comes again", () => {
    const footer = reminders("subagent", "session")
    const harness = setup(footer.value)

    harness.emit(report("subagent", "completed", { endedAt: 200 }))
    expect(footer.toasts).toEqual([])

    footer.view("session", "session")
    harness.emit(report("subagent", "completed", { endedAt: 200 }))
    expect(footer.toasts).toEqual([])
    // Another sub-agent's result is announced all the same.
    harness.emit(report("foreground", "completed", { endedAt: 300 }))
    expect(footer.toasts).toHaveLength(1)
  })

  test("names the sub-agent by its Task link, then its own agent, then plainly", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(report("subagent", "completed", { endedAt: 1 }))
    harness.emit(report("agented", "completed", { endedAt: 2 }))
    harness.emit(report("plain", "completed", { endedAt: 3 }))
    harness.emit(report("unknown-child", "completed", { endedAt: 4 }))

    expect(footer.toasts.map((toast) => toast.text)).toEqual([
      "explore finished · ⏎ view",
      "build finished · ⏎ view",
      "agent finished · ⏎ view",
      "agent finished · ⏎ view",
    ])
  })

  test("only the report of a background run is one: a plain text part, a part the user wrote and a tool part are not", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    const plain = report("subagent")
    if (plain.type === "message.part.updated" && plain.properties.part.type === "text") {
      plain.properties.part.metadata = undefined
    }
    harness.emit(plain)
    // Not synthetic: the user cannot write a report.
    harness.emit(report("subagent", "completed", { synthetic: false, endedAt: 2 }))
    // A result that is not well formed.
    const broken = report("subagent", "completed", { endedAt: 3 })
    if (broken.type === "message.part.updated" && broken.properties.part.type === "text") {
      broken.properties.part.metadata = { backgroundResult: { childSessionID: "subagent", status: "paused" } }
    }
    harness.emit(broken)
    harness.emit({
      id: "tool-1",
      type: "message.part.updated",
      properties: {
        sessionID: "session",
        time: 1,
        part: {
          id: "prt-tool",
          sessionID: "session",
          messageID: "msg-tool",
          type: "tool",
          callID: "call-1",
          tool: "task",
          state: { status: "pending", input: {}, raw: "" },
        },
      },
    })

    expect(footer.toasts).toEqual([])
  })

  test("a run the main agent waits for leaves no toast: its end is the Task call's, not a result", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(busy("foreground"))
    harness.emit(idle("foreground"))
    harness.emit(busy("foreground"))
    harness.emit(failed("foreground"))
    harness.emit(busy("node"))
    harness.emit(idle("node"))

    expect(footer.toasts).toEqual([])
    expect(harness.notifications.map((each) => each.sound.name)).toEqual(["subagent_done", "error", "subagent_done"])
  })

  test("dispose unsubscribes the handler of results as well", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.dispose()
    harness.emit(report("subagent"))

    expect(footer.toasts).toEqual([])
  })
})
