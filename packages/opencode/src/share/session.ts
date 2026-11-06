import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Effect, Layer, Context } from "effect"
import { Config } from "@/config/config"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ShareNext } from "./share-next"

export interface Interface {
  readonly share: (sessionID: SessionID) => Effect.Effect<{ url: string }, unknown>
  readonly unshare: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionShare") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const session = yield* Session.Service
    const shareNext = yield* ShareNext.Service

    const share = Effect.fn("SessionShare.share")(function* (sessionID: SessionID) {
      const conf = yield* cfg.get()
      if (conf.share === "disabled") throw new Error("Sharing is disabled in configuration")
      const result = yield* shareNext.create(sessionID)
      yield* session.setShare({ sessionID, share: { url: result.url } })
      return result
    })

    const unshare = Effect.fn("SessionShare.unshare")(function* (sessionID: SessionID) {
      yield* shareNext.remove(sessionID)
      yield* session.setShare({ sessionID, share: undefined })
    })

    return Service.of({ share, unshare })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(ShareNext.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export const node = LayerNode.make(layer, [Config.node, Session.node, ShareNext.node])

export * as SessionShare from "./session"
