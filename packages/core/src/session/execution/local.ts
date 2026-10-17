import { Cause, DateTime, Effect, Layer, Option } from "effect"
import { EventV2 } from "../../event"
import { LocationServiceMap } from "../../location-layer"
import { PluginInternal } from "../../plugin/internal"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionLifecycleHooks } from "../lifecycle-hooks"
import { SessionRewakeBridge } from "./rewake-bridge"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const events = yield* EventV2.Service
    const locations = yield* LocationServiceMap
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* PluginInternal.Ready.use((ready) => ready.awaitReady).pipe(
          Effect.andThen(SessionRunner.Service.use((runner) => runner.run({ sessionID, force }))),
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })

    const service = SessionExecution.Service.of({
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
      rewake: (input) =>
        SessionLifecycleHooks.withLock(
          input.sessionID,
          Effect.gen(function* () {
            // The hook callback may have completed after a new prompt, cancel,
            // or SessionEnd. Validate inside the same lock as those lifecycle
            // transitions, before recording anything for model replay.
            const session = yield* store.get(input.sessionID)
            if (!session) return false
            if (!(yield* input.valid())) return true
            yield* events.publish(SessionEvent.Synthetic, {
              sessionID: input.sessionID,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              text: input.text,
            })
            yield* coordinator.wake(input.sessionID, true)
            return true
          }),
        ),
    })
    const bridge = Option.getOrUndefined(yield* Effect.serviceOption(SessionRewakeBridge.Service))
    if (bridge && service.rewake) {
      yield* bridge.register(service.rewake)
      yield* Effect.addFinalizer(() => bridge.unregister(service.rewake!))
    }
    return service
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionStore.defaultLayer))
