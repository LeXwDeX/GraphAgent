import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect, mock } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const installationCall = mock(() => {
  throw new Error("Installation must not be used by the retired endpoint")
})

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: installationCall,
      latest: installationCall,
      upgrade: installationCall,
    }),
  ),
  Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("global HttpApi", () => {
  it.live("disables omitted-body upgrade requests without installation side effects", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post(GlobalPaths.upgrade)

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ success: false, error: Installation.UPDATES_DISABLED })
      expect(installationCall).not.toHaveBeenCalled()
    }),
  )

  it.live("disables explicit target requests without installation side effects", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text(JSON.stringify({ target: "99.0.0" }), "application/json")),
        HttpClient.execute,
      )
      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ success: false, error: Installation.UPDATES_DISABLED })
      expect(installationCall).not.toHaveBeenCalled()
    }),
  )

  it.live("rejects malformed upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text("{", "application/json")),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ success: false, error: "Invalid request body" })
    }),
  )
})
