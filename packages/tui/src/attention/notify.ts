// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Event } from "@graphagent/sdk/v2"
import type { TuiAttentionSoundName } from "@graphagent/tui/plugin-api"
import { t } from "../i18n"

type SessionError = Extract<Event, { type: "session.error" }>["properties"]["error"]

type NotifyInput = {
  title?: string
  message: string
  notification: false | { when: "blurred" }
  sound: { name: TuiAttentionSoundName; when: "always" }
}

type NotificationsInput = {
  event: {
    on<T extends Event["type"]>(type: T, handler: (event: Extract<Event, { type: T }>) => void): () => void
  }
  sessions: {
    get(sessionID: string): { title?: string; parentID?: string } | undefined
  }
  attention: {
    notify(input: NotifyInput): Promise<unknown>
  }
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
 * completed turns, and session errors. Subagent sessions only play a sound.
 * Returns the disposer that unsubscribes every event handler.
 */
export function createTuiNotifications(input: NotificationsInput): () => void {
  const active = new Set<string>()
  const errored = new Set<string>()
  const questions = new Set<string>()
  const permissions = new Set<string>()

  function notify(sessionID: string | undefined, message: string, sound: TuiAttentionSoundName) {
    const session = sessionID ? input.sessions.get(sessionID) : undefined
    const isSubagent = session?.parentID !== undefined
    void input.attention.notify({
      title: session?.title,
      message,
      notification: isSubagent ? false : { when: "blurred" },
      sound: { name: sound, when: "always" },
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
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}
