import { NodeServices } from "@effect/platform-node"
import { HttpServer } from "effect/unstable/http"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Cause, Deferred, Effect, Exit, Layer, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../../../src/server/auth"
import { Authorization, authorizationLayer } from "../../../src/server/routes/instance/httpapi/middleware/authorization"
import { http } from "./dsl"

// Importing the standalone exerciser changes DB/XDG settings. Restore the test
// process settings immediately, as other test files share this process.
const keys = [
  "OPENCODE_DB",
  "OPENCODE_DISABLE_SHARE",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
] as const
const savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const savedDb = Flag.OPENCODE_DB
const { appCache, callAuthProbe, disposeApps } = await import("./backend")
const { cleanupExercisePaths } = await import("./environment")
Flag.OPENCODE_DB = savedDb
for (const key of keys) {
  const value = savedEnv[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
const modules = await (await import("./runtime")).runtime()
const originalApp = modules.HttpApiApp

const Api = HttpApi.make("auth-readiness").add(
  HttpApiGroup.make("probe")
    .add(
      HttpApiEndpoint.get("health", "/global/health", { success: Schema.String, error: HttpApiError.BadRequest }),
      HttpApiEndpoint.get("probe", "/probe", { success: Schema.String }),
    )
    .middleware(Authorization),
)
const scenario = http.protected.get("/global/health", "auth-readiness").global().ok()

afterEach(async () => {
  await disposeApps()
  modules.HttpApiApp = originalApp
})
afterAll(async () => {
  await Effect.runPromise(cleanupExercisePaths)
})

function installRoutes(
  options: {
    acquire?: Effect.Effect<void, never, import("effect").Scope.Scope>
    health?: Effect.Effect<string, HttpApiError.BadRequest>
    probe?: Effect.Effect<string>
  } = {},
) {
  const counts = { health: 0, probe: 0 }
  const handlers = HttpApiBuilder.group(Api, "probe", (handlers) =>
    handlers
      .handle("health", () =>
        Effect.gen(function* () {
          counts.health++
          return yield* options.health ?? Effect.succeed("ok")
        }),
      )
      .handle("probe", () =>
        Effect.gen(function* () {
          counts.probe++
          return yield* options.probe ?? Effect.succeed("ok")
        }),
      ),
  )
  const routes = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(handlers),
    Layer.provide(HttpServer.layerServices),
    Layer.provide(NodeServices.layer),
    Layer.provide(authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))),
    Layer.provide(Layer.effectDiscard(options.acquire ?? Effect.void)),
  )
  modules.HttpApiApp = { ...originalApp, routes }
  return counts
}

describe("HttpAPI exerciser auth readiness", () => {
  test("keeps cold layer acquisition outside the auth probe response budget", async () => {
    let acquisitions = 0
    const counts = installRoutes({
      acquire: Effect.gen(function* () {
        acquisitions++
        // Deliberately cross the real 1s response budget during layer build.
        yield* Effect.sleep("1200 millis")
      }),
    })

    const missing = await Effect.runPromise(callAuthProbe(scenario))
    expect(missing.status).toBe(401)
    expect(missing.timedOut).toBe(false)
    const valid = await Effect.runPromise(callAuthProbe(scenario, "valid"))
    expect(valid.status).toBe(200)
    expect(valid.timedOut).toBe(false)
    expect(acquisitions).toBe(1)
    // One valid health request establishes readiness; one is the valid probe.
    expect(counts.health).toBe(2)
  })

  test("rejects failed readiness, releases its scope, and allows a fresh app", async () => {
    let releases = 0
    const counts = installRoutes({
      health: Effect.fail(new HttpApiError.BadRequest({})),
      acquire: Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          releases++
        }),
      ),
    })
    const exit = await Effect.runPromiseExit(callAuthProbe(scenario))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("auth readiness expected 200, got 400")
    expect(counts.health).toBe(1)
    expect(releases).toBe(1)
    expect(appCache[":secret"]).toBeUndefined()

    const next = installRoutes()
    expect((await Effect.runPromise(callAuthProbe(scenario))).status).toBe(401)
    expect(next.health).toBe(1)
  })

  test("interrupts cold acquisition, releases resources, and never dispatches a probe", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const interrupted = Deferred.makeUnsafe<void>()
    let acquisitions = 0
    let releases = 0
    const counts = installRoutes({
      acquire: Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            acquisitions++
          }),
          () =>
            Effect.sync(() => {
              releases++
            }),
        )
        yield* Deferred.succeed(entered, undefined)
        yield* Effect.never
      }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
    })
    const controller = new AbortController()
    const request = Effect.runPromiseExit(callAuthProbe(scenario), { signal: controller.signal })
    await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("5 seconds")))
    controller.abort()
    const exit = await request
    await Effect.runPromise(Deferred.await(interrupted).pipe(Effect.timeout("5 seconds")))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(acquisitions).toBe(1)
    expect(releases).toBe(1)
    expect(counts.health).toBe(0)
    expect(appCache[":secret"]).toBeUndefined()
    const next = installRoutes()
    expect((await Effect.runPromise(callAuthProbe(scenario))).status).toBe(401)
    expect(next.health).toBe(1)
  })

  test("retains the one-second response budget after readiness", async () => {
    const stopped = Deferred.makeUnsafe<void>()
    const counts = installRoutes({
      probe: Effect.sleep("5 seconds").pipe(
        Effect.as("too late"),
        Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
      ),
    })
    const probe = http.protected.get("/probe", "slow-auth-response").global().ok()
    // First establish and cache readiness before timing only the actual probe.
    expect((await Effect.runPromise(callAuthProbe(probe))).status).toBe(401)
    const started = performance.now()
    const result = await Effect.runPromise(callAuthProbe(probe, "valid"))
    expect(result.status).toBe(0)
    expect(result.timedOut).toBe(true)
    expect(performance.now() - started).toBeLessThan(3000)
    await Effect.runPromise(Deferred.await(stopped).pipe(Effect.timeout("5 seconds")))
    expect(counts.health).toBe(1)
    expect(counts.probe).toBe(1)
  })
})
