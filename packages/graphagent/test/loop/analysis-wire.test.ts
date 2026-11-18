// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@graphagent/core/event/sql"
import { FSUtil } from "@graphagent/core/fs-util"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionProjector } from "@graphagent/core/session/projector"
import { MessageTable, PartTable, SessionTable, TodoTable } from "@graphagent/core/session/sql"
import type { ConfigV1 } from "@graphagent/core/v1/config/config"
import { Config } from "@/config/config"
import { SettingsHook } from "@/hook"
import { LoopAnalysis } from "@/loop/analysis"
import { Provider } from "@/provider/provider"
import { AgentScheduler } from "@/session/agent-scheduler"
import { LLM } from "@/session/llm"
import { Session } from "@/session/session"
import { SystemPrompt } from "@/session/system"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { result } from "./fixture"

// The same service on the real request path: the real LLM service and AI SDK transport talk to a fake
// HTTP model. The scripted-LLM tests pin the service's decisions; this one pins that they reach the wire.

let hookTriggers = 0
const hooks = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: () =>
      Effect.sync(() => {
        hookTriggers++
      }).pipe(Effect.andThen(Effect.die("the analysis must not trigger settings hooks"))),
    list: () =>
      Effect.sync(() => {
        hookTriggers++
      }).pipe(Effect.as([])),
  }),
)

const root = LayerNode.group([
  LoopAnalysis.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Config.node,
  LLM.node,
  SystemPrompt.node,
  Database.node,
  CrossSpawnSpawner.node,
  FSUtil.node,
  AgentScheduler.node,
])
const it = testEffect(
  LayerNode.buildLayer(LayerNode.group([root, LayerNode.make(TestLLMServer.layer, [])]), {
    replacements: [LayerNode.replace(SettingsHook.node, hooks)],
  }),
)

function configFor(url: string): Partial<ConfigV1.Info> {
  const base = testProviderConfig(url)
  const template = base.provider.test.models["test-model"]
  return {
    ...base,
    language: "en",
    model: "test/test-model",
    provider: {
      test: {
        ...base.provider.test,
        models: { "test-model": { ...template, reasoning: true, limit: { context: 100_000, output: 10_000 } } },
      },
    },
  }
}

const snapshot = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return {
    sessions: yield* db.select().from(SessionTable).all(),
    messages: yield* db.select().from(MessageTable).all(),
    parts: yield* db.select().from(PartTable).all(),
    todos: yield* db.select().from(TodoTable).all(),
    events: yield* db.select().from(EventTable).all(),
    sequences: yield* db.select().from(EventSequenceTable).all(),
  }
})

type Body = {
  model?: string
  reasoning_effort?: string
  tools?: Array<{ function?: { name?: string } }>
  messages?: any[]
}

describe("LoopAnalysis on the wire (#1328)", () => {
  it.live("asks for the model's top thinking tier, offers the five tools and replays a tool round", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const analysis = yield* LoopAnalysis.Service
          const session = yield* sessions.create({
            title: "loop",
            model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test"), variant: "low" },
          })
          yield* (yield* FSUtil.Service).writeFileString(`${dir}/importer.ts`, "export const x = 1")
          yield* llm.tool("list_dir", { path: "." })
          yield* llm.tool("submit_analysis", result())

          const before = yield* snapshot
          const outcome = yield* analysis.run({
            sessionID: session.id,
            firstDescription: "Make the importer idempotent.",
            outcome: { type: "completed" },
            humans: [],
            abort: new AbortController().signal,
          })
          const after = yield* snapshot

          expect(outcome.type).toBe("ok")
          expect(outcome.steps).toBe(2)
          expect(outcome.model).toEqual({ providerID: "test", modelID: "test-model", variant: "high" })

          const [first, second] = (yield* llm.inputs) as Body[]
          // The session was on `low`; the analysis asks for the model's highest tier.
          expect(first?.model).toBe("test-model")
          expect(first?.reasoning_effort).toBe("high")
          expect(second?.reasoning_effort).toBe("high")
          const names = (first?.tools ?? [])
            .map((tool) => tool.function?.name ?? "")
            .toSorted((a, b) => a.localeCompare(b))
          expect(names).toEqual(["bash", "grep", "list_dir", "read_file", "submit_analysis"])

          // The second request carries the first round: the assistant's call and the directory listing.
          const roles = (second?.messages ?? []).map((message) => message.role)
          expect(roles).toEqual(["system", "user", "assistant", "tool"])
          const call = second?.messages?.[2]?.tool_calls?.[0]
          expect(call?.function?.name).toBe("list_dir")
          expect(String(second?.messages?.[3]?.content)).toContain("importer.ts")

          // Reading the repository and thinking leave no trace in the session.
          expect(after).toEqual(before)
          expect(hookTriggers).toBe(0)
        }),
      { config: configFor },
    ),
  )
})
