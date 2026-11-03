import { LLMError } from "@opencode-ai/llm"
import { Cause, Clock, DateTime, Effect, Layer, Option } from "effect"
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

const identity = (value: string | undefined) =>
  value && !value.includes("://") && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(value) ? value : undefined

const llmCategories = new Set([
  "InvalidRequest",
  "NoRoute",
  "Authentication",
  "RateLimit",
  "QuotaExceeded",
  "ContentPolicy",
  "ProviderInternal",
  "Transport",
  "InvalidProviderOutput",
  "UnknownProvider",
])

/** Report a drain failure without including provider response or prompt content. */
export const drain = (
  sessionID: SessionSchema.ID,
  run: (
    onModelResolved: NonNullable<Parameters<SessionRunner.Interface["run"]>[0]["onModelResolved"]>,
  ) => Effect.Effect<void, SessionRunner.RunError>,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    let model: { readonly providerID: string; readonly modelID: string } | undefined
    return yield* run((resolved) => (model = resolved)).pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.gen(function* () {
              const error = Option.getOrUndefined(Cause.findErrorOption(cause))
              const category =
                error instanceof LLMError && llmCategories.has(error.reason._tag) ? error.reason._tag : undefined
              const status =
                error instanceof LLMError
                  ? (("status" in error.reason ? error.reason.status : undefined) ??
                    ("http" in error.reason ? error.reason.http?.response?.status : undefined))
                  : undefined
              const duration = (yield* Clock.currentTimeMillis) - started
              yield* Effect.logError("Failed to drain Session", {
                sessionID: identity(sessionID),
                providerID: identity(model?.providerID),
                modelID: identity(model?.modelID),
                errorCategory: category ?? (Cause.hasDies(cause) ? "defect" : "failure"),
                errorCode:
                  typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
                    ? status
                    : undefined,
                retryable:
                  category === undefined ? undefined : category === "RateLimit" || category === "ProviderInternal",
                durationMs: Math.min(Math.max(0, duration), 2_147_483_647),
              })
            }),
      ),
    )
  })

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
        return yield* drain(sessionID, (onModelResolved) =>
          PluginInternal.Ready.use((ready) => ready.awaitReady).pipe(
            Effect.andThen(SessionRunner.Service.use((runner) => runner.run({ sessionID, force, onModelResolved }))),
            Effect.provide(locations.get(session.location)),
          ),
        )
      }),
    })

    const service = SessionExecution.Service.of({
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
      rewake: (input) =>
        Effect.gen(function* () {
          const scheduled = yield* SessionLifecycleHooks.withLock(
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
              return yield* coordinator.wakeTracked(input.sessionID, true)
            }),
          )
          if (typeof scheduled === "boolean") return scheduled
          // Do not hold the admission lock while the runner executes hooks.
          yield* scheduled.pipe(Effect.orDie)
          return true
        }),
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
