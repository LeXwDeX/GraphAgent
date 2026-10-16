import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigReasoningDistillation } from "@opencode-ai/core/config/reasoning-distillation"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { APICallError } from "ai"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { Config } from "@/config/config"
import { Image } from "@/image/image"
import { Agent } from "../../src/agent/agent"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { Token } from "@/util/token"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance, TestInstance } from "../fixture/fixture"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"

import type { Provider } from "@/provider/provider"
import * as SessionProcessorModule from "../../src/session/processor"
import { Snapshot } from "../../src/snapshot"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestConfig } from "../fixture/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Memory } from "@/memory/memory"
import { SettingsHook } from "@/hook/settings"
import { HookStartContext } from "@/hook/start-context"
import { CompactionTimeoutError } from "../../src/session/compaction-timeout"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const usage = (input: ConstructorParameters<typeof Usage>[0]) => new Usage(input)

const basicUsage = () => usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })

afterEach(() => {
  mock.restore()
})

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const wide = () => ProviderTest.fake({ model: createModel({ context: 100_000, output: 32_000 }) })

function createUserMessage(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    return msg
  })
}

function createAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string) {
  return SessionNs.Service.use((ssn) =>
    ssn.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: root, root },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      time: { created: Date.now() },
      finish: "end_turn",
    }),
  )
}

function createSummaryAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string, text: string) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID,
        mode: "compaction",
        agent: "compaction",
        path: { cwd: root, root },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: ref.modelID,
        providerID: ref.providerID,
        parentID,
        summary: true,
        time: { created: Date.now() },
        finish: "end_turn",
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text,
      })
      return msg
    }),
  )
}

function createCompactionMarker(sessionID: SessionID) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: ref,
        sessionID,
        agent: "build",
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: false,
      })
    }),
  )
}

function fake(
  input: Parameters<SessionProcessorModule.SessionProcessor.Interface["create"]>[0],
  result: "continue" | "compact",
) {
  const msg = input.assistantMessage
  return {
    get message() {
      return msg
    },
    updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
    completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
    process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed(result)),
  } satisfies SessionProcessorModule.SessionProcessor.Handle
}

function layer(result: "continue" | "compact") {
  return Layer.succeed(
    SessionProcessorModule.SessionProcessor.Service,
    SessionProcessorModule.SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) => Effect.succeed(fake(input, result))),
    }),
  )
}

function cfg(compaction?: ConfigV1.Info["compaction"]) {
  const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  return TestConfig.layer({
    get: () => Effect.succeed({ ...base, compaction }),
  })
}

const deps = Layer.mergeAll(
  wide().layer,
  layer("continue"),
  Agent.defaultLayer,
  Plugin.defaultLayer,
  EventV2Bridge.defaultLayer,
  Config.defaultLayer,
  SessionStatus.defaultLayer,
  RuntimeFlags.layer({ experimentalEventSystem: true }),
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionCompaction.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

const it = testEffect(env)

const compactionEnv = Layer.mergeAll(
  SessionNs.defaultLayer,
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)
const itCompaction = testEffect(compactionEnv)

type CompactionProcessOptions = {
  result?: "continue" | "compact"
  llm?: Layer.Layer<LLM.Service>
  plugin?: Layer.Layer<Plugin.Service>
  provider?: ReturnType<typeof ProviderTest.fake>
  config?: Layer.Layer<Config.Service>
  memory?: Layer.Layer<Memory.Service>
  settingsHook?: Layer.Layer<SettingsHook.Service>
  startContext?: Layer.Layer<HookStartContext.Service>
}

function withCompaction(options?: CompactionProcessOptions) {
  return Effect.provide(compactionProcessLayer(options))
}

function compactionProcessLayer(options?: CompactionProcessOptions) {
  const events = EventV2Bridge.defaultLayer
  const status = SessionStatus.layer.pipe(Layer.provide(events))
  const processor = options?.llm
    ? SessionProcessorModule.SessionProcessor.layer.pipe(
        Layer.provide(summary),
        Layer.provide(Image.defaultLayer),
        Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
        Layer.provide(status),
      )
    : layer(options?.result ?? "continue")
  const compaction = SessionCompaction.layer.pipe(
    Layer.provide(processor),
    Layer.provideMerge(Layer.mergeAll(
        options?.memory ?? Layer.empty,
        options?.settingsHook ?? Layer.empty,
        options?.startContext ?? Layer.empty,
      ),
    ),
  )
  return Layer.mergeAll(compaction, processor, events, status).pipe(
    Layer.provide(SessionNs.defaultLayer),
    Layer.provide((options?.provider ?? wide()).layer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(options?.llm ?? LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(options?.plugin ?? Plugin.defaultLayer),
    Layer.provide(status),
    Layer.provide(events),
    Layer.provide(options?.config ?? Config.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provide(EventV2Bridge.defaultLayer),
  )
}

function createSummaryCompaction(sessionID: SessionID) {
  return SessionCompaction.use.create({ sessionID, agent: "build", model: ref, auto: false })
}

function readCompactionPart(sessionID: SessionID) {
  return SessionNs.use
    .messages({ sessionID })
    .pipe(
      Effect.map((messages) =>
        messages.at(-2)?.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction"),
      ),
    )
}

function llm() {
  const queue: Array<
    Stream.Stream<LLMEvent, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown>)
  > = []

  return {
    push(stream: Stream.Stream<LLMEvent, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown>)) {
      queue.push(stream)
    },
    layer: Layer.succeed(
      LLM.Service,
      LLM.Service.of({
        organizer: () => Effect.succeed(undefined),
        stream: (input) => {
          const item = queue.shift() ?? Stream.empty
          const stream = typeof item === "function" ? item(input) : item
          return stream.pipe(Stream.mapEffect((event) => Effect.succeed(event)))
        },
      }),
    ),
  }
}

function reply(
  text: string,
  capture?: (input: LLM.StreamInput) => void,
): (input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown> {
  return (input) => {
    capture?.(input)
    return Stream.make(
      LLMEvent.textStart({ id: "txt-0" }),
      LLMEvent.textDelta({ id: "txt-0", text }),
      LLMEvent.textEnd({ id: "txt-0" }),
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: basicUsage(),
      }),
      LLMEvent.finish({
        reason: "stop",
        usage: basicUsage(),
      }),
    )
  }
}

function plugin(ready: Deferred.Deferred<void>) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.session.compacting") return Effect.succeed(output)
      return Effect.sync(() => Deferred.doneUnsafe(ready, Effect.void)).pipe(
        Effect.andThen(Effect.never),
        Effect.as(output),
      )
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

function autocontinue(enabled: boolean) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.compaction.autocontinue") return Effect.succeed(output)
      return Effect.sync(() => {
        ;(output as { enabled: boolean }).enabled = enabled
        return output
      })
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

describe("session.compaction.isOverflow", () => {
  it.live(
    "compacts at the default ceiling on a larger model window",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 1_000_000, output: 32_000 })
        const tokens = { input: 249_999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
        expect(yield* compact.isOverflow({ tokens: { ...tokens, input: 250_000 }, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "accepts a larger configured ceiling without exceeding the model limit",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const largeModel = createModel({ context: 1_000_000, output: 32_000 })
          const smallModel = createModel({ context: 300_000, output: 32_000 })
          const tokens = { input: 300_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          expect(yield* compact.isOverflow({ tokens, model: largeModel })).toBe(false)
          expect(yield* compact.isOverflow({ tokens, model: smallModel })).toBe(true)
          expect(yield* compact.isOverflow({ tokens: { ...tokens, input: 400_000 }, model: largeModel })).toBe(true)
        }),
      { config: { compaction: { max_context_tokens: 400_000 } } },
    ),
  )

  it.live(
    "uses the current model's smaller limit when switching models",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const tokens = { input: 85_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          const largeModel = createModel({ context: 1_000_000, output: 32_000 })
          const smallModel = createModel({ context: 100_000, output: 32_000 })
          expect(yield* compact.isOverflow({ tokens, model: largeModel })).toBe(false)
          expect(yield* compact.isOverflow({ tokens, model: smallModel })).toBe(true)
        }),
      { config: { compaction: { max_context_tokens: 250_000 } } },
    ),
  )

  it.live(
    "uses a fresh active-history estimate when prior model usage undercounts the switched model",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const model = createModel({ context: 1_000_000, output: 32_000 })
          const tokens = { input: 190_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
          expect(yield* compact.isOverflow({ tokens, model, estimatedInputTokens: 250_000 })).toBe(true)
        }),
      { config: { compaction: { max_context_tokens: 250_000 } } },
    ),
  )

  it.live(
    "honors the model limit while the proactive ceiling is cooling down",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const model = createModel({ context: 100_000, output: 10_000 })
          const currentHistoryTokens = 100_000
          expect(
            yield* compact.isOverflow({
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              model,
              estimatedInputTokens: currentHistoryTokens,
              threshold: "model",
            }),
          ).toBe(true)
        }),
      { config: { compaction: { max_context_tokens: 250_000 } } },
    ),
  )

  it.live(
    "does not compact at the configured ceiling when automatic compaction is disabled",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const model = createModel({ context: 1_000_000, output: 32_000 })
          const tokens = { input: 300_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
        }),
      { config: { compaction: { auto: false, max_context_tokens: 250_000 } } },
    ),
  )

  it.live(
    "returns true when token count exceeds usable context",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when token count within usable context",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "includes cache.read in token count",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 60_000, output: 10_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "respects input limit for input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 271_000, output: 1_000, reasoning: 0, cache: { read: 2_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when input/output are within input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 200_000, output: 20_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "returns false when output within limit with input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, input: 120_000, output: 10_000 })
        const tokens = { input: 50_000, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  // ─── Bug reproduction tests ───────────────────────────────────────────
  // These tests demonstrate that when limit.input is set, isOverflow()
  // does not subtract any headroom for the next model response. This means
  // compaction only triggers AFTER we've already consumed the full input
  // budget, leaving zero room for the next API call's output tokens.
  //
  // Compare: without limit.input, usable = context - output (reserves space).
  // With limit.input, usable = limit.input (reserves nothing).
  //
  // Related issues: #10634, #8089, #11086, #12621
  // Open PRs: #6875, #12924

  it.live(
    "BUG: no headroom when limit.input is set — compaction should trigger near boundary but does not",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        // Simulate Claude with prompt caching: input limit = 200K, output limit = 32K
        const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })

        // We've used 198K tokens total. Only 2K under the input limit.
        // On the next turn, the full conversation (198K) becomes input,
        // plus the model needs room to generate output — this WILL overflow.
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 180K + 3K + 15K = 198K
        // usable = limit.input = 200K (no output subtracted!)
        // 198K > 200K = false → no compaction triggered

        // WITHOUT limit.input: usable = 200K - 32K = 168K, and 198K > 168K = true ✓
        // WITH limit.input: usable = 200K, and 198K > 200K = false ✗

        // With 198K used and only 2K headroom, the next turn will overflow.
        // Compaction MUST trigger here.
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "BUG: without limit.input, same token count correctly triggers compaction",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        // Same model but without limit.input — uses context - output instead
        const model = createModel({ context: 200_000, output: 32_000 })

        // Same token usage as above
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 198K
        // usable = context - output = 200K - 32K = 168K
        // 198K > 168K = true → compaction correctly triggered

        const result = yield* compact.isOverflow({ tokens, model })
        expect(result).toBe(true) // ← Correct: headroom is reserved
      }),
    ),
  )

  it.live(
    "BUG: asymmetry — limit.input model allows 30K more usage before compaction than equivalent model without it",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        // Two models with identical context/output limits, differing only in limit.input
        const withInputLimit = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        const withoutInputLimit = createModel({ context: 200_000, output: 32_000 })

        // 170K total tokens — well above context-output (168K) but below input limit (200K)
        const tokens = { input: 166_000, output: 10_000, reasoning: 0, cache: { read: 5_000, write: 0 } }

        const withLimit = yield* compact.isOverflow({ tokens, model: withInputLimit })
        const withoutLimit = yield* compact.isOverflow({ tokens, model: withoutInputLimit })

        // Both models have identical real capacity — they should agree:
        expect(withLimit).toBe(true) // should compact (170K leaves no room for 32K output)
        expect(withoutLimit).toBe(true) // correctly compacts (170K > 168K)
      }),
    ),
  )

  it.live(
    "returns false when model context limit is 0",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 0, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "returns false when compaction.auto is disabled",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
          expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
        }),
      {
        config: {
          compaction: { auto: false },
        },
      },
    ),
  )
})

describe("session.compaction.create", () => {
  it.live(
    "creates a compaction user message and part",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service

        const info = yield* ssn.create({})

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: true,
          overflow: true,
        })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        expect(msgs).toHaveLength(1)
        expect(msgs[0].info.role).toBe("user")
        expect(msgs[0].parts).toHaveLength(1)
        expect(msgs[0].parts[0]).toMatchObject({
          type: "compaction",
          auto: true,
          overflow: true,
        })
      }),
    ),
  )

  it.live.skip(
    "projects a compaction message to v2 (v2 projector disabled)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: true,
          overflow: true,
        })

        const v2 = yield* SessionV2.Service.use((svc) => svc.messages({ sessionID: info.id })).pipe(
          Effect.provide(SessionExecution.noopLayer),
          Effect.provide(SessionV2.defaultLayer),
        )
        expect(v2.at(-1)).toMatchObject({
          type: "compaction",
          reason: "auto",
          summary: "",
        })
      }),
    ),
  )
})

describe("session.compaction.process", () => {
  it.instance(
    "does not expose the retired persistent prune entry point",
    Effect.gen(function* () {
      const compact = yield* SessionCompaction.Service
      expect("prune" in compact).toBe(false)
    }),
  )

  it.instance(
    "throws when parent is not a user message",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const reply = yield* createAssistantMessage(session.id, msg.id, test.directory)
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const exit = yield* Effect.exit(
        SessionCompaction.use.process({
          parentID: reply.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Error)
        if (error instanceof Error) {
          expect(error.message).toContain(`Compaction parent must be a user message: ${reply.id}`)
        }
      }
    }),
  )

  itCompaction.instance(
    "runs manual full compaction with dynamic folding disabled and orders hooks",
    () => {
      const order: string[] = []
      let pluginContext: string[] = []
      const stub = llm()
      stub.push(reply("summary"))
      const memory = Layer.mock(Memory.Service, {
        checkpoint: () =>
          Effect.sync(() => {
            order.push("memory")
            return ["memory-context"]
          }),
      })
      const settingsHook = Layer.mock(SettingsHook.Service, {
        trigger: (payload) =>
          Effect.sync(() => {
            if (payload.event === "PreCompact") order.push("precompact")
            return { additionalContexts: [], systemMessages: [] }
          }),
        list: () => Effect.succeed([]),
      })
      const orderedPlugin = Layer.mock(Plugin.Service)({
        trigger: (name, _input, output) =>
          Effect.sync(() => {
            if (
              name === "experimental.session.compacting" &&
              typeof output === "object" &&
              output !== null &&
              "context" in output &&
              Array.isArray(output.context) &&
              output.context.every((value) => typeof value === "string")
            ) {
              order.push("plugin")
              pluginContext = [...output.context]
            }
            return output
          }),
        list: () => Effect.succeed([]),
        init: () => Effect.void,
      })

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })

        yield* SessionCompaction.use.process({
          parentID: msg.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        expect(order.slice(0, 3)).toEqual(["memory", "precompact", "plugin"])
        expect(pluginContext).toEqual(["memory-context"])
      }).pipe(withCompaction({ llm: stub.layer, plugin: orderedPlugin, memory, settingsHook }))
    },
    { git: true, config: { compaction: { dynamic: false } } },
  )

  itCompaction.instance(
    "skips the MEMORY checkpoint for child agent sessions",
    () => {
      let checkpoints = 0
      const stub = llm()
      stub.push(reply("summary"))
      const memory = Layer.mock(Memory.Service, {
        checkpoint: () =>
          Effect.sync(() => {
            checkpoints++
            return []
          }),
      })

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const parent = yield* ssn.create({})
        const child = yield* ssn.create({ parentID: parent.id })
        const msg = yield* createUserMessage(child.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: child.id })

        yield* SessionCompaction.use.process({
          parentID: msg.id,
          messages: msgs,
          sessionID: child.id,
          auto: false,
        })

        expect(checkpoints).toBe(0)
      }).pipe(withCompaction({ llm: stub.layer, memory }))
    },
    { git: true },
  )

  it.instance(
    "publishes compacted event on continue",
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const done = yield* Deferred.make<void, Error>()
      let seen = false
      const unsub = yield* events.listen((evt) => {
        if (evt.type !== SessionCompaction.Event.Compacted.type) return Effect.void
        if ((evt.data as typeof SessionCompaction.Event.Compacted.data.Type).sessionID !== session.id)
          return Effect.void
        seen = true
        Deferred.doneUnsafe(done, Effect.void)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      yield* Deferred.await(done).pipe(Effect.timeout("500 millis"))
      expect(result).toBe("continue")
      expect(seen).toBe(true)
    }),
  )

  itCompaction.instance(
    "marks summary message as errored on compact result",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const summary = (yield* ssn.messages({ sessionID: session.id })).find(
        (msg) => msg.info.role === "assistant" && msg.info.summary,
      )

      expect(result).toBe("stop")
      expect(summary?.info.role).toBe("assistant")
      if (summary?.info.role === "assistant") {
        expect(summary.info.finish).toBe("error")
        expect(JSON.stringify(summary.info.error)).toContain("Session too large to compact")
      }
    }).pipe(withCompaction({ result: "compact" })),
  )

  it.instance(
    "adds synthetic continue prompt when auto is enabled",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
      })

      const all = yield* ssn.messages({ sessionID: session.id })
      const last = all.at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("user")
      expect(last?.parts[0]).toMatchObject({
        type: "text",
        synthetic: true,
        metadata: { compaction_continue: true },
      })
      if (last?.parts[0]?.type === "text") {
        expect(last.parts[0].text).toContain("Continue if you have next steps")
      }
    }),
  )

  itCompaction.instance(
    "persists tail_start_id for retained recent turns",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "first")
      const keep = yield* createUserMessage(session.id, "second")
      yield* createUserMessage(session.id, "third")
      yield* createSummaryCompaction(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const part = yield* readCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBe(keep.id)
    }).pipe(withCompaction({ config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }) })),
  )

  itCompaction.instance(
    "shrinks retained tail to fit preserve token budget",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "first")
      yield* createUserMessage(session.id, "x".repeat(2_000))
      const keep = yield* createUserMessage(session.id, "tiny")
      yield* createSummaryCompaction(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const part = yield* readCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBe(keep.id)
    }).pipe(withCompaction({ config: cfg({ tail_turns: 2, preserve_recent_tokens: 100 }) })),
  )

  itCompaction.instance(
    "falls back to full summary when even one recent turn exceeds preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "first")
        yield* createUserMessage(session.id, "y".repeat(2_000))
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBeUndefined()
        expect(captured).toContain("yyyy")
      }).pipe(withCompaction({ llm: stub.layer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 20 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "falls back to full summary when retained tail media exceeds preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older")
        const recent = yield* createUserMessage(session.id, "recent image turn")
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: recent.id,
          sessionID: session.id,
          type: "file",
          mime: "image/png",
          filename: "big.png",
          url: `data:image/png;base64,${"a".repeat(4_000)}`,
        })
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBeUndefined()
        expect(captured).toContain("recent image turn")
        expect(captured).toContain("Attached image/png: big.png")
      }).pipe(withCompaction({ llm: stub.layer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 100 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "retains a split turn suffix when a later message fits the preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older")
        const recent = yield* createUserMessage(session.id, "recent turn")
        const large = yield* createAssistantMessage(session.id, recent.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: large.id,
          sessionID: session.id,
          type: "text",
          text: "z".repeat(2_000),
        })
        const keep = yield* createAssistantMessage(session.id, recent.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: keep.id,
          sessionID: session.id,
          type: "text",
          text: "keep tail",
        })
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBe(keep.id)
        expect(captured).toContain("zzzz")
        expect(captured).not.toContain("keep tail")

        const filtered = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        expect(filtered.map((msg) => msg.info.id).slice(0, 3)).toEqual([parent!, expect.any(String), keep.id])
        expect(filtered[1]?.info.role).toBe("assistant")
        expect(filtered[1]?.info.role === "assistant" ? filtered[1].info.summary : false).toBe(true)
        expect(filtered.map((msg) => msg.info.id)).not.toContain(large.id)
      }).pipe(withCompaction({ llm: stub.layer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 100 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "allows plugins to disable synthetic continue prompt",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
      })

      const all = yield* ssn.messages({ sessionID: session.id })
      const last = all.at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("assistant")
      expect(
        all.some(
          (msg) =>
            msg.info.role === "user" &&
            msg.parts.some(
              (part) => part.type === "text" && part.synthetic && part.text.includes("Continue if you have next steps"),
            ),
        ),
      ).toBe(false)
    }).pipe(withCompaction({ plugin: autocontinue(false) })),
  )

  // SessionStart(source: "compact") — Claude Code parity: contexts returned by the hook
  // are re-injected after the summary, on the follow-up user message when one exists
  // and through the HookStartContext queue otherwise.
  function sessionStartHook(sources: string[], contexts: string[] = ["compact-ctx"]) {
    return Layer.mock(SettingsHook.Service, {
      trigger: (payload) =>
        Effect.sync(() => {
          if (payload.event !== "SessionStart") return { additionalContexts: [], systemMessages: [] }
          sources.push(payload.source)
          return { additionalContexts: contexts, systemMessages: [] }
        }),
      list: () => Effect.succeed([]),
    })
  }

  // Recording stand-in for the HookStartContext queue; compaction only ever calls `append`.
  function recordingStartContext(queued: string[]) {
    return Layer.succeed(
      HookStartContext.Service,
      HookStartContext.Service.of({
        append: (_sessionID, ctx) => Effect.sync(() => void queued.push(ctx)),
        consume: () => Effect.succeed([]),
        markStarted: () => Effect.void,
        claimResume: () => Effect.succeed(false),
      }),
    )
  }

  const syntheticTexts = (message: SessionV1.WithParts | undefined) =>
    message?.parts.flatMap((part) => (part.type === "text" && part.synthetic ? [part.text] : [])) ?? []

  itCompaction.instance(
    "fires SessionStart compact and attaches contexts to the auto-continue message",
    () => {
      const sources: string[] = []
      const queued: string[] = []
      const stub = llm()
      stub.push(reply("summary"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })

        const result = yield* SessionCompaction.use.process({
          parentID: msg.id,
          messages: msgs,
          sessionID: session.id,
          auto: true,
        })

        const last = (yield* ssn.messages({ sessionID: session.id })).at(-1)
        expect(result).toBe("continue")
        expect(sources).toEqual(["compact"])
        expect(last?.info.role).toBe("user")
        expect(syntheticTexts(last)).toEqual([expect.stringContaining("Continue if you have next steps"), "compact-ctx"])
        expect(queued).toEqual([])
      }).pipe(
        withCompaction({
          llm: stub.layer,
          settingsHook: sessionStartHook(sources),
          startContext: recordingStartContext(queued),
        }),
      )
    },
    { git: true },
  )

  itCompaction.instance(
    "attaches SessionStart compact contexts to the overflow replay message",
    () => {
      const sources: string[] = []
      const queued: string[] = []
      const stub = llm()
      stub.push(reply("summary"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "root")
        yield* createUserMessage(session.id, "replayed")
        const msg = yield* createUserMessage(session.id, "current")
        const msgs = yield* ssn.messages({ sessionID: session.id })

        yield* SessionCompaction.use.process({
          parentID: msg.id,
          messages: msgs,
          sessionID: session.id,
          auto: true,
          overflow: true,
        })

        const last = (yield* ssn.messages({ sessionID: session.id })).at(-1)
        expect(sources).toEqual(["compact"])
        expect(last?.info.role).toBe("user")
        expect(syntheticTexts(last)).toEqual(["compact-ctx"])
        expect(last?.parts.some((part) => part.type === "text" && part.text === "replayed")).toBe(true)
        expect(queued).toEqual([])
      }).pipe(
        withCompaction({
          llm: stub.layer,
          settingsHook: sessionStartHook(sources),
          startContext: recordingStartContext(queued),
        }),
      )
    },
    { git: true },
  )

  itCompaction.instance(
    "queues SessionStart compact contexts for the next prompt when no follow-up message exists",
    () => {
      const sources: string[] = []
      const queued: string[] = []
      const stub = llm()
      stub.push(reply("summary"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })

        yield* SessionCompaction.use.process({
          parentID: msg.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        expect(sources).toEqual(["compact"])
        expect(queued).toEqual(["compact-ctx"])
      }).pipe(
        withCompaction({
          llm: stub.layer,
          settingsHook: sessionStartHook(sources, ["compact-ctx", ""]),
          startContext: recordingStartContext(queued),
        }),
      )
    },
    { git: true },
  )

  itCompaction.instance(
    "does not fire SessionStart compact for child sessions",
    () => {
      const sources: string[] = []
      const queued: string[] = []
      const stub = llm()
      stub.push(reply("summary"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const parent = yield* ssn.create({})
        const child = yield* ssn.create({ parentID: parent.id })
        const msg = yield* createUserMessage(child.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: child.id })

        yield* SessionCompaction.use.process({
          parentID: msg.id,
          messages: msgs,
          sessionID: child.id,
          auto: true,
        })

        expect(sources).toEqual([])
        expect(queued).toEqual([])
      }).pipe(
        withCompaction({
          llm: stub.layer,
          settingsHook: sessionStartHook(sources),
          startContext: recordingStartContext(queued),
        }),
      )
    },
    { git: true },
  )

  it.instance(
    "replays the prior user turn on overflow when earlier context exists",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "root")
      const replay = yield* createUserMessage(session.id, "image")
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: replay.id,
        sessionID: session.id,
        type: "file",
        mime: "image/png",
        filename: "cat.png",
        url: "https://example.com/cat.png",
      })
      const msg = yield* createUserMessage(session.id, "current")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
        overflow: true,
      })

      const last = (yield* ssn.messages({ sessionID: session.id })).at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("user")
      expect(last?.parts.some((part) => part.type === "file")).toBe(false)
      expect(
        last?.parts.some((part) => part.type === "text" && part.text.includes("Attached image/png: cat.png")),
      ).toBe(true)
    }),
  )

  it.instance(
    "falls back to overflow guidance when no replayable turn exists",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "earlier")
      const msg = yield* createUserMessage(session.id, "current")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
        overflow: true,
      })

      const last = (yield* ssn.messages({ sessionID: session.id })).at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("user")
      if (last?.parts[0]?.type === "text") {
        expect(last.parts[0].text).toContain("previous request exceeded the provider's size limit")
      }
    }),
  )

  for (const family of ["gpt-5.2", "claude-sonnet-4.5"]) {
    for (const enabled of [undefined, false, true]) {
      for (const suffix of [false, true]) {
        itCompaction.instance(
          `successful small-model compaction fits the resumed conversation policy for ${family}, override ${enabled}, suffix ${suffix}`,
          () => {
            const stub = llm()
            const captured: string[] = []
            const small = { ...createModel({ context: 100_000, output: 32_000 }), id: ModelV2.ID.make("qwen-small") }
            const main = { ...createModel({ context: 8_192, output: 1_000 }), id: ModelV2.ID.make(family) }
            const provider = ProviderTest.fake({
              getSmallModel: () => Effect.succeed(small),
              getModel: () => Effect.succeed(main),
            })
            stub.push(reply("complete summary", (input) => captured.push(JSON.stringify(input.messages))))
            const base: ConfigV1.Info = {
              reasoningDistillation: { enabled: true },
              provider: { test: { models: { [family]: { reasoningDistillation: { enabled } } } } },
              compaction: { tail_turns: 1, preserve_recent_tokens: 300 },
            }
            return Effect.gen(function* () {
              const ssn = yield* SessionNs.Service
              const instance = yield* TestInstance
              const session = yield* ssn.create({})
              yield* createUserMessage(session.id, "earlier context")
              const tail = yield* createUserMessage(session.id, "recent turn")
              const assistant = yield* createAssistantMessage(session.id, tail.id, instance.directory)
              yield* ssn.updatePart({
                id: PartID.ascending(),
                messageID: assistant.id,
                sessionID: session.id,
                type: "reasoning",
                text: "short distilled reasoning",
                time: { start: 1, end: 2 },
                distillation: {
                  originalText: `original reasoning ${"x".repeat(60_000)}`,
                  sourceFingerprint: "tail-source",
                  version: 2,
                },
              })
              let suffixID: MessageID | undefined
              if (suffix) {
                const keep = yield* createAssistantMessage(session.id, tail.id, instance.directory)
                suffixID = keep.id
                yield* ssn.updatePart({
                  id: PartID.ascending(),
                  messageID: keep.id,
                  sessionID: session.id,
                  type: "text",
                  text: "retained tiny suffix",
                })
              }
              yield* createSummaryCompaction(session.id)
              const messages = yield* ssn.messages({ sessionID: session.id })
              const marker = messages.at(-1)!.parts.find((part) => part.type === "compaction")
              if (!marker || marker.type !== "compaction") throw new Error("Expected compaction marker")
              yield* ssn.updatePart({ ...marker, tail_start_id: tail.id })
              marker.tail_start_id = tail.id
              expect(
                yield* SessionCompaction.use.process({
                  parentID: messages.at(-1)!.info.id,
                  messages,
                  sessionID: session.id,
                  auto: false,
                }),
              ).toBe("continue")
              expect(captured).toHaveLength(1)
              expect(captured[0]).not.toContain("original reasoning")
              const part = yield* readCompactionPart(session.id)
              expect(part?.tail_start_id).toBe(enabled ? tail.id : suffixID)
              const retained = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
              expect(retained.some((message) => message.info.id === tail.id)).toBe(enabled === true)
              if (suffixID) expect(retained.some((message) => message.info.id === suffixID)).toBe(true)
              const wire = yield* MessageV2.toModelMessagesEffect(retained, main, {
                stripMedia: true,
                reasoningDistillationEnabled: ConfigReasoningDistillation.resolveEnabled({
                  disabledByEnvironment: false,
                  enabled: true,
                  modelEnabled: enabled,
                  modelID: main.id,
                }).enabled,
              })
              expect(JSON.stringify(wire)).not.toContain("original reasoning")
              expect(Token.estimate(JSON.stringify(wire))).toBeLessThanOrEqual(300)
              expect(
                yield* SessionCompaction.use.isOverflow({
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  model: main,
                  estimatedInputTokens: Token.estimate(JSON.stringify(wire)),
                  threshold: "model",
                }),
              ).toBe(false)
            }).pipe(
              withCompaction({
                llm: stub.layer,
                provider,
                config: TestConfig.layer({ get: () => Effect.succeed(base) }),
              }),
            )
          },
          { git: true },
        )
      }
    }
  }

  for (const narrow of ["conversation", "summarizer"]) {
    itCompaction.instance(
      `successful small-model compaction uses the smaller default budget for the resumed conversation, narrow ${narrow}`,
      () => {
        const stub = llm()
        const small = createModel({ context: narrow === "summarizer" ? 8_192 : 100_000, output: 1_000 })
        const main = createModel({ context: narrow === "conversation" ? 8_192 : 100_000, output: 1_000 })
        const provider = ProviderTest.fake({
          getSmallModel: () => Effect.succeed({ ...small, id: ModelV2.ID.make("small") }),
          getModel: () => Effect.succeed(main),
        })
        stub.push(reply("complete summary"))
        return Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          yield* createUserMessage(session.id, "earlier context")
          const tail = yield* createUserMessage(session.id, "x".repeat(20_000))
          yield* createSummaryCompaction(session.id)
          const messages = yield* ssn.messages({ sessionID: session.id })
          expect(
            yield* SessionCompaction.use.process({
              parentID: messages.at(-1)!.info.id,
              messages,
              sessionID: session.id,
              auto: false,
            }),
          ).toBe("continue")
          expect((yield* readCompactionPart(session.id))?.tail_start_id).toBeUndefined()
          const retained = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
          expect(retained.some((message) => message.info.id === tail.id)).toBe(false)
        }).pipe(withCompaction({ llm: stub.layer, provider, config: cfg({ tail_turns: 1 }) }))
      },
      { git: true },
    )
  }

  for (const family of ["gpt-5.2", "claude-sonnet-4.5"]) {
    for (const enabled of [undefined, true]) {
      for (const suffix of [false, true]) {
        itCompaction.instance(
          `compaction fallback reselects head and retained tail for ${family}, model override ${enabled}, suffix ${suffix}`,
          () => {
            const stub = llm()
            const captured: string[] = []
            let recent = ""
            const small = { ...createModel({ context: 100_000, output: 32_000 }), id: ModelV2.ID.make("qwen-small") }
            const fallback = { ...small, id: ModelV2.ID.make(family) }
            const provider = ProviderTest.fake({
              getSmallModel: () => Effect.succeed(small),
              getModel: () => Effect.succeed(fallback),
            })
            stub.push((input) => {
              captured.push(JSON.stringify(input.messages))
              return Stream.fail(new CompactionTimeoutError({ message: "try fallback model" }))
            })
            stub.push(reply("complete summary", (input) => captured.push(JSON.stringify(input.messages))))
            const base = Schema.decodeUnknownSync(ConfigV1.Info)({
              reasoningDistillation: { enabled: true },
              provider: { test: { models: { [family]: { reasoningDistillation: { enabled } } } } },
              compaction: { tail_turns: 1, preserve_recent_tokens: 300 },
            }) as ConfigV1.Info
            return Effect.gen(function* () {
              const ssn = yield* SessionNs.Service
              const instance = yield* TestInstance
              const events = yield* EventV2Bridge.Service
              const publish = events.publish.bind(events)
              spyOn(events, "publish").mockImplementation((definition, data, options) => {
                if (typeof data === "object" && data !== null && "recent" in data && typeof data.recent === "string")
                  recent = data.recent
                return publish(definition, data, options)
              })
              const session = yield* ssn.create({})
              let tailID: MessageID | undefined
              let suffixID: MessageID | undefined
              for (const name of ["head", "tail"]) {
                const user = yield* createUserMessage(session.id, `${name} turn`)
                if (name === "tail") tailID = user.id
                const assistant = yield* createAssistantMessage(session.id, user.id, instance.directory)
                yield* ssn.updatePart({
                  id: PartID.ascending(),
                  messageID: assistant.id,
                  sessionID: session.id,
                  type: "reasoning",
                  text: `${name} distilled reasoning`,
                  time: { start: 1, end: 2 },
                  distillation: {
                    originalText: `${name} original reasoning${name === "tail" ? "x".repeat(4_000) : ""}`,
                    sourceFingerprint: `${name}-source`,
                    version: 2,
                  },
                })
                if (name === "tail" && suffix) {
                  const keep = yield* createAssistantMessage(session.id, user.id, instance.directory)
                  suffixID = keep.id
                  yield* ssn.updatePart({
                    id: PartID.ascending(),
                    messageID: keep.id,
                    sessionID: session.id,
                    type: "text",
                    text: "retained tiny suffix",
                  })
                }
              }
              yield* createSummaryCompaction(session.id)
              const messages = yield* ssn.messages({ sessionID: session.id })
              const marker = messages.at(-1)!.parts.find((part) => part.type === "compaction")
              if (!marker || marker.type !== "compaction") throw new Error("Expected compaction marker")
              yield* ssn.updatePart({ ...marker, tail_start_id: tailID })
              marker.tail_start_id = tailID
              const result = yield* SessionCompaction.use.process({
                parentID: messages.at(-1)!.info.id,
                messages,
                sessionID: session.id,
                auto: false,
              })
              expect(result).toBe("continue")
              expect(captured).toHaveLength(2)
              const part = yield* readCompactionPart(session.id)
              expect(part?.type).toBe("compaction")
              expect(part?.tail_start_id).toBe(enabled ? tailID : suffixID)
              expect(captured[0]).toContain("head distilled reasoning")
              expect(captured[0]).not.toContain("head original reasoning")
              expect(captured[1]).toContain(enabled ? "head distilled reasoning" : "head original reasoning")
              expect(captured[1]).not.toContain(enabled ? "head original reasoning" : "head distilled reasoning")
              if (enabled) {
                expect(captured[1]).not.toContain("tail distilled reasoning")
                expect(recent).toContain("tail distilled reasoning")
                expect(recent).not.toContain("tail original reasoning")
              } else {
                expect(captured[1]).toContain(`tail original reasoning${"x".repeat(4_000)}`)
                expect(recent).not.toContain("tail original reasoning")
                if (suffix) {
                  expect(captured[1]).not.toContain("retained tiny suffix")
                  expect(recent).toContain("retained tiny suffix")
                } else expect(recent).toBe("")
              }
              expect(Token.estimate(recent)).toBeLessThanOrEqual(300)
              const retained = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
              expect(retained.some((message) => message.info.id === tailID)).toBe(enabled === true)
              if (suffixID) expect(retained.some((message) => message.info.id === suffixID)).toBe(true)
            }).pipe(
              withCompaction({
                llm: stub.layer,
                provider,
                config: TestConfig.layer({ get: () => Effect.succeed(base) }),
              }),
            )
          },
          { git: true },
        )
      }
    }
  }

  for (const outcome of [
    "success",
    "exhausted",
    "overflow",
    "gateway-timeout",
    "native-408",
    "native-504",
    "native-504-retry-after",
    "native-cancel",
    "cancel",
  ] as const) {
    itCompaction.instance(
      `compaction model ladder: ${outcome}`,
      () => {
        const stub = llm()
        const seen: string[] = []
        const requests: string[] = []
        const small = { ...createModel({ context: 100_000, output: 32_000 }), id: ModelV2.ID.make("small") }
        const agentModel = { ...small, id: ModelV2.ID.make("agent") }
        const conversation = createModel({ context: 100_000, output: 32_000 })
        const provider = ProviderTest.fake({
          model: conversation,
          getSmallModel: () => Effect.succeed(small),
          getModel: (_providerID, modelID) => Effect.succeed(modelID === agentModel.id ? agentModel : conversation),
        })
        const ready = Deferred.makeUnsafe<void>()
        for (const model of [small, agentModel, conversation]) {
          stub.push((input) => {
            seen.push(input.model.id)
            expect(input.retries).toBe(0)
            if (outcome === "cancel") {
              return Stream.fromEffect(Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)))
            }
            if (outcome.startsWith("native-")) {
              const http = Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.gen(function* () {
                    requests.push(input.model.id)
                    if (outcome === "native-cancel") {
                      yield* Deferred.succeed(ready, undefined)
                      return yield* Effect.never
                    }
                    return HttpClientResponse.fromWeb(
                      request,
                      new Response(null, {
                        status: outcome === "native-408" ? 408 : 504,
                        headers: outcome === "native-504-retry-after" ? { "retry-after-ms": "10000" } : {},
                      }),
                    )
                  }),
                ),
              )
              return Stream.unwrap(
                Effect.gen(function* () {
                  const llmClient = yield* LLMClient.Service
                  const native = yield* LLMNativeRuntime.stream({
                    model: {
                      ...input.model,
                      api: { id: input.model.id, url: "https://provider.test/v1", npm: "@ai-sdk/openai-compatible" },
                    },
                    provider: {
                      id: input.model.providerID,
                      name: "test",
                      source: "config",
                      env: [],
                      options: { apiKey: "test" },
                      models: {},
                    },
                    auth: undefined,
                    llmClient,
                    messages: input.messages,
                    tools: {},
                    headers: {},
                    abort: new AbortController().signal,
                    contextFolding: {
                      enabled: false,
                      purpose: input.purpose ?? "unknown",
                      system: { kind: "messages" },
                    },
                  })
                  if (native.type !== "supported") return yield* Effect.die(native.reason)
                  return native.stream
                }).pipe(
                  Effect.provide(
                    LLMClient.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(http)), WebSocketExecutor.layer),
                      ),
                      Layer.fresh,
                    ),
                  ),
                ),
              )
            }
            if (outcome === "gateway-timeout")
              return Stream.fail(
                new APICallError({
                  message: "Gateway Timeout",
                  url: "https://example.com",
                  requestBodyValues: {},
                  statusCode: 504,
                  isRetryable: true,
                  responseHeaders: { "retry-after-ms": "10000" },
                }),
              )
            if (outcome === "success" && model === conversation) return reply("complete summary")(input)
            const error =
              outcome === "overflow" && model === small
                ? new APICallError({
                    message: "maximum context length exceeded",
                    url: "https://example.com",
                    requestBodyValues: {},
                    statusCode: 400,
                    isRetryable: false,
                  })
                : new CompactionTimeoutError({ message: "Compaction stream timed out without progress" })
            return Stream.make(
              LLMEvent.textStart({ id: "partial" }),
              LLMEvent.textDelta({ id: "partial", text: "incomplete summary" }),
            ).pipe(Stream.concat(Stream.fail(error)))
          })
        }
        return Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          yield* createUserMessage(session.id, "hello")
          yield* createSummaryCompaction(session.id)
          const messages = yield* ssn.messages({ sessionID: session.id })
          const parent = messages.at(-1)!
          const effect = SessionCompaction.use.process({
            parentID: parent.info.id,
            messages,
            sessionID: session.id,
            auto: true,
          })
          if (outcome === "cancel" || outcome === "native-cancel") {
            const fiber = yield* effect.pipe(Effect.forkChild)
            yield* Deferred.await(ready)
            yield* Fiber.interrupt(fiber)
            const exit = yield* Fiber.await(fiber)
            expect(Exit.isFailure(exit)).toBe(true)
            expect(seen).toEqual(["small"])
            if (outcome === "native-cancel") expect(requests).toEqual(["small"])
            return
          }
          const started = Date.now()
          const result = yield* effect
          expect(Date.now() - started).toBeLessThan(2_000)
          expect(seen).toEqual(["small", "agent", "test-model"])
          if (outcome.startsWith("native-")) expect(requests).toEqual(seen)
          expect(result).toBe(outcome === "success" ? "continue" : "stop")
          const stored = yield* ssn.messages({ sessionID: session.id })
          const summaries = stored.filter((item) => item.info.role === "assistant" && item.info.summary)
          expect(summaries).toHaveLength(1)
          expect(summaries[0].info.role === "assistant" && summaries[0].info.modelID).toBe(
            ModelV2.ID.make("test-model"),
          )
          if (outcome === "success") {
            expect(summaries[0].parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
              "complete summary",
            ])
            expect(
              stored.filter((item) => item.parts.some((part) => part.type === "text" && part.synthetic)),
            ).toHaveLength(1)
          } else {
            const status = yield* SessionStatus.Service
            expect((yield* status.get(session.id)).type).toBe("idle")
            expect(summaries[0].info.role === "assistant" && summaries[0].info.error).toBeDefined()
          }
        }).pipe(
          withCompaction({
            llm: stub.layer,
            provider,
          }),
        )
      },
      { git: true, config: { agent: { compaction: { model: "test/agent" } } } },
    )
  }

  itCompaction.instance(
    "actual stalled compaction stream is aborted before model fallback",
    () => {
      const stub = llm()
      const seen: string[] = []
      const small = { ...createModel({ context: 100_000, output: 32_000 }), id: ModelV2.ID.make("small") }
      const ready = Deferred.makeUnsafe<void>()
      let interrupted = false
      stub.push((input) => {
        seen.push(input.model.id)
        return Stream.fromEffect(
          Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true
              }),
            ),
          ),
        )
      })
      stub.push(
        reply("recovered summary", (input) => {
          expect(interrupted).toBe(true)
          seen.push(input.model.id)
        }),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const parent = yield* createUserMessage(session.id, "hello")
        const messages = yield* ssn.messages({ sessionID: session.id })
        yield* Effect.gen(function* () {
          const fiber = yield* SessionCompaction.use
            .process({ parentID: parent.id, messages, sessionID: session.id, auto: false })
            .pipe(Effect.forkChild)
          yield* Deferred.await(ready)
          yield* TestClock.adjust("2 minutes")
          expect(yield* Fiber.join(fiber)).toBe("continue")
          expect(seen).toEqual(["small", "test-model"])
        }).pipe(Effect.provide(TestClock.layer()))
      }).pipe(
        withCompaction({
          llm: stub.layer,
          provider: ProviderTest.fake({
            model: createModel({ context: 100_000, output: 32_000 }),
            getSmallModel: () => Effect.succeed(small),
          }),
        }),
      )
    },
    { git: true },
  )

  itCompaction.instance(
    "duplicate compaction models are attempted only once",
    () => {
      const stub = llm()
      let calls = 0
      stub.push(() => {
        calls++
        return Stream.fail(new CompactionTimeoutError({ message: "Compaction stream timed out" }))
      })
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const parent = yield* createUserMessage(session.id, "hello")
        const result = yield* SessionCompaction.use.process({
          parentID: parent.id,
          messages: yield* ssn.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: false,
        })
        expect(result).toBe("stop")
        expect(calls).toBe(1)
      }).pipe(withCompaction({ llm: stub.layer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "stops quickly when aborted during retry backoff",
    () => {
      const stub = llm()
      stub.push(
        Stream.fromAsyncIterable(
          {
            async *[Symbol.asyncIterator]() {
              yield LLMEvent.stepStart({ index: 0 })
              throw new APICallError({
                message: "boom",
                url: "https://example.com/v1/chat/completions",
                requestBodyValues: {},
                statusCode: 503,
                responseHeaders: { "retry-after-ms": "10000" },
                responseBody: '{"error":"boom"}',
                isRetryable: true,
              })
            },
          },
          (err) => err,
        ),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const ready = yield* Deferred.make<void>()
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID !== session.id || data.status.type !== "retry") return Effect.void
          Deferred.doneUnsafe(ready, Effect.void)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => off)

        const fiber = yield* SessionCompaction.use
          .process({
            parentID: msg.id,
            messages: msgs,
            sessionID: session.id,
            auto: false,
          })
          .pipe(Effect.forkChild)

        yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
        const start = Date.now()
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          expect(Date.now() - start).toBeLessThan(250)
        }
      }).pipe(withCompaction({ llm: stub.layer }))
    },
    { git: true },
    { timeout: 10_000 },
  )

  itCompaction.instance(
    "does not leave a summary assistant when aborted before processor setup",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        return yield* Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          const msg = yield* createUserMessage(session.id, "hello")
          const msgs = yield* ssn.messages({ sessionID: session.id })
          const fiber = yield* SessionCompaction.use
            .process({
              parentID: msg.id,
              messages: msgs,
              sessionID: session.id,
              auto: false,
            })
            .pipe(Effect.forkChild)

          yield* Deferred.await(ready).pipe(Effect.timeout("1 second"))
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))
          const all = yield* ssn.messages({ sessionID: session.id })

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          expect(all.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(false)
        }).pipe(withCompaction({ plugin: plugin(ready) }))
      }),
    { git: true },
  )

  itCompaction.instance(
    "silently drops reasoning-delta arriving without prior reasoning-start",
    () => {
      // Regression: PR initially auto-created a reasoning Part for orphan deltas (no preceding
      // reasoning-start). Reverted to match dev — drop silently. Pinned here so any future
      // change to processor.ts reasoning-delta handling triggers this test.
      const stub = llm()
      stub.push(
        Stream.make(
          LLMEvent.reasoningDelta({ id: "orphan-1", text: "stray reasoning" }),
          LLMEvent.textStart({ id: "txt-0" }),
          LLMEvent.textDelta({ id: "txt-0", text: "summary" }),
          LLMEvent.textEnd({ id: "txt-0" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: basicUsage() }),
          LLMEvent.finish({ reason: "stop", usage: basicUsage() }),
        ),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        yield* SessionCompaction.use.process({
          parentID: msg.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const summary = (yield* ssn.messages({ sessionID: session.id })).find(
          (item) => item.info.role === "assistant" && item.info.summary,
        )
        expect(summary?.parts.some((part) => part.type === "reasoning")).toBe(false)
        // Sanity: the text part still got through.
        expect(summary?.parts.some((part) => part.type === "text" && part.text === "summary")).toBe(true)
      }).pipe(withCompaction({ llm: stub.layer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "does not allow tool calls while generating the summary",
    () => {
      const stub = llm()
      stub.push(
        Stream.make(
          LLMEvent.toolCall({ id: "call-1", name: "_noop", input: {} }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: basicUsage(),
          }),
          LLMEvent.finish({
            reason: "tool-calls",
            usage: basicUsage(),
          }),
        ),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        yield* SessionCompaction.use.process({ parentID: msg.id, messages: msgs, sessionID: session.id, auto: false })

        const summary = (yield* ssn.messages({ sessionID: session.id })).find(
          (item) => item.info.role === "assistant" && item.info.summary,
        )

        expect(summary?.info.role).toBe("assistant")
        expect(summary?.parts.some((part) => part.type === "tool")).toBe(false)
      }).pipe(withCompaction({ llm: stub.layer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "summarizes only the head while keeping recent tail out of summary input",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(
        reply("summary", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        yield* createUserMessage(session.id, "keep this turn")
        yield* createUserMessage(session.id, "and this one too")
        yield* createCompactionMarker(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        expect(captured).toContain("older context")
        expect(captured).not.toContain("keep this turn")
        expect(captured).not.toContain("and this one too")
        expect(captured).not.toContain("What did we do so far?")
      }).pipe(withCompaction({ llm: stub.layer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "anchors repeated compactions with the previous summary",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary one"))
      stub.push(
        reply("summary two", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        yield* createUserMessage(session.id, "keep this turn")
        yield* createCompactionMarker(session.id)

        let msgs = yield* ssn.messages({ sessionID: session.id })
        let parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        yield* createUserMessage(session.id, "latest turn")
        yield* createCompactionMarker(session.id)

        msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        expect(captured).toContain("<previous-summary>")
        expect(captured).toContain("summary one")
        expect(captured.match(/summary one/g)?.length).toBe(1)
        expect(captured).toContain("## Constraints & Preferences")
        expect(captured).toContain("## Progress")
      }).pipe(withCompaction({ llm: stub.layer }))
    },
    { git: true },
  )

  itCompaction.instance("keeps recent pre-compaction turns across repeated compactions", () => {
    const stub = llm()
    stub.push(reply("summary one"))
    stub.push(reply("summary two"))

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const u1 = yield* createUserMessage(session.id, "one")
      const u2 = yield* createUserMessage(session.id, "two")
      const u3 = yield* createUserMessage(session.id, "three")
      yield* createCompactionMarker(session.id)

      let msgs = yield* ssn.messages({ sessionID: session.id })
      let parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const u4 = yield* createUserMessage(session.id, "four")
      yield* createCompactionMarker(session.id)

      msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
      parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const filtered = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
      const ids = filtered.map((msg) => msg.info.id)

      expect(ids).not.toContain(u1.id)
      expect(ids).not.toContain(u2.id)
      expect(ids).toContain(u3.id)
      expect(ids).toContain(u4.id)
      expect(filtered.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(true)
      expect(
        filtered.some((msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction")),
      ).toBe(true)
    }).pipe(withCompaction({ llm: stub.layer, config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }) }))
  })

  itCompaction.instance(
    "ignores previous summaries when sizing the retained tail",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const test = yield* TestInstance
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older")
      const keep = yield* createUserMessage(session.id, "keep this turn")
      const keepReply = yield* createAssistantMessage(session.id, keep.id, test.directory)
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: keepReply.id,
        sessionID: session.id,
        type: "text",
        text: "keep reply",
      })

      yield* createCompactionMarker(session.id)
      const firstCompaction = (yield* ssn.messages({ sessionID: session.id })).at(-1)?.info.id
      expect(firstCompaction).toBeTruthy()
      yield* createSummaryAssistantMessage(session.id, firstCompaction!, test.directory, "summary ".repeat(800))

      const recent = yield* createUserMessage(session.id, "recent turn")
      const recentReply = yield* createAssistantMessage(session.id, recent.id, test.directory)
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: recentReply.id,
        sessionID: session.id,
        type: "text",
        text: "recent reply",
      })

      yield* createCompactionMarker(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const part = yield* readCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBe(keep.id)
    }).pipe(withCompaction({ config: cfg({ tail_turns: 2, preserve_recent_tokens: 500 }) })),
  )
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("SessionNs.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("subtracts cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    // AI SDK v6 normalizes inputTokens to include cached tokens for all providers
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("separates reasoning tokens from output tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(400)
    expect(result.tokens.reasoning).toBe(100)
    expect(result.tokens.total).toBe(1500)
  })

  test("does not double count reasoning tokens in cost", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 0,
        output: 15,
        cache: { read: 0, write: 0 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 250_000, totalTokens: 1_000_000 }),
    })

    expect(result.tokens.output).toBe(750_000)
    expect(result.tokens.reasoning).toBe(250_000)
    expect(result.cost).toBe(15)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 }),
    })

    expect(result.cost).toBe(3 + 1.5)
  })

  test("uses authoritative Copilot billed cost when provided", () => {
    const result = SessionNs.getUsage({
      model: createModel({
        context: 100_000,
        output: 32_000,
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 0.3 } },
      }),
      usage: usage({ inputTokens: 11_774, outputTokens: 39, totalTokens: 11_813 }),
      metadata: { copilot: { totalNanoAiu: 4_473_525_000 } },
    })

    expect(result.cost).toBe(0.04473525)
  })

  test("uses matching context cost tier before over-200k fallback", () => {
    const model = createModel({
      context: 1_000_000,
      output: 32_000,
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.5 },
        tiers: [
          {
            input: 3,
            output: 4,
            cache: { read: 0.3, write: 1.5 },
            tier: { type: "context", size: 200_000 },
          },
          {
            input: 5,
            output: 6,
            cache: { read: 0.5, write: 2.5 },
            tier: { type: "context", size: 500_000 },
          },
        ],
        experimentalOver200K: {
          input: 100,
          output: 100,
          cache: { read: 100, write: 100 },
        },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({
        inputTokens: 650_000,
        outputTokens: 100_000,
        totalTokens: 750_000,
        cacheReadInputTokens: 100_000,
      }),
    })

    expect(result.tokens.input).toBe(550_000)
    expect(result.cost).toBe(2.75 + 0.6 + 0.05)
  })

  test("falls back to over-200k pricing when no cost tier matches", () => {
    const model = createModel({
      context: 1_000_000,
      output: 32_000,
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.5 },
        tiers: [
          {
            input: 5,
            output: 6,
            cache: { read: 0.5, write: 2.5 },
            tier: { type: "context", size: 500_000 },
          },
        ],
        experimentalOver200K: {
          input: 3,
          output: 4,
          cache: { read: 0.3, write: 1.5 },
        },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 300_000, outputTokens: 100_000, totalTokens: 400_000 }),
    })

    expect(result.cost).toBe(0.9 + 0.4)
  })

  test.each(["@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/google-vertex/anthropic"])(
    "computes total from components for %s models",
    (npm) => {
      const model = createModel({ context: 100_000, output: 32_000, npm })
      // AI SDK v6: inputTokens includes cached tokens for all providers
      const item = usage({
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cacheReadInputTokens: 200,
      })
      if (npm === "@ai-sdk/amazon-bedrock") {
        const result = SessionNs.getUsage({
          model,
          usage: item,
          metadata: {
            bedrock: {
              usage: {
                cacheWriteInputTokens: 300,
              },
            },
          },
        })

        // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
        expect(result.tokens.input).toBe(500)
        expect(result.tokens.cache.read).toBe(200)
        expect(result.tokens.cache.write).toBe(300)
        // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
        expect(result.tokens.total).toBe(1500)
        return
      }

      const result = SessionNs.getUsage({
        model,
        usage: item,
        metadata: {
          anthropic: {
            cacheCreationInputTokens: 300,
          },
        },
      })

      // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
      expect(result.tokens.input).toBe(500)
      expect(result.tokens.cache.read).toBe(200)
      expect(result.tokens.cache.write).toBe(300)
      // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
      expect(result.tokens.total).toBe(1500)
    },
  )

  test("extracts cache write tokens from vertex metadata key", () => {
    const model = createModel({ context: 100_000, output: 32_000, npm: "@ai-sdk/google-vertex/anthropic" })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: {
        vertex: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.input).toBe(500)
    expect(result.tokens.cache.read).toBe(200)
    expect(result.tokens.cache.write).toBe(300)
  })
})
