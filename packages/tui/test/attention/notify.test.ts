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

/** The footer and the route as the reminders see them: the toasts shown, the sessions entered, the session on screen. */
function reminders(viewing?: string) {
  const toasts: ToastOptions[] = []
  const opened: string[] = []
  let current = viewing
  const value: SubagentReminders = {
    toast: { show: (options) => void toasts.push(options) },
    viewing: () => current,
    task: (sessionID) => links[sessionID],
    open: (sessionID) => void opened.push(sessionID),
  }
  return {
    value,
    toasts,
    opened,
    view(sessionID?: string) {
      current = sessionID
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

describe("sub-agent reminders", () => {
  test("a sub-agent that finishes while the user is elsewhere leaves a toast that goes into it", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(busy("subagent"))
    harness.emit(idle("subagent"))

    expect(footer.toasts).toHaveLength(1)
    expect(footer.toasts[0]).toMatchObject({
      text: "explore finished",
      level: "info",
      dedupeKey: "subagent.done.subagent",
    })
    // Clicking it is the way in: `openSubAgent` of the app, with the session this toast is about.
    footer.toasts[0]?.onActivate?.()
    expect(footer.opened).toEqual(["subagent"])
    // The sound and the no-system-notification rule stay as they were.
    expect(harness.notifications).toEqual([
      {
        title: "Subagent session",
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
    ])
  })

  test("says the Chinese text when the interface is Chinese", () => {
    setLanguage("zh-CN")
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(busy("subagent"))
    harness.emit(idle("subagent"))
    harness.emit({ id: "event-3", type: "permission.asked", properties: permission("permission-1", "subagent") })
    harness.emit(busy("subagent"))
    harness.emit(failed("subagent"))

    expect(footer.toasts.map((toast) => [toast.text, toast.level])).toEqual([
      ["explore 已完成", "info"],
      ["explore 需要权限 · /agents", "warning"],
      ["explore 失败", "error"],
    ])
  })

  test("a failed sub-agent leaves an error toast, and its idle afterwards is not a second reminder", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(busy("subagent"))
    harness.emit(failed("subagent"))
    harness.emit(idle("subagent"))

    expect(footer.toasts).toHaveLength(1)
    expect(footer.toasts[0]).toMatchObject({
      text: "explore failed",
      level: "error",
      dedupeKey: "subagent.failed.subagent",
    })
    footer.toasts[0]?.onActivate?.()
    expect(footer.opened).toEqual(["subagent"])
    expect(harness.notifications.map((each) => each.sound.name)).toEqual(["error"])
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

  test("the sub-agent the user is looking at leaves no toast, and the sound still plays", () => {
    const footer = reminders("subagent")
    const harness = setup(footer.value)

    harness.emit({ id: "event-1", type: "permission.asked", properties: permission("permission-1", "subagent") })
    harness.emit(busy("subagent"))
    harness.emit(idle("subagent"))
    harness.emit(busy("subagent"))
    harness.emit(failed("subagent"))

    expect(footer.toasts).toEqual([])
    expect(harness.notifications.map((each) => each.sound.name)).toEqual(["permission", "subagent_done", "error"])

    // Once the user leaves it, the next reminder comes.
    footer.view("session")
    harness.emit({ id: "event-2", type: "permission.asked", properties: permission("permission-2", "subagent") })
    expect(footer.toasts).toHaveLength(1)
  })

  test("home counts as elsewhere", () => {
    const footer = reminders(undefined)
    const harness = setup(footer.value)

    harness.emit(busy("subagent"))
    harness.emit(idle("subagent"))

    expect(footer.toasts.map((toast) => toast.text)).toEqual(["explore finished"])
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

  test("a sub-agent that is not a background one leaves no toast when it finishes or fails, only its sound", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(busy("foreground"))
    harness.emit(idle("foreground"))
    harness.emit(busy("foreground"))
    harness.emit(failed("foreground"))

    expect(footer.toasts).toEqual([])
    expect(harness.notifications.map((each) => [each.sound.name, each.notification])).toEqual([
      ["subagent_done", false],
      ["error", false],
    ])
  })

  test("a DAG node session leaves no toast when it finishes or fails: it has no Task link, so no background", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(busy("node"))
    harness.emit(idle("node"))
    harness.emit(busy("node"))
    harness.emit(failed("node"))

    expect(footer.toasts).toEqual([])
    expect(harness.notifications.map((each) => each.sound.name)).toEqual(["subagent_done", "error"])
  })

  test("a background sub-agent that fails leaves its toast, and one that is waited for does not", () => {
    const footer = reminders("session")
    const harness = setup(footer.value)

    harness.emit(busy("foreground"))
    harness.emit(failed("foreground"))
    harness.emit(busy("subagent"))
    harness.emit(failed("subagent"))

    expect(footer.toasts.map((toast) => toast.dedupeKey)).toEqual(["subagent.failed.subagent"])
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
    footer.view("node")
    harness.emit({ id: "event-4", type: "permission.asked", properties: permission("permission-4", "node") })
    expect(footer.toasts).toHaveLength(3)
  })

  test("without reminders a sub-agent only plays its sound", () => {
    const harness = setup()

    harness.emit(busy("subagent"))
    harness.emit(idle("subagent"))

    expect(harness.notifications).toHaveLength(1)
  })
})
