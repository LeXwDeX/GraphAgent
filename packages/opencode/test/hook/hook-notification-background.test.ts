import { expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { SessionRunState } from "@/session/run-state"
import { Notification } from "@/notification"
import { SessionAttention } from "@/notification/attention"
import { Permission } from "@/permission"
import { SettingsHook, type HookPayload } from "@/hook/settings"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const seen: HookPayload[] = []
let observed: Deferred.Deferred<void> | undefined
let observedType = ""
const settings = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: (payload) =>
      Effect.gen(function* () {
        seen.push(payload)
        if (payload.event === "Notification" && payload.notificationType === observedType && observed)
          yield* Deferred.succeed(observed, undefined)
        return { additionalContexts: [], systemMessages: [] }
      }),
    list: () => Effect.succeed([]),
  }),
)
const layer = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  Config.defaultLayer,
  Database.defaultLayer,
  Session.defaultLayer,
  SessionRunState.defaultLayer,
  Truncate.defaultLayer,
  RuntimeFlags.layer({ experimentalBackgroundSubagents: true }),
  Permission.layer,
  Notification.layer,
).pipe(
  Layer.provideMerge(Layer.mergeAll(settings, EventV2Bridge.defaultLayer, SessionAttention.defaultLayer)),
  Layer.provideMerge(CrossSpawnSpawner.defaultLayer),
  Layer.provideMerge(Ripgrep.defaultLayer),
)
const it = testEffect(layer)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const drain = Effect.gen(function* () {
  for (let i = 0; i < 30; i++) yield* Effect.yieldNow
})

it.effect(
  "actual background TaskTool input and completion notifications require a live terminal task view",
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const attention = yield* SessionAttention.Service
      const permission = yield* Permission.Service
      const jobs = yield* BackgroundJob.Service
      const events = yield* EventV2Bridge.Service
      const parent = yield* sessions.create({ title: "Synthetic background owner" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: parent.id,
        role: "user",
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      const assistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        sessionID: parent.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        ...model,
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(assistant)
      const tool = yield* TaskTool
      const definition = yield* tool.init()
      for (const viewing of [false, true]) {
        seen.length = 0
        yield* attention.update(parent.id, { clientID: "terminal", clientType: "terminal", backgroundView: viewing })
        const finished = yield* Deferred.make<void>()
        const requested = yield* Deferred.make<void>()
        const injected = yield* Deferred.make<void>()
        observed = yield* Deferred.make<void>()
        observedType = viewing ? "agent_needs_input" : "permission_prompt"
        const off = yield* events.listen((event) =>
          event.type === Permission.Event.Asked.type
            ? Deferred.succeed(requested, undefined).pipe(Effect.asVoid)
            : Effect.void,
        )
        yield* Effect.addFinalizer(() => off)
        const ops: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
          prompt: (input) =>
            Effect.gen(function* () {
              if (input.sessionID === parent.id) yield* Deferred.succeed(injected, undefined)
              else {
                yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "user",
                  sessionID: input.sessionID,
                  agent: "general",
                  model,
                  time: { created: Date.now() },
                })
                yield* permission
                  .ask({
                    sessionID: input.sessionID,
                    permission: "read",
                    patterns: ["synthetic"],
                    always: [],
                    metadata: {},
                    ruleset: [],
                  })
                  .pipe(Effect.orDie)
                yield* Deferred.await(finished)
              }
              const info = {
                ...assistant,
                id: MessageID.ascending(),
                sessionID: input.sessionID,
                parentID: input.messageID ?? user.id,
              }
              return {
                info,
                parts: [
                  {
                    id: PartID.ascending(),
                    sessionID: input.sessionID,
                    messageID: info.id,
                    type: "text",
                    text: "Synthetic background done",
                  },
                ],
              }
            }),
        }
        const result = yield* definition.execute(
          {
            description: "Synthetic background task",
            prompt: "Synthetic request",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: parent.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: ops },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        yield* Deferred.await(requested)
        const pending = (yield* permission.list())[0]
        expect(pending).toBeDefined()
        yield* drain
        yield* TestClock.adjust("6 seconds")
        yield* Deferred.await(observed)
        yield* drain
        expect(
          seen.filter((item) => item.event === "Notification" && item.notificationType === "agent_needs_input"),
        ).toHaveLength(viewing ? 1 : 0)
        yield* permission.reply({ requestID: pending.id, reply: "once" })
        yield* Deferred.succeed(finished, undefined)
        if (typeof result.metadata.sessionId !== "string") throw new Error("Missing actual task session")
        expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.status).toBe("completed")
        yield* Deferred.await(injected)
        expect(
          seen.filter((item) => item.event === "Notification" && item.notificationType === "agent_completed"),
        ).toHaveLength(viewing ? 1 : 0)
      }
    }),
  ),
)
