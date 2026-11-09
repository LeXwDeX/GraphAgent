// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/schema/project"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"

const parent = SessionID.make("ses_mailbox_parent")
const message: DagMessages.Message = {
  id: "agent_report",
  workflowID: "dag_already_completed",
  sender: {
    id: "child_endpoint",
    kind: "node",
    sessionID: "ses_child",
    workflowID: "dag_already_completed",
    nodeID: "worker",
    attemptID: "attempt_1",
  },
  recipient: { id: "parent_endpoint", kind: "main", sessionID: parent },
  recipientSequence: 1,
  acceptedRevision: 1,
  content: "Completed investigation; please review.",
  state: "queued",
  transcriptID: "msg_agent_report",
  partID: "prt_agent_report",
  timeCreated: 1,
}

type MailboxProbe = {
  admissions: SessionPrompt.PromptInput[]
  callers: DagMessages.Caller[]
  history?: SessionV1.WithParts[]
}

function mailboxLayer(probe: MailboxProbe) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, status, dag)
  const messages = Layer.mock(DagMessages.Service, {
    pendingRecipients: (scope) => Effect.succeed(scope.afterSessionID ? [] : [message.recipient]),
    receive: (caller, input) =>
      Effect.sync(() => {
        probe.callers.push(caller)
        expect(input).toEqual({ limit: 64, queuedOnly: true })
        return { ok: true as const, value: [message] }
      }),
  })
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    messages: () => Effect.sync(() => probe.history ?? []),
  })
  const prompt = Layer.mock(SessionPrompt.Service, {
    prepareIfIdle: (input) =>
      Effect.sync(() => {
        probe.admissions.push(input)
        return Option.some({ activate: Effect.void, result: Effect.never, abort: Effect.void })
      }),
  })
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(messages),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(Layer.mock(Agent.Service, {})),
  )
  return Layer.merge(base, loop)
}

function run<A>(probe: MailboxProbe, work: Effect.Effect<A, Error, DagLoop.Service | SessionStatus.Service>) {
  return Effect.runPromise(
    work.pipe(
      Effect.provide(mailboxLayer(probe)),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        root: process.cwd(),
        project: {
          id: Project.ID.make("project-1"),
          worktree: process.cwd(),
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
      }),
      Effect.scoped,
    ),
  )
}

describe("DAG parent agent mailbox wake", () => {
  it("retains queued input after a failed preparation until later host prompt context is admitted", async () => {
    const providerID = ProviderV2.ID.make("test")
    const modelID = ModelV2.ID.make("test")
    const failed: SessionV1.WithParts = {
      info: {
        id: MessageID.make("msg_failed"),
        sessionID: parent,
        parentID: MessageID.make("msg_user"),
        role: "assistant",
        agent: "build",
        mode: "build",
        providerID,
        modelID,
        path: { cwd: process.cwd(), root: process.cwd() },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, completed: 2 },
        error: { name: "APIError", data: { message: "preparation failed", isRetryable: false } },
      },
      parts: [],
    }
    const agentContext: SessionV1.WithParts = {
      info: {
        id: MessageID.make(message.transcriptID),
        sessionID: parent,
        role: "user",
        agent: "build",
        model: { providerID, modelID },
        time: { created: 3 },
      },
      parts: [
        {
          id: PartID.make(message.partID),
          messageID: MessageID.make(message.transcriptID),
          sessionID: parent,
          type: "text",
          synthetic: true,
          text: DagMessages.renderMessage(message),
        },
      ],
    }
    const probe: MailboxProbe = { admissions: [], callers: [], history: [failed, agentContext] }
    await run(
      probe,
      Effect.gen(function* () {
        yield* (yield* DagLoop.Service).init()
        yield* Effect.sleep(600)
        expect(probe.admissions).toHaveLength(0)
        expect(message.state).toBe("queued")
        // The ordinary prompt is ordered after the failed assistant even at the
        // same timestamp, and was admitted before its completion. This grants no
        // authorization from its text or from the node's queued message.
        probe.history?.push({
          info: {
            id: MessageID.make("msg_followup"),
            sessionID: parent,
            role: "user",
            agent: "build",
            model: { providerID, modelID },
            time: { created: 1 },
          },
          parts: [
            {
              id: PartID.make("prt_followup"),
              messageID: MessageID.make("msg_followup"),
              sessionID: parent,
              type: "text",
              text: "Continue the existing task",
            },
          ],
        })
        yield* (yield* SessionStatus.Service).set(parent, { type: "idle" })
        yield* pollWithTimeout(
          Effect.sync(() => (probe.admissions.length === 1 ? true : undefined)),
          "new host context did not release mailbox retry",
        )
        expect(probe.admissions).toHaveLength(1)
      }),
    )
  })

  it("admits a queued report with its durable IDs even after the source workflow is gone", async () => {
    const probe = { admissions: [] as SessionPrompt.PromptInput[], callers: [] as DagMessages.Caller[] }
    await run(
      probe,
      Effect.gen(function* () {
        yield* (yield* DagLoop.Service).init()
        yield* pollWithTimeout(
          Effect.sync(() => (probe.admissions.length === 1 ? true : undefined)),
          "mailbox was not admitted",
        )
        const input = probe.admissions[0]
        expect(input.sessionID).toBe(parent)
        expect(input.messageID).toBe(MessageID.make(message.transcriptID))
        expect(input.parts).toEqual([
          { id: PartID.make(message.partID), type: "text", synthetic: true, text: DagMessages.renderMessage(message) },
        ])
        expect(probe.callers[0]).toEqual({ sessionID: parent, projectID: "project-1", directory: process.cwd() })
        yield* Effect.sleep(600)
        expect(probe.admissions).toHaveLength(1)
        // Admission does not associate a model snapshot or change delivery state.
        expect(message.state).toBe("queued")
      }),
    )
  })

  it("defers busy parents and admits exactly once when the existing idle signal arrives", async () => {
    const probe = { admissions: [] as SessionPrompt.PromptInput[], callers: [] as DagMessages.Caller[] }
    await run(
      probe,
      Effect.gen(function* () {
        const status = yield* SessionStatus.Service
        yield* status.set(parent, { type: "busy" })
        yield* (yield* DagLoop.Service).init()
        yield* Effect.sleep(600)
        expect(probe.admissions).toHaveLength(0)
        expect(probe.callers).toHaveLength(0)
        yield* status.set(parent, { type: "idle" })
        yield* pollWithTimeout(
          Effect.sync(() => (probe.admissions.length === 1 ? true : undefined)),
          "idle mailbox was not admitted",
        )
        yield* status.set(parent, { type: "idle" })
        yield* Effect.sleep(600)
        expect(probe.admissions).toHaveLength(1)
      }),
    )
  })
})
