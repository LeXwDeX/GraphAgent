// Must stay the first import: it settles the interface language before the
// command modules evaluate their `describe` strings.
import "./cli/language-init"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@graphagent/core/installation/version"
import { FormatError } from "./cli/error"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { EOL } from "os"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { APP_NAME } from "@graphagent/core/brand"
import { getLanguage, t } from "@graphagent/tui/i18n"

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith(`${APP_NAME} `)) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

// yargs' own labels ("Options:", validation messages) follow the same language.
const YARGS_LOCALE = { "zh-CN": "zh_CN", en: "en" } as const

// Validation failures that should print the help text. yargs localises these
// messages, so match both the English and the Simplified Chinese prefixes.
const HELP_ON_FAILURE = [
  "Unknown argument",
  "Not enough non-option arguments",
  "Invalid values:",
  "无法识别",
  "缺少 non-option 参数",
  "无效的选项值",
]

const cli = yargs(args)
  .detectLocale(false)
  .locale(YARGS_LOCALE[getLanguage()])
  .parserConfiguration({ "populate--": true })
  .scriptName(APP_NAME)
  .wrap(100)
  .help("help", t("cli.common.help"))
  .alias("help", "h")
  .version("version", t("cli.common.version"), InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: t("cli.common.option.printLogs"),
    type: "boolean",
  })
  .option("log-level", {
    describe: t("cli.common.option.logLevel"),
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.GRAPHAGENT_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.GRAPHAGENT_LOG_LEVEL = opts.logLevel

    Heap.start()

    process.env.AGENT = "1"
    process.env.GRAPHAGENT = "1"
    process.env.GRAPHAGENT_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", t("cli.common.completion"))
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(DbCommand)
  .fail((msg, err) => {
    if (msg && HELP_ON_FAILURE.some((prefix) => msg.startsWith(prefix))) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error(t("cli.common.unexpectedError") + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
