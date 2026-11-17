import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { Global } from "@graphagent/core/global"
import { t } from "@graphagent/tui/i18n"
import fs from "fs/promises"
import os from "os"
import path from "path"

interface UninstallArgs {
  keepConfig: boolean
  keepData: boolean
  dryRun: boolean
  force: boolean
}

// `id` is the fixed English name the `--keep-<id>` flags derive from; only
// `label` is translated.
interface RemovalTargets {
  directories: Array<{ id: "data" | "cache" | "config" | "state"; path: string; label: string; keep: boolean }>
  binary: string | null
}

export const UninstallCommand = {
  command: "uninstall",
  describe: t("cli.uninstall.describe"),
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: t("cli.uninstall.option.keepConfig"),
        default: false,
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: t("cli.uninstall.option.keepData"),
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: t("cli.uninstall.option.dryRun"),
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: t("cli.uninstall.option.force"),
        default: false,
      }),

  handler: async (args: UninstallArgs) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro(t("cli.uninstall.intro"))

    const method = await Installation.method()
    prompts.log.info(t("cli.uninstall.method", { method }))

    const targets = await collectRemovalTargets(args, method)

    await showRemovalSummary(targets)

    if (!args.force && !args.dryRun) {
      const confirm = await prompts.confirm({
        active: t("cli.common.yes"),
        inactive: t("cli.common.no"),
        message: t("cli.uninstall.confirm"),
        initialValue: false,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro(t("cli.uninstall.cancelled"))
        return
      }
    }

    if (args.dryRun) {
      prompts.log.warn(t("cli.uninstall.dryRun"))
      prompts.outro(t("cli.uninstall.done"))
      return
    }

    await executeUninstall(method, targets)

    prompts.outro(t("cli.uninstall.done"))
  },
}

async function collectRemovalTargets(args: UninstallArgs, method: Installation.Method): Promise<RemovalTargets> {
  const directories: RemovalTargets["directories"] = [
    { id: "data", path: Global.Path.data, label: t("cli.uninstall.label.data"), keep: args.keepData },
    { id: "cache", path: Global.Path.cache, label: t("cli.uninstall.label.cache"), keep: false },
    { id: "config", path: Global.Path.config, label: t("cli.uninstall.label.config"), keep: args.keepConfig },
    { id: "state", path: Global.Path.state, label: t("cli.uninstall.label.state"), keep: false },
  ]

  const binary = method === "curl" ? process.execPath : null

  return { directories, binary }
}

async function showRemovalSummary(targets: RemovalTargets) {
  prompts.log.message(t("cli.uninstall.summary"))

  for (const dir of targets.directories) {
    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const size = await getDirectorySize(dir.path)
    const sizeStr = formatSize(size)
    const status = dir.keep ? UI.Style.TEXT_DIM + t("cli.uninstall.keeping") : ""
    const prefix = dir.keep ? "○" : "✓"
    const entry = t("cli.uninstall.labeled", { label: dir.label, value: shortenPath(dir.path) })

    prompts.log.info(`  ${prefix} ${entry} ${UI.Style.TEXT_DIM}(${sizeStr})${status}`)
  }

  if (targets.binary) {
    const entry = t("cli.uninstall.labeled", {
      label: t("cli.uninstall.label.binary"),
      value: shortenPath(targets.binary),
    })
    prompts.log.info(`  ✓ ${entry}`)
  }
}

async function executeUninstall(method: Installation.Method, targets: RemovalTargets) {
  const spinner = prompts.spinner()
  const errors: string[] = []

  for (const dir of targets.directories) {
    if (dir.keep) {
      prompts.log.step(t("cli.uninstall.skipping", { label: dir.label, flag: `--keep-${dir.id}` }))
      continue
    }

    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    spinner.start(t("cli.uninstall.removing", { label: dir.label }))
    const err = await fs.rm(dir.path, { recursive: true, force: true }).catch((e) => e)
    if (err) {
      spinner.error(t("cli.uninstall.removeFailed", { label: dir.label }))
      errors.push(t("cli.uninstall.labeled", { label: dir.label, value: err.message }))
      continue
    }
    spinner.stop(t("cli.uninstall.removed", { label: dir.label }))
  }

  if (method === "curl" && targets.binary) {
    UI.empty()
    prompts.log.message(t("cli.uninstall.binaryHint"))
    prompts.log.info(`  rm "${targets.binary}"`)

    const binDir = path.dirname(targets.binary)
    if (binDir.includes(".graphagent")) {
      prompts.log.info(`  rmdir "${binDir}" 2>/dev/null`)
    }
  }

  if (errors.length > 0) {
    UI.empty()
    prompts.log.warn(t("cli.uninstall.someFailed"))
    for (const err of errors) {
      prompts.log.error(`  ${err}`)
    }
  }

  UI.empty()
  prompts.log.success(t("cli.uninstall.thanks"))
}

async function getDirectorySize(dir: string): Promise<number> {
  let total = 0

  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  }

  await walk(dir)
  return total
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) {
    return p.replace(home, "~")
  }
  return p
}
