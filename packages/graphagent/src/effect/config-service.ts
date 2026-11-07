import { Config, Context, Effect, Layer } from "effect"

type ConfigMap = Record<string, Config.Config<unknown>>

/**
 * The service shape inferred from an object of Effect `Config` definitions.
 */
export type Shape<Fields extends ConfigMap> = {
  readonly [Key in keyof Fields]: Config.Success<Fields[Key]>
}

/**
 * A Context service class with generated layers for config-backed services.
 */
export type ServiceClass<Self, Id extends string, Service> = Context.ServiceClass<Self, Id, Service> & {
  /** Provide already-parsed config, useful in tests. */
  readonly layer: (input: Service) => Layer.Layer<Self>
  /** Parse config once from the active Effect ConfigProvider and provide the service. */
  readonly defaultLayer: Layer.Layer<Self, Config.ConfigError>
}

/**
 * Create a Context service whose implementation is derived from Effect `Config`.
 *
 * This keeps Effect `Config` as the source of truth for env names, defaults, and
 * validation while generating a typed service plus convenient production/test
 * layers.
 *
 * ```ts
 * class ExampleConfig extends ConfigService.Service<ExampleConfig>()(
 *   "@opencode/ExampleConfig",
 *   {
 *     endpoint: Config.String("GRAPHAGENT_EXAMPLE_ENDPOINT").pipe(Config.option),
 *     retries: Config.int("GRAPHAGENT_EXAMPLE_RETRIES").pipe(Config.withDefault(3)),
 *   },
 * ) {}
 *
 * const live = ExampleConfig.defaultLayer
 * const test = ExampleConfig.layer({ endpoint: Option.some("https://example.com"), retries: 1 })
 * ```
 */
export const Service =
  <Self>() =>
  <const Id extends string, const Fields extends ConfigMap>(id: Id, fields: Fields) => {
    class ConfigTag extends Context.Service<Self, Shape<Fields>>()(id) {
      static layer(input: Shape<Fields>) {
        return Layer.succeed(this, this.of(input))
      }

      static get defaultLayer() {
        const tag = this
        return Layer.effect(
          tag,
          Effect.gen(function* () {
            const config = yield* Config.all(fields)
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Config.all preserves the field shape, but its conditional return type also supports iterable inputs.
            return tag.of(config as Shape<Fields>)
          }),
        )
      }
    }

    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The generated class carries typed static helpers.
    return ConfigTag as ServiceClass<Self, Id, Shape<Fields>>
  }

export * as ConfigService from "./config-service"
