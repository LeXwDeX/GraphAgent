import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpEffect, HttpRouter } from "effect/http"
import { parse } from "./assertions"
import { runtime, type Runtime } from "./runtime"
import type { ActiveScenario, BackendApp, CallResult, CaptureMode, FollowupRequestSpec, SeededContext } from "./types"

export function call(scenario: ActiveScenario, ctx: SeededContext<unknown>) {
  // The signal parameter is load-bearing: Effect.promise is interruptible only
  // when the callback declares it (evaluate.length !== 0). Without it the
  // scenario timeout cannot break a stuck request and the runner hangs
  // silently. The signal is also threaded into the Request so the handler
  // side observes the abort.
  return Effect.promise(async (signal) =>
    capture(await app(await runtime()).request(toRequest(scenario, ctx, signal)), scenario.capture),
  )
}

export function callRequest(spec: FollowupRequestSpec) {
  return Effect.promise(async (signal) => {
    const headers = spec.body === undefined ? spec.headers : { "content-type": "application/json", ...spec.headers }
    const response = await app(await runtime()).request(
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

export type CachedApp = BackendApp & { readonly dispose: () => Promise<void> }

export const appCache: Partial<Record<string, CachedApp>> = {}

const appKey = "default"

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

function app(modules: Runtime) {
  if (appCache[appKey]) return appCache[appKey]

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
                GRAPHAGENT_DISABLE_FILEWATCHER: process.env.GRAPHAGENT_DISABLE_FILEWATCHER,
                GRAPHAGENT_FILEWATCHER: process.env.GRAPHAGENT_FILEWATCHER,
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
  return (appCache[appKey] = {
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
