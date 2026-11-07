import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Option } from "effect"
import { Event } from "./event"

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

// DAG-04 (#316): bounded disposal, mirroring the httpapi exerciser's cleanup
// guard (test/server/httpapi-exercise/runner.ts `bounded`, 10s). A wedged
// instance disposal must not hang global shutdown forever; after the timeout
// we abandon the in-flight disposal and move on — the same trade the
// exerciser makes ("resource may leak" beats "never terminates").
// timeoutOption represents the timeout as Option.none (never as an error), so
// a genuine disposal failure still propagates for callers that do not swallow,
// while a hang is always cut off and the Disposed event below always lands.
// The cut lands at the disposal's first interruptible point: a wedge inside
// an uninterruptible finalizer region can outlast the cap (a hard sever would
// need Effect.disconnect, deliberately not taken — same residual the
// exerciser's Promise.race guard carries).
const DISPOSE_ALL_TIMEOUT = "10 seconds"

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn("Server.disposeAllInstancesAndEmitGlobalDisposed")(
  function* (options?: { swallowErrors?: boolean }) {
    const store = yield* InstanceStore.Service
    const disposeAttempt = options?.swallowErrors
      ? store.disposeAll().pipe(
          Effect.catchCause((cause) => Effect.logWarning("global disposal failed", { cause })),
        )
      : store.disposeAll()
    const outcome = yield* disposeAttempt.pipe(Effect.timeoutOption(DISPOSE_ALL_TIMEOUT))
    if (Option.isNone(outcome))
      yield* Effect.logWarning("global disposal timed out — abandoning in-flight disposal", {
        timeout: DISPOSE_ALL_TIMEOUT,
      })
    yield* emitGlobalDisposed
  },
)

export * as GlobalLifecycle from "./global-lifecycle"
