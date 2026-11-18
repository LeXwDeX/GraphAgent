// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Event } from "@graphagent/sdk"
import type { AttentionSoundName } from "../config"
import { backgroundResultOf, type BackgroundResult, type TaskIndexEntry } from "../context/session-summary"
import { t } from "../i18n"
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
 * What a sub-agent reminder needs beyond the sound (#1033 4, 6; #1058 7). Without it a sub-agent session only plays
 * its sound, as before.
 */
export type SubagentReminders = {
  toast: { show(options: ToastOptions): void }
  /** The session on screen: the sub-agent the user is looking at needs no reminder. */
  viewing(): string | undefined
  /** The root of the session tree on screen; none on home. A background run is announced only within it. */
  currentRoot(): string | undefined
  /** The parent's Task link of a child session: its kind, for the text of the reminder. A DAG node has no link. */
  task(sessionID: string): Pick<TaskIndexEntry, "kind"> | undefined
  /** Goes into a sub-agent session; `openSubAgent` is the one way in. */
  open(sessionID: string): void
  /**
   * Brings the user to the report of a background run: the session whose transcript holds it, scrolled to the message
   * the server added (`messageID`).
   */
  openResult(sessionID: string, messageID: string): void
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
 * that is not on screen also leaves a footer toast: one that goes into it when
 * it asks for permission, whichever way it runs, and, when a background run ends,
 * one that brings the user to that message in the session that holds it. That one comes
 * from the arrival of the result (the `message.part.updated` event of the message
 * the server adds), not from the child's status, and only once per result: the
 * data a snapshot, a hydration or a reconnect loads never makes it. The foreground
 * sub-agents report to the main agent, which is what the user is waiting on, and
 * DAG nodes have their own progress display.
 * Returns the disposer that unsubscribes every event handler.
 */
export function createTuiNotifications(input: NotificationsInput): () => void {
  const active = new Set<string>()
  const errored = new Set<string>()
  const questions = new Set<string>()
  const permissions = new Set<string>()
  // The results announced so far, by child and end time: the same part arriving again is not a new result.
  const announced = new Set<string>()

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

  /** A sub-agent that is not on screen asks for permission: whichever way it runs, the user is the one who can answer. */
  function remindPermission(sessionID: string | undefined) {
    const reminders = input.subagent
    if (!reminders || !sessionID) return
    const session = input.sessions.get(sessionID)
    if (session?.parentID === undefined) return
    if (reminders.viewing() === sessionID) return
    const kind = subagentKind({ title: session.title ?? "", agent: session.agent }, reminders.task(sessionID))
    reminders.toast.show({
      text: t("subagent.toast.permission", { kind }),
      level: "warning",
      dedupeKey: `subagent.permission.${sessionID}`,
      onActivate: () => reminders.open(sessionID),
    })
  }

  function rootOf(sessionID: string): string {
    const seen = new Set<string>()
    let current = sessionID
    while (!seen.has(current)) {
      seen.add(current)
      const parentID = input.sessions.get(current)?.parentID
      if (!parentID) break
      current = parentID
    }
    return current
  }

  /**
   * A background run ended and the server reported it in `sessionID`, the session the run was started from. Only a
   * result part is such a report, so a run the main agent waits for never comes here. The toast is for the tree the
   * user is in, once per result, and not for the sub-agent the user is looking at.
   */
  function announceResult(sessionID: string, found: { childSessionID: string; result: BackgroundResult }) {
    const reminders = input.subagent
    if (!reminders) return
    const root = reminders.currentRoot()
    if (root === undefined || rootOf(sessionID) !== root) return
    const key = `${found.childSessionID}:${found.result.endedAt}`
    if (announced.has(key)) return
    announced.add(key)
    if (reminders.viewing() === found.childSessionID) return
    const child = input.sessions.get(found.childSessionID)
    const kind = subagentKind({ title: child?.title ?? "", agent: child?.agent }, reminders.task(found.childSessionID))
    const completed = found.result.status === "completed"
    reminders.toast.show({
      text: t(completed ? "background.toast.done" : "background.toast.failed", { kind }),
      level: completed ? "success" : "error",
      dedupeKey: found.childSessionID,
      onActivate: () => reminders.openResult(sessionID, found.result.messageID),
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
      remindPermission(event.properties.sessionID)
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
    }),
    input.event.on("session.error", (event) => {
      const sessionID = event.properties.sessionID
      if (!sessionID) return
      if (!active.has(sessionID)) return
      errored.add(sessionID)
      notify(sessionID, sessionErrorMessage(event.properties.error), "error")
    }),
    // The report of a background run is a message the server adds to the session that started it.
    input.event.on("message.part.updated", (event) => {
      const part = event.properties.part
      if (part.type !== "text") return
      const found = backgroundResultOf(part)
      if (found) announceResult(part.sessionID, found)
    }),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}
