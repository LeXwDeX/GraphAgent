import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import type { Scope } from "effect/Scope"
import { EventV2 } from "@graphagent/core/event"
import { Flag } from "@graphagent/core/flag/flag"
import { ModelsDev } from "@graphagent/core/models-dev"

const eventLayer = EventV2.defaultLayer
const layer = ModelsDev.defaultLayer.pipe(Layer.provideMerge(eventLayer))
const original = {
  path: Flag.GRAPHAGENT_MODELS_PATH,
  url: Flag.GRAPHAGENT_MODELS_URL,
  disabled: Flag.GRAPHAGENT_DISABLE_MODELS_FETCH,
}

const fixture = {
  acme: {
    api: "https://acme.test",
    name: "Acme",
    env: ["ACME_API_KEY"],
    id: "acme",
    models: {
      "acme-large": {
        id: "acme-large",
        name: "Acme Large",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128_000, output: 4096 },
      },
    },
  },
} satisfies Record<string, ModelsDev.Provider>

afterEach(() => {
  Flag.GRAPHAGENT_MODELS_PATH = original.path
  Flag.GRAPHAGENT_MODELS_URL = original.url
  Flag.GRAPHAGENT_DISABLE_MODELS_FETCH = original.disabled
})

describe("ModelsDev", () => {
  test("returns empty catalog and publishes fetch_failed when offline without cache or snapshot", () =>
    runWithFlags(
      {
        path: path.join(import.meta.dir, "fixtures", "missing-models-dev.json"),
        url: "http://127.0.0.1:9",
        disabled: false,
      },
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const failed = yield* events.subscribe(ModelsDev.Event.FetchFailed).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        const models = yield* ModelsDev.Service.use((service) => service.get())

        expect(models).toEqual({})
        expect((yield* Fiber.join(failed)).map((event) => event.data)).toEqual([{ source: "http://127.0.0.1:9" }])
      }),
    ),
  )

  test("loads disk cache before network", () =>
    runWithFlags(
      {
        path: path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json"),
        url: "http://127.0.0.1:9",
        disabled: false,
      },
      Effect.gen(function* () {
        const models = yield* ModelsDev.Service.use((service) => service.get())

        expect(Object.keys(models)).toEqual(["acme", "local"])
        expect(models.acme.name).toEqual("Acme")
      }),
    ),
  )

  test("successful refresh after fallback repopulates the cached catalog", async () => {
    let online = false
    const server = Bun.serve({
      port: 0,
      fetch() {
        if (!online) return new Response("offline", { status: 503 })
        return Response.json(fixture)
      },
    })
    try {
      await runWithFlags(
        {
          path: path.join(import.meta.dir, "fixtures", "missing-models-dev-refresh.json"),
          url: server.url.origin,
          disabled: false,
        },
        Effect.gen(function* () {
          const events = yield* EventV2.Service
          const refreshed = yield* events.subscribe(ModelsDev.Event.Refreshed).pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )
          const service = yield* ModelsDev.Service

          expect(yield* service.get()).toEqual({})
          online = true
          yield* service.refresh(true)
          expect(yield* Fiber.join(refreshed)).toHaveLength(1)
          expect(yield* service.get()).toEqual(fixture)
        }),
      )
    } finally {
      server.stop(true)
    }
  })
})

function run<A, E>(effect: Effect.Effect<A, E, EventV2.Service | ModelsDev.Service | Scope>) {
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layer)))
}

function runWithFlags<A, E, R>(
  next: { path: string | undefined; url: string | undefined; disabled: boolean },
  effect: Effect.Effect<A, E, EventV2.Service | ModelsDev.Service | Scope>,
) {
  Flag.GRAPHAGENT_MODELS_PATH = next.path
  Flag.GRAPHAGENT_MODELS_URL = next.url
  Flag.GRAPHAGENT_DISABLE_MODELS_FETCH = next.disabled
  return run(effect)
}
