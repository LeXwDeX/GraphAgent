import { Config } from "@/config/config"
import { ConfigHotReload } from "@/config/hot-reload"
import { GlobalBus } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { UPDATES_DISABLED } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@graphagent/core/installation/version"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiError } from "effect/http-api"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config
        .updateGlobal(ctx.payload)
        .pipe(Effect.catchTag("ConfigChangeBlocked", () => Effect.fail(new HttpApiError.BadRequest({}))))
      if (result.changed) {
        if (ConfigHotReload.isHotReloadOnly(result.changedKeys)) {
          // #1013 (C1 PR5): hot-read keys apply to the next workflow run, so
          // keep every instance (and its in-flight nodes) alive and report the
          // changed keys instead.
          yield* Effect.sync(() =>
            GlobalBus.emit("event", {
              directory: "global",
              payload: {
                type: ConfigHotReload.CONFIG_UPDATED_EVENT,
                properties: { keys: result.changedKeys },
              },
            }),
          )
        } else {
          bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
        }
      }
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      return HttpServerResponse.jsonUnsafe({ success: false, error: UPDATES_DISABLED }, { status: 400 })
    })

    return handlers
      .handle("health", health)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
  }),
)
