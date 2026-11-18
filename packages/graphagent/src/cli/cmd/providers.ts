import type { Argv } from "yargs"
import { Auth } from "../../auth"
import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"
import { ModelsDev } from "@graphagent/core/models-dev"
import { APP_NAME } from "@graphagent/core/brand"

import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import os from "os"
import { Config } from "@/config/config"
import { Global } from "@graphagent/core/global"
import { ProviderAdapters } from "@/provider/adapter/registry"
import type { AuthHook } from "@/provider/adapter/types"
import { Process } from "@/util/process"
import { errorMessage } from "@/util/error"
import { text } from "node:stream/consumers"
import { Effect, Option } from "effect"
import { t } from "@graphagent/tui/i18n"
import { ProvidersProbeCommand } from "./providers-probe"

type PluginAuth = AuthHook

const promptValue = <Value>(value: Option.Option<Value>) => {
  if (Option.isNone(value)) return Effect.die(new UI.CancelledError())
  return Effect.succeed(value.value)
}

const put = Effect.fn("Cli.providers.put")(function* (key: string, info: Auth.Info) {
  const auth = yield* Auth.Service
  yield* Effect.orDie(auth.set(key, info))
})

const cliTry = <Value>(message: string, fn: () => PromiseLike<Value>) =>
  Effect.tryPromise({
    try: fn,
    catch: (error) => new CliError({ message: message + errorMessage(error) }),
  })

const handlePluginAuth = Effect.fn("Cli.providers.pluginAuth")(function* (
  plugin: { auth: PluginAuth },
  provider: string,
  methodName?: string,
) {
  const index = yield* Effect.gen(function* () {
    if (!methodName) {
      if (plugin.auth.methods.length <= 1) return 0
      return yield* promptValue(
        yield* Prompt.select({
          message: t("cli.providers.login.method"),
          options: plugin.auth.methods.map((x, index) => ({
            label: x.label,
            value: index,
          })),
        }),
      )
    }
    const match = plugin.auth.methods.findIndex((x) => x.label.toLowerCase() === methodName.toLowerCase())
    if (match === -1) {
      return yield* fail(
        t("cli.providers.login.unknownMethod", {
          method: methodName,
          provider,
          available: plugin.auth.methods.map((x) => x.label).join(", "),
        }),
      )
    }
    return match
  })
  const method = plugin.auth.methods[index]

  yield* Effect.sleep("10 millis")
  const inputs: Record<string, string> = {}
  if (method.prompts) {
    for (const prompt of method.prompts) {
      if (prompt.when) {
        const value = inputs[prompt.when.key]
        if (value === undefined) continue
        const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
        if (!matches) continue
      }
      if (prompt.condition && !prompt.condition(inputs)) continue
      if (prompt.type === "select") {
        const value = yield* Prompt.select({
          message: prompt.message,
          options: prompt.options,
        })
        inputs[prompt.key] = yield* promptValue(value)
        continue
      }
      const value = yield* Prompt.text({
        message: prompt.message,
        placeholder: prompt.placeholder,
        validate: prompt.validate ? (v) => prompt.validate!(v ?? "") : undefined,
      })
      inputs[prompt.key] = yield* promptValue(value)
    }
  }

  if (method.type === "oauth") {
    const authorize = yield* cliTry(t("cli.providers.login.authorizeFailedPrefix"), () => method.authorize(inputs))

    if (authorize.url) {
      yield* Prompt.log.info(t("cli.providers.login.goTo", { url: authorize.url }))
    }

    if (authorize.method === "auto") {
      if (authorize.instructions) {
        yield* Prompt.log.info(authorize.instructions)
      }
      const spinner = Prompt.spinner()
      yield* spinner.start(t("cli.providers.login.waiting"))
      const result = yield* cliTry(t("cli.providers.login.authorizeFailedPrefix"), () => authorize.callback())
      if (result.type === "failed") {
        yield* spinner.stop(t("cli.providers.login.authorizeFailed"), 1)
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          yield* put(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          yield* put(saveProvider, {
            type: "api",
            key: result.key,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          })
        }
        yield* spinner.stop(t("cli.providers.login.success"))
      }
    }

    if (authorize.method === "code") {
      const code = yield* Prompt.text({
        message: t("cli.providers.login.pasteCode"),
        validate: (x) => (x && x.length > 0 ? undefined : t("cli.providers.required")),
      })
      const authorizationCode = yield* promptValue(code)
      const result = yield* cliTry(t("cli.providers.login.authorizeFailedPrefix"), () =>
        authorize.callback(authorizationCode),
      )
      if (result.type === "failed") {
        yield* Prompt.log.error(t("cli.providers.login.authorizeFailed"))
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          yield* put(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          yield* put(saveProvider, {
            type: "api",
            key: result.key,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          })
        }
        yield* Prompt.log.success(t("cli.providers.login.success"))
      }
    }

    yield* Prompt.outro(t("cli.providers.done"))
    return true
  }

  if (method.type === "api") {
    const key = yield* Prompt.password({
      message: t("cli.providers.apiKeyPrompt"),
      validate: (x) => (x && x.length > 0 ? undefined : t("cli.providers.required")),
    })
    const apiKey = yield* promptValue(key)

    const metadata = Object.keys(inputs).length ? { metadata: inputs } : {}
    const authorizeApi = method.authorize
    if (!authorizeApi) {
      yield* put(provider, {
        type: "api",
        key: apiKey,
        ...metadata,
      })
      yield* Prompt.outro(t("cli.providers.done"))
      return true
    }

    const result = yield* cliTry(t("cli.providers.login.authorizeFailedPrefix"), () => authorizeApi(inputs))
    if (result.type === "failed") {
      yield* Prompt.log.error(t("cli.providers.login.authorizeFailed"))
    }
    if (result.type === "success") {
      const saveProvider = result.provider ?? provider
      const merged = { ...(metadata.metadata ?? {}), ...(result.metadata ?? {}) }
      yield* put(saveProvider, {
        type: "api",
        key: result.key ?? apiKey,
        ...(Object.keys(merged).length ? { metadata: merged } : {}),
      })
      yield* Prompt.log.success(t("cli.providers.login.success"))
    }
    yield* Prompt.outro(t("cli.providers.done"))
    return true
  }

  return false
})

export function resolvePluginProviders(input: {
  hooks: Array<AuthHook | { auth?: AuthHook }>
  existingProviders: Record<string, unknown>
  disabled: Set<string>
  enabled?: Set<string>
  providerNames: Record<string, string | undefined>
}): Array<{ id: string; name: string }> {
  const seen = new Set<string>()
  const result: Array<{ id: string; name: string }> = []

  for (const hook of input.hooks) {
    const auth = "provider" in hook ? hook : hook.auth
    if (!auth) continue
    const id = auth.provider
    if (seen.has(id)) continue
    seen.add(id)
    if (Object.hasOwn(input.existingProviders, id)) continue
    if (input.disabled.has(id)) continue
    if (input.enabled && !input.enabled.has(id)) continue
    result.push({
      id,
      name: input.providerNames[id] ?? id,
    })
  }

  return result
}

export const ProvidersCommand = cmd({
  command: "providers",
  aliases: ["auth"],
  describe: t("cli.providers.describe"),
  builder: (yargs) =>
    yargs
      .command(ProvidersListCommand)
      .command(ProvidersLoginCommand)
      .command(ProvidersLogoutCommand)
      .command(ProvidersProbeCommand)
      .demandCommand(),
  async handler() {},
})

export const ProvidersListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: t("cli.providers.list.describe"),
  // Lists global credentials + provider env vars; no project instance needed.
  instance: false,
  handler: Effect.fn("Cli.providers.list")(function* (_args) {
    const authSvc = yield* Auth.Service
    const modelsDev = yield* ModelsDev.Service

    UI.empty()
    const authPath = path.join(Global.Path.data, "auth.json")
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath
    yield* Prompt.intro(`${t("cli.providers.list.credentials")} ${UI.Style.TEXT_DIM}${displayPath}`)
    const results = Object.entries(yield* Effect.orDie(authSvc.all()))
    const database = yield* modelsDev.get()

    for (const [providerID, result] of results) {
      const name = database[providerID]?.name || providerID
      yield* Prompt.log.info(`${name} ${UI.Style.TEXT_DIM}${result.type}`)
    }

    yield* Prompt.outro(t("cli.providers.list.credentialCount", { count: results.length }))

    const activeEnvVars: Array<{ provider: string; envVar: string }> = []

    for (const [providerID, provider] of Object.entries(database)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({
            provider: provider.name || providerID,
            envVar,
          })
        }
      }
    }

    if (activeEnvVars.length > 0) {
      UI.empty()
      yield* Prompt.intro(t("cli.providers.list.environment"))

      for (const { provider, envVar } of activeEnvVars) {
        yield* Prompt.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      yield* Prompt.outro(
        t(activeEnvVars.length === 1 ? "cli.providers.list.envCount.one" : "cli.providers.list.envCount.other", {
          count: activeEnvVars.length,
        }),
      )
    }
  }),
})

export const ProvidersLoginCommand = effectCmd({
  command: "login [url]",
  describe: t("cli.providers.login.describe"),
  // URL login skips instance bootstrap, which would load remote config with the stale token and crash before re-auth.
  instance: (args) => !args.url,
  builder: (yargs: Argv) =>
    yargs
      .positional("url", {
        describe: t("cli.providers.login.option.url", { app: APP_NAME }),
        type: "string",
      })
      .option("provider", {
        alias: ["p"],
        describe: t("cli.providers.login.option.provider"),
        type: "string",
      })
      .option("method", {
        alias: ["m"],
        describe: t("cli.providers.login.option.method"),
        type: "string",
      }),
  handler: Effect.fn("Cli.providers.login")(function* (args) {
    const authSvc = yield* Auth.Service

    UI.empty()
    yield* Prompt.intro(t("cli.providers.login.addCredential"))
    if (args.url) {
      const url = args.url.replace(/\/+$/, "")
      const wellknown = (yield* cliTry(t("cli.providers.login.metadataFailedPrefix", { url }), () =>
        fetch(`${url}/.well-known/graphagent`).then((x) => x.json()),
      )) as {
        auth: { command: string[]; env: string }
      }
      yield* Prompt.log.info(t("cli.providers.login.running", { command: wellknown.auth.command.join(" ") }))
      const abort = new AbortController()
      const proc = Process.spawn(wellknown.auth.command, { stdout: "pipe", stderr: "inherit", abort: abort.signal })
      if (!proc.stdout) {
        yield* Prompt.log.error(t("cli.providers.failed"))
        yield* Prompt.outro(t("cli.providers.done"))
        return
      }
      const [exit, token] = yield* cliTry(t("cli.providers.login.commandFailedPrefix"), () =>
        Promise.all([proc.exited, text(proc.stdout!)]),
      ).pipe(Effect.ensuring(Effect.sync(() => abort.abort())))
      if (exit !== 0) {
        yield* Prompt.log.error(t("cli.providers.failed"))
        yield* Prompt.outro(t("cli.providers.done"))
        return
      }
      yield* Effect.orDie(authSvc.set(url, { type: "wellknown", key: wellknown.auth.env, token: token.trim() }))
      yield* Prompt.log.success(t("cli.providers.login.loggedInto", { url }))
      yield* Prompt.outro(t("cli.providers.done"))
      return
    }

    const cfgSvc = yield* Config.Service
    const adapters = yield* ProviderAdapters.Service
    const modelsDev = yield* ModelsDev.Service
    yield* Effect.ignore(modelsDev.refresh(true))

    const config = yield* cfgSvc.get()

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

    const allProviders = yield* modelsDev.get()
    const providers: Record<string, (typeof allProviders)[string]> = {}
    for (const [key, value] of Object.entries(allProviders)) {
      if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) providers[key] = value
    }
    const authHooks = yield* adapters.authHooks()
    const hooks = Object.values(authHooks)

    const priority: Record<string, number> = {
      openai: 1,
      "github-copilot": 2,
      google: 3,
      anthropic: 4,
      openrouter: 5,
      vercel: 6,
    }
    const pluginProviders = resolvePluginProviders({
      hooks,
      existingProviders: providers,
      disabled,
      enabled,
      providerNames: Object.fromEntries(Object.entries(config.provider ?? {}).map(([id, p]) => [id, p.name])),
    })
    const options = [
      ...pipe(
        providers,
        values(),
        sortBy(
          (x) => priority[x.id] ?? 99,
          (x) => x.name ?? x.id,
        ),
        map((x) => ({
          label: x.name,
          value: x.id,
          hint: {
            openai: t("cli.providers.login.hintOpenai"),
          }[x.id],
        })),
      ),
      ...pluginProviders.map((x) => ({
        label: x.name,
        value: x.id,
        hint: t("cli.providers.login.hintBuiltIn"),
      })),
    ]

    let provider: string
    if (args.provider) {
      const input = args.provider
      const byID = options.find((x) => x.value === input)
      const byName = options.find((x) => x.label.toLowerCase() === input.toLowerCase())
      const match = byID ?? byName
      if (!match) {
        return yield* fail(t("cli.providers.login.unknownProvider", { provider: input }))
      }
      provider = match.value
    } else {
      provider = yield* promptValue(
        yield* Prompt.autocomplete({
          message: t("cli.providers.selectProvider"),
          maxItems: 8,
          options: [...options, { value: "other", label: t("cli.providers.login.other") }],
        }),
      )
    }

    const authHook = authHooks[provider]
    if (authHook) {
      const handled = yield* handlePluginAuth({ auth: authHook }, provider, args.method)
      if (handled) return
    }

    if (provider === "other") {
      provider = (yield* promptValue(
        yield* Prompt.text({
          message: t("cli.providers.login.providerId"),
          validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : t("cli.providers.login.providerIdInvalid")),
        }),
      )).replace(/^@ai-sdk\//, "")

      const customAuth = authHooks[provider]
      if (customAuth) {
        const handled = yield* handlePluginAuth({ auth: customAuth }, provider, args.method)
        if (handled) return
      }

      yield* Prompt.log.warn(t("cli.providers.login.customNotice", { provider }))
    }

    if (provider === "amazon-bedrock") {
      yield* Prompt.log.info(t("cli.providers.login.bedrock"))
    }

    if (provider === "vercel") {
      yield* Prompt.log.info(t("cli.providers.login.vercel"))
    }

    if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
      yield* Prompt.log.info(t("cli.providers.login.cloudflare"))
    }

    const key = yield* Prompt.password({
      message: t("cli.providers.apiKeyPrompt"),
      validate: (x) => (x && x.length > 0 ? undefined : t("cli.providers.required")),
    })
    const apiKey = yield* promptValue(key)
    yield* Effect.orDie(authSvc.set(provider, { type: "api", key: apiKey }))

    yield* Prompt.outro(t("cli.providers.done"))
  }),
})

export const ProvidersLogoutCommand = effectCmd({
  command: "logout [provider]",
  describe: t("cli.providers.logout.describe"),
  builder: (yargs) =>
    yargs.positional("provider", {
      describe: t("cli.providers.logout.option.provider"),
      type: "string",
    }),
  // Removes a global auth credential; no project instance needed.
  instance: false,
  handler: Effect.fn("Cli.providers.logout")(function* (args) {
    const authSvc = yield* Auth.Service
    const modelsDev = yield* ModelsDev.Service

    UI.empty()
    const credentials: Array<[string, Auth.Info]> = Object.entries(yield* Effect.orDie(authSvc.all()))
    yield* Prompt.intro(t("cli.providers.logout.removeCredential"))
    if (credentials.length === 0) {
      yield* Prompt.log.error(t("cli.providers.logout.none"))
      return
    }
    const database = yield* modelsDev.get()
    const options = credentials.map(([key, value]) => ({
      label: (database[key]?.name || key) + UI.Style.TEXT_DIM + " (" + value.type + ")",
      value: key,
    }))
    const provider = args.provider
      ? options.find(
          (option) =>
            option.value === args.provider ||
            database[option.value]?.name?.toLowerCase() === args.provider?.toLowerCase(),
        )?.value
      : yield* promptValue(
          yield* Prompt.autocomplete({
            message: t("cli.providers.selectProvider"),
            maxItems: 8,
            options,
          }),
        )
    if (!provider) return yield* fail(t("cli.providers.logout.unknownProvider", { provider: String(args.provider) }))
    yield* Effect.orDie(authSvc.remove(provider))
    yield* Prompt.outro(t("cli.providers.logout.success"))
  }),
})
