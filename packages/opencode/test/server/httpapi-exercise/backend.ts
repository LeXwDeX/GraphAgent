import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpEffect, HttpRouter } from "effect/unstable/http"
import { parse } from "./assertions"
import { exerciseWorkingDirectory } from "./environment"
import { runtime, type Runtime } from "./runtime"
import type { ActiveScenario, BackendApp, CallResult, CaptureMode, FollowupRequestSpec, SeededContext } from "./types"

type CallOptions = {
  auth?: {
    password?: string
    username?: string
  }
}

export function call(scenario: ActiveScenario, ctx: SeededContext<unknown>, options: CallOptions = {}) {
  // The signal parameter is load-bearing: Effect.promise is interruptible only
  // when the callback declares it (evaluate.length !== 0). Without it the
  // scenario timeout cannot break a stuck request and the runner hangs
  // silently. The signal is also threaded into the Request so the handler
  // side observes the abort.
  return Effect.promise(async (signal) =>
    capture(await app(await runtime(), options).request(toRequest(scenario, ctx, signal)), scenario.capture),
  )
}

export function callRequest(spec: FollowupRequestSpec) {
  return Effect.promise(async (signal) => {
    const headers = spec.body === undefined ? spec.headers : { "content-type": "application/json", ...spec.headers }
    const response = await app(await runtime(), {}).request(
      new Request(new URL(spec.path, "http://localhost"), {
        method: spec.method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal,
      }),
    )
    return capture(response, "full")
  })
}

export function callAuthProbe(scenario: ActiveScenario, credentials: "missing" | "valid" = "missing") {
  return Effect.gen(function* () {
    const backend = app(yield* Effect.promise(runtime), { auth: { password: "secret" } })
    yield* authReady(backend)
    return yield* Effect.promise(async (signal) => {
      const controller = new AbortController()
      // Forward fiber interruption (scenario timeout) into the probe abort so
      // neither the request nor the race below can outlive the scenario.
      const abortOuter = () => controller.abort("scenario interrupted")
      signal.addEventListener("abort", abortOuter, { once: true })
      try {
        return await Promise.race([
          Promise.resolve(backend.request(toAuthProbeRequest(scenario, credentials, controller.signal))).then(
            (response) => capture(response, scenario.capture),
          ),
          Bun.sleep(1_000).then(() => {
            controller.abort("auth probe timed out")
            return {
              status: 0,
              contentType: "",
              text: "auth probe timed out",
              body: undefined,
              timedOut: true,
            }
          }),
        ])
      } finally {
        signal.removeEventListener("abort", abortOuter)
      }
    })
  })
}

const authReadiness = new WeakMap<CachedApp, Effect.Effect<void>>()

function authReady(backend: CachedApp) {
  const existing = authReadiness.get(backend)
  if (existing) return existing
  // A valid health request acquires the complete route layer before measuring
  // auth response latency. Cache only within this app's lifetime.
  const ready = Effect.runSync(
    Effect.cached(
      Effect.promise(async (signal) => {
        const response = await backend.request(
          new Request("http://localhost/global/health", {
            headers: {
              authorization: basic("opencode", "secret"),
              "x-opencode-directory": exerciseWorkingDirectory,
            },
            signal,
          }),
        )
        await response.body?.cancel()
        if (response.status !== 200) throw new Error(`auth readiness expected 200, got ${response.status}`)
      }).pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.die(new Error("auth readiness timed out")),
        }),
        Effect.onError(() =>
          Effect.promise(async () => {
            // Failed/interrupted Effect.cached values must not poison later scenarios.
            // An old failure must also never evict a newer app.
            if (appCache[":secret"] === backend) delete appCache[":secret"]
            await backend.dispose()
          }),
        ),
      ),
    ),
  )
  authReadiness.set(backend, ready)
  return ready
}

export type CachedApp = BackendApp & { readonly dispose: () => Promise<void> }

export const appCache: Partial<Record<string, CachedApp>> = {}

export async function disposeApps(heartbeat?: (label: string) => void) {
  const apps = Object.values(appCache)
  for (const key of Object.keys(appCache)) delete appCache[key]
  heartbeat?.(`teardown: disposing ${apps.filter((app) => app !== undefined).length} app(s)`)
  await Promise.all(
    apps.flatMap((app, i) =>
      app === undefined
        ? []
        : [
            app.dispose().then(
              () => heartbeat?.(`teardown: app[${i}] disposed`),
              (err) => heartbeat?.(`teardown: app[${i}] dispose error: ${err}`),
            ),
          ],
    ),
  )
  heartbeat?.("teardown: all apps disposed")
}

function app(modules: Runtime, options: CallOptions) {
  const username = options.auth?.username
  const password = options.auth?.password
  const cacheKey = `${username ?? ""}:${password ?? ""}`
  if (appCache[cacheKey]) return appCache[cacheKey]

  const scope = Scope.makeUnsafe()
  // HttpRouter.toWebHandler builds its layer in a detached promise on the first
  // request. Build explicitly so scenario cancellation interrupts acquisition
  // and dispose still releases exactly this app's memo-map references.
  const handler = Effect.runSync(
    Effect.cached(
      Effect.gen(function* () {
        const routes = modules.HttpApiApp.routes.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                OPENCODE_SERVER_PASSWORD: password,
                OPENCODE_SERVER_USERNAME: username,
                OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER,
                OPENCODE_EXPERIMENTAL_FILEWATCHER: process.env.OPENCODE_EXPERIMENTAL_FILEWATCHER,
              }),
            ),
          ),
          Layer.provideMerge(HttpRouter.layer),
        )
        // Request markers describe handler requirements, not layer services.
        // HttpRouter.toWebHandler erases the same markers at this boundary.
        const context = yield* Layer.buildWithMemoMap(
          routes as Layer.Layer<HttpRouter.HttpRouter, Layer.Error<typeof routes>>,
          modules.memoMap,
          scope,
        )
        const http = Context.get(context, HttpRouter.HttpRouter).asHttpEffect()
        return HttpEffect.toWebHandlerWith<HttpRouter.HttpRouter, Effect.Services<typeof http>, unknown>(context)(http)
      }),
    ),
  )
  return (appCache[cacheKey] = {
    dispose: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    request(input: string | URL | Request, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init)
      return Effect.runPromise(handler, { signal: request.signal }).then((handle) => {
        request.signal.throwIfAborted()
        return handle(request, modules.HttpApiApp.context)
      })
    },
  })
}

function toRequest(scenario: ActiveScenario, ctx: SeededContext<unknown>, signal: AbortSignal) {
  const spec = scenario.request(ctx, ctx.state)
  return new Request(new URL(spec.path, "http://localhost"), {
    method: scenario.method,
    headers: spec.body === undefined ? spec.headers : { "content-type": "application/json", ...spec.headers },
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    signal,
  })
}

function toAuthProbeRequest(scenario: ActiveScenario, credentials: "missing" | "valid", signal: AbortSignal) {
  const spec = scenario.authProbe ?? {
    path: authProbePath(scenario.path),
    body: scenario.method === "GET" ? undefined : {},
  }
  const headers = {
    ...(spec.body === undefined ? {} : { "content-type": "application/json" }),
    // Valid-credential probes run the real handler; keep them inside the exercise root.
    "x-opencode-directory": exerciseWorkingDirectory,
    ...spec.headers,
    ...(credentials === "valid" ? { authorization: basic("opencode", "secret") } : {}),
  }
  return new Request(new URL(spec.path, "http://localhost"), {
    method: scenario.method,
    headers,
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    signal,
  })
}

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function authProbePath(path: string) {
  return path
    .replace(/\{([^}]+)\}/g, (_match, key: string) => `auth_${key}`)
    .replace(/:([^/]+)/g, (_match, key: string) => `auth_${key}`)
}

async function capture(response: Response, mode: CaptureMode): Promise<CallResult> {
  const text = mode === "stream" ? await captureStream(response) : await response.text()
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text,
    body: parse(text),
    timedOut: false,
  }
}

async function captureStream(response: Response) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const read = reader.read().then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  )
  const winner = await Promise.race([read, Bun.sleep(1_000).then(() => ({ timeout: true }))])
  if ("timeout" in winner) {
    await reader.cancel("timed out waiting for stream chunk").catch(() => undefined)
    throw new Error("timed out waiting for stream chunk")
  }
  if ("error" in winner) throw winner.error
  await reader.cancel().catch(() => undefined)
  if (winner.result.done) return ""
  return new TextDecoder().decode(winner.result.value)
}
