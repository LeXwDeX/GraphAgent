// Opencode publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Cause, Context, Effect, Layer, Stream } from "effect"

export class Service extends Context.Service<Service, EventV2.Interface>()("@opencode/EventV2Bridge") {}

function projectIDFromLocation(location: Location.Ref | undefined) {
  if (!location || !("project" in location)) return undefined
  const project = location.project
  if (!project || typeof project !== "object" || !("id" in project) || typeof project.id !== "string") {
    return undefined
  }
  return project.id
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      Effect.gen(function* () {
        if (options?.location) return yield* events.publish(definition, data, options)
        const ctx = yield* InstanceRef
        if (!ctx) return yield* events.publish(definition, data, options)
        const workspaceID = yield* WorkspaceRef
        return yield* events.publish(definition, data, {
          ...options,
          location: new Location.Info({
            directory: AbsolutePath.make(ctx.directory),
            ...(workspaceID ? { workspaceID } : {}),
            project: { id: Project.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
          }),
        })
      })

    const publishMany: EventV2.Interface["publishMany"] = (entries, options) =>
      Effect.gen(function* () {
        if (options?.location) return yield* events.publishMany(entries, options)
        const ctx = yield* InstanceRef
        if (!ctx) return yield* events.publishMany(entries, options)
        const workspaceID = yield* WorkspaceRef
        return yield* events.publishMany(entries, {
          ...options,
          location: new Location.Info({
            directory: AbsolutePath.make(ctx.directory),
            ...(workspaceID ? { workspaceID } : {}),
            project: { id: Project.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
          }),
        })
      })

    const forward = Effect.fnUntraced(
      function* (event: EventV2.Payload) {
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        const projectID = ctx?.project.id ?? projectIDFromLocation(event.location)
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: projectID,
          workspace: workspaceID,
          payload: { id: event.id, type: event.type, properties: event.data },
        })
        if (event.durable === undefined) return
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: projectID,
          workspace: workspaceID,
          payload: {
            type: "sync",
            syncEvent: {
              id: event.id,
              type: EventV2.versionedType(event.type, event.durable.version),
              seq: event.durable.seq,
              aggregateID: event.durable.aggregateID,
              data: event.data,
            },
          },
        })
      },
      (effect, event) =>
        Effect.catchCauseIf(
          effect,
          (cause) => !Cause.hasInterrupts(cause),
          (cause) => Effect.logError("EventV2 bridge forwarding failed", { eventID: event.id, cause }),
        ),
    )

    // startImmediately runs the stream through its PubSub subscription before
    // the layer is acquired, so the first publish cannot race bridge startup.
    yield* events.all().pipe(Stream.runForEach(forward), Effect.forkScoped({ startImmediately: true }))

    return Service.of({ ...events, publish, publishMany })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer))

export const node = LayerNode.make(layer, [EventV2.node])

export * as EventV2Bridge from "./event-v2-bridge"
