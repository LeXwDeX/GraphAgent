import { SessionAttention } from "./attention"
/** Non-blocking internal hook delivery. Producers own the business timing and cancellation. */
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Option } from "effect"

export interface NotifyInput {
  message: string
  title?: string
  /** Official Notification matcher category. */
  notificationType: string
  /** Session that needs attention; reported to the hook as `session_id`. */
  sessionID?: string
}

export interface Interface {
  /**
   * Record an "agent needs attention" moment. Fires the `Notification` hook
   * (optional, tolerant — hook failure never propagates). Future UI delivery
   * plugs in here without touching call sites.
   */
  readonly notify: (input: NotifyInput) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Notification") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { SettingsHook } = yield* Effect.promise(() => import("@/hook/settings"))
    const layerSettings = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))

    const notify = Effect.fn("Notification.notify")(
      function* (input: NotifyInput) {
        const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service)) ?? layerSettings
        if (!settingsHook) return
        const { consumerContext } = yield* Effect.promise(() => import("@/hook/consumer-context"))
        const nResult = yield* settingsHook
          .trigger(
            {
              event: "Notification",
              message: input.message,
              title: input.title,
              notificationType: input.notificationType,
            },
            input.sessionID
              ? yield* consumerContext(input.sessionID).pipe(Effect.orDie)
              : { sessionID: "", transcriptPath: "" },
          )
          .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] })))
        void nResult // Notification output cannot alter the conversation.
        if (input.sessionID && ["permission_prompt", "elicitation_dialog"].includes(input.notificationType)) {
          const { BackgroundJob } = yield* Effect.promise(() => import("@/background/job"))
          const jobs = Option.getOrUndefined(yield* Effect.serviceOption(BackgroundJob.Service))
          const attention = Option.getOrUndefined(yield* Effect.serviceOption(SessionAttention.Service))
          const job = jobs
            ? (yield* jobs.list()).find(
                (job) =>
                  job.status === "running" &&
                  job.metadata?.background === true &&
                  job.metadata?.sessionId === input.sessionID,
              )
            : undefined
          const parent = job?.metadata?.parentSessionId
          if (attention && typeof parent === "string" && (yield* attention.viewing(parent))) {
            yield* settingsHook
              .trigger(
                {
                  event: "Notification",
                  notificationType: "agent_needs_input",
                  message: "A background agent needs your input",
                },
                yield* consumerContext(input.sessionID).pipe(Effect.orDie),
              )
              .pipe(Effect.ignore)
          }
        }
      },
      Effect.ignore,
      Effect.catchDefect(() => Effect.void),
    )

    return Service.of({ notify })
  }),
)

export const defaultLayer: Layer.Layer<Service> = Layer.suspend(() =>
  layer.pipe(Layer.provide(SessionAttention.defaultLayer)),
)

export const node = {
  ...LayerNode.make(layer, []),
  get dependencies() {
    return [SessionAttention.node]
  },
}

export * as Notification from "."
