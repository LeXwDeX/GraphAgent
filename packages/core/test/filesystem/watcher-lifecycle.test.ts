import { describe, expect } from "bun:test"
import type ParcelWatcher from "@parcel/watcher"
import path from "node:path"
import os from "node:os"
import { ConfigProvider, Effect, Layer, Logger } from "effect"
import { Config } from "@graphagent/core/config"
import { EventV2 } from "@graphagent/core/event"
import { FSUtil } from "@graphagent/core/fs-util"
import { Watcher } from "@graphagent/core/filesystem/watcher"
import { Git } from "@graphagent/core/git"
import { Location } from "@graphagent/core/location"
import { AbsolutePath } from "@graphagent/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(FSUtil.defaultLayer, EventV2.defaultLayer, Git.defaultLayer))

function fixture(
  acquire?: (subscription: ParcelWatcher.AsyncSubscription) => Promise<ParcelWatcher.AsyncSubscription>,
  timeout = 15,
) {
  let callback: ParcelWatcher.SubscribeCallback | undefined
  let subscribeCalls = 0
  let unsubscribeCalls = 0
  const subscription = {
    unsubscribe: async () => {
      unsubscribeCalls++
    },
  }
  const native: typeof ParcelWatcher = {
    subscribe: (_directory, next) => {
      subscribeCalls++
      callback = next
      return acquire ? acquire(subscription) : Promise.resolve(subscription)
    },
    unsubscribe: async () => {},
    getEventsSince: async () => [],
    writeSnapshot: async (_directory, snapshot) => snapshot,
  }
  const messages: unknown[] = []
  const published: unknown[] = []
  const directory = AbsolutePath.make(path.resolve(os.tmpdir()))
  const layer = Watcher.layerWith({ native, timeout }).pipe(
    Layer.provide(Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))),
    Layer.provide(
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location({ directory }, { vcs: { type: "git", store: AbsolutePath.make(path.join(directory, ".git")) } }),
        ),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          GRAPHAGENT_FILEWATCHER: "true",
          GRAPHAGENT_DISABLE_FILEWATCHER: "false",
        }),
      ),
    ),
    Layer.provide(
      Layer.effect(
        EventV2.Service,
        Effect.map(EventV2.Service, (events) =>
          EventV2.Service.of({
            ...events,
            publish: (definition, data, options) =>
              events.publish(definition, data, options).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    published.push(data)
                  }),
                ),
              ),
          }),
        ),
      ),
    ),
    Layer.provide(
      Logger.layer([
        Logger.make(({ message }) => {
          messages.push(message)
        }),
      ]),
    ),
  )
  return {
    layer,
    subscription,
    messages,
    published,
    get subscribeCalls() {
      return subscribeCalls
    },
    get unsubscribeCalls() {
      return unsubscribeCalls
    },
    notify(error: Error | null, updates?: ParcelWatcher.Event[]) {
      if (callback) Reflect.apply(callback, undefined, [error, updates])
    },
  }
}

const settle = Effect.promise(() => Bun.sleep(30))
const hasLog = (messages: unknown[], text: string) => JSON.stringify(messages).includes(text)

describe("Watcher subscription lifecycle without native streams", () => {
  for (const [name, acquire] of [
    [
      "synchronous subscribe throws",
      () => {
        throw new Error("native synchronous failure")
      },
    ],
    ["immediately rejected subscribe", () => Promise.reject(new Error("native rejected failure"))],
  ] as const) {
    it.live(name, () =>
      Effect.gen(function* () {
        const f = fixture(acquire)
        expect(f.subscribeCalls).toBe(0)
        yield* settle.pipe(Effect.provide(f.layer), Effect.scoped)
        expect(f.subscribeCalls).toBe(1)
        expect(hasLog(f.messages, "failed to subscribe")).toBe(true)
        expect(f.unsubscribeCalls).toBe(0)
      }),
    )
  }

  it.live("callback errors do not throw or publish updates", () =>
    Effect.gen(function* () {
      const f = fixture()
      yield* Effect.gen(function* () {
        yield* settle
        expect(() =>
          f.notify(new Error("native callback failure"), [{ type: "create", path: "/private/tmp/error" }]),
        ).not.toThrow()
        expect(() => f.notify(new Error("native callback without events"))).not.toThrow()
        expect(() => f.notify(null)).not.toThrow()
        yield* Effect.yieldNow
        expect(f.published).toHaveLength(0)
        expect(hasLog(f.messages, "watcher callback failed")).toBe(true)
      }).pipe(Effect.provide(f.layer), Effect.scoped)
      expect(f.unsubscribeCalls).toBe(1)
    }),
  )

  it.live("successful subscription unsubscribes once and ignores callbacks after disposal", () =>
    Effect.gen(function* () {
      const f = fixture()
      yield* Effect.gen(function* () {
        yield* settle
        f.notify(null, [{ type: "create", path: "/private/tmp/live" }])
        yield* Effect.yieldNow
        expect(f.published).toEqual([{ file: "/private/tmp/live", event: "add" }])
      }).pipe(Effect.provide(f.layer), Effect.scoped)
      expect(f.unsubscribeCalls).toBe(1)
      f.notify(null, [{ type: "delete", path: "/private/tmp/live" }])
      yield* Effect.yieldNow
      expect(f.published).toHaveLength(1)
    }),
  )

  it.live("timeout relinquishes callbacks and cleans a subscription which arrives later", () =>
    Effect.gen(function* () {
      const pending = Promise.withResolvers<ParcelWatcher.AsyncSubscription>()
      const f = fixture(() => pending.promise)
      yield* Effect.gen(function* () {
        yield* settle
        expect(hasLog(f.messages, "failed to subscribe")).toBe(true)
        f.notify(null, [{ type: "create", path: "/private/tmp/late" }])
        pending.resolve(f.subscription)
        yield* settle
        expect(f.unsubscribeCalls).toBe(1)
        expect(f.published).toHaveLength(0)
      }).pipe(Effect.provide(f.layer), Effect.scoped)
      expect(f.unsubscribeCalls).toBe(1)
    }),
  )

  it.live("scope interruption cleans late acquisition without waiting for native subscribe", () =>
    Effect.gen(function* () {
      const pending = Promise.withResolvers<ParcelWatcher.AsyncSubscription>()
      const f = fixture(() => pending.promise, 60_000)
      yield* Effect.yieldNow.pipe(Effect.provide(f.layer), Effect.scoped)
      expect(f.subscribeCalls).toBe(1)
      expect(f.unsubscribeCalls).toBe(0)
      pending.resolve(f.subscription)
      yield* settle
      expect(f.unsubscribeCalls).toBe(1)
      f.notify(null, [{ type: "create", path: "/private/tmp/disposed" }])
      yield* Effect.yieldNow
      expect(f.published).toHaveLength(0)
    }),
  )

  it.live("synchronous unsubscribe failure is reported without breaking scope disposal", () =>
    Effect.gen(function* () {
      const f = fixture(() =>
        Promise.resolve({
          unsubscribe: () => {
            throw new Error("native cleanup failure")
          },
        }),
      )
      yield* settle.pipe(Effect.provide(f.layer), Effect.scoped)
      expect(hasLog(f.messages, "failed to unsubscribe")).toBe(true)
    }),
  )
})
