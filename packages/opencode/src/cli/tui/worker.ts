import "./worker-console"
import { HookClientLifecycle } from "@/hook/client-lifecycle"
import { Logging } from "@opencode-ai/core/observability/logging"

import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { Global } from "@opencode-ai/core/global"
import { appendFileSync } from "node:fs"
import path from "node:path"

Heap.start()

// Crash observability: swallowing these silently leaves the worker running in a
// corrupt state with no diagnostic trail (TUI appears hung with zero logs).
// Log to the shared log file synchronously so the line survives process.exit.
const logFatal = (kind: string, error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  const line = `timestamp=${new Date().toISOString()} level=ERROR service=tui-worker kind=${kind} error=${JSON.stringify(detail)}\n`
  try {
    appendFileSync(path.join(Global.Path.log, "opencode.log"), line)
  } catch {
    // The log directory may be gone; never let the crash handler itself throw.
  }
}

const onUnhandledRejection = (error: unknown) => {
  // Keep the worker alive: stray rejections from background tasks are not
  // proof of corrupt state, but they must be observable.
  logFatal("unhandledRejection", error)
}

const onUncaughtException = (error: Error) => {
  // Process state is unknown past this point; notify the parent and exit so
  // the TUI can surface the failure instead of hanging on dead RPC calls.
  logFatal("uncaughtException", error)
  try {
    Rpc.emit("worker.fatal", { message: error.message, stack: error.stack })
  } catch {}
  process.exit(1)
}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

const localSessions = new Map<string, string>()

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    const url = new URL(input.url)
    const directory = request.headers.get("x-opencode-directory") ?? url.searchParams.get("directory") ?? process.cwd()
    const existing = url.pathname.match(/\/(?:session|chat)\/([^/]+)\/(?:message|prompt|command|shell)$/)
    if (input.method.toUpperCase() === "POST" && existing) localSessions.set(decodeURIComponent(existing[1]), directory)
    if (input.method.toUpperCase() === "POST" && /\/(?:session|chat)\/?$/.test(url.pathname) && response.ok) {
      try {
        const parsed = JSON.parse(body)
        const created = parsed?.data ?? parsed
        const payload = input.body ? JSON.parse(input.body) : undefined
        const createdDirectory =
          typeof payload?.location?.directory === "string" ? payload.location.directory : directory
        if (typeof created?.id === "string") localSessions.set(created.id, createdDirectory)
      } catch {
        /* Non-JSON responses are not session creation. */
      }
    }
    if (input.method.toUpperCase() === "POST" && url.pathname.endsWith("/control-plane/move-session") && response.ok) {
      try {
        const moved = JSON.parse(input.body ?? "{}")
        if (typeof moved.sessionID === "string" && typeof moved.destination?.directory === "string")
          localSessions.set(moved.sessionID, moved.destination.directory)
      } catch {
        /* Only a successfully decoded move request can update client lifecycle ownership. */
      }
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        yield* Logging.backgroundDebug("lifecycle.worker.reload", { source: "worker.rpc.reload", phase: "requested" })
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    await AppRuntime.runPromise(
      Logging.backgroundDebug("lifecycle.worker.shutdown", { source: "worker.rpc.shutdown", phase: "requested" }),
    )
    for (const [sessionID, directory] of localSessions)
      await AppRuntime.runPromise(
        HookClientLifecycle.endLocalSession({ sessionID, directory, reason: "prompt_input_exit" }).pipe(
          Effect.catchCause(() => Effect.void),
        ),
      )
    localSessions.clear()
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

Rpc.listen(rpc)
