// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1031 M2: the L3 note must not attach to automated turns (DAG deliveries, wakes, goal continuations, mailbox
// messages): `MessageV2.isAutomationMessage` tells them from the user's own. The note's lifecycle (#1456) is tested
// with the other state reminders in reminder-state.test.ts.
import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"

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

  test("recognizes background results, PR-watch notices and delivered user reminders by their metadata", () => {
    for (const metadata of [
      { backgroundResult: { status: "completed", title: "background task" } },
      { prWatch: { watchID: "pr_1", outcome: "passed" } },
      { reminder: { reminderID: "rmd_1", fireAt: 1, creator: "user", delayedMinutes: 0 } },
    ])
      expect(MessageV2.isAutomationMessage(user("msg_meta", "notice", { synthetic: true, metadata }))).toBe(true)
  })

  test("a state reminder part is no automation marker, and does not turn a user's message into an automated one", () => {
    // The state reminders of #1456 mark their parts with `stateReminder`, not `reminder`.
    const mark = { stateReminder: { kind: "todo", digest: "0123456789abcdef" } }
    expect(
      MessageV2.isAutomationMessage(
        user("msg_state", "[todo reminder] 1 uncompleted", { synthetic: true, metadata: mark }),
      ),
    ).toBe(false)
    const own = user("msg_own", "fix the build")
    own.parts.push({
      id: PartID.make("prt_state"),
      messageID: MessageID.make("msg_own"),
      sessionID: SessionID.make("ses_dag_reminder"),
      type: "text",
      text: "[todo reminder] 1 uncompleted",
      synthetic: true,
      metadata: mark,
    } as (typeof own.parts)[number])
    expect(MessageV2.isAutomationMessage(own)).toBe(false)
  })

  test("a user-typed line that quotes the reminder metadata key is not automated", () => {
    // The marker is the synthetic part the clock's delivery writes; a typed message has none.
    expect(
      MessageV2.isAutomationMessage(user("msg_typed", "remind me", { metadata: { reminder: { reminderID: "rmd_1" } } })),
    ).toBe(false)
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
