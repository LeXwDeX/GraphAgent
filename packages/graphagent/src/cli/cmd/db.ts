import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@graphagent/core/database/database"
import { Vacuum } from "@graphagent/core/database/vacuum"
import { APP_NAME } from "@graphagent/core/brand"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd, fail } from "../effect-cmd"

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
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

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

// #524: the ONLY conversion path for legacy auto_vacuum=NONE databases.
// Deliberate invocation by design — the target file must be named explicitly
// with --db, never a default path; pair it with `opencode db path`. Refuses
// anything that is not an existing regular file (a typo must not create a
// database). Converts FULL -> VACUUM -> wal_checkpoint(TRUNCATE) outside any
// startup path and fails nonzero unless the readback is FULL.
const VacuumCommand = effectCmd({
  command: "vacuum",
  describe: "convert a database file to full auto_vacuum (FULL -> VACUUM -> truncate WAL)",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.option("db", {
      type: "string",
      demandOption: true,
      describe: `path to the SQLite database file (print the default with \`${APP_NAME} db path\`)`,
    })
  },
  handler: Effect.fn("Cli.db.vacuum")(function* (args: { db: string }) {
    const result = yield* Vacuum.convertToFull(args.db).pipe(
      Effect.catch((cause) =>
        cause._tag === "VacuumRefused"
          ? fail(cause.message)
          : fail(
              `vacuum failed for ${args.db} — close running opencode processes that use this file and retry (${cause.message})`,
            ),
      ),
    )
    console.log(`auto_vacuum=${result.autoVacuum}`)
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).command(VacuumCommand).demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
