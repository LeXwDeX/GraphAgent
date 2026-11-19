import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ProviderRedact } from "@/provider/redact"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/http-api"
import { InstanceHttpApi } from "../api"
import { AfterResponse } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    // #1553: `{env:}` and `{file:}` references are resolved by the time the configuration is read, so every read
    // response is redacted on its way out; the runtime keeps reading the resolved values from the services.
    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return ProviderRedact.redactConfig(yield* configSvc.get())
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc
        .update(ctx.payload)
        .pipe(Effect.catchTag("ConfigChangeBlocked", () => Effect.fail(new HttpApiError.BadRequest({}))))
      yield* (yield* AfterResponse.Service).dispose(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const catalog = yield* providerSvc.publicCatalog()
      return { ...catalog, providers: catalog.providers.map(ProviderRedact.redactProvider) }
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)
