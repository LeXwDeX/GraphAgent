// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Event } from "@graphagent/sdk"
import type { AttentionSoundName } from "../config"
import type { TaskIndexEntry } from "../context/session-summary"
import { t, type MessageKey } from "../i18n"
import { subagentKind } from "../session/subagents"
import type { ToastOptions } from "../ui/toast"

type SessionError = Extract<Event, { type: "session.error" }>["properties"]["error"]

type NotifyInput = {
  title?: string
  message: string
  notification: false | { when: "blurred" }
  sound: { name: AttentionSoundName; when: "always" }
}

/**
 * What a sub-agent reminder needs beyond the sound (#1033 4, 6). Without it a sub-agent session only plays its sound,
 * as before.
 */
export type SubagentReminders = {
  toast: { show(options: ToastOptions): void }
  /** The session on screen: the sub-agent the user is looking at needs no reminder. */
  viewing(): string | undefined
  /**
   * The parent's Task link of a child session: its kind, for the text of the reminder, and whether it runs in the
   * background. A session with no link (a DAG node's) is a sub-agent that does not.
   */
  task(sessionID: string): Pick<TaskIndexEntry, "kind" | "background"> | undefined
  /** Goes into a sub-agent session; `openSubAgent` is the one way in. */
  open(sessionID: string): void
}

type NotificationsInput = {
  event: {
    on<T extends Event["type"]>(type: T, handler: (event: Extract<Event, { type: T }>) => void): () => void
  }
  sessions: {
    get(sessionID: string): { title?: string; parentID?: string; agent?: string } | undefined
  }
  attention: {
    notify(input: NotifyInput): Promise<unknown>
  }
  subagent?: SubagentReminders
}

type SubagentReminder = "permission" | "done" | "failed"

const REMINDER_TEXT: Record<SubagentReminder, MessageKey> = {
  permission: "subagent.toast.permission",
  done: "subagent.toast.done",
  failed: "subagent.toast.failed",
}

const REMINDER_LEVEL: Record<SubagentReminder, ToastOptions["level"]> = {
  permission: "warning",
  done: "info",
  failed: "error",
}

function sessionErrorMessage(error: SessionError) {
  if (error?.name === "MessageAbortedError") return t("attention.aborted")
  const data = error?.data
  if (data && typeof data === "object" && "message" in data && data.message === "SSE read timed out") {
    return t("attention.modelTimeout")
  }
  return t("attention.error")
}

/**
 * Built-in session attention notifications: pending questions and permissions,
 * completed turns, and session errors. Subagent sessions play a sound and never
 * raise a system notification. When the caller passes `subagent`, a sub-agent
 * that is not on screen also leaves a footer toast that goes into it: when it
 * asks for permission, whichever way it runs, and when a background one
 * finishes or fails. The others report to the main agent, which is what the user
 * is waiting on, and DAG nodes have their own progress display.
 * Returns the disposer that unsubscribes every event handler.
 */
export function createTuiNotifications(input: NotificationsInput): () => void {
  const active = new Set<string>()
  const errored = new Set<string>()
  const questions = new Set<string>()
  const permissions = new Set<string>()

  function notify(sessionID: string | undefined, message: string, sound: AttentionSoundName) {
    const session = sessionID ? input.sessions.get(sessionID) : undefined
    const isSubagent = session?.parentID !== undefined
    void input.attention.notify({
      title: session?.title,
      message,
      notification: isSubagent ? false : { when: "blurred" },
      sound: { name: sound, when: "always" },
    })
  }

  function remind(sessionID: string | undefined, reminder: SubagentReminder) {
    const reminders = input.subagent
    if (!reminders || !sessionID) return
    const session = input.sessions.get(sessionID)
    if (session?.parentID === undefined) return
    if (reminders.viewing() === sessionID) return
    const task = reminders.task(sessionID)
    if (reminder !== "permission" && task?.background !== true) return
    const kind = subagentKind({ title: session.title ?? "", agent: session.agent }, task)
    reminders.toast.show({
      text: t(REMINDER_TEXT[reminder], { kind }),
      level: REMINDER_LEVEL[reminder],
      dedupeKey: `subagent.${reminder}.${sessionID}`,
      onActivate: () => reminders.open(sessionID),
    })
  }

  const disposers = [
    input.event.on("question.asked", (event) => {
      if (questions.has(event.properties.id)) return
      questions.add(event.properties.id)
      notify(event.properties.sessionID, t("attention.question"), "question")
    }),
    input.event.on("question.replied", (event) => {
      questions.delete(event.properties.requestID)
    }),
    input.event.on("question.rejected", (event) => {
      questions.delete(event.properties.requestID)
    }),
    input.event.on("question.timed_out", (event) => {
      questions.delete(event.properties.requestID)
    }),
    input.event.on("permission.asked", (event) => {
      if (permissions.has(event.properties.id)) return
      permissions.add(event.properties.id)
      notify(event.properties.sessionID, t("attention.permission"), "permission")
      remind(event.properties.sessionID, "permission")
    }),
    input.event.on("permission.replied", (event) => {
      permissions.delete(event.properties.requestID)
    }),
    input.event.on("session.status", (event) => {
      const sessionID = event.properties.sessionID
      if (event.properties.status.type === "busy" || event.properties.status.type === "retry") {
        active.add(sessionID)
        errored.delete(sessionID)
        return
      }
      if (event.properties.status.type !== "idle") return
      if (!active.has(sessionID)) return
      active.delete(sessionID)
      if (errored.has(sessionID)) {
        errored.delete(sessionID)
        return
      }
      const session = input.sessions.get(sessionID)
      notify(sessionID, t("attention.done"), session?.parentID ? "subagent_done" : "done")
      remind(sessionID, "done")
    }),
    input.event.on("session.error", (event) => {
      const sessionID = event.properties.sessionID
      if (!sessionID) return
      if (!active.has(sessionID)) return
      errored.add(sessionID)
      notify(sessionID, sessionErrorMessage(event.properties.error), "error")
      // An abort is the user's own doing, and stopping the main agent aborts every sub-agent under it.
      if (event.properties.error?.name !== "MessageAbortedError") remind(sessionID, "failed")
    }),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}
