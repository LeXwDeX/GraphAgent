// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { AssistantMessage, Part, TextPart, ToolPart, UserMessage } from "@graphagent/sdk"
import { directory } from "./tui-sdk"

/**
 * Messages and parts as `GET /session/:id/message` serves them, for the tests that need a session with a transcript:
 * one entry per message, its parts next to it.
 */

export type MessageEntry = { info: UserMessage | AssistantMessage; parts: Part[] }

export function userMessage(id: string, sessionID: string, created: number): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
  }
}

export function assistantMessage(id: string, sessionID: string, parentID: string, created: number): AssistantMessage {
  return {
    id,
    sessionID,
    parentID,
    role: "assistant",
    agent: "explore",
    mode: "explore",
    modelID: "test-model",
    providerID: "test",
    path: { cwd: directory, root: directory },
    time: { created, completed: created + 1 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  }
}

export const textPart = (messageID: string, sessionID: string, id: string, body: string): TextPart => ({
  id,
  sessionID,
  messageID,
  type: "text",
  text: body,
  time: { start: 1, end: 2 },
})

/** A finished `read` call. */
export function readPart(messageID: string, sessionID: string, id: string): ToolPart {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `call_${id}`,
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: "CHANGELOG.md" },
      output: "ok",
      title: "CHANGELOG.md",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

export type TaskStatus = "running" | "completed" | "error"

/** The Task call of a parent that started `childID`: the summary layer links the two through it. */
export function taskCall(input: {
  parentID: string
  messageID: string
  id: string
  childID: string
  status?: TaskStatus
  description?: string
  background?: boolean
}) {
  const status = input.status ?? "completed"
  const description = input.description ?? "扫描变更日志"
  const toolInput = { description, subagent_type: "explore", prompt: "x" }
  const metadata = { sessionID: input.childID, ...(input.background ? { background: true } : {}) }
  const state: ToolPart["state"] =
    status === "running"
      ? { status, input: toolInput, title: description, metadata, time: { start: 1 } }
      : status === "completed"
        ? { status, input: toolInput, output: "done", title: description, metadata, time: { start: 1, end: 2 } }
        : { status, input: toolInput, error: "boom", metadata, time: { start: 1, end: 2 } }
  return {
    id: input.id,
    sessionID: input.parentID,
    messageID: input.messageID,
    type: "tool",
    callID: `call_${input.id}`,
    tool: "task",
    state,
  } satisfies ToolPart
}
