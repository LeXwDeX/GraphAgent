// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// The only gate that boots the CLI against a real on-disk database. Every other
// CLI test inherits GRAPHAGENT_DB=:memory: from test/preload.ts, so the startup
// path a user hits — open the channel's file, check its baseline, migrate or
// refuse — is otherwise never executed. A rebaseline that leaves a developer's
// database behind is exactly the failure this file pins.

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { baseline } from "@graphagent/core/database/migration.gen"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("graphagent startup against a file database", () => {
  cliIt.live(
    "db path prints the file a source run opens, not :memory:",
    ({ graphagent }) =>
      Effect.gen(function* () {
        const r = yield* graphagent.spawn(["db", "path"], { env: { GRAPHAGENT_DB: "" } })
        graphagent.expectExit(r, 0, "db path")
        const printed = r.stdout.trim()
        expect(printed).toMatch(/[/\\].+\.(db|sqlite|sqlite3)$/i)
        // The harness isolates XDG_DATA_HOME; only the basename is portable.
        expect(printed).toContain(Database.channelFile("local"))
      }),
    60_000,
  )

  cliIt.live(
    "a database from an older baseline fails with the file, both fingerprints and no 'Unexpected error'",
    ({ graphagent }) =>
      Effect.gen(function* () {
        const home = process.env["GRAPHAGENT_TEST_HOME"]
        if (!home) throw new Error("the CLI harness must set GRAPHAGENT_TEST_HOME")
        const filename = `${home}/stale.db`
        const child = Bun.spawnSync(["sqlite3", filename, "CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL); INSERT INTO migration(id, time_completed) VALUES ('baseline-stale', 0);"])
        expect(child.exitCode).toBe(0)

        const r = yield* graphagent.spawn(["agent", "list"], { env: { GRAPHAGENT_DB: filename } })
        expect(r.exitCode).not.toBe(0)
        expect(r.stderr).toContain(filename)
        expect(r.stderr).toContain("baseline-stale")
        expect(r.stderr).toContain(baseline.id)
        expect(r.stderr).not.toContain("Unexpected error")
      }),
    60_000,
  )

  cliIt.live(
    "a fresh file database starts and answers a command",
    ({ graphagent }) =>
      Effect.gen(function* () {
        const home = process.env["GRAPHAGENT_TEST_HOME"]
        if (!home) throw new Error("the CLI harness must set GRAPHAGENT_TEST_HOME")
        const r = yield* graphagent.spawn(["agent", "list"], { env: { GRAPHAGENT_DB: `${home}/fresh.db` } })
        graphagent.expectExit(r, 0, "agent list on a fresh file database")
      }),
    60_000,
  )
})