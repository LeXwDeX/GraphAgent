// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { SessionV1 } from "@graphagent/core/v1/session"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Memory } from "@/memory/memory"
import { MemoryModel } from "@/memory/model"
import { MemoryPrompts } from "@/memory/prompts"
import { MemorySchema } from "@/memory/schema"
import { MemoryStore } from "@/memory/store"
import { Project } from "@/project/project"
import { Provider } from "@/provider/provider"
import { AgentScheduler } from "@/session/agent-scheduler"
import type { Lane } from "@/session/agent-scheduler-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { provideTmpdirServer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const memoryConfig = {
  schema_version: 1,
  enabled: true,
  model: "test/test-model",
  topic_limit: 10,
  turn_interval: 5,
  injection: { max_topics: 3, max_tokens: 1_200 },
} satisfies MemorySchema.Config

const createTopicReply = reply()
  .text(
    JSON.stringify({
      actions: [
        {
          type: "create_topic",
          name: "Reply style",
          summary: "The user confirmed a durable preference for concise replies.",
          categories: ["preference"],
          keywords: ["replies", "concise"],
          related_topics: [],
          item: {
            kind: "preference",
            content: "User prefers concise replies.",
            rationale: "The user confirmed this preference and it is long-term.",
          },
        },
      ],
    }),
  )
  .stop()

// #395 regression: openai-compatible providers downgrade response_format to
// bare {"type":"json_object"} and never receive the streamObject schema, so
// the model free-styles a fresh shape every call and validation rejects it.
// The matchers below only answer requests that visibly carry the schema, so
// every test in this file fails the moment the schema leaves the wire again.
const wireIt = testEffect(
  LayerNode.buildLayer(
    LayerNode.group([Provider.node, MemoryModel.node, CrossSpawnSpawner.node, LayerNode.make(TestLLMServer.layer, [])]),
  ),
)

const wireGenerate = (schema: Schema.Decoder<unknown>, system: string) =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ref.providerID, ref.modelID)
    return yield* (yield* MemoryModel.Service).generate({
      model,
      system,
      prompt: "User confirmed: replies stay concise.",
      schema,
      maxOutputTokens: 2_048,
    })
  })

const schedulerFixture = () => {
  const requests: AgentScheduler.RequestInput[] = []
  const releases: AgentScheduler.RequestInput[] = []
  const layer = Layer.mock(AgentScheduler.Service, {
    request: (input) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          requests.push(input)
          return {
            release: Effect.sync(() => {
              releases.push(input)
            }),
          }
        }),
        (permit) => permit.release,
      ),
  })
  return { requests, releases, layer }
}

const scheduledWireIt = (fixture: ReturnType<typeof schedulerFixture>) =>
  testEffect(
    LayerNode.buildLayer(
      LayerNode.group([
        Provider.node,
        MemoryModel.node,
        CrossSpawnSpawner.node,
        LayerNode.make(TestLLMServer.layer, []),
      ]),
      { replacements: [LayerNode.replace(AgentScheduler.node, fixture.layer)] },
    ),
  )

// Same model layer without any scheduler in context: optional access must
// degrade to an unscheduled call.
const unscheduledWireIt = testEffect(
  LayerNode.buildLayer(
    LayerNode.group([
      Provider.node,
      LayerNode.make(MemoryModel.layer, [Provider.node]),
      CrossSpawnSpawner.node,
      LayerNode.make(TestLLMServer.layer, []),
    ]),
  ),
)

const scheduledGenerate = (input: { sessionID?: string; lane?: Lane }) =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ref.providerID, ref.modelID)
    return yield* (yield* MemoryModel.Service).generate({
      model,
      system: MemoryPrompts.MATCH_SYSTEM,
      prompt: "User confirmed: replies stay concise.",
      schema: MemorySchema.MatchResponse,
      maxOutputTokens: 2_048,
      ...input,
    })
  })

describe("memory model scheduler (issue #1021)", () => {
  const withSession = schedulerFixture()
  const withSessionIt = scheduledWireIt(withSession)

  withSessionIt.live("takes a permit for the triggering session and lane, then releases it", () =>
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          yield* llm.pushMatch(
            (hit) => JSON.stringify(hit.body).includes("topic_ids"),
            reply().text('{"topic_ids":[]}').stop(),
          )
          yield* scheduledGenerate({ sessionID: "ses_memory_scheduled", lane: "child" })
          expect(withSession.requests).toEqual([
            {
              lane: "child",
              providerID: ProviderV2.ID.make("test"),
              modelID: ModelV2.ID.make("test-model"),
              sessionID: "ses_memory_scheduled",
            },
          ])
          expect(withSession.releases).toHaveLength(1)
          expect(withSession.releases[0]).toBe(withSession.requests[0])
        }),
      { config: (url) => testProviderConfig(url) },
    ),
  )

  const withoutSession = schedulerFixture()
  const withoutSessionIt = scheduledWireIt(withoutSession)

  withoutSessionIt.live("does not take a permit when the request carries no session", () =>
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          yield* llm.pushMatch(
            (hit) => JSON.stringify(hit.body).includes("topic_ids"),
            reply().text('{"topic_ids":[]}').stop(),
          )
          yield* scheduledGenerate({ lane: "interactive" })
          expect(withoutSession.requests).toHaveLength(0)
          expect(withoutSession.releases).toHaveLength(0)
        }),
      { config: (url) => testProviderConfig(url) },
    ),
  )

  unscheduledWireIt.live("still generates when no scheduler is available", () =>
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          yield* llm.pushMatch(
            (hit) => JSON.stringify(hit.body).includes("topic_ids"),
            reply().text('{"topic_ids":[]}').stop(),
          )
          yield* scheduledGenerate({ sessionID: "ses_memory_unscheduled", lane: "child" })
        }),
      { config: (url) => testProviderConfig(url) },
    ),
  )
})

describe("memory model wire schema (issue #395)", () => {
  wireIt.live("carries the maintenance schema on the wire so the model can conform", () =>
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          yield* llm.pushMatch(
            (hit) => JSON.stringify(hit.body).includes("create_topic"),
            reply().text('{"actions":[{"type":"no_change"}]}').stop(),
          )
          const result = yield* wireGenerate(MemorySchema.MaintenanceResponse, MemoryPrompts.MAINTAIN_SYSTEM)
          expect(result).toEqual({ actions: [{ type: "no_change" }] })
          const inputs = yield* llm.inputs
          const maintenance = inputs.find((input) => JSON.stringify(input.messages).includes("create_topic"))
          expect(maintenance).toBeDefined()
          expect(maintenance?.response_format).toEqual({ type: "json_object" })
        }),
      { config: (url) => testProviderConfig(url) },
    ),
  )

  wireIt.live("keeps a provider error with an empty message legible", () =>
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          yield* llm.push(raw({ head: [{ error: { message: "" } }] }))
          const failure = yield* wireGenerate(MemorySchema.MaintenanceResponse, MemoryPrompts.MAINTAIN_SYSTEM).pipe(
            Effect.flip,
          )
          if (!(failure instanceof MemoryModel.GenerateError))
            return yield* Effect.fail(new Error(`expected GenerateError, got: ${String(failure)}`))
          expect(failure.message).toBe("MEMORY model call failed: (provider stream error with an empty message)")
        }),
      { config: (url) => testProviderConfig(url) },
    ),
  )
})

const stackIt = testEffect(
  LayerNode.buildLayer(
    LayerNode.group([
      Memory.node,
      Project.node,
      MemoryStore.node,
      CrossSpawnSpawner.node,
      LayerNode.make(TestLLMServer.layer, []),
    ]),
  ),
)

describe("memory maintenance end to end (issue #395)", () => {
  stackIt.live("creates a topic when the wire schema lets the model conform", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const project = yield* Project.Service
          const registered = yield* project.fromDirectory(dir)
          yield* project.setInitialized(registered.project.id)
          const configDir = path.join(dir, ".agents")
          yield* Effect.promise(() => fs.mkdir(configDir, { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(path.join(configDir, "settings.local.json"), JSON.stringify({ memory: memoryConfig })),
          )

          yield* llm.pushMatch(
            (hit) => JSON.stringify(hit.body).includes("topic_ids"),
            reply().text('{"topic_ids":[]}').stop(),
          )
          yield* llm.pushMatch((hit) => JSON.stringify(hit.body).includes("create_topic"), createTopicReply)

          const sessionID = SessionID.make("ses_memory_wire")
          const userID = MessageID.ascending()
          const messages: SessionV1.WithParts[] = [
            {
              info: {
                id: userID,
                role: "user",
                sessionID,
                time: { created: Date.now() },
                agent: "build",
                model: ref,
              },
              parts: [
                {
                  id: PartID.ascending(),
                  messageID: userID,
                  sessionID,
                  type: "text",
                  text: "以后回复保持简洁，这点长期有效",
                },
              ],
            },
            {
              info: {
                id: MessageID.ascending(),
                role: "assistant",
                sessionID,
                parentID: userID,
                mode: "build",
                agent: "build",
                path: { cwd: dir, root: dir },
                cost: 0,
                tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                providerID: ref.providerID,
                modelID: ref.modelID,
                time: { created: Date.now() },
                finish: "end_turn",
              },
              parts: [],
            },
          ]

          yield* (yield* Memory.Service).checkpoint({ sessionID, messages })

          const store = yield* MemoryStore.Service
          const projectID = (yield* InstanceState.context).project.id
          const topics = yield* pollWithTimeout(
            Effect.suspend(() => store.readTopics(projectID)).pipe(
              Effect.map((all) => (all.length > 0 ? all : undefined)),
            ),
            "maintenance never committed a topic",
          )
          expect(topics[0]?.metadata.categories).toEqual(["preference"])
        }),
      { config: (url) => testProviderConfig(url), git: true },
    ),
  )
})
