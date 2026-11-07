import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer, Option } from "effect"
import { Memory } from "@/memory/memory"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { testEffect } from "../lib/effect"

// Issue #311 regression: /memory answered "Memory remains off" and
// memory_search answered "unavailable for this session" in live TUI sessions
// because Memory.node was missing from the server app group. LayerNode nodes
// built via Layer.provide do not re-export their dependency services, so
// listing Memory.node only in per-consumer dependency arrays (SessionPrompt,
// SystemPrompt, Compaction, bootstrap) never surfaced Memory.Service in the
// request-time ambient context. These tests build the exact node graph the
// server provides to route handlers and assert the service is present there.

const appLayer = LayerNode.buildLayer(HttpApiApp.app)

const appIt = testEffect(Layer.mergeAll(appLayer, CrossSpawnSpawner.defaultLayer))

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

describe("server app graph memory wiring", () => {
  appIt.instance(
    "exposes Memory.Service in the ambient context live sessions run in",
    () =>
      Effect.gen(function* () {
        const memory = yield* Effect.serviceOption(Memory.Service)
        expect(Option.isSome(memory)).toBe(true)
      }),
    { git: true },
  )

  const setEnabledCalls: boolean[] = []
  // Same node graph, with Memory.node swapped for a recorder: proves the
  // /memory command branch resolves Memory.Service from the app-graph output
  // (not from a per-consumer dependency scope) and reaches setEnabled.
  const spyIt = testEffect(
    Layer.mergeAll(
      LayerNode.buildLayer(HttpApiApp.app, {
        replacements: [
          LayerNode.replace(
            Memory.node,
            Layer.mock(Memory.Service, {
              setEnabled: (enabled) =>
                Effect.sync(() => {
                  setEnabledCalls.push(enabled)
                  return enabled ? ("Memory on" as const) : ("Memory off" as const)
                }),
            }),
          ),
        ],
      }),
      CrossSpawnSpawner.defaultLayer,
    ),
  )

  spyIt.instance(
    "routes the /memory command through the app graph to Memory.setEnabled",
    () =>
      Effect.gen(function* () {
        setEnabledCalls.length = 0
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "memory wiring" })
        const prompt = yield* SessionPrompt.Service

        const result = yield* prompt.command({ sessionID: chat.id, command: "memory", arguments: "on" })

        const texts = result.parts
          .filter((part): part is SessionV1.TextPart => part.type === "text")
          .map((part) => part.text)
        expect(texts).toEqual(["/memory on", "Memory on"])
        expect(setEnabledCalls).toEqual([true])
      }),
    { git: true, config: cfg },
  )
})
