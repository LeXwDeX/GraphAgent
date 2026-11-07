import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Effect, Layer, Context, Option } from "effect"
import { AzureAdapter } from "./azure"
import { CloudflareAIGatewayAdapter, CloudflareWorkersAdapter } from "./cloudflare"
import { CodexAdapter, experimentalWebSocketsEnabled } from "./codex"
import { CopilotAdapter } from "./copilot/copilot"
import { DigitalOceanAdapter } from "./digitalocean"
import { SnowflakeCortexAdapter } from "./snowflake-cortex"
import { XaiAdapter } from "./xai"
import type { AdapterContext, ChatInput, ChatParams, ProviderAdapter, ProviderAdapterFactory, AuthHook } from "./types"
import type { Provider } from "@/provider/provider"

export const BUILTIN: readonly ProviderAdapterFactory[] = [
  CodexAdapter,
  CopilotAdapter,
  CloudflareWorkersAdapter,
  CloudflareAIGatewayAdapter,
  AzureAdapter,
  DigitalOceanAdapter,
  SnowflakeCortexAdapter,
  XaiAdapter,
]

export interface Interface {
  readonly authHooks: () => Effect.Effect<Record<string, AuthHook>>
  readonly list: () => Effect.Effect<readonly ProviderAdapter[]>
  readonly smallModel: (input: { provider: Provider.Info }) => Effect.Effect<Provider.Model | undefined>
  readonly chatParams: (input: ChatInput, output: ChatParams) => Effect.Effect<ChatParams>
  readonly chatHeaders: (
    input: ChatInput,
    output: { headers: Record<string, string> },
  ) => Effect.Effect<Record<string, string>>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderAdapters") {}

export const loadAdapters = Effect.fn("ProviderAdapters.loadAdapters")(function* (
  factories: readonly ProviderAdapterFactory[],
  context: AdapterContext,
  disabled: boolean,
) {
  const adapters: ProviderAdapter[] = []
  if (disabled) return adapters
  for (const factory of factories) {
    const adapter = yield* Effect.tryPromise(() => Promise.resolve(factory(context))).pipe(
      Effect.tapError((error) => Effect.logError("failed to load provider adapter", { name: factory.name, error })),
      Effect.option,
    )
    if (adapter._tag === "Some") adapters.push(adapter.value)
  }
  return adapters
})

export const disposeAdapters = Effect.fn("ProviderAdapters.disposeAdapters")(function* (
  adapters: readonly ProviderAdapter[],
) {
  yield* Effect.forEach(
    adapters,
    (adapter) =>
      Effect.tryPromise(() => Promise.resolve(adapter.dispose?.())).pipe(
        Effect.tapError((error) => Effect.logError("provider adapter dispose hook failed", { id: adapter.id, error })),
        Effect.ignore,
      ),
    { discard: true },
  )
})

export const dispatchEvent = Effect.fn("ProviderAdapters.dispatchEvent")(function* (
  adapters: readonly ProviderAdapter[],
  event: { id: string; type: string; properties: unknown },
) {
  yield* Effect.forEach(
    adapters,
    (adapter) =>
      Effect.tryPromise(() => Promise.resolve(adapter.onEvent?.(event))).pipe(
        Effect.tapError((error) => Effect.logError("provider adapter event hook failed", { type: event.type, error })),
        Effect.ignore,
        Effect.forkDetach,
      ),
    { discard: true },
  )
})

export const eventMatchesDirectory = (event: { location?: { directory?: string } }, directory: string) =>
  event.location?.directory === directory

export const createRegistry = (adaptersEffect: Effect.Effect<readonly ProviderAdapter[]>): Interface => {
  const list = Effect.fn("ProviderAdapters.list")(function* () {
    return yield* adaptersEffect
  })

  const authHooks = Effect.fn("ProviderAdapters.authHooks")(function* () {
    const result: Record<string, AuthHook> = {}
    for (const adapter of yield* adaptersEffect) {
      if (adapter.auth) result[adapter.auth.provider] = adapter.auth
    }
    return result
  })

  const smallModel = Effect.fn("ProviderAdapters.smallModel")(function* (input: { provider: Provider.Info }) {
    let result: Provider.Model | undefined
    for (const adapter of yield* adaptersEffect) {
      if (adapter.smallModel) result = yield* Effect.promise(() => Promise.resolve(adapter.smallModel!({ provider: input.provider })))
    }
    return result
  })

  const chatParams = Effect.fn("ProviderAdapters.chatParams")(function* (input: ChatInput, output: ChatParams) {
    for (const adapter of yield* adaptersEffect) {
      if (adapter.chatParams) yield* Effect.promise(() => Promise.resolve(adapter.chatParams!(input, output)))
    }
    return output
  })

  const chatHeaders = Effect.fn("ProviderAdapters.chatHeaders")(function* (
    input: ChatInput,
    output: { headers: Record<string, string> },
  ) {
    for (const adapter of yield* adaptersEffect) {
      if (adapter.chatHeaders) yield* Effect.promise(() => Promise.resolve(adapter.chatHeaders!(input, output)))
    }
    return output.headers
  })

  return { authHooks, list, smallModel, chatParams, chatHeaders, init: () => Effect.asVoid(adaptersEffect) }
}

export const layer: Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | RuntimeFlags.Service | EventV2Bridge.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const session = yield* Effect.serviceOption(Session.Service)
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make<readonly ProviderAdapter[]>(
      Effect.fn("ProviderAdapters.state")(function* (ctx) {
        const bridge = yield* EffectBridge.make()
        const cfg = yield* config.get()
        const adapterContext: AdapterContext = {
          directory: ctx.directory,
          worktree: ctx.worktree,
          project: ctx.project,
          experimentalWebSockets: experimentalWebSocketsEnabled({
            enabled: flags.experimentalWebSockets,
            configured: cfg.provider?.openai?.options?.experimentalWebSockets,
          }),
          auth: {
            set: (providerID, info) => bridge.promise(auth.set(providerID, info)),
          },
          sessions: {
            get: (sessionID) =>
              session._tag === "None"
                ? Promise.resolve(undefined)
                : bridge.promise(session.value.get(SessionID.make(sessionID))).catch(() => undefined),
            message: (sessionID, messageID) =>
              session._tag === "None"
                ? Promise.resolve(undefined)
                : bridge
                    .promise(
                      session.value
                        .findMessage(SessionID.make(sessionID), (message) => message.info.id === messageID)
                        .pipe(Effect.map(Option.getOrUndefined)),
                    )
                    .then((message) => (message ? { parts: message.parts } : undefined))
                    .catch(() => undefined),
          },
        }

        const adapters = yield* loadAdapters(BUILTIN, adapterContext, flags.disableDefaultPlugins)
        if (flags.disableDefaultPlugins) return adapters

        const unsubscribe = yield* events.listen((event) => {
          if (!eventMatchesDirectory(event, ctx.directory)) return Effect.void
          return dispatchEvent(adapters, { id: event.id, type: event.type, properties: event.data })
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        yield* Effect.addFinalizer(() => disposeAdapters(adapters))
        return adapters
      }),
    )

    return Service.of(createRegistry(InstanceState.get(state)))
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

export const emptyLayer = Layer.succeed(Service, {
  authHooks: () => Effect.succeed({}),
  list: () => Effect.succeed([]),
  smallModel: () => Effect.succeed(undefined),
  chatParams: (_input, output) => Effect.succeed(output),
  chatHeaders: (_input, output) => Effect.succeed(output.headers),
  init: () => Effect.void,
})

export const node = LayerNode.make(layer, [
  Auth.node,
  Config.node,
  RuntimeFlags.node,
  EventV2Bridge.node,
])

export * as ProviderAdapters from "./registry"
