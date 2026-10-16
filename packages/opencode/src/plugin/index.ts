import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { snapshotAgentHooks, recordPluginAgentHooks } from "@/config/agent-hooks"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ServerAuth } from "@/server/auth"
import { CodexAuthPlugin } from "./openai/codex"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { AzureAuthPlugin } from "./azure"
import { DigitalOceanAuthPlugin } from "./digitalocean"
import { XaiAuthPlugin } from "./xai"
import { SnowflakeCortexAuthPlugin } from "./snowflake-cortex"
import { Effect, Layer, Context } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstallationChannel } from "@opencode-ai/core/installation/version"

export const KNOWN_EXTERNAL_DCP_PACKAGE = "@lexwdex-org/opencode-dcp"

type State = {
  hooks: Hooks[]
  knownExternalDcp:
    | Readonly<{
        packageName: typeof KNOWN_EXTERNAL_DCP_PACKAGE
        source: PluginLoader.Loaded["source"]
      }>
    | undefined
  externalDcpMigrationNotified: boolean
}

export type ContextFoldingCompatibility = Readonly<{
  knownExternalDcp: "unknown" | "loaded"
  migrationNotice: "not-applicable" | "notified" | "already-notified"
}>

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly contextFoldingCompatibility: () => Effect.Effect<ContextFoldingCompatibility>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

export function experimentalWebSocketsEnabled(input: { enabled: boolean; channel?: string; configured?: boolean }) {
  return input.configured ?? (input.enabled || ["local", "dev", "beta"].includes(input.channel ?? InstallationChannel))
}

// Built-in plugins that are directly imported (not installed from npm)
function internalPlugins(flags: RuntimeFlags.Info, experimentalWebSockets?: boolean): PluginInstance[] {
  return [
    // Temporary rollout: pre-release builds use WebSockets by default; releases require explicit opt-in.
    (input) =>
      CodexAuthPlugin(input, {
        experimentalWebSockets: experimentalWebSocketsEnabled({
          enabled: flags.experimentalWebSockets,
          configured: experimentalWebSockets,
        }),
      }),
    CopilotAuthPlugin,
    GitlabAuthPlugin,
    PoeAuthPlugin,
    CloudflareWorkersAuthPlugin,
    CloudflareAIGatewayAuthPlugin,
    AzureAuthPlugin,
    DigitalOceanAuthPlugin,
    SnowflakeCortexAuthPlugin,
    XaiAuthPlugin,
  ]
}

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }

  return result
}

async function applyPlugin(load: PluginLoader.Loaded, input: PluginInput, hooks: Hooks[]) {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    hooks.push(await (plugin as PluginModule).server(input, load.options))
    return
  }

  for (const server of getLegacyPlugins(load.mod)) {
    hooks.push(await server(input, load.options))
  }
}

function knownExternalDcp(load: PluginLoader.Loaded): State["knownExternalDcp"] {
  if (load.source === "npm" && parsePluginSpecifier(load.spec).pkg === KNOWN_EXTERNAL_DCP_PACKAGE) {
    return { packageName: KNOWN_EXTERNAL_DCP_PACKAGE, source: load.source }
  }
  const name = load.pkg?.json.name
  if (load.source === "file" && typeof name === "string" && name.trim() === KNOWN_EXTERNAL_DCP_PACKAGE) {
    return { packageName: KNOWN_EXTERNAL_DCP_PACKAGE, source: load.source }
  }
}

function hasContextFoldingHook(hook: Hooks) {
  return (
    typeof hook["experimental.chat.messages.transform"] === "function" ||
    typeof hook["experimental.session.compacting"] === "function"
  )
}

function activeKnownExternalDcp(
  load: PluginLoader.Loaded,
  registeredHooks: readonly Hooks[],
): State["knownExternalDcp"] {
  if (!registeredHooks.some(hasContextFoldingHook)) return
  return knownExternalDcp(load)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: Hooks[] = []
        let knownExternalDcpDescriptor: State["knownExternalDcp"]
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const serverUrl = Server.url
        const client = createOpencodeClient({
          baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
          directory: ctx.directory,
          headers: ServerAuth.headers(),
          ...(serverUrl ? {} : { fetch: async (...args) => Server.Default().app.fetch(...args) }),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, adapter as WorkspaceAdapter)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        for (const plugin of flags.disableDefaultPlugins
          ? []
          : internalPlugins(flags, cfg.provider?.openai?.options?.experimentalWebSockets)) {
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load internal plugin", { name: plugin.name, error })),
            Effect.option,
          )
          if (init._tag === "Some") hooks.push(init.value)
        }

        const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])
        if (flags.pure && cfg.plugin_origins?.length) {
        }
        if (plugins.length) yield* config.waitForDependencies()

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {},
              missing(candidate, _retry, message) {},
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        const hookOwners = new WeakMap<object, string>()
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          const hookStart = hooks.length
          yield* Effect.tryPromise({
            try: () => applyPlugin(load, input, hooks),
            catch: (err) => {
              const message = errorMessage(err)
              return message
            },
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load plugin", { path: load.spec, error })),
            Effect.option,
          )
          // Derive compatibility from hooks that actually remain registered. An
          // empty successful return means DCP is disabled; a retained hook from a
          // partially failed legacy module is still active and must stay exclusive.
          for (const hook of hooks.slice(hookStart)) hookOwners.set(hook, load.spec)
          knownExternalDcpDescriptor ??= activeKnownExternalDcp(load, hooks.slice(hookStart))
        }

        // Notify plugins of current config
        for (const hook of hooks) {
          const beforeAgentHooks = snapshotAgentHooks(cfg)
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("plugin config hook failed", { error })),
            Effect.ignore,
          )
          const owner = hookOwners.get(hook)
          if (owner) recordPluginAgentHooks(cfg, beforeAgentHooks, owner)
        }

        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          // Fire-and-forget by design (bus delivery must not block on plugin
          // hooks), but rejections have to be observed: a bare `void promise`
          // produces unhandledRejection — crashing headless runs and leaving
          // only a log line in TUI worker runs.
          return Effect.forEach(
            hooks,
            (hook) =>
              Effect.tryPromise({
                try: () =>
                  Promise.resolve(
                    hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } as any }),
                  ),
                catch: errorMessage,
              }).pipe(
                Effect.tapError((error) => Effect.logError("plugin event hook failed", { type: event.type, error })),
                Effect.ignore,
                Effect.forkDetach,
              ),
            { discard: true },
          )
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            hooks,
            (hook) =>
              Effect.tryPromise({
                try: () => Promise.resolve(hook.dispose?.()),
                catch: errorMessage,
              }).pipe(
                Effect.tapError((error) => Effect.logError("plugin dispose hook failed", { error })),
                Effect.ignore,
              ),
            { discard: true },
          ),
        )

        return { hooks, knownExternalDcp: knownExternalDcpDescriptor, externalDcpMigrationNotified: false }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      for (const hook of s.hooks) {
        const fn = hook[name] as any
        if (!fn) continue
        yield* Effect.promise(async () => fn(input, output))
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const contextFoldingCompatibility = Effect.fn("Plugin.contextFoldingCompatibility")(function* () {
      const s = yield* InstanceState.get(state)
      if (!s.knownExternalDcp) {
        return {
          knownExternalDcp: "unknown",
          migrationNotice: "not-applicable",
        } as const
      }
      if (s.externalDcpMigrationNotified) {
        return {
          knownExternalDcp: "loaded",
          migrationNotice: "already-notified",
        } as const
      }

      // Set the lifecycle guard before yielding so concurrent first requests cannot emit duplicate notices.
      s.externalDcpMigrationNotified = true
      yield* Effect.logWarning(
        `Known external context-pruning plugin ${s.knownExternalDcp.packageName} registered active context-folding hooks; built-in dynamic context folding is disabled. Remove or disable the external plugin and restart this instance to use the built-in capability.`,
        {
          compatibility: "external-dcp-active",
          source: s.knownExternalDcp.source,
          migration: "remove-or-disable-plugin-and-restart",
        },
      )
      return {
        knownExternalDcp: "loaded",
        migrationNotice: "notified",
      } as const
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ trigger, list, contextFoldingCompatibility, init })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, Config.node, RuntimeFlags.node])

export * as Plugin from "."
