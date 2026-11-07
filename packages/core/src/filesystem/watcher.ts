export * as Watcher from "./watcher"

// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { Cause, Context, Effect, Layer } from "effect"
import { FileSystemWatcher } from "@opencode-ai/schema/filesystem-watcher"
import path from "path"
import { Config } from "../config"
import { EventV2 } from "../event"
import { Flag } from "../flag/flag"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { Location } from "../location"
import { lazy } from "../util/lazy"
import { Ignore } from "./ignore"
import { Protected } from "./protected"

declare const GRAPHAGENT_LIBC: string | undefined

const SUBSCRIBE_TIMEOUT_MS = 10_000

export const Event = FileSystemWatcher.Event

const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const libc = typeof GRAPHAGENT_LIBC === "undefined" ? undefined : GRAPHAGENT_LIBC
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch {
    return
  }
})

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const relative = path.relative(dir, item)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  })
}

export const hasNativeBinding = () => !!watcher()

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileWatcher") {}

export const layerWith = (options?: {
  readonly native?: typeof import("@parcel/watcher")
  readonly timeout?: number
}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      if (yield* Flag.GRAPHAGENT_DISABLE_FILEWATCHER) return Service.of({})

      const backend = getBackend()
      const location = yield* Location.Service
      if (!backend) {
        yield* Effect.logError("watcher backend not supported", {
          directory: location.directory,
          platform: process.platform,
        })
        return Service.of({})
      }

      const w = options?.native ?? watcher()
      if (!w) return Service.of({})

      yield* Effect.logInfo("watcher backend", { directory: location.directory, platform: process.platform, backend })
      const events = yield* EventV2.Service
      const fs = yield* FSUtil.Service
      const git = yield* Git.Service
      const context = yield* Effect.context()
      const runFork = Effect.runForkWith(context)
      const subscriptions: ParcelWatcher.AsyncSubscription[] = []
      let disposed = false
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          disposed = true
        }).pipe(
          Effect.andThen(
            Effect.forEach(
              subscriptions,
              (subscription) =>
                Effect.promise(() => subscription.unsubscribe()).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError("failed to unsubscribe", { cause: Cause.pretty(cause) }),
                  ),
                ),
              { concurrency: "unbounded" },
            ),
          ),
        ),
      )

      const callback: ParcelWatcher.SubscribeCallback = (error, updates) => {
        if (disposed) return
        if (error) {
          runFork(Effect.logError("watcher callback failed", { error }))
          return
        }
        for (const update of updates ?? []) {
          if (update.type === "create") runFork(events.publish(Event.Updated, { file: update.path, event: "add" }))
          if (update.type === "update") runFork(events.publish(Event.Updated, { file: update.path, event: "change" }))
          if (update.type === "delete") runFork(events.publish(Event.Updated, { file: update.path, event: "unlink" }))
        }
      }

      const subscribe = (directory: string, ignore: string[]) =>
        Effect.suspend(() => {
          let pending: Promise<ParcelWatcher.AsyncSubscription> | undefined
          let accepted = false
          let relinquished = false
          // Declaring the signal keeps the promise wait interruptible even though
          // the native watcher cannot abort acquisition itself.
          return Effect.promise((_signal) => {
            // Attach the rejection handler when the fiber runs, rather than starting
            // a native subscription while merely constructing the effect.
            pending = w.subscribe(
              directory,
              (error, updates) => {
                if (!relinquished) callback(error, updates)
              },
              { ignore, backend },
            )
            return pending
          }).pipe(
            Effect.tap((subscription) =>
              Effect.sync(() => {
                subscriptions.push(subscription)
                accepted = true
              }),
            ),
            Effect.timeout(options?.timeout ?? SUBSCRIBE_TIMEOUT_MS),
            Effect.onExit(() =>
              Effect.sync(() => {
                if (accepted) return
                relinquished = true
                if (!pending) return
                // Timeout and scope interruption both relinquish ownership, including
                // subscriptions which resolve after the scope has already closed.
                void pending.then(
                  async (subscription) => {
                    try {
                      await subscription.unsubscribe()
                    } catch (error) {
                      runFork(Effect.logError("failed to unsubscribe", { directory, error }))
                    }
                  },
                  () => {},
                )
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logError("failed to subscribe", { directory, cause: Cause.pretty(cause) }),
            ),
          )
        })

      const config = (yield* (yield* Config.Service).entries())
        .filter((entry): entry is Config.Document => entry.type === "document")
        .flatMap((item) => item.info.watcher?.ignore ?? [])
      if (location.vcs && (yield* Flag.GRAPHAGENT_FILEWATCHER)) {
        yield* Effect.forkScoped(
          subscribe(location.directory, [...Ignore.PATTERNS, ...config, ...protecteds(location.directory)]),
        )
      }

      if (location.vcs?.type === "git") {
        const resolved = (yield* git.repo.discover(location.directory))?.gitDirectory
        const vcs = resolved
          ? yield* fs.realPath(resolved).pipe(Effect.catch(() => Effect.succeed(resolved)))
          : undefined
        if (vcs && !config.includes(".git") && !config.includes(vcs) && (!resolved || !config.includes(resolved))) {
          const ignore = (yield* fs.readDirectoryEntries(vcs).pipe(Effect.catch(() => Effect.succeed([])))).flatMap(
            (entry) => (entry.name === "HEAD" ? [] : [entry.name]),
          )
          yield* Effect.forkScoped(subscribe(vcs, ignore))
        }
      }

      return Service.of({})
    }).pipe(
      Effect.catchCause((cause) => {
        return Effect.logError("failed to init watcher service", { cause: Cause.pretty(cause) }).pipe(
          Effect.as(Service.of({})),
        )
      }),
    ),
  )

export const layer = layerWith()

export const locationLayer = layer.pipe(Layer.provide(Config.locationLayer), Layer.provide(Git.defaultLayer))
