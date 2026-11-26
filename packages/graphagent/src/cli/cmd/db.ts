import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@graphagent/core/database/database"
import { Vacuum } from "@graphagent/core/database/vacuum"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd, fail } from "../effect-cmd"
import { cmd } from "./cmd"
import { t } from "@graphagent/tui/i18n"

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: t("cli.db.query.describe"),
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: t("cli.db.query.arg.query"),
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: t("cli.db.query.option.format"),
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = cmd<{}, {}>({
  command: "path",
  describe: t("cli.db.path.describe"),
  // Deliberately not an `effectCmd`: the database layer is what a stale baseline
  // kills, so the one command that names the file must not build it.
  handler: () => {
    console.log(Database.path())
  },
})

// #524: the ONLY conversion path for legacy auto_vacuum=NONE databases.
// Deliberate invocation by design — the target file must be named explicitly
// with --db, never a default path; pair it with `graphagent db path`. Refuses
// anything that is not an existing regular file (a typo must not create a
// database). Converts FULL -> VACUUM -> wal_checkpoint(TRUNCATE) outside any
// startup path and fails nonzero unless the readback is FULL.
const VacuumCommand = effectCmd({
  command: "vacuum",
  describe: t("cli.db.vacuum.describe"),
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.option("db", {
      type: "string",
      demandOption: true,
      describe: t("cli.db.vacuum.option.db"),
    })
  },
  handler: Effect.fn("Cli.db.vacuum")(function* (args: { db: string }) {
    const result = yield* Vacuum.convertToFull(args.db).pipe(
      Effect.catch((cause) =>
        cause._tag === "VacuumRefused"
          ? fail(cause.message)
          : fail(t("cli.db.vacuum.failed", { db: args.db, message: cause.message })),
      ),
    )
    console.log(`auto_vacuum=${result.autoVacuum}`)
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: t("cli.db.describe"),
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).command(VacuumCommand).demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
