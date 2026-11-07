import { Config, ConfigProvider, Context, Effect, Layer } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.Boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.Number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )

export class Service extends ConfigService.Service<Service>()("@opencode/RuntimeFlags", {
  disableDefaultPlugins: bool("GRAPHAGENT_DISABLE_DEFAULT_PLUGINS"),
  disableLspDownload: bool("GRAPHAGENT_DISABLE_LSP_DOWNLOAD"),
  enableExa: bool("GRAPHAGENT_ENABLE_EXA"),
  enableParallel: bool("GRAPHAGENT_ENABLE_PARALLEL"),
  enableExperimentalModels: bool("GRAPHAGENT_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("GRAPHAGENT_ENABLE_QUESTION_TOOL"),
  experimentalBackgroundSubagents: bool("GRAPHAGENT_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("GRAPHAGENT_LSP_TY"),
  experimentalLspTool: bool("GRAPHAGENT_LSP_TOOL"),
  experimentalOxfmt: bool("GRAPHAGENT_OXFMT"),
  experimentalPlanMode: bool("GRAPHAGENT_PLAN_MODE"),
  experimentalWorkspaces: bool("GRAPHAGENT_WORKSPACES"),
  experimentalIconDiscovery: bool("GRAPHAGENT_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("GRAPHAGENT_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("GRAPHAGENT_BASH_DEFAULT_TIMEOUT_MS"),
  bashSilenceWarnMs: positiveInteger("GRAPHAGENT_BASH_SILENCE_WARN_MS"),
  experimentalNativeLlm: bool("GRAPHAGENT_NATIVE_LLM"),
  experimentalWebSockets: bool("GRAPHAGENT_WEBSOCKETS"),
  client: Config.String("GRAPHAGENT_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export const node = LayerNode.make(defaultLayer, [])

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
