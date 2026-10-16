import { NodeFileSystem } from "@effect/platform-node"
import { Cause, Deferred, Effect, Exit, FileSystem, Layer, Logger, PlatformError, References } from "effect"
import fsNative from "node:fs/promises"
import path from "node:path"
import { Logging } from "../../../src/observability/logging"

const mode = process.env.DIAGNOSTIC_TEST_MODE
if (mode === "bare") {
  await Effect.runPromise(
    Logging.backgroundDebug("background-bare-marker").pipe(Effect.provideService(References.MinimumLogLevel, "Debug")),
  )
} else {
  const flushed = Deferred.makeUnsafe<void>()
  let writes = 0
  const program = Effect.gen(function* () {
    const writers = yield* Effect.service(Logger.CurrentLoggers)
    const file = [...writers][0]
    if (mode === "throw")
      Object.defineProperty(file, "log", {
        value: () => {
          throw new Error("private-diagnostic-failure")
        },
      })
    const rogue = Logger.make(() => {
      throw new Error("non-file logger must never receive diagnostics")
    })
    yield* Logging.backgroundDebug("background-debug-marker", {
      source: "fixture",
      sessionID: "session-fixture",
      attempt: 1,
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([...writers, rogue])))
    if (mode === "write-defect-once") yield* Deferred.await(flushed)
    yield* Logging.backgroundDebug("background-second-marker", { source: "fixture" })
  })
  const filesystem =
    mode?.startsWith("write-") || mode?.startsWith("open-") || mode?.startsWith("close-")
      ? Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            return {
              ...fs,
              open: (...args: Parameters<typeof fs.open>) =>
                fs.open(...args).pipe(
                  Effect.tap(() =>
                    mode?.startsWith("open-")
                      ? Effect.addFinalizer(() =>
                          Effect.promise(() =>
                            fsNative.writeFile(path.join(process.env.OPENCODE_TEST_HOME!, "released"), "yes"),
                          ),
                        )
                      : Effect.void,
                  ),
                  Effect.flatMap((file) =>
                    mode === "open-typed"
                      ? Effect.fail(
                          PlatformError.badArgument({
                            module: "FileSystem",
                            method: "open",
                            description: "private-open-error",
                          }),
                        )
                      : mode === "open-defect"
                        ? Effect.die(new Error("private-open-defect"))
                        : mode === "open-interrupt"
                          ? Effect.interrupt
                          : Effect.succeed(file),
                  ),
                  Effect.tap(() =>
                    mode?.startsWith("close-")
                      ? Effect.addFinalizer(() =>
                          mode === "close-interrupt" ? Effect.interrupt : Effect.die(new Error("private-close-defect")),
                        )
                      : Effect.void,
                  ),
                  Effect.map(
                    (file) =>
                      new Proxy(file, {
                        get(target, key, receiver) {
                          if (key === "write" && mode?.startsWith("write-"))
                            return (...args: Parameters<typeof file.write>) => {
                              writes++
                              if (mode === "write-defect-once")
                                return writes === 1
                                  ? Deferred.succeed(flushed, undefined).pipe(
                                      Effect.andThen(Effect.die(new Error("private-write-defect"))),
                                    )
                                  : file.write(...args)
                              return mode === "write-interrupt"
                                ? Effect.interrupt
                                : mode === "write-typed"
                                  ? Effect.fail(
                                      PlatformError.badArgument({
                                        module: "FileSystem",
                                        method: "write",
                                        description: "private-write-error",
                                      }),
                                    )
                                  : Effect.die(new Error("private-write-defect"))
                            }
                          return Reflect.get(target, key, receiver)
                        },
                      }),
                  ),
                ),
            }
          }),
        ).pipe(Layer.provide(NodeFileSystem.layer))
      : NodeFileSystem.layer
  const loggers = Logging.loggers()
  const result = await Effect.runPromiseExit(
    program.pipe(
      Effect.provide(
        Logger.layer(loggers).pipe(
          Layer.provide(filesystem),
          Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
        ),
      ),
      Effect.scoped,
    ),
  )
  if (Exit.isFailure(result)) {
    if (!mode?.endsWith("interrupt") || !Cause.hasInterrupts(result.cause))
      throw new Error("unexpected fixture failure")
    await fsNative.writeFile(path.join(process.env.OPENCODE_TEST_HOME!, "interrupted"), "yes")
  }
}
