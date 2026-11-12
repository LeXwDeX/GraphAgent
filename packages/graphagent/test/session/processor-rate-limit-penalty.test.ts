// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Clock, Effect, Fiber, Layer, Option, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import path from "path"
import { APICallError } from "ai"
import type { Agent } from "../../src/agent/agent"
import { Session } from "@/session/session"
import { AgentScheduler } from "@/session/agent-scheduler"
import * as AgentSchedulerState from "@/session/agent-scheduler-state"
import { LLM } from "../../src/session/llm"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Provider } from "@/provider/provider"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { SessionProjector } from "@graphagent/core/session/projector"
import { LLMEvent } from "@graphagent/llm"

// Issue #1021 acceptance, processor level: a provider 429 reaches
// `AgentScheduler.penalize` through the retry policy (`onRateLimit`), the
// penalty refuses the rate-limited model's child and background permits until
// the provider's `retry-after` elapses, and capacity comes back on its own.
// The retry policy and the scheduler each have unit tests; this file pins the
// wire between them (`processor.ts` passes `scheduler.penalize` as the hook),
// which nothing else exercises.

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarizeTurn: () => Effect.void,
    read: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const user = Effect.fn("RateLimitPenaltyTest.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("RateLimitPenaltyTest.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  AgentScheduler.node,
  CrossSpawnSpawner.node,
])

type Script = LLMEvent[] | Stream.Stream<LLMEvent, unknown>

/**
 * Each processor attempt consumes the next script; the last script repeats.
 * The scheduler is test-local: the process-wide state would carry penalties
 * from one test (and from TestClock's restarted time) into the next.
 */
function scenario(scripts: Script[]) {
  const limits: AgentSchedulerState.SchedulerLimits = {
    ...AgentSchedulerState.DEFAULT_LIMITS,
    global: 8,
    perProvider: 8,
  }
  const scheduler = AgentScheduler.make(AgentSchedulerState.makeState(limits), () => Effect.succeed(limits))
  let calls = 0
  const llm = Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      organizer: () => Effect.succeed(undefined),
      stream: () => {
        const script = scripts[Math.min(calls, scripts.length - 1)]
        calls += 1
        return Array.isArray(script) ? Stream.fromIterable(script) : script
      },
    }),
  )
  const it = testEffect(
    LayerNode.buildLayer(root, {
      replacements: [
        LayerNode.replace(SessionSummary.node, summary),
        LayerNode.replace(LLM.node, llm),
        LayerNode.replace(AgentScheduler.node, Layer.succeed(AgentScheduler.Service, scheduler)),
      ],
    }),
  )
  return { count: () => calls, it, scheduler }
}

const recovered: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-1" }),
  LLMEvent.textDelta({ id: "text-1", text: "recovered" }),
  LLMEvent.textEnd({ id: "text-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const providerFailure = (statusCode: number, headers?: Record<string, string>) =>
  new APICallError({
    message: statusCode === 429 ? "Too Many Requests" : "Bad Gateway",
    url: "http://localhost/v1",
    requestBodyValues: {},
    statusCode,
    ...(headers ? { responseHeaders: headers } : {}),
    responseBody: JSON.stringify({ error: { message: statusCode === 429 ? "rate limited" : "upstream failed" } }),
    isRetryable: true,
  })

const input = (sessionID: SessionID, parent: SessionV1.User, model: Provider.Model): LLM.StreamInput => ({
  user: {
    id: parent.id,
    sessionID: parent.sessionID,
    role: "user",
    time: parent.time,
    agent: parent.agent,
    model: { providerID: ref.providerID, modelID: ref.modelID },
  } satisfies SessionV1.User,
  sessionID,
  model,
  agent: agent(),
  system: [],
  messages: [{ role: "user", content: "answer" }],
  tools: {},
})

/**
 * Wait until the processor publishes its retry status. That status is set only
 * after the rate-limit hook ran, so it is the readiness signal for the
 * penalty. The wait is real time: the virtual clock is deliberately frozen.
 */
const untilRetrying = (status: SessionStatus.Interface, sessionID: SessionID) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000
    for (;;) {
      const current = yield* status.get(sessionID)
      if (current.type === "retry") return current
      if (Date.now() > deadline) return yield* Effect.die(new Error("the processor never reached its retry wait"))
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)))
    }
  })

/** Whether the scheduler would grant a permit right now. */
const grants = (scheduler: AgentScheduler.Interface, lane: AgentSchedulerState.Lane, modelID = ref.modelID) =>
  Effect.scoped(
    scheduler
      .tryRequest({ lane, providerID: ref.providerID, modelID, sessionID: `probe-${lane}` })
      .pipe(Effect.map(Option.isSome)),
  )

const limited = scenario([Stream.fail(providerFailure(429, { "retry-after": "2" })), recovered])

limited.it.effect(
  "session.processor: a 429 with retry-after penalizes the model's child and background lanes until it elapses",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const status = yield* SessionStatus.Service
        const { scheduler } = limited
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "answer")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        // Nothing is penalized before the provider rejects the request.
        expect(yield* grants(scheduler, "child")).toBe(true)
        expect((yield* scheduler.capacity()).providers[ref.providerID]?.penalizedUntil).toBeUndefined()

        const start = yield* Clock.currentTimeMillis
        const running = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        const retry = yield* untilRetrying(status, chat.id)
        expect(limited.count()).toBe(1)

        // The provider asked for 2s: the penalty ends exactly there, and it is
        // the same deadline the session reports as its next attempt.
        const penalizedUntil = (yield* scheduler.capacity()).providers[ref.providerID]?.penalizedUntil
        expect(penalizedUntil).toBe(start + 2_000)
        expect(retry.type === "retry" ? retry.next : undefined).toBe(penalizedUntil)

        // Inside the window this model gets no new child or background permit…
        expect(yield* grants(scheduler, "child")).toBe(false)
        expect(yield* grants(scheduler, "background")).toBe(false)
        // …a waiting child request is not granted either…
        const waiting = yield* Effect.scoped(
          scheduler
            .request({ lane: "child", providerID: ref.providerID, modelID: ref.modelID, sessionID: "queued-child" })
            .pipe(Effect.as("granted" as const)),
        ).pipe(Effect.forkChild)
        // …while the user's own turns and other models are untouched.
        expect(yield* grants(scheduler, "interactive")).toBe(true)
        expect(yield* grants(scheduler, "side")).toBe(true)
        expect(yield* grants(scheduler, "child", ModelV2.ID.make("other-model"))).toBe(true)

        yield* TestClock.adjust("1999 millis")
        expect(yield* grants(scheduler, "child")).toBe(false)
        expect(waiting.pollUnsafe()).toBeUndefined()
        expect(limited.count()).toBe(1)

        // At the retry-after boundary the lane recovers without any release,
        // the queued child gets its permit, and the processor retries.
        yield* TestClock.adjust("1 millis")
        expect(yield* Fiber.join(waiting)).toBe("granted")
        expect(yield* grants(scheduler, "child")).toBe(true)
        expect(yield* grants(scheduler, "background")).toBe(true)
        const result = yield* Fiber.join(running)

        expect(result).toBe("continue")
        expect(limited.count()).toBe(2)
        expect(msg.error).toBeUndefined()
        expect(msg.finish).toBe("stop")
      }),
    { config: cfg },
  ),
)

const gateway = scenario([Stream.fail(providerFailure(502)), recovered])

gateway.it.effect(
  "session.processor: a retried gateway error is not a rate limit and penalizes nothing",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const status = yield* SessionStatus.Service
        const { scheduler } = gateway
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "answer")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const running = yield* handle.process(input(chat.id, parent, mdl)).pipe(Effect.forkChild)
        yield* untilRetrying(status, chat.id)
        // The retry is under way, yet only the rate-limit branch may touch the scheduler.
        expect((yield* scheduler.capacity()).providers[ref.providerID]?.penalizedUntil).toBeUndefined()
        expect(yield* grants(scheduler, "child")).toBe(true)
        expect(yield* grants(scheduler, "background")).toBe(true)

        yield* TestClock.adjust("90 seconds")
        expect(yield* Fiber.join(running)).toBe("continue")
        expect(gateway.count()).toBe(2)
        expect((yield* scheduler.capacity()).providers[ref.providerID]?.penalizedUntil).toBeUndefined()
      }),
    { config: cfg },
  ),
)
