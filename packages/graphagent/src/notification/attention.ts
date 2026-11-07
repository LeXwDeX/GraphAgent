import { Clock, Context, Deferred, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"

export interface Update {
  clientID: string
  clientType?: "terminal" | "web"
  activity?: number
  backgroundView?: boolean
  closed?: boolean
}
interface Client {
  closed?: boolean
  clientType?: "terminal" | "web"
  generation: number
  expires: number
  backgroundView: boolean
}
interface Entry {
  clients: Map<string, Client>
  changed: Deferred.Deferred<void>
  terminalChanged: Deferred.Deferred<void>
}
export interface Interface {
  readonly input: (sessionID: string) => Effect.Effect<void>
  readonly update: (sessionID: string, input: Update) => Effect.Effect<void>
  readonly quiet: (sessionID: string, milliseconds: number) => Effect.Effect<void>
  readonly activity: (sessionID: string) => Effect.Effect<void>
  readonly viewing: (sessionID: string) => Effect.Effect<boolean>
  readonly clear: (sessionID: string) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAttention") {}
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() => Effect.succeed(new Map<string, Entry>()))
    const entry = Effect.fn("SessionAttention.entry")(function* (sessionID: string) {
      const entries = yield* InstanceState.get(state)
      const existing = entries.get(sessionID)
      if (existing) return existing
      const created: Entry = {
        clients: new Map(),
        changed: yield* Deferred.make<void>(),
        terminalChanged: yield* Deferred.make<void>(),
      }
      entries.set(sessionID, created)
      return created
    })
    const activity = (sessionID: string) =>
      entry(sessionID).pipe(Effect.flatMap((value) => Deferred.await(value.changed)))
    const input = Effect.fn("SessionAttention.input")(function* (sessionID: string) {
      const value = yield* entry(sessionID)
      const changed = value.changed
      value.changed = yield* Deferred.make<void>()
      yield* Deferred.succeed(changed, undefined)
    })
    const update = Effect.fn("SessionAttention.update")(function* (sessionID: string, input: Update) {
      const value = yield* entry(sessionID)
      const now = yield* Clock.currentTimeMillis
      for (const [id, client] of value.clients) if (client.expires <= now) value.clients.delete(id)
      const previous = value.clients.get(input.clientID)
      if (previous?.closed) return
      if (input.closed) {
        value.clients.set(input.clientID, {
          ...previous,
          generation: previous?.generation ?? -1,
          expires: now + 30_000,
          backgroundView: false,
          closed: true,
        })
        return
      }
      if (input.activity !== undefined && input.activity > (previous?.generation ?? -1)) {
        const changed = value.changed
        value.changed = yield* Deferred.make<void>()
        yield* Deferred.succeed(changed, undefined)
        if ((input.clientType ?? previous?.clientType) === "terminal") {
          const terminal = value.terminalChanged
          value.terminalChanged = yield* Deferred.make<void>()
          yield* Deferred.succeed(terminal, undefined)
        }
      }
      value.clients.set(input.clientID, {
        clientType: input.clientType ?? previous?.clientType,
        generation: Math.max(previous?.generation ?? -1, input.activity ?? -1),
        expires: now + 30_000,
        backgroundView: input.backgroundView ?? previous?.backgroundView ?? false,
      })
    })
    const quiet = Effect.fn("SessionAttention.quiet")(function* (sessionID: string, milliseconds: number) {
      while (true) {
        const settled = yield* Effect.raceFirst(
          Effect.sleep(milliseconds).pipe(Effect.as(true)),
          entry(sessionID).pipe(
            Effect.flatMap((value) => Deferred.await(value.terminalChanged)),
            Effect.as(false),
          ),
        )
        if (settled) return
      }
    })
    const viewing = Effect.fn("SessionAttention.viewing")(function* (sessionID: string) {
      const value = yield* entry(sessionID)
      const now = yield* Clock.currentTimeMillis
      for (const [id, client] of value.clients) if (client.expires <= now) value.clients.delete(id)
      return [...value.clients.values()].some((client) => client.backgroundView && client.clientType === "terminal")
    })
    const clear = Effect.fn("SessionAttention.clear")(function* (sessionID: string) {
      const entries = yield* InstanceState.get(state)
      const value = entries.get(sessionID)
      entries.delete(sessionID)
      if (value) {
        yield* Deferred.interrupt(value.changed)
        yield* Deferred.interrupt(value.terminalChanged)
      }
    })
    return Service.of({ input, update, quiet, activity, viewing, clear })
  }),
)
export const defaultLayer = layer
export const node = LayerNode.make(layer, [])
export * as SessionAttention from "./attention"
