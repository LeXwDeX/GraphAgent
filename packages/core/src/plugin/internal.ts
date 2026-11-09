export * as PluginInternal from "./internal"

import type { PluginContext } from "./context"
import { Context, Effect, Fiber, Layer, Scope } from "effect"
import { Config } from "../config"
import { ConfigReferencePlugin } from "../config/plugin/reference"
import { EventV2 } from "../event"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { ModelsDev } from "../models-dev"
import { Npm } from "../npm"
import { PluginV2 } from "../plugin"
import { Reference } from "../reference"
import { FetchHttpClient, HttpClient } from "effect/http"

export type Requirements =
  | Config.Service
  | EventV2.Service
  | FileSystem.Service
  | FSUtil.Service
  | Global.Service
  | HttpClient.HttpClient
  | Location.Service
  | ModelsDev.Service
  | Npm.Service
  | Reference.Service

export interface Plugin<R = never> {
  readonly id: string
  readonly effect: (context: PluginContext) => Effect.Effect<void, never, R | Scope.Scope>
}

export function define<R>(plugin: Plugin<R>) {
  return plugin
}

/** Completion of the configured plugins for this Location. */
export class Ready extends Context.Service<Ready, { readonly awaitReady: Effect.Effect<void> }>()(
  "@graphagent/v2/PluginInternal/Ready",
) {}

export const locationLayer = Layer.effect(
  Ready,
  Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const modelsDev = yield* ModelsDev.Service
    const npm = yield* Npm.Service
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const filesystem = yield* FileSystem.Service
    const global = yield* Global.Service
    const http = yield* HttpClient.HttpClient
    const reference = yield* Reference.Service
    const add = <R>(input: Plugin<R>) => {
      const loaded = {
        id: input.id,
        effect: (context: PluginContext) =>
          input
            .effect(context)
            .pipe(
              Effect.provideService(Config.Service, config),
              Effect.provideService(Location.Service, location),
              Effect.provideService(ModelsDev.Service, modelsDev),
              Effect.provideService(Npm.Service, npm),
              Effect.provideService(EventV2.Service, events),
              Effect.provideService(FSUtil.Service, fs),
              Effect.provideService(FileSystem.Service, filesystem),
              Effect.provideService(Global.Service, global),
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.provideService(Reference.Service, reference),
            ),
      }
      return plugin.add(PluginV2.ID.make(loaded.id), loaded.effect)
    }

    const boot = yield* Effect.gen(function* () {
      yield* add(ConfigReferencePlugin.Plugin)
    }).pipe(Effect.withSpan("PluginInternal.boot"), Effect.forkScoped({ startImmediately: true }))
    return Ready.of({ awaitReady: Fiber.join(boot) })
  }),
).pipe(
  Layer.provideMerge(PluginV2.locationLayer),
  Layer.provideMerge(Config.locationLayer),
  Layer.provideMerge(FileSystem.locationLayer),
  Layer.provideMerge(FetchHttpClient.layer),
)
