import { describe, expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { ProviderAdapters } from "@/provider/adapter/registry"
import { testEffect } from "../../lib/effect"
import type { AdapterContext, ProviderAdapter } from "@/provider/adapter/types"

const it = testEffect(ProviderAdapters.emptyLayer)

describe("ProviderAdapters registry", () => {
  it.effect("keeps the built-in adapter order stable", () =>
    Effect.sync(() => {
      expect(ProviderAdapters.BUILTIN.map((factory) => factory.name)).toEqual([
        "CodexAdapter",
        "CopilotAdapter",
        "CloudflareWorkersAdapter",
        "CloudflareAIGatewayAdapter",
        "AzureAdapter",
        "DigitalOceanAdapter",
        "SnowflakeCortexAdapter",
        "XaiAdapter",
      ])
    }),
  )

  it.effect("provides an empty registry for isolated tests", () =>
    Effect.gen(function* () {
      const adapters = yield* ProviderAdapters.Service
      expect(yield* adapters.list()).toEqual([])
      expect(yield* adapters.authHooks()).toEqual({})

      const params = {
        temperature: 0,
        topP: undefined,
        topK: undefined,
        maxOutputTokens: undefined,
        options: {},
      }
      expect(yield* adapters.chatParams({} as never, params)).toBe(params)
      expect(yield* adapters.chatHeaders({} as never, { headers: {} })).toEqual({})
    }),
  )

  it.effect("skips failed factories and preserves factory order", () =>
    Effect.gen(function* () {
      const factories = [
        (() => {
          throw new Error("factory failed")
        }) as never,
        (() => ({ id: "first" })) as never,
        (() => ({ id: "second" })) as never,
      ]
      const loaded = yield* ProviderAdapters.loadAdapters(factories, {} as AdapterContext, false)
      expect(loaded.map((adapter) => adapter.id)).toEqual(["first", "second"])
      expect(yield* ProviderAdapters.loadAdapters(factories, {} as AdapterContext, true)).toEqual([])
    }),
  )

  it.effect("applies hooks in order and keeps the last auth hook", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const first = {
        id: "first",
        auth: { provider: "demo", methods: [] },
        chatParams: (_input: any, output: { options: Record<string, any> }) => {
          seen.push("first")
          output.options.first = true
        },
      } satisfies ProviderAdapter
      const second = {
        id: "second",
        auth: { provider: "demo", methods: [] },
        chatParams: (_input: any, output: { options: Record<string, any> }) => {
          seen.push("second")
          output.options.second = true
        },
      } satisfies ProviderAdapter
      const registry = ProviderAdapters.createRegistry(Effect.succeed([first, second]))
      const params = {
        temperature: undefined,
        topP: undefined,
        topK: undefined,
        maxOutputTokens: undefined,
        options: {},
      }
      yield* registry.chatParams({} as never, params)
      expect(seen).toEqual(["first", "second"])
      expect(params.options).toEqual({ first: true, second: true })
      expect((yield* registry.authHooks()).demo).toBe(second.auth)
    }),
  )

  it.effect("isolates event errors and disposes adapters in order", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const done = yield* Deferred.make<void>()
      const adapters: ProviderAdapter[] = [
        {
          id: "first",
          onEvent: async () => {
            calls.push("event:first")
            throw new Error("event failed")
          },
          dispose: async () => {
            calls.push("dispose:first")
            throw new Error("dispose failed")
          },
        },
        {
          id: "second",
          onEvent: async () => {
            calls.push("event:second")
            await Effect.runPromise(Deferred.succeed(done, undefined))
          },
          dispose: async () => {
            calls.push("dispose:second")
          },
        },
      ]
      yield* ProviderAdapters.dispatchEvent(adapters, { id: "event", type: "test", properties: {} })
      yield* Deferred.await(done)
      expect(calls.slice(0, 2)).toEqual(["event:first", "event:second"])
      yield* ProviderAdapters.disposeAdapters(adapters)
      expect(calls.slice(2)).toEqual(["dispose:first", "dispose:second"])
    }),
  )

  it.effect("filters events by instance directory", () =>
    Effect.sync(() => {
      expect(ProviderAdapters.eventMatchesDirectory({ location: { directory: "/tmp/a" } }, "/tmp/a")).toBe(true)
      expect(ProviderAdapters.eventMatchesDirectory({ location: { directory: "/tmp/b" } }, "/tmp/a")).toBe(false)
      expect(ProviderAdapters.eventMatchesDirectory({}, "/tmp/a")).toBe(false)
    }),
  )
})
