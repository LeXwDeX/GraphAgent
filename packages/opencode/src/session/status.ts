import { SessionAttention } from "@/notification/attention"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Fiber, Scope, Option } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { Notification } from "@/notification"
import { BackgroundJob } from "@/background/job"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info
export const Event = SessionStatusEvent
export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
  readonly settle?: (sessionID: SessionID) => Effect.Effect<void>
  readonly clear?: (sessionID: SessionID) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const layerNotification = Option.getOrUndefined(yield* Effect.serviceOption(Notification.Service))
    const attention = Option.getOrUndefined(yield* Effect.serviceOption(SessionAttention.Service))
    const jobs = Option.getOrUndefined(yield* Effect.serviceOption(BackgroundJob.Service))
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        return {
          statuses: new Map<SessionID, Info>(),
          timers: new Map<SessionID, Fiber.Fiber<void>>(),
          scope: yield* Scope.Scope,
        }
      }),
    )
    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      return (yield* InstanceState.get(state)).statuses.get(sessionID) ?? { type: "idle" as const }
    })
    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map((yield* InstanceState.get(state)).statuses)
    })
    const clear = Effect.fn("SessionStatus.clear")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const timer = data.timers.get(sessionID)
      data.timers.delete(sessionID)
      data.statuses.delete(sessionID)
      if (timer) yield* Fiber.interrupt(timer)
    })
    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      const previous = data.statuses.get(sessionID)
      const timer = data.timers.get(sessionID)
      data.timers.delete(sessionID)
      if (timer) yield* Fiber.interrupt(timer)
      yield* events.publish(Event.Status, { sessionID, status })
      if (status.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID })
        data.statuses.delete(sessionID)
        const notification =
          Option.getOrUndefined(yield* Effect.serviceOption(Notification.Service)) ?? layerNotification
        if (previous?.type === "busy" && notification) {
          const fiber = yield* Effect.sleep("60 seconds").pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const { DagStore } = yield* Effect.promise(() => import("@opencode-ai/core/dag/store"))
                const { HookTurnContext } = yield* Effect.promise(() => import("@/hook/turn-context"))
                const workflows = Option.getOrUndefined(yield* Effect.serviceOption(DagStore.Service))
                const active = jobs ? yield* HookTurnContext.backgroundTasks(sessionID, { jobs, workflows }) : []
                if (active.length) return
                if (data.statuses.has(sessionID)) return
                yield* notification.notify({
                  sessionID,
                  notificationType: "idle_prompt",
                  message: "Session is awaiting your next prompt",
                })
              }),
            ),
            Effect.raceFirst(attention ? attention.activity(sessionID) : Effect.never),
            Effect.ensuring(Effect.sync(() => data.timers.delete(sessionID))),
            Effect.forkIn(data.scope),
          )
          data.timers.set(sessionID, fiber)
        }
        return
      }
      data.statuses.set(sessionID, status)
    })
    const settle = (sessionID: SessionID) =>
      clear(sessionID).pipe(
        Effect.andThen(events.publish(Event.Status, { sessionID, status: { type: "idle" } })),
        Effect.andThen(events.publish(Event.Idle, { sessionID })),
      )
    return Service.of({ get, list, set, clear, settle })
  }),
)
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Notification.defaultLayer),
    Layer.provide(BackgroundJob.defaultLayer),
    Layer.provide(SessionAttention.defaultLayer),
  ),
)
export const node = {
  ...LayerNode.make(layer, [EventV2Bridge.node]),
  get dependencies() {
    return [EventV2Bridge.node, Notification.node, BackgroundJob.node, SessionAttention.node]
  },
}
export * as SessionStatus from "./status"
