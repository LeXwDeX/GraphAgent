import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/layer-node-platform"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@opencode-ai/core/global"
import fsNode from "fs/promises"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Auth } from "../auth"
import { applyEdits, modify } from "jsonc-parser"
import { existsSync } from "fs"
import { isRecord } from "@/util/record"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { RemoteAuthError } from "@opencode-ai/core/v1/config/error"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { ConfigAgent } from "./agent"
import { setAgentHookOrigins, type AgentHookProvenance } from "./agent-hooks"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { HookConfigChange } from "@/hook/config-change"
import { HookPermissions } from "./permissions"
import type { PermissionUpdate } from "@/hook/trigger-result"
import { ConfigPaths } from "./paths"
import { RemoteLkg } from "./remote-lkg"
import { ConfigVariable } from "./variable"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { CONFIG_BASENAME, PROJECT_DIR } from "@opencode-ai/core/brand"

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  const merged = mergeDeep(target, source) as Info
  if (target.permissions !== undefined || source.permissions !== undefined || target.permission || source.permission)
    merged.permissions = [...HookPermissions.orderedRules(target), ...HookPermissions.orderedRules(source)]
  return merged
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

type Info = ConfigV1.Info

type State = {
  config: Info
  directories: string[]
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly updateHookPermissions: (
    updates: readonly PermissionUpdate[],
  ) => Effect.Effect<Info, HookConfigChange.ConfigChangeBlocked>
  readonly update: (config: Info) => Effect.Effect<void, HookConfigChange.ConfigChangeBlocked>
  readonly updateGlobal: (
    config: Info,
  ) => Effect.Effect<{ info: Info; changed: boolean }, HookConfigChange.ConfigChangeBlocked>
  readonly invalidate: () => Effect.Effect<void, HookConfigChange.ConfigChangeBlocked>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

export const use = serviceUse(Service)

function globalConfigFile() {
  const candidates = [`${CONFIG_BASENAME}.jsonc`, `${CONFIG_BASENAME}.json`, "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  return info
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const http = yield* HttpClient.HttpClient

    const configChanges = yield* HookConfigChange.Service
    const checkConfigChange = Effect.fn("Config.checkChange")(function* (
      file: string,
      source: HookConfigChange.Change["source"],
    ) {
      const decision = yield* configChanges.check({ path: file, source })
      if (decision.blocked) yield* new HookConfigChange.ConfigChangeBlocked({ message: decision.blocked.reason })
    })

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const readRemoteLkg = Effect.fnUntraced(function* <S extends Schema.Decoder<unknown, never>>(
      url: string,
      schema: S,
      role: RemoteLkg.Role,
    ) {
      const cached = yield* RemoteLkg.read({ url, role })
      if (cached.status !== "available") return undefined
      const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(cached.body)
      if (Option.isNone(parsed)) {
        yield* Effect.logWarning("remote config LKG unavailable", {
          digest: cached.digest,
          role,
          reason: "invalid-json",
        })
        return undefined
      }
      const data = Schema.decodeUnknownOption(schema)(parsed.value)
      if (Option.isNone(data)) {
        yield* Effect.logWarning("remote config LKG unavailable", {
          digest: cached.digest,
          role,
          reason: "schema-decode",
        })
        return undefined
      }
      yield* Effect.logInfo("using remote config LKG", {
        digest: cached.digest,
        role,
        ageSeconds: cached.ageSeconds,
      })
      return { data: data.value, source: "lkg" as const }
    })

    const fallbackRemoteJson = Effect.fnUntraced(function* <S extends Schema.Decoder<unknown, never>>(
      url: string,
      schema: S,
      role: RemoteLkg.Role,
      reason: "transport" | "http-status" | "body-read" | "json-syntax",
      status?: number,
    ) {
      yield* Effect.logWarning(
        reason === "body-read" || reason === "json-syntax"
          ? "failed to read remote config, skipping source"
          : "failed to fetch remote config, skipping source",
        { digest: RemoteLkg.digest(url), role, reason, status },
      )
      return yield* readRemoteLkg(url, schema, role)
    })

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Decoder<unknown, never>>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
      role: RemoteLkg.Role,
    ) {
      const response = yield* withTransientReadRetry(http)
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (response === undefined) return yield* fallbackRemoteJson(url, schema, role, "transport")
      if (response.status === 401 || response.status === 403) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* fallbackRemoteJson(url, schema, role, "http-status", response.status)
      }
      const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (body === undefined) return yield* fallbackRemoteJson(url, schema, role, "body-read")
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(body)
      if (Option.isNone(parsed)) return yield* fallbackRemoteJson(url, schema, role, "json-syntax")
      const data = yield* Schema.decodeUnknownEffect(schema)(parsed.value).pipe(
        Effect.catch(() =>
          Effect.die(new Error(`failed to decode remote config (${RemoteLkg.digest(url)}): schema-decode`)),
        ),
      )
      return { data, source: "online" as const, body }
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env }
            : { text, type: "virtual", ...options, env },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(parsed), source)
      if (!("path" in options)) return data

      if (!data.$schema) {
        data.$schema = "https://opencode.ai/config.json"
        const updated = text.replace(/^\s*\{/, '{\n  "$schema": "https://opencode.ai/config.json",')
        yield* fs.writeFileString(options.path, updated).pipe(Effect.catch(() => Effect.void))
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.GRAPHAGENT_CONFIG && !Flag.GRAPHAGENT_CONFIG_DIR && !Flag.GRAPHAGENT_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* fs
            .writeWithDirs(file, JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2))
            .pipe(Effect.catch(() => Effect.void))
        }
      }
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, `${CONFIG_BASENAME}.json`), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, `${CONFIG_BASENAME}.jsonc`), env))

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              result["$schema"] = "https://opencode.ai/config.json"
              result = mergeConfig(result, rest)
              await fsNode.writeFile(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch(() => {}),
        )
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const agentHookOrigins = new Map<string, AgentHookProvenance>()
        const modeHookOrigins = new Map<string, AgentHookProvenance>()
        const agentHookSource = (source: string): AgentHookProvenance["source"] => {
          const roots = [Global.Path.config]
          return roots.some((root) => source === root || source.startsWith(root + path.sep)) ? "user" : "project"
        }
        const rememberAgentHooks = (next: Info, source: string) => {
          for (const [name, mode] of Object.entries(next.mode ?? {})) {
            if (Object.hasOwn(mode, "hooks"))
              modeHookOrigins.set(name, { source: agentHookSource(source), origin: source })
          }
          for (const [name, agent] of Object.entries(next.agent ?? {})) {
            if (Object.hasOwn(agent, "hooks"))
              agentHookOrigins.set(name, { source: agentHookSource(source), origin: source })
          }
        }
        const authEnv: Record<string, string> = {}

        const merge = (source: string, next: Info) => {
          rememberAgentHooks(next, source)
          result = mergeConfigConcatArrays(result, next)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/graphagent`
            yield* Effect.logDebug("fetching remote config", {
              digest: RemoteLkg.digest(wellknownURL),
              role: "well-known",
            })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url, "well-known")
            // Unreachable source: the warning was logged by fetchRemoteJson; skip this source entirely
            // without merging anything so the local config stays fully usable.
            if (wellknown === undefined) continue
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.data.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetched = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", {
                    digest: RemoteLkg.digest(remote.url),
                    role: "remote-config",
                  })
                  const hit = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url, "remote-config")
                  if (hit === undefined) return { config: {} }
                  const data = hit.data
                  if (isRecord(data) && isRecord(data.config)) {
                    return {
                      config: data.config,
                      cache:
                        hit.source === "online"
                          ? { url: remote.url, role: "remote-config" as const, body: hit.body }
                          : undefined,
                    }
                  }
                  if (isRecord(data)) {
                    return {
                      config: data,
                      cache:
                        hit.source === "online"
                          ? { url: remote.url, role: "remote-config" as const, body: hit.body }
                          : undefined,
                    }
                  }
                  return yield* Effect.die(
                    new Error(`failed to decode remote config (${RemoteLkg.digest(remote.url)}): expected object`),
                  )
                })
              : { config: {} }
            const remoteConfig = mergeConfig(
              isRecord(wellknown.data.config) ? wellknown.data.config : {},
              fetched.config,
            )
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://opencode.ai/config.json"
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            if (wellknown.source === "online") {
              yield* RemoteLkg.write({ url: wellknownURL, role: "well-known", body: wellknown.body })
            }
            if (fetched.cache) yield* RemoteLkg.write(fetched.cache)
            merge(source, next)
            yield* Effect.logDebug("loaded remote config from well-known", {
              digest: RemoteLkg.digest(wellknownURL),
              role: "well-known",
            })
          }
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        merge(Global.Path.config, global)

        if (Flag.GRAPHAGENT_CONFIG) {
          merge(Flag.GRAPHAGENT_CONFIG, yield* loadFile(Flag.GRAPHAGENT_CONFIG, authEnv))
          yield* Effect.logDebug("loaded custom config", { path: Flag.GRAPHAGENT_CONFIG })
        }

        if (!Flag.GRAPHAGENT_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files(CONFIG_BASENAME, ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            merge(file, yield* loadFile(file, authEnv))
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.GRAPHAGENT_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from GRAPHAGENT_CONFIG_DIR", { path: Flag.GRAPHAGENT_CONFIG_DIR })
        }

        for (const dir of directories) {
          if (path.basename(dir) === PROJECT_DIR || dir === Flag.GRAPHAGENT_CONFIG_DIR) {
            for (const file of [`${CONFIG_BASENAME}.json`, `${CONFIG_BASENAME}.jsonc`]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              merge(source, yield* loadFile(source, authEnv))
              result.agent ??= {}
              result.mode ??= {}
            }
          }

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          for (const loaded of [
            yield* Effect.promise(() => ConfigAgent.load(dir)),
            yield* Effect.promise(() => ConfigAgent.loadMode(dir)),
          ]) {
            for (const [name, agent] of Object.entries(loaded)) {
              if (agent.hooks !== undefined)
                agentHookOrigins.set(name, { source: agentHookSource(dir), origin: String(agent.hookOrigin) })
            }
            result.agent = mergeDeep(result.agent ?? {}, loaded)
          }
        }

        if (process.env.GRAPHAGENT_CONFIG_CONTENT) {
          const source = "GRAPHAGENT_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.GRAPHAGENT_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          merge(source, next)
          yield* Effect.logDebug("loaded custom config from GRAPHAGENT_CONFIG_CONTENT")
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of [`${CONFIG_BASENAME}.json`, `${CONFIG_BASENAME}.jsonc`]) {
            const source = path.join(managedDir, file)
            merge(source, yield* loadFile(source))
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          const next = yield* loadConfig(managed.text, { dir: path.dirname(managed.source), source: managed.source })
          rememberAgentHooks(next, managed.source)
          result = mergeConfigConcatArrays(result, next)
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          if (Object.hasOwn(mode, "hooks"))
            agentHookOrigins.set(name, modeHookOrigins.get(name) ?? { source: "project", origin: "mode:" + name })
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        const localPermissions = yield* HookPermissions.read(HookPermissions.localFile(ctx.directory))
        if (localPermissions.permission || localPermissions.permissions) result = mergeConfig(result, localPermissions)
        if (localPermissions.hookPermissions)
          result.hookPermissions = { ...result.hookPermissions, ...localPermissions.hookPermissions }

        if (Flag.GRAPHAGENT_PERMISSION) {
          try {
            result = mergeConfig(result, { permission: JSON.parse(Flag.GRAPHAGENT_PERMISSION) })
          } catch (err) {
            yield* Effect.logWarning("GRAPHAGENT_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permissions = [
            ...HookPermissions.orderedRules({ permission: perms }),
            ...HookPermissions.orderedRules(result),
          ]
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (Flag.GRAPHAGENT_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.GRAPHAGENT_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, dynamic: false, prune: false }
        }

        setAgentHookOrigins(result, agentHookOrigins)
        return {
          config: result,
          directories,
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* Effect.void
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file)
      yield* checkConfigChange(file, "project_settings")
      yield* fs
        .writeFileString(file, JSON.stringify(mergeDeep(writable(existing), writable(config)), null, 2))
        .pipe(Effect.orDie)
    })

    const updateHookPermissions = Effect.fn("Config.updateHookPermissions")(function* (
      updates: readonly PermissionUpdate[],
    ) {
      yield* Effect.sync(() => HookPermissions.validateUpdates(updates))
      const effectiveUpdates = updates.filter(
        (entry) => !(entry.type === "setMode" && entry.mode === "bypassPermissions"),
      )
      if (!effectiveUpdates.length) return yield* InstanceState.use(state, (current) => current.config)
      const ctx = yield* InstanceState.context
      for (const destination of ["userSettings", "projectSettings", "localSettings"] as const) {
        if (!effectiveUpdates.some((entry) => entry.destination === destination)) continue
        const file =
          destination === "userSettings"
            ? globalConfigFile()
            : destination === "projectSettings"
              ? path.join(ctx.directory, `${CONFIG_BASENAME}.jsonc`)
              : HookPermissions.localFile(ctx.directory)
        yield* checkConfigChange(
          file,
          destination === "userSettings"
            ? "user_settings"
            : destination === "localSettings"
              ? "local_settings"
              : "project_settings",
        )
      }
      for (const destination of ["userSettings", "projectSettings", "localSettings"] as const) {
        const entries = effectiveUpdates.filter((entry) => entry.destination === destination)
        if (!entries.length) continue
        const file =
          destination === "userSettings"
            ? globalConfigFile()
            : destination === "projectSettings"
              ? path.join(ctx.directory, `${CONFIG_BASENAME}.jsonc`)
              : HookPermissions.localFile(ctx.directory)
        yield* HookPermissions.update(file, entries, ctx.directory).pipe(
          Effect.provideService(FSUtil.Service, fs),
          Effect.provide(EffectFlock.defaultLayer),
          Effect.orDie,
        )
      }
      const next = yield* loadInstanceState(ctx).pipe(Effect.orDie)
      yield* InstanceState.use(state, (current) => {
        current.config.permission = next.config.permission
        current.config.permissions = next.config.permissions
        current.config.hookPermissions = next.config.hookPermissions
      })
      return yield* InstanceState.use(state, (current) => current.config)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* checkConfigChange(globalConfigFile(), "user_settings")
      yield* invalidateGlobal
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      const file = globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"
      const patch = writableGlobal(config)

      let next: Info
      let changed: boolean
      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(before, file), file)
        const merged = mergeDeep(writable(existing), patch)
        const serialized = JSON.stringify(merged, null, 2)
        changed = serialized !== before
        if (changed) {
          yield* checkConfigChange(file, "user_settings")
          yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
        }
        next = merged
      } else {
        const updated = patchJsonc(before, patch)
        next = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(updated, file), file)
        changed = updated !== before
        if (changed) {
          yield* checkConfigChange(file, "user_settings")
          yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
        }
      }

      if (changed) yield* invalidateGlobal
      return { info: next, changed }
    })

    return Service.of({
      get,
      getGlobal,
      update,
      updateGlobal,
      updateHookPermissions,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
).pipe(Layer.provide(HookConfigChange.defaultLayer))

export const defaultLayer = layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export const node = LayerNode.make(layer, [FSUtil.node, Auth.node, httpClient, HookConfigChange.node])

export * as Config from "./config"
