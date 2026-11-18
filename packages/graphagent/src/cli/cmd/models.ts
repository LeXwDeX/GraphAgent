import { EOL } from "os"
import { Effect } from "effect"
import { ModelsDev } from "@graphagent/core/models-dev"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ProviderV2 } from "@graphagent/core/provider"
import { t } from "@graphagent/tui/i18n"
import { ProviderRedact } from "@/provider/redact"

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: t("cli.models.describe"),
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: t("cli.models.arg.provider"),
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: t("cli.models.option.verbose"),
        type: "boolean",
      })
      .option("refresh", {
        describe: t("cli.models.option.refresh"),
        type: "boolean",
      }),
  handler: Effect.fn("Cli.models")(function* (args) {
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    if (args.refresh) {
      yield* ModelsDev.Service.use((s) => s.refresh(true))
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + t("cli.models.refreshed") + UI.Style.TEXT_NORMAL)
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    const print = (providerID: ProviderV2.ID, verbose?: boolean) => {
      const p = providers[providerID]
      const sorted = Object.entries(p.models).sort(([a], [b]) => a.localeCompare(b))
      for (const [modelID, model] of sorted) {
        process.stdout.write(`${providerID}/${modelID}`)
        process.stdout.write(EOL)
        if (verbose) {
          process.stdout.write(JSON.stringify(ProviderRedact.redactModel(model), null, 2))
          process.stdout.write(EOL)
        }
      }
    }

    if (args.provider) {
      const providerID = ProviderV2.ID.make(args.provider)
      if (!providers[providerID]) return yield* fail(t("cli.models.providerNotFound", { provider: args.provider }))
      print(providerID, args.verbose)
      return
    }

    const ids = Object.keys(providers).sort((a, b) => a.localeCompare(b))

    for (const providerID of ids) print(ProviderV2.ID.make(providerID), args.verbose)
  }),
})
