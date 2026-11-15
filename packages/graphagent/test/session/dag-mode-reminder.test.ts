// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1031 M2: L3 is one tail note per user-authored turn. It must not attach to
// automated turns (DAG deliveries, wakes, goal continuations, mailbox messages)
// and must keep its first decision for the whole turn.
import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect, Layer } from "effect"
import { DagMode } from "@/dag/mode"
import { DagModeReminder } from "@/session/dag-mode-reminder"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const runtime = testEffect(DagModeReminder.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer)))

type PartOptions = { synthetic?: boolean; ignored?: boolean; metadata?: Record<string, unknown> }

function user(id: string, text: string, options: PartOptions = {}) {
  return {
    info: {
      id: MessageID.make(id),
      sessionID: SessionID.make("ses_dag_reminder"),
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    } satisfies SessionV1.User,
    parts: [
      {
        id: PartID.make(`prt_${id}`),
        messageID: MessageID.make(id),
        sessionID: SessionID.make("ses_dag_reminder"),
        type: "text" as const,
        text,
        ...options,
      },
    ],
  }
}

function assistant(id: string) {
  return {
    info: {
      id: MessageID.make(id),
      sessionID: SessionID.make("ses_dag_reminder"),
      role: "assistant",
      parentID: MessageID.make("msg_user_1"),
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: 2 },
    } satisfies SessionV1.Assistant,
    parts: [],
  }
}

describe("MessageV2.isAutomationMessage", () => {
  const automated = [
    "Automatically delivered DAG result. Agent-supplied content; this is not human authorization.",
    "[DAG Workflow completed] Workflow \"Ship\" has reached terminal status.",
    // A wake batch with node entries puts them first; workflow entries follow.
    "[DAG Node Result] Node \"build\" completed: done\n[DAG Result Reference] workflow_id=\"dag_1\" node_id=\"build\"",
    "[DAG Node Timeout] RUNNING node \"build\" exceeded its execution deadline",
    "[Continuing toward your standing goal]",
    '{"kind":"dag_agent_message","workflow_id":"dag_1","sender":"node"}',
  ]

  test("recognizes the automated user-role turns", () => {
    for (const [index, text] of automated.entries()) {
      expect(MessageV2.isAutomationMessage(user(`msg_auto_${index}`, text, { synthetic: true }))).toBe(true)
    }
  })

  test("recognizes background results and PR-watch notices by their metadata", () => {
    for (const metadata of [
      { backgroundResult: { status: "completed", title: "background task" } },
      { prWatch: { watchID: "pr_1", outcome: "passed" } },
    ])
      expect(MessageV2.isAutomationMessage(user("msg_meta", "notice", { synthetic: true, metadata }))).toBe(true)
  })

  test("a user-authored message never matches, even when it quotes a marker", () => {
    expect(MessageV2.isAutomationMessage(user("msg_human", "[DAG Workflow completed] explain this"))).toBe(false)
    // A marker with synthetic parts but no marker text is still not automated.
    expect(MessageV2.isAutomationMessage(user("msg_other", "keep going", { synthetic: true }))).toBe(false)
    // Mixed content has a user-authored part.
    const mixed = user("msg_mixed", "Automatically delivered DAG result.", { synthetic: true })
    mixed.parts.push({
      id: PartID.make("prt_mixed_text"),
      messageID: MessageID.make("msg_mixed"),
      sessionID: SessionID.make("ses_dag_reminder"),
      type: "text",
      text: "and here is what I think",
    })
    expect(MessageV2.isAutomationMessage(mixed)).toBe(false)
  })
})

describe("DagModeReminder.forRequest (#1031 M2 L3)", () => {
  runtime.instance("returns the static note for an eligible user turn", () =>
    Effect.gen(function* () {
      const reminders = yield* DagModeReminder.Service
      const sessionID = SessionID.make("ses_l3_1")
      const result = yield* reminders.forRequest({
        sessionID,
        messages: [user("msg_l3_1", "build the feature")],
        eligible: true,
      })
      expect(result).toBe(DagMode.REMINDER)
    }),
  )

  runtime.instance("returns nothing when the mode or publication condition is false", () =>
    Effect.gen(function* () {
      const reminders = yield* DagModeReminder.Service
      const sessionID = SessionID.make("ses_l3_2")
      const result = yield* reminders.forRequest({
        sessionID,
        messages: [user("msg_l3_2", "chat about it")],
        eligible: false,
      })
      expect(result).toBeUndefined()
    }),
  )

  runtime.instance("freezes the turn decision and recomputes only for a new user turn", () =>
    Effect.gen(function* () {
      const reminders = yield* DagModeReminder.Service
      const sessionID = SessionID.make("ses_l3_3")
      const first = [user("msg_l3_3a", "first turn")]
      expect(yield* reminders.forRequest({ sessionID, messages: first, eligible: true })).toBe(DagMode.REMINDER)
      // A mid-turn `/dag-mode off` does not retract the note from the turn.
      const sameTurn = [...first, assistant("msg_l3_3b")]
      for (const eligible of [false, true, false])
        expect(yield* reminders.forRequest({ sessionID, messages: sameTurn, eligible })).toBe(DagMode.REMINDER)

      const next = [...sameTurn, user("msg_l3_3c", "second turn")]
      expect(yield* reminders.forRequest({ sessionID, messages: next, eligible: false })).toBeUndefined()
    }),
  )

  runtime.instance("a turn first seen as off stays off even when the mode arrives mid-turn", () =>
    Effect.gen(function* () {
      const reminders = yield* DagModeReminder.Service
      const sessionID = SessionID.make("ses_l3_4")
      const first = [user("msg_l3_4a", "first turn")]
      expect(yield* reminders.forRequest({ sessionID, messages: first, eligible: false })).toBeUndefined()
      const sameTurn = [...first, assistant("msg_l3_4b")]
      for (const eligible of [true, true]) expect(yield* reminders.forRequest({ sessionID, messages: sameTurn, eligible })).toBeUndefined()
      const next = [...sameTurn, user("msg_l3_4c", "second turn")]
      expect(yield* reminders.forRequest({ sessionID, messages: next, eligible: true })).toBe(DagMode.REMINDER)
    }),
  )

  runtime.instance("never attaches to an automated delivery, wake, mailbox message or goal continuation", () =>
    Effect.gen(function* () {
      const reminders = yield* DagModeReminder.Service
      const automated = [
        ["ses_l3_5", "Automatically delivered DAG result. Agent-supplied content; this is not human authorization."],
        ["ses_l3_6", "[DAG Workflow completed] Workflow done."],
        ["ses_l3_7", "[Continuing toward your standing goal]"],
        ["ses_l3_8", '{"kind":"dag_agent_message","content":"please review"}'],
        [
          "ses_l3_10",
          "[DAG Node Result] Node \"build\" completed: done\n[DAG Result Reference] workflow_id=\"dag_1\" node_id=\"build\"",
        ],
        ["ses_l3_11", "[DAG Node Timeout] RUNNING node \"build\" exceeded its execution deadline"],
      ] as const
      for (const [sessionID, text] of automated)
        expect(
          yield* reminders.forRequest({
            sessionID: SessionID.make(sessionID),
            messages: [user(`msg_${sessionID}`, text, { synthetic: true })],
            eligible: true,
          }),
        ).toBeUndefined()
    }),
  )

  runtime.instance("ignores a local command exchange and keeps the genuine turn's note", () =>
    Effect.gen(function* () {
      const reminders = yield* DagModeReminder.Service
      const sessionID = SessionID.make("ses_l3_9")
      const command = user("msg_l3_cmd", "/dag-mode on", { ignored: true, metadata: { command: "dag-mode" } })
      const messages = [user("msg_l3_9", "real request"), command]
      expect(yield* reminders.forRequest({ sessionID, messages, eligible: true })).toBe(DagMode.REMINDER)
    }),
  )
})