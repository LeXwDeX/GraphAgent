import "./worker-console"
import { HookClientLifecycle } from "@/hook/client-lifecycle"
import { Logging } from "@graphagent/core/observability/logging"

import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import type { RpcFetchRequest, RpcFetchResponse, WorkerMethods } from "./rpc-contract"
import { isCancellableRequest } from "./rpc-contract"
import { EventPump, type PumpEvent } from "./event-pump"
import type { RpcContext } from "@/util/rpc"
import { ClientSessions } from "@/session/client-sessions"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { Global } from "@graphagent/core/global"
import { APP_NAME } from "@graphagent/core/brand"
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
    appendFileSync(path.join(Global.Path.log, `${APP_NAME}.log`), line)
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

// Raw GlobalBus events are filtered, merged and batched by the pump. Schema
// encoding happens there before the batch crosses the worker boundary.
const pump = new EventPump({
  emit: (events) => Rpc.emit("global.events", events),
})

GlobalBus.on("event", (event) => {
  pump.push(event as PumpEvent)
})

export const rpc = {
  async fetch(input: RpcFetchRequest, context?: RpcContext): Promise<RpcFetchResponse> {
    const url = new URL(input.url)
    // Cancellation is new in the bridge, so apply the signal only to requests
    // that are safe to abort. State-changing POSTs keep running to completion.
    const signal = context && isCancellableRequest(input.method, url.pathname) ? context.signal : undefined
    const request = new Request(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal,
    })
    const response = await Server.Default().app.fetch(request)
    return {
      status: response.status,
      headers: [...response.headers.entries()],
      body: new Uint8Array(await response.arrayBuffer()),
    }
  },
  async snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async setInterest(input: { full: readonly string[] }) {
    await pump.setInterest(input)
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
    for (const { sessionID, directory } of ClientSessions.list())
      await AppRuntime.runPromise(
        HookClientLifecycle.endLocalSession({ sessionID, directory, reason: "prompt_input_exit" }).pipe(
          Effect.catchCause(() => Effect.void),
        ),
      )
    ClientSessions.clear()
    pump.dispose()
    await InstanceRuntime.disposeAllInstances()
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

Rpc.listen<WorkerMethods>(rpc)
