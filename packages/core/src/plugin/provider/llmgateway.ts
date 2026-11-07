import { APP_NAME, APP_TITLE, HOMEPAGE_URL } from "../../brand"
import { Effect } from "effect"
import { define } from "../internal"
import { Integration } from "../../integration"

export const LLMGatewayPlugin = define({
  id: "llmgateway",
  effect: Effect.fn(function* (ctx) {
    const integrations = yield* Integration.Service
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.disabled) continue
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://api.llmgateway.io/v1") continue
          if (!(yield* integrations.get(Integration.ID.make(item.provider.id)))) continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["HTTP-Referer"] = HOMEPAGE_URL
            provider.request.headers["X-Title"] = APP_TITLE
            provider.request.headers["X-Source"] = APP_NAME
          })
        }
      }),
    )
  }),
})
