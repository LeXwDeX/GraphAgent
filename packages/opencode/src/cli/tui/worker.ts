import "./worker-console"

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
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

Rpc.listen(rpc)
