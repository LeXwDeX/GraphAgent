import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { define } from "@graphagent/core/plugin/context/index"
import { PluginV2 } from "@graphagent/core/plugin"
import { Reference } from "@graphagent/core/reference"
import { AbsolutePath } from "@graphagent/core/schema"
import { EventV2 } from "../src/event"
import { FSUtil } from "../src/fs-util"
import { Global } from "../src/global"
import { RepositoryCache } from "../src/repository-cache"
import { testEffect } from "./lib/effect"
import { tempLocationLayer } from "./fixture/location"

const PluginTestLayer = PluginV2.locationLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      EventV2.defaultLayer,
      FetchHttpClient.layer,
      FSUtil.defaultLayer,
      Global.defaultLayer,
      RepositoryCache.defaultLayer,
      tempLocationLayer,
    ),
  ),
)

const it = testEffect(PluginTestLayer)

describe("PluginV2", () => {
  it.effect("waits for a plugin and returns immediately once active", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const id = PluginV2.ID.make("waited")
      const waiting = yield* plugins.wait(id).pipe(Effect.forkChild)

      yield* plugins.add(id, () => Effect.void)
      yield* Fiber.join(waiting)
      yield* plugins.wait(id)
    }),
  )

  it.effect("propagates plugin activation defects to waiters", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const id = PluginV2.ID.make("failed")
      const waiting = yield* plugins.wait(id).pipe(Effect.exit, Effect.forkChild)

      const added = yield* plugins.add(id, () => Effect.die("boom")).pipe(Effect.exit)
      const pending = yield* Fiber.join(waiting)
      const later = yield* plugins.wait(id).pipe(Effect.exit)

      expect(Exit.isFailure(added)).toBe(true)
      expect(Exit.isFailure(pending)).toBe(true)
      expect(Exit.isFailure(later)).toBe(true)
    }),
  )

  it.effect("adds, replaces, and removes plugins", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const references = yield* Reference.Service
      let description = "first"

      const managed = () =>
        define({
          id: "managed",
          effect: (ctx) =>
            ctx.reference
              .transform((reference) => {
                reference.add("docs", {
                  type: "local",
                  path: AbsolutePath.make("/repo/docs"),
                  description,
                })
              })
              .pipe(Effect.asVoid),
        })

      yield* plugins.add(PluginV2.ID.make("managed"), managed().effect)

      expect(yield* references.list()).toMatchObject([{ name: "docs", description: "first" }])

      description = "second"
      yield* plugins.add(PluginV2.ID.make("managed"), managed().effect)
      expect(yield* references.list()).toMatchObject([{ name: "docs", description: "second" }])

      yield* plugins.remove(PluginV2.ID.make("managed"))
      expect(yield* references.list()).toEqual([])
    }),
  )
})
