// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// This file is loaded on every CLI start (providers.ts imports it), so it keeps to the cheap imports below and
// loads the provider service, the AI SDK and the probe modules only when the command runs.
import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { t } from "@graphagent/tui/i18n"

// A header value shorter than this is masked only when its name looks like a credential: masking a value such as "1"
// or "true" under any other name would also blank every such digit or word in the report.
const MIN_HEADER_SECRET_LENGTH = 8

export const ProvidersProbeCommand = effectCmd({
  command: "probe <model>",
  describe: t("cli.providers.probe.describe"),
  builder: (yargs) =>
    yargs.positional("model", {
      describe: t("cli.providers.probe.arg.model"),
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.providers.probe")(function* (args) {
    if (!/^[^/]+\/.+$/.test(args.model)) {
      yield* fail(t("cli.providers.probe.invalidModel", { value: args.model }))
      return
    }
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const { ProviderRedact } = yield* Effect.promise(() => import("@/provider/redact"))
    const { ProbeOptions } = yield* Effect.promise(() => import("@/provider/probe/options"))
    const { ProbeReport } = yield* Effect.promise(() => import("@/provider/probe/report"))
    const { ProbeRun } = yield* Effect.promise(() => import("@/provider/probe/run"))
    const { ProbeTransport } = yield* Effect.promise(() => import("@/provider/probe/transport"))

    // Everything checked here fails before the first request, with nothing on stdout.
    const provider = yield* Provider.Service
    const parsed = Provider.parseModel(args.model)
    const notFound = () => fail(t("cli.providers.probe.modelNotFound", { model: args.model }))
    const model = yield* provider
      .getModel(parsed.providerID, parsed.modelID)
      .pipe(Effect.catchTag("ProviderModelNotFoundError", notFound))
    if (!model.api.npm.includes("@ai-sdk/openai-compatible")) {
      yield* fail(t("cli.providers.probe.unsupported", { model: args.model, npm: model.api.npm }))
      return
    }
    const info = yield* provider.getProvider(parsed.providerID)
    const language = yield* provider.getLanguage(model).pipe(Effect.catchTag("ProviderModelNotFoundError", notFound))

    // The credentials the engine would use: the provider option first, then the key from the credential store or
    // the environment. Every one of them, and every header value, is a text the command never prints: a gateway may
    // take its credential in a header of any name (Cookie, X-Custom-Auth), so the name cannot decide.
    const apiKey = typeof info.options.apiKey === "string" ? info.options.apiKey : info.key
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries({ ...info.options.headers, ...model.headers })) {
      if (typeof value === "string") headers[name] = value
    }
    const secrets: string[] = []
    const keep = (value: string | undefined) => {
      if (value !== undefined && value !== "") secrets.push(value)
    }
    keep(apiKey)
    keep(info.key)
    for (const [name, value] of Object.entries(headers)) {
      const text = value.trim()
      if (text.length < MIN_HEADER_SECRET_LENGTH && !ProviderRedact.isSecretKey(name, value)) continue
      keep(text)
      // The token alone as well, since an endpoint may echo it without its `Bearer ` prefix.
      keep(text.replace(/^Bearer\s+/i, ""))
    }
    const ctx = {
      providerID: parsed.providerID,
      modelID: model.id,
      apiID: model.api.id,
      interleaved: model.capabilities.interleaved,
      secrets,
    }
    const say = (text: string) => UI.println(ProbeReport.redact(text, ctx.secrets))

    const baseURL = ProbeTransport.resolveBaseURL({
      optionsBaseURL: info.options.baseURL,
      apiURL: model.api.url,
      env: process.env,
    })
    const transport = ProbeTransport.make({
      language,
      baseURL,
      apiKey,
      headers,
      // What a normal turn sends beside the messages, so the endpoint is probed in the mode the engine uses.
      providerOptions: ProbeOptions.resolve({ model, providerOptions: info.options }),
    })
    const { findings, chatOk } = yield* Effect.promise(() =>
      ProbeRun.run(transport, ctx, (count, tokens) => say(t("cli.providers.probe.plan", { count, tokens }))),
    )
    for (const line of ProbeReport.render(findings, ctx)) say(line)

    if (!chatOk) {
      yield* fail(t("cli.providers.probe.noResponse"))
      return
    }
    const snippet = JSON.stringify(ProbeReport.snippet(findings, ctx), null, 2)
    process.stdout.write(ProbeReport.redact(snippet, ctx.secrets) + EOL)
  }),
})
