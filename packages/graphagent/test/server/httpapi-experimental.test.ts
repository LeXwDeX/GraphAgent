import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/http"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { Session } from "@/session/session"
import { Database } from "@graphagent/core/database/database"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("experimental HttpApi", () => {
  it.instance(
    "serves capabilities and MCP resources through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const [capabilities, resources] = yield* Effect.all(
          [request(ExperimentalPaths.capabilities, tmp.directory), request(ExperimentalPaths.resource, tmp.directory)],
          { concurrency: "unbounded" },
        )

        expect(capabilities.status).toBe(200)
        expect(yield* json<{ backgroundSubagents: boolean }>(capabilities)).toEqual({
          backgroundSubagents: expect.any(Boolean),
        })

        expect(resources.status).toBe(200)
        expect(yield* json(resources)).toEqual({})
      }),
    {
      config: {
        formatter: false,
        lsp: false,
      },
      mcp: {
        demo: {
          type: "local",
          command: ["echo", "demo"],
          disabled: true,
        },
      },
    },
  )
})
