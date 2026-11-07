import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { layerWebSocketConstructorGlobal } from "effect/socket/Socket"
import type { LayerNode } from "@graphagent/core/effect/layer-node"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

/** Builds the served app with app-graph node replacements (e.g. a fake ProviderAdapters). */
export function httpApiLayerWith(replacements: readonly LayerNode.Replacement[]) {
  const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
    HttpApiApp.createRoutes({ replacements }),
    {
      disableListenLog: true,
      disableLogger: true,
    },
  )

  return servedRoutes.pipe(
    Layer.provide(layerWebSocketConstructorGlobal),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  )
}

export const httpApiLayer = httpApiLayerWith([])

export function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

export function requestInDirectory(path: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-graphagent-directory", directory)
  return request(path, { ...init, headers })
}
