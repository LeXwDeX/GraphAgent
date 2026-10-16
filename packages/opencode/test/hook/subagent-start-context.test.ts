import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID, PartID } from "@/session/schema"
import { HookStartContext } from "@/hook/start-context"
import { SettingsHook, type HookPayload, type TriggerResult } from "@/hook/settings"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Claude Code injects SubagentStart hookSpecificOutput.additionalContext into the
// subagent's context. The task tool must queue every non-empty additionalContext
// for the child session in HookStartContext before the child prompt is admitted
// (prompt admission drains the queue into synthetic text parts of the first
// user message).

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const recorded: HookPayload[] = []
let startContexts: string[] = []
const recorder = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: (payload) =>
      Effect.sync(() => {
        recorded.push(payload)
        const result: TriggerResult = {
          additionalContexts: payload.event === "SubagentStart" ? startContexts : [],
          systemMessages: [],
        }
        return result
      }),
    list: () => Effect.succeed([]),
  }),
)

const layer = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  EventV2Bridge.defaultLayer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Session.defaultLayer,
  SessionRunState.defaultLayer,
  SessionStatus.defaultLayer,
  Truncate.defaultLayer,
  ToolRegistry.defaultLayer,
  Database.defaultLayer,
  HookStartContext.defaultLayer,
  recorder,
  RuntimeFlags.layer({}),
).pipe(Layer.provide(Ripgrep.defaultLayer))

const it = testEffect(layer)

const seed = Effect.fn("SubagentStartContextTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Parent" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

// The prompt stub plays the role of prompt admission: it drains HookStartContext
// for the child session exactly like SessionPrompt does before writing parts.
function drainingOps(
  startCtx: HookStartContext.Interface,
  drained: { sessionID: string; texts: readonly string[] }[],
): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        drained.push({ sessionID: input.sessionID, texts: yield* startCtx.consume(input.sessionID) })
        const id = MessageID.ascending()
        return {
          info: {
            id,
            role: "assistant",
            parentID: input.messageID ?? MessageID.ascending(),
            sessionID: input.sessionID,
            mode: input.agent ?? "general",
            agent: input.agent ?? "general",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: input.model?.modelID ?? ref.modelID,
            providerID: input.model?.providerID ?? ref.providerID,
            time: { created: Date.now() },
            finish: "stop",
          },
          parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text: "done" }],
        } satisfies SessionV1.WithParts
      }),
  }
}

const run = Effect.fn("SubagentStartContextTest.run")(function* (
  drained: { sessionID: string; texts: readonly string[] }[],
  extra?: { task_id?: string },
) {
  const { chat, assistant } = yield* seed()
  const startCtx = yield* HookStartContext.Service
  const tool = yield* TaskTool
  const def = yield* tool.init()
  const result = yield* def.execute(
    { description: "ctx", prompt: "do it", subagent_type: "general", ...extra },
    {
      sessionID: chat.id,
      messageID: assistant.id,
      agent: "build",
      abort: new AbortController().signal,
      extra: { promptOps: drainingOps(startCtx, drained) },
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    },
  )
  return { chat, result }
})

describe("SubagentStart additionalContext injection", () => {
  it.instance("queues every non-empty additionalContext for the child session before its prompt", () =>
    Effect.gen(function* () {
      recorded.length = 0
      startContexts = ["CTX_ONE", "", "CTX_TWO"]
      const drained: { sessionID: string; texts: readonly string[] }[] = []
      const { chat } = yield* run(drained)
      const sessions = yield* Session.Service
      const child = (yield* sessions.list()).find((info) => info.parentID === chat.id)
      expect(child).toBeDefined()

      const start = recorded.find((payload) => payload.event === "SubagentStart")
      expect(start).toMatchObject({ event: "SubagentStart", agentID: child!.id, agentType: "general" })
      expect(drained).toEqual([{ sessionID: child!.id, texts: ["CTX_ONE", "CTX_TWO"] }])
    }),
  )

  it.instance("queues nothing when the hook returns no additionalContext", () =>
    Effect.gen(function* () {
      recorded.length = 0
      startContexts = []
      const drained: { sessionID: string; texts: readonly string[] }[] = []
      yield* run(drained)
      expect(drained).toHaveLength(1)
      expect(drained[0]!.texts).toEqual([])
    }),
  )

  it.instance("resumed task_id session receives the context when SubagentStart fires", () =>
    Effect.gen(function* () {
      recorded.length = 0
      startContexts = []
      const first: { sessionID: string; texts: readonly string[] }[] = []
      const { chat } = yield* run(first)
      const sessions = yield* Session.Service
      const child = (yield* sessions.list()).find((info) => info.parentID === chat.id)!

      startContexts = ["RESUME_CTX"]
      const second: { sessionID: string; texts: readonly string[] }[] = []
      const { chat: chat2 } = yield* run(second, { task_id: child.id })
      expect(chat2.id).not.toBe(chat.id)
      expect(second).toEqual([{ sessionID: child.id, texts: ["RESUME_CTX"] }])
    }),
  )

  it.instance("a failed resolvePromptParts leaves no stale queued context for the child", () =>
    Effect.gen(function* () {
      recorded.length = 0
      startContexts = ["STALE_CTX"]
      const { chat, assistant } = yield* seed()
      const startCtx = yield* HookStartContext.Service
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ops: TaskPromptOps = {
        ...drainingOps(startCtx, []),
        resolvePromptParts: () => Effect.die(new Error("resolve failed")),
      }
      yield* def
        .execute(
          { description: "ctx", prompt: "do it", subagent_type: "general" },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: ops },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)
      const sessions = yield* Session.Service
      const child = (yield* sessions.list()).find((info) => info.parentID === chat.id)!
      expect(yield* startCtx.consume(child.id)).toEqual([])
    }),
  )
})
