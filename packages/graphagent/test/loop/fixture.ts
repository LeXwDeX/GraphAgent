// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import type { SessionV1 } from "@graphagent/core/v1/session"
import type { LoopAnalysisResult, LoopIntent, LoopProgress } from "@graphagent/schema/loop"
import { MessageID, PartID, SessionID } from "@/session/schema"

/** A first-analysis intent: two unmet items, so a `continue` verdict is consistent with it. */
export const intent = (overrides: Partial<LoopIntent> = {}): LoopIntent => ({
  objective: "Ship the loop analysis service",
  acceptance: [
    { id: "A1", text: "The schema is exported", status: "unmet" },
    { id: "A2", text: "The validator rejects drift", status: "unmet" },
  ],
  constraints: ["Do not touch the shared runner"],
  non_goals: ["No new configuration keys"],
  assumptions: [],
  open_questions: [],
  ...overrides,
})

export const progress = (overrides: Partial<LoopProgress> = {}): LoopProgress => ({
  advanced: true,
  summary: "Schema landed",
  done: ["schema"],
  remaining: ["validator"],
  ...overrides,
})

/** A result V1-V8 accept as a first analysis (and as a later one when the intent is unchanged). */
export const result = (overrides: Partial<LoopAnalysisResult> = {}): LoopAnalysisResult => ({
  verdict: "continue",
  intent: intent(),
  intent_change: { changed: false },
  progress: progress(),
  next_prompt: "Implement the validator and run its tests.",
  reason: "Two acceptance items are still unmet.",
  ...overrides,
})

// ── session messages ───────────────────────────────────────────

export const modelRef = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const sessionID = SessionID.make("ses_loop_fixture")

export function text(messageID: MessageID, value: string, extra: Partial<SessionV1.TextPart> = {}): SessionV1.TextPart {
  return { id: PartID.ascending(), sessionID, messageID, type: "text", text: value, ...extra }
}

/** A user message with one text part. `synthetic` marks automation (loop continuation, wake-up, hooks). */
export function user(
  value: string,
  options: { synthetic?: boolean; metadata?: Record<string, unknown>; ignored?: boolean } = {},
): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: { id, sessionID, role: "user", time: { created: 0 }, agent: "build", model: modelRef },
    parts: [
      text(id, value, {
        ...(options.synthetic ? { synthetic: true } : {}),
        ...(options.ignored ? { ignored: true } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      }),
    ],
  }
}

export function assistant(
  parent: SessionV1.WithParts,
  parts: (messageID: MessageID) => SessionV1.Part[],
  options: { summary?: boolean; completed?: boolean } = {},
): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 0, ...(options.completed === false ? {} : { completed: 1 }) },
      parentID: parent.info.id,
      modelID: modelRef.modelID,
      providerID: modelRef.providerID,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      ...(options.summary ? { summary: true } : {}),
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "end_turn",
    },
    parts: parts(id),
  }
}

export function reply(parent: SessionV1.WithParts, value: string, options: { summary?: boolean } = {}) {
  return assistant(parent, (id) => [text(id, value)], options)
}

/** The user-role marker a compaction starts with; its summary is the assistant message that follows. */
export function compaction(): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: { id, sessionID, role: "user", time: { created: 0 }, agent: "build", model: modelRef },
    parts: [{ id: PartID.ascending(), sessionID, messageID: id, type: "compaction", auto: true }],
  }
}

export function toolPart(
  messageID: MessageID,
  state: SessionV1.ToolPart["state"],
  name = "bash",
  callID = "call_1",
): SessionV1.ToolPart {
  return { id: PartID.ascending(), sessionID, messageID, type: "tool", callID, tool: name, state }
}
