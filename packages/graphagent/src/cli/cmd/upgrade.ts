import type { Argv } from "yargs"
import { UI } from "../ui"
import { UPDATES_DISABLED } from "../../installation"

/** Hidden compatibility command for scripts using older releases. */
export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: false as const,
  builder: (yargs: Argv) =>
    yargs.positional("target", { type: "string" }).option("method", { alias: "m", type: "string" }),
  handler: async () => {
    UI.error(UPDATES_DISABLED)
    process.exitCode = 1
  },
}
