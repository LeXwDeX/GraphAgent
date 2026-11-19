import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Database } from "@graphagent/core/database/database"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@graphagent/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { NotFoundError } from "@/storage/storage"
import { EOL } from "os"
import path from "path"
import { which } from "@graphagent/core/util/which"
import { t } from "@graphagent/tui/i18n"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.GRAPHAGENT_GIT_BASH_PATH) {
    const less = path.join(Flag.GRAPHAGENT_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: t("cli.session.describe"),
  builder: (yargs: Argv) => yargs.command(SessionListCommand).command(SessionDeleteCommand).demandCommand(),
  async handler() {},
})

/** `rootID` and every session below it, DAG node sessions included: the sessions `Session.remove` deletes. */
export const sessionTree = Effect.fnUntraced(function* (
  children: (parentID: SessionID) => Effect.Effect<ReadonlyArray<{ readonly id: SessionID }>>,
  rootID: SessionID,
) {
  const seen = new Set<SessionID>([rootID])
  let level: readonly SessionID[] = [rootID]
  while (level.length > 0) {
    const listed = yield* Effect.forEach(level, (id) => children(id), { concurrency: "unbounded" })
    level = listed.flat().flatMap((child) => (seen.has(child.id) ? [] : (seen.add(child.id), [child.id])))
  }
  return [...seen]
})

/**
 * `removeSession` cancels only this process's runs (#1558). A turn that another live process is running somewhere in
 * the tree would go on spending tokens against rows that are gone, so the delete is refused until the user has
 * stopped that run, or accepted it with `--force` (#1584). The turn rows say who runs what; there is no
 * cross-process cancel to offer instead.
 */
export const refuseForeignRuns = Effect.fnUntraced(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const database = yield* Database.Service
  // Loaded here like the prompt engine: `turns` pulls in the child-run machinery.
  const { Turns } = yield* Effect.promise(() => import("@/session/turns"))
  const tree = yield* sessionTree((id) => sessions.children(id), sessionID)
  const runs = yield* Turns.foreignRunning(database, tree)
  if (runs.length === 0) return
  const listed = runs.map((run) => `${run.sessionID} (pid ${run.pid})`).join(", ")
  yield* fail(t("cli.session.delete.foreignRunning", { runs: listed }))
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: t("cli.session.delete.describe"),
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: t("cli.session.delete.arg.sessionID"),
        type: "string",
        demandOption: true,
      })
      .option("force", {
        describe: t("cli.session.delete.option.force"),
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    // Loaded here: the CLI entry imports this module for every command, and the prompt engine is heavy.
    const { SessionPrompt } = yield* Effect.promise(() => import("@/session/prompt"))
    const prompt = yield* SessionPrompt.Service
    const sessionID = SessionID.make(args.sessionID)
    if (!args.force) yield* refuseForeignRuns(sessionID)
    yield* prompt
      .removeSession(sessionID)
      .pipe(
        Effect.catchIf(NotFoundError.isInstance, () => fail(t("cli.session.notFound", { sessionID: args.sessionID }))),
      )
    UI.println(
      UI.Style.TEXT_SUCCESS_BOLD + t("cli.session.delete.done", { sessionID: args.sessionID }) + UI.Style.TEXT_NORMAL,
    )
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: t("cli.session.list.describe"),
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: t("cli.session.list.option.maxCount"),
        type: "number",
      })
      .option("format", {
        describe: t("cli.session.list.option.format"),
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service.use((svc) => svc.list({ roots: true, limit: args.maxCount }))

    if (sessions.length === 0) return

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      yield* Effect.promise(async () => {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      })
    } else {
      console.log(output)
    }
  }),
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  // The header labels are translated, so pad by display width (CJK is two columns).
  const column = (label: string, width: number) => label + " ".repeat(Math.max(0, width - Bun.stringWidth(label)))
  const header = [
    column(t("cli.session.list.header.id"), maxIdWidth),
    column(t("cli.session.list.header.title"), maxTitleWidth),
    t("cli.session.list.header.updated"),
  ].join("  ")
  lines.push(header)
  lines.push("─".repeat(Bun.stringWidth(header)))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}
