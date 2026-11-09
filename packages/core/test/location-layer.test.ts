import { describe, expect } from "bun:test"
import { Effect, Equal, Hash, Layer, Schema } from "effect"
import { define } from "@graphagent/core/plugin/context/index"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import { Location } from "@graphagent/core/location"
import { PluginV2 } from "@graphagent/core/plugin"
import { Reference } from "@graphagent/core/reference"
import { AbsolutePath } from "@graphagent/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { FSUtil } from "../src/fs-util"
import { Global } from "../src/global"
import { ModelsDev } from "../src/models-dev"
import { Npm } from "../src/npm"
import { Project } from "../src/project"

const it = testEffect(
  Layer.merge(
    Layer.mergeAll(Database.defaultLayer, EventV2.defaultLayer),
    LocationServiceMap.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Project.defaultLayer,
          EventV2.defaultLayer,
          Npm.defaultLayer,
          ModelsDev.defaultLayer,
          FSUtil.defaultLayer,
          Global.defaultLayer,
        ),
      ),
    ),
  ),
)

describe("LocationServiceMap", () => {
  it.live("reuses cached services for constructed and decoded location refs", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.scoped(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap
            const directory = AbsolutePath.make(dir.path)
            const constructed = Location.Ref.make({ directory })
            const decoded = Schema.decodeUnknownSync(Location.Ref)({ directory })

            expect(constructed).toEqual({ directory, workspaceID: undefined })
            expect(decoded).toEqual(constructed)
            expect(Equal.equals(constructed, decoded)).toBe(true)
            expect(Hash.hash(constructed)).toBe(Hash.hash(decoded))
            expect(yield* locations.contextEffect(constructed)).toBe(yield* locations.contextEffect(decoded))
          }),
        ),
      ),
    ),
  )

  it.live("installs public plugins into a location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const plugins = yield* PluginV2.Service
          const contributor = define({
            id: "reference-owner",
            effect: (ctx) =>
              ctx.reference
                .transform((reference) => {
                  reference.add("guide", { type: "local", path: AbsolutePath.make(dir.path), description: "Docs" })
                })
                .pipe(Effect.asVoid),
          })
          yield* plugins.add(PluginV2.ID.make(contributor.id), contributor.effect)

          expect(yield* (yield* Reference.Service).list()).toContainEqual(
            expect.objectContaining({ name: "guide", description: "Docs" }),
          )
        }).pipe(
          Effect.scoped,
          Effect.provide(LocationServiceMap.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
        ),
      ),
    ),
  )
})
