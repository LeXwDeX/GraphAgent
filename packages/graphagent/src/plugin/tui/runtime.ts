import { runtimeModules as keymapRuntimeModules } from "@opentui/keymap/runtime-modules"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import {
  type TuiDispose,
  type TuiPlugin,
  type TuiPluginApi,
  type TuiPluginModule,
  type TuiPluginMeta,
  type TuiSlotPlugin,
} from "@graphagent/tui/plugin-api"
import { TuiConfig } from "@/config/tui"
import { errorData, errorMessage } from "@graphagent/tui/util/error"
import { resolveHostAttentionSoundPaths } from "@/config/tui-host-attention"
import { internalTuiPlugins, type InternalTuiPlugin } from "./internal"
import type { HostPluginApi, HostSlots } from "@graphagent/tui/plugin/slots"
import { createCommandShim } from "@graphagent/tui/plugin/command-shim"
import { createPluginRuntime, type PluginRuntime, type TuiPluginHost } from "@graphagent/tui/plugin/runtime"

ensureRuntimePluginSupport({ additional: keymapRuntimeModules })

type PluginLoad = {
  options: Record<string, unknown> | undefined
  spec: string
  source: "internal"
  id: string
  module: TuiPluginModule
  plugin_root: string
}

type Api = HostPluginApi

type PluginScope = {
  lifecycle: TuiPluginApi["lifecycle"]
  track: (fn: (() => void) | undefined) => () => void
  dispose: () => Promise<void>
}

type PluginEntry = {
  id: string
  load: PluginLoad
  meta: TuiPluginMeta
  plugin: TuiPlugin
  scope?: PluginScope
}

const ScopedKeymapMethods = new Set<PropertyKey>([
  "acquireResource",
  "registerLayer",
  "registerLayerFields",
  "prependLayerBindingsTransformer",
  "appendLayerBindingsTransformer",
  "prependBindingTransformer",
  "appendBindingTransformer",
  "prependBindingParser",
  "appendBindingParser",
  "registerToken",
  "registerSequencePattern",
  "prependBindingExpander",
  "appendBindingExpander",
  "registerBindingFields",
  "registerCommandFields",
  "prependCommandTransformer",
  "appendCommandTransformer",
  "prependCommandResolver",
  "appendCommandResolver",
  "prependLayerAnalyzer",
  "appendLayerAnalyzer",
  "intercept",
  "on",
  "prependEventMatchResolver",
  "appendEventMatchResolver",
  "prependDisambiguationResolver",
  "appendDisambiguationResolver",
])

type RuntimeState = {
  directory: string
  api: Api
  view: PluginRuntime
  dispose?: () => void
  slots: HostSlots
  plugins: PluginEntry[]
  plugins_by_id: Map<string, PluginEntry>
  dispose_timeout_ms: number
}

const DISPOSE_TIMEOUT_MS = 5000

function fail(message: string, data: Record<string, unknown>) {
  if (!("error" in data)) {
    console.error(`[tui.plugin] ${message}`, data)
    return
  }

  const text = `${message}: ${errorMessage(data.error)}`
  const next = { ...data, error: errorData(data.error) }
  console.error(`[tui.plugin] ${text}`, next)
}

function createScopedKeymap(keymap: TuiPluginApi["keymap"], scope: PluginScope): TuiPluginApi["keymap"] {
  const cache = new Map<PropertyKey, unknown>()
  return new Proxy(keymap, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== "function") return value
      if (cache.has(prop)) return cache.get(prop)
      const fn = ScopedKeymapMethods.has(prop)
        ? (...args: unknown[]) => {
            const dispose = (value as (...args: unknown[]) => unknown).apply(target, args)
            return scope.track(typeof dispose === "function" ? (dispose as () => void) : undefined)
          }
        : (...args: unknown[]) => (value as (...args: unknown[]) => unknown).apply(target, args)
      cache.set(prop, fn)
      return fn
    },
  })
}

function createScopedAttention(
  attention: TuiPluginApi["attention"],
  scope: PluginScope,
  root: string,
): TuiPluginApi["attention"] {
  return {
    notify(input) {
      return attention.notify(input)
    },
    soundboard: {
      registerPack(pack) {
        return scope.track(
          attention.soundboard.registerPack({
            ...pack,
            sounds: resolveHostAttentionSoundPaths(root, pack.sounds, { trim: true }),
          }),
        )
      },
      activate(id, options) {
        return attention.soundboard.activate(id, options)
      },
      current() {
        return attention.soundboard.current()
      },
      list() {
        return attention.soundboard.list()
      },
    },
  }
}

function createScopedMode(mode: TuiPluginApi["mode"], scope: PluginScope): TuiPluginApi["mode"] {
  return {
    current() {
      return mode.current()
    },
    push(value) {
      return scope.track(mode.push(value))
    },
  }
}

type CleanupResult = { type: "ok" } | { type: "error"; error: unknown } | { type: "timeout" }

function runCleanup(fn: () => unknown, ms: number): Promise<CleanupResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ type: "timeout" })
    }, ms)

    Promise.resolve()
      .then(fn)
      .then(
        () => {
          resolve({ type: "ok" })
        },
        (error) => {
          resolve({ type: "error", error })
        },
      )
      .finally(() => {
        clearTimeout(timer)
      })
  })
}

function createMeta(load: PluginLoad): TuiPluginMeta {
  const now = Date.now()
  return {
    state: "same",
    id: load.id,
    source: load.source,
    spec: load.spec,
    target: load.spec,
    first_time: now,
    last_time: now,
    time_changed: now,
    load_count: 1,
    fingerprint: load.spec,
  }
}

function loadInternalPlugin(item: InternalTuiPlugin): PluginLoad {
  return {
    options: undefined,
    spec: item.id,
    source: "internal",
    id: item.id,
    module: item,
    plugin_root: process.cwd(),
  }
}

function createPluginScope(load: PluginLoad, id: string, disposeTimeoutMs: number) {
  const ctrl = new AbortController()
  let list: { key: symbol; fn: TuiDispose }[] = []
  let done = false

  const onDispose = (fn: TuiDispose) => {
    if (done) return () => {}
    const key = Symbol()
    list.push({ key, fn })
    let drop = false
    return () => {
      if (drop) return
      drop = true
      list = list.filter((x) => x.key !== key)
    }
  }

  const track = (fn: (() => void) | undefined) => {
    if (!fn) return () => {}
    let drop = false
    let off = () => {}
    const wrapped = () => {
      if (drop) return
      drop = true
      off()
      fn()
    }
    off = onDispose(wrapped)
    return wrapped
  }

  const lifecycle: TuiPluginApi["lifecycle"] = {
    signal: ctrl.signal,
    onDispose,
  }

  const dispose = async () => {
    if (done) return
    done = true
    ctrl.abort()
    const queue = [...list].reverse()
    list = []
    const until = Date.now() + disposeTimeoutMs
    for (const item of queue) {
      const left = until - Date.now()
      if (left <= 0) {
        fail("timed out cleaning up tui plugin", {
          path: load.spec,
          id,
          timeout: disposeTimeoutMs,
        })
        break
      }

      const out = await runCleanup(item.fn, left)
      if (out.type === "ok") continue
      if (out.type === "timeout") {
        fail("timed out cleaning up tui plugin", {
          path: load.spec,
          id,
          timeout: disposeTimeoutMs,
        })
        break
      }

      if (out.type === "error") {
        fail("failed to clean up tui plugin", {
          path: load.spec,
          id,
          error: out.error,
        })
      }
    }
  }

  return {
    lifecycle,
    track,
    dispose,
  }
}

async function deactivatePluginEntry(plugin: PluginEntry) {
  if (!plugin.scope) return
  const scope = plugin.scope
  plugin.scope = undefined
  await scope.dispose()
}

async function activatePluginEntry(state: RuntimeState, plugin: PluginEntry) {
  if (plugin.scope) return true

  const scope = createPluginScope(plugin.load, plugin.id, state.dispose_timeout_ms)
  const api = pluginApi(state, plugin, scope, plugin.id)
  const ok = await Promise.resolve()
    .then(async () => {
      await plugin.plugin(api, plugin.load.options, plugin.meta)
      return true
    })
    .catch((error) => {
      fail("failed to initialize tui plugin", {
        path: plugin.load.spec,
        id: plugin.id,
        error,
      })
      return false
    })

  if (!ok) {
    await scope.dispose()
    return false
  }

  plugin.scope = scope
  return true
}

function pluginApi(runtime: RuntimeState, plugin: PluginEntry, scope: PluginScope, base: string): TuiPluginApi {
  const api = runtime.api
  const host = runtime.slots
  const load = plugin.load

  const route: TuiPluginApi["route"] = {
    register(list) {
      return scope.track(api.route.register(list))
    },
    navigate(name, params) {
      api.route.navigate(name, params)
    },
    get current() {
      return api.route.current
    },
  }

  const event: TuiPluginApi["event"] = {
    on(type, handler) {
      return scope.track(api.event.on(type, handler))
    },
  }

  const keymap = createScopedKeymap(api.keymap, scope)

  let count = 0

  const slots: TuiPluginApi["slots"] = {
    register(plugin: TuiSlotPlugin) {
      const id = count ? `${base}:${count}` : base
      count += 1
      scope.track(host.register({ ...plugin, id }))
      return id
    },
  }

  return {
    app: api.app,
    attention: createScopedAttention(api.attention, scope, load.plugin_root),
    // Keep deprecated `api.command` working for v1 plugins; remove in v2.
    command: createCommandShim(keymap, api.ui.dialog, api.tuiConfig.keybinds),
    keys: api.keys,
    keymap,
    mode: createScopedMode(api.mode, scope),
    route,
    ui: api.ui,
    tuiConfig: api.tuiConfig,
    kv: api.kv,
    state: api.state,
    theme: api.theme,
    get client() {
      return api.client
    },
    event,
    renderer: api.renderer,
    slots,
    lifecycle: scope.lifecycle,
  }
}

function addPluginEntry(state: RuntimeState, plugin: PluginEntry) {
  if (state.plugins_by_id.has(plugin.id)) {
    fail("duplicate tui plugin id", {
      id: plugin.id,
      path: plugin.load.spec,
    })
    return false
  }

  state.plugins_by_id.set(plugin.id, plugin)
  state.plugins.push(plugin)
  return true
}

let dir = ""
let loaded: Promise<void> | undefined
let runtime: RuntimeState | undefined

export async function init(input: {
  api: HostPluginApi
  config: TuiConfig.Resolved
  runtime?: PluginRuntime
  dispose?: () => void
  disposeTimeoutMs?: number
}) {
  const cwd = process.cwd()
  if (loaded) {
    if (dir !== cwd) {
      throw new Error(`TuiPluginRuntime.init() called with a different working directory. expected=${dir} got=${cwd}`)
    }
    return loaded
  }

  dir = cwd
  loaded = load({ ...input, runtime: input.runtime ?? createPluginRuntime() })
  return loaded
}

export async function dispose() {
  const task = loaded
  loaded = undefined
  dir = ""
  if (task) await task.catch((error) => fail("failed to finish loading tui plugins during disposal", { error }))
  const state = runtime
  runtime = undefined
  if (!state) return
  const queue = [...state.plugins].reverse()
  for (const plugin of queue) {
    await deactivatePluginEntry(plugin).catch((error) => fail("failed to dispose tui plugin", { id: plugin.id, error }))
  }
  try {
    state.dispose?.()
  } finally {
    state.slots.dispose()
    state.view.clear()
  }
}

async function load(input: {
  api: Api
  config: TuiConfig.Resolved
  runtime: PluginRuntime
  dispose?: () => void
  disposeTimeoutMs?: number
}) {
  const { api } = input
  const cwd = process.cwd()
  const slots = input.runtime.setupSlots(api)
  const next: RuntimeState = {
    directory: cwd,
    api,
    view: input.runtime,
    dispose: input.dispose,
    slots,
    plugins: [],
    plugins_by_id: new Map(),
    dispose_timeout_ms: input.disposeTimeoutMs ?? DISPOSE_TIMEOUT_MS,
  }
  runtime = next
  try {
    for (const item of internalTuiPlugins()) {
      const entry = loadInternalPlugin(item)
      addPluginEntry(next, {
        id: entry.id,
        load: entry,
        meta: createMeta(entry),
        plugin: entry.module.tui,
      })
    }

    for (const plugin of next.plugins) {
      // Keep plugin execution sequential for deterministic side effects:
      // command registration order affects keybind/command precedence,
      // route registration is last-wins when ids collide,
      // and hook chains rely on stable plugin ordering.
      await activatePluginEntry(next, plugin)
    }
  } catch (error) {
    fail("failed to load tui plugins", { directory: cwd, error })
  }
}

export function createBuiltinTuiHost(): TuiPluginHost {
  return {
    start: init,
    dispose,
  }
}

export * as TuiPluginRuntime from "./runtime"
