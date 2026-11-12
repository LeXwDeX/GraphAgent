// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { SessionProjector } from "@graphagent/core/session/projector"
import { LLMEvent } from "@graphagent/llm"
import { Effect, Layer, Option } from "effect"
import { logLines } from "effect/testing/TestConsole"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { AgentScheduler } from "@/session/agent-scheduler"
import * as AgentSchedulerState from "@/session/agent-scheduler-state"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { LLM } from "@/session/llm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { makeFakeProvider } from "../lib/fake-provider"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"

// Issue #1021 acceptance: reasoning distillation is background work. Its
// organizer request goes through `AgentScheduler.tryRequest` on the
// `background` lane, and when no permit is free the job is dropped exactly like
// the queue's own per-session bound: no request is sent, the turn is not
// delayed, and nothing is reported as a failure. A second turn with a free
// permit then proves the drop was the permit's doing and not a disabled feature.

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarizeTurn: () => Effect.void,
    read: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionRunState.node,
  SessionStatus.node,
  Database.node,
  CrossSpawnSpawner.node,
  AgentScheduler.node,
])

/** Reasoning long enough to repay an organizer call, then a final answer. */
const longThought = (label: string) => `${label} `.repeat(60).trim()
const reasoningTurn = (label: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.reasoningStart({ id: `reasoning-${label}` }),
  LLMEvent.reasoningDelta({ id: `reasoning-${label}`, text: longThought(`${label}-thinking`) }),
  LLMEvent.reasoningEnd({ id: `reasoning-${label}` }),
  LLMEvent.textStart({ id: `text-${label}` }),
  LLMEvent.textDelta({ id: `text-${label}`, text: `answer ${label}` }),
  LLMEvent.textEnd({ id: `text-${label}` }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const ORGANIZER_MODEL = "small-model"

/** One scheduler for the file, sized so a single held stream exhausts it. */
const limits: AgentSchedulerState.SchedulerLimits = { ...AgentSchedulerState.DEFAULT_LIMITS, global: 1, perProvider: 1 }
const inner = AgentScheduler.make(AgentSchedulerState.makeState(limits), () => Effect.succeed(limits))

/** What the organizer path asked the scheduler for, and whether it was granted. */
const attempts: Array<{ readonly request: AgentScheduler.RequestInput; readonly granted: boolean }> = []
const scheduler: AgentScheduler.Interface = {
  ...inner,
  tryRequest: (request) =>
    inner
      .tryRequest(request)
      .pipe(Effect.tap((permit) => Effect.sync(() => attempts.push({ request, granted: Option.isSome(permit) })))),
}

/** The prompts the organizer model actually received. */
const organized: string[] = []
let turns = 0
const provider = makeFakeProvider({
  script: () => reasoningTurn(`turn${++turns}`),
  organizer: () =>
    Effect.succeed({
      transport: "engine" as const,
      providerID: "test",
      modelID: ORGANIZER_MODEL,
      model: "test/small",
      call:
        () =>
        async ({ prompt }) => {
          organized.push(prompt)
          return { text: "organized", finishReason: "stop" }
        },
    }),
})

const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [
      LayerNode.replace(MCP.node, mcp),
      LayerNode.replace(LSP.node, lsp),
      LayerNode.replace(SessionSummary.node, summary),
      LayerNode.replace(LLM.node, provider.layer),
      LayerNode.replace(AgentScheduler.node, Layer.succeed(AgentScheduler.Service, scheduler)),
    ],
  }),
)

it.live(
  "reasoning distillation is dropped without a request or an error when the background lane has no permit",
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const prompts = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "organizer permit" })
        const sentToOrganizer = (label: string) => organized.some((prompt) => prompt.includes(`${label}-thinking`))

        // Another stream owns the only permit, as a long interactive turn would.
        const held = yield* scheduler.request({
          lane: "interactive",
          providerID: "test",
          modelID: "test-model",
          sessionID: "someone-else",
        })

        // The turn itself never needs a permit here (the model is scripted) and
        // must finish normally while its organizer job is turned away.
        yield* prompts.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "think, then answer" }],
        })
        yield* pollWithTimeout(
          Effect.sync(() => (attempts.length >= 1 ? true : undefined)),
          "the organizer job never asked the scheduler for a permit",
        )
        expect(attempts).toEqual([
          {
            request: { lane: "background", providerID: "test", modelID: ORGANIZER_MODEL, sessionID: chat.id },
            granted: false,
          },
        ])

        // The permit comes back: the very next turn's organizer job is served.
        // Waiting for that call also guarantees the dropped job ran to the end,
        // so the absence of its request below is observed, not raced.
        yield* held.release
        yield* prompts.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "again" }],
        })
        yield* pollWithTimeout(
          Effect.sync(() => (organized.length >= 1 ? true : undefined)),
          "the organizer was never called once a permit was free",
        )

        expect(attempts.map((attempt) => attempt.granted)).toEqual([false, true])
        expect(organized).toHaveLength(1)
        expect(sentToOrganizer("turn1")).toBe(false)
        expect(sentToOrganizer("turn2")).toBe(true)

        // No error anywhere: both turns completed, and a dropped job is silent.
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const assistants = messages.filter((message) => message.info.role === "assistant")
        expect(assistants).toHaveLength(2)
        expect(
          assistants.every((message) => message.info.role === "assistant" && message.info.error === undefined),
        ).toBe(true)
        expect(JSON.stringify(yield* logLines)).not.toContain("reasoning distillation failed")
      }),
    { config: { ...testProviderConfig("http://localhost:1/v1"), reasoningDistillation: { enabled: true } } },
  ),
)
