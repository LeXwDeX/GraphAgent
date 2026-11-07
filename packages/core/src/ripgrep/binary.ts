import { Context, Effect, Layer } from "effect"
import { LayerNode } from "../effect/layer-node"
import { RuntimeAsset } from "../runtime-asset"
import { RipgrepAsset } from "../runtime-asset/catalog/ripgrep"

export namespace RipgrepBinary {
  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@graphagent/RipgrepBinary") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const runtime = yield* RuntimeAsset.Service

      return Service.of({
        filepath: yield* Effect.cached(
          runtime
            .resolve(RipgrepAsset.descriptor)
            .pipe(
              Effect.flatMap((result) =>
                result._tag === "Available"
                  ? Effect.succeed(result.path)
                  : Effect.fail(new Error(`ripgrep is unavailable: ${result.reason}`)),
              ),
            ),
        ),
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(RuntimeAsset.defaultLayer))

  export const node = LayerNode.make(layer, [RuntimeAsset.node])
}
