// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1557: a model the catalog does not have is the caller's mistake, so every endpoint that resolves a model answers it
// with a declared 400 `ProviderModelNotFoundError` naming the model and its closest matches, not a 500 defect. The
// prompt service raises the provider's error as a defect; the session handlers translate it at their boundary.
import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { OpenApi } from "effect/http-api"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Database } from "@graphagent/core/database/database"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Provider } from "../../src/provider/provider"
import { mapModelNotFound } from "../../src/server/routes/instance/httpapi/handlers/session-errors"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { Session } from "@/session/session"
import { MessageID, PartID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"
import { it as plain, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))),
)
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    Database.defaultLayer,
    httpApiLayer,
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// `test-model` is the one model of the fake provider, so `test-modle` is a typo of it and the catalog suggests it.
const unknown = { providerID: "test", modelID: "test-modle" }
const declared = {
  name: "ProviderModelNotFoundError",
  data: {
    providerID: "test",
    modelID: "test-modle",
    suggestions: ["test-model"],
    message: "Model not found: test/test-modle. Did you mean: test-model?",
  },
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {}

const post = (directory: string, route: string, body: unknown) =>
  requestInDirectory(route, directory, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

// A session with one user message, which is what summarize needs to have something to summarize.
const seedSession = (directory: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "unknown model" })
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: session.id,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: session.id,
      messageID: user.id,
      type: "text",
      text: "hello",
    })
    return { session, user }
  }).pipe(provideInstanceEffect(directory))

describe("the declared model-not-found error", () => {
  plain.effect("is documented as a 400 on exactly the endpoints that resolve a model", () =>
    Effect.sync(() => {
      const spec = OpenApi.fromApi(PublicApi)
      const documented: string[] = []
      for (const [path, item] of Object.entries(record(spec.paths))) {
        for (const [method, operation] of Object.entries(record(item))) {
          const bad = record(record(record(operation).responses)["400"])
          if (JSON.stringify(bad).includes("#/components/schemas/ProviderModelNotFoundError"))
            documented.push(`${method.toUpperCase()} ${path}`)
        }
      }
      expect(documented.sort()).toEqual([
        "POST /session/{sessionID}/command",
        "POST /session/{sessionID}/init",
        "POST /session/{sessionID}/message",
        "POST /session/{sessionID}/model",
        "POST /session/{sessionID}/resume",
        "POST /session/{sessionID}/summarize",
      ])
      // The wire body the CLI formatter reads: `{ name, data: { providerID, modelID, suggestions, message } }`.
      const schema = record(record(record(spec.components).schemas).ProviderModelNotFoundError)
      const properties = record(schema.properties)
      expect(Object.keys(properties).sort()).toEqual(["data", "name"])
      expect(Object.keys(record(record(properties.data).properties)).sort()).toEqual([
        "message",
        "modelID",
        "providerID",
        "suggestions",
      ])
    }),
  )

  describe("mapModelNotFound", () => {
    const missing = new Provider.ModelNotFoundError({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("test-modle"),
      suggestions: ["test-model"],
    })

    plain.effect("turns the provider's defect into the declared error", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(mapModelNotFound(Effect.die(missing)))
        expect(error).toMatchObject(declared)
      }),
    )

    plain.effect("gives an empty suggestion list when the catalog has no close name", () =>
      Effect.gen(function* () {
        const bare = new Provider.ModelNotFoundError({
          providerID: ProviderV2.ID.make("removed-provider"),
          modelID: ModelV2.ID.make("removed-model"),
        })
        const error = yield* Effect.flip(mapModelNotFound(Effect.die(bare)))
        expect(error).toMatchObject({
          name: "ProviderModelNotFoundError",
          data: {
            providerID: "removed-provider",
            modelID: "removed-model",
            suggestions: [],
            message: "Model not found: removed-provider/removed-model.",
          },
        })
      }),
    )

    plain.effect("leaves a success, a typed failure and another defect as they are", () =>
      Effect.gen(function* () {
        expect(yield* mapModelNotFound(Effect.succeed("ok"))).toBe("ok")
        expect(yield* Effect.flip(mapModelNotFound(Effect.fail("typed")))).toBe("typed")

        const other = new Error("not a model problem")
        const exit = yield* Effect.exit(mapModelNotFound(Effect.die(other)))
        expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
        expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBe(other)
      }),
    )

    plain.effect("leaves a cause that was also interrupted as it is", () =>
      Effect.gen(function* () {
        const cause = Cause.fromReasons([Cause.makeDieReason(missing), Cause.makeInterruptReason()])
        const exit = yield* Effect.exit(mapModelNotFound(Effect.failCause(cause)))
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && Cause.hasDies(exit.cause)).toBe(true)
        expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      }),
    )
  })

  const endpoints: ReadonlyArray<{ readonly name: string; readonly route: string; readonly body: () => unknown }> = [
    {
      name: "prompt",
      route: "message",
      body: () => ({ agent: "build", model: unknown, parts: [{ type: "text", text: "hello" }] }),
    },
    {
      name: "command",
      route: "command",
      body: () => ({ command: "init", arguments: "", model: `${unknown.providerID}/${unknown.modelID}` }),
    },
    { name: "init", route: "init", body: () => ({ ...unknown, messageID: MessageID.ascending() }) },
    { name: "summarize", route: "summarize", body: () => unknown },
    { name: "setModel", route: "model", body: () => ({ model: unknown }) },
  ]

  it.live("answers 400 with the declared body where a request names a model the catalog does not have", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      for (const endpoint of endpoints) {
        // A session of its own each, so one endpoint's failed attempt cannot change what the next one meets.
        const { session } = yield* seedSession(directory)
        const response = yield* post(directory, `/session/${session.id}/${endpoint.route}`, endpoint.body())
        expect([endpoint.name, response.status, yield* response.json]).toEqual([endpoint.name, 400, declared])
      }
      // None of them got as far as asking a model.
      expect(yield* llm.calls).toBe(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )

  it.live("answers 400 when a prompt or command names no model and the session still names one that is gone", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      const created = yield* post(directory, "/session", {
        title: "stored model is gone",
        model: { providerID: "removed-provider", id: "removed-model", variant: "default" },
      })
      expect(created.status).toBe(200)
      const id = String(record(yield* created.json).id)
      const gone = {
        name: "ProviderModelNotFoundError",
        data: {
          providerID: "removed-provider",
          modelID: "removed-model",
          suggestions: [],
          message: "Model not found: removed-provider/removed-model.",
        },
      }

      const prompt = yield* post(directory, `/session/${id}/message`, {
        agent: "build",
        parts: [{ type: "text", text: "hello" }],
      })
      expect([prompt.status, yield* prompt.json]).toEqual([400, gone])
      const command = yield* post(directory, `/session/${id}/command`, { command: "init", arguments: "" })
      expect([command.status, yield* command.json]).toEqual([400, gone])
      expect(yield* llm.calls).toBe(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )

  it.live("answers 400 on resume when the followup saved for the session names a model that is gone", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      const { session } = yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const seeded = yield* seedSession(directory)
        // Resume runs a saved followup only after a finished assistant message, and the followup is what names the model.
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: seeded.user.id,
          sessionID: seeded.session.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: directory, root: directory },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: Date.now(), completed: Date.now() },
          finish: "stop",
        })
        yield* sessions.setMetadata({
          sessionID: seeded.session.id,
          metadata: {
            hookPendingInput: {
              version: 1,
              messageID: MessageID.ascending(),
              phase: "pending",
              input: { kind: "prompt", model: unknown, parts: [{ type: "text", text: "saved followup" }] },
            },
          },
        })
        return seeded
      }).pipe(provideInstanceEffect(directory))

      const response = yield* post(directory, `/session/${session.id}/resume`, {})
      expect([response.status, yield* response.json]).toEqual([400, declared])
      expect(yield* llm.calls).toBe(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )

  it.live("leaves a shell command and an async prompt alone: neither resolves the model in its response", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      const { session } = yield* seedSession(directory)

      const shell = yield* post(directory, `/session/${session.id}/shell`, {
        agent: "build",
        model: unknown,
        command: "true",
      })
      expect(shell.status).toBe(200)
      // The async prompt answers before it resolves anything; the error reaches the client as a session event.
      const queued = yield* post(directory, `/session/${session.id}/prompt_async`, {
        agent: "build",
        model: unknown,
        parts: [{ type: "text", text: "hello" }],
      })
      expect(queued.status).toBe(204)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )
})
