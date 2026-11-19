// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1584, end to end: process A runs a turn (a `graphagent run` held open by a model stream that never ends),
// and process B, a second `graphagent session delete`, must not delete the session under it. The harness gives
// every process an in-memory database, so the test points all of them at one file with GRAPHAGENT_DB.
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import path from "node:path"
import { Database } from "@graphagent/core/database/database"
import { SessionTable } from "@graphagent/core/session/sql"
import { SessionTurnTable } from "@graphagent/core/session/turn.sql"
import { SessionID } from "@/session/schema"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

describe("graphagent session delete across processes", () => {
  cliIt.live(
    "refuses a session another process is running and names its pid, and --force deletes it anyway",
    ({ graphagent, llm, home }) =>
      Effect.gen(function* () {
        const dbPath = path.join(home, "shared.db")
        const env = { GRAPHAGENT_DB: dbPath }
        const database = Database.layerFromPath(dbPath)
        const rows = <A, E>(effect: Effect.Effect<A, E, Database.Service>) => effect.pipe(Effect.provide(database))

        // Process A: the turn is `running` in the shared database while the model stream hangs.
        yield* llm.hang
        const run = yield* graphagent.startRun("hold this turn open", { env })
        yield* llm.wait(1)
        const turn = yield* rows(
          pollWithTimeout(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              return yield* db
                .select({ sessionID: SessionTurnTable.session_id, runnerID: SessionTurnTable.runner_id })
                .from(SessionTurnTable)
                .where(eq(SessionTurnTable.state, "running"))
                .get()
                .pipe(Effect.orDie)
            }),
            "process A never started a turn",
            "30 seconds",
          ),
        )
        const sessionID = SessionID.make(turn.sessionID)
        const pid = Number(turn.runnerID?.split(":")[0])
        expect(pid).toBeGreaterThan(0)
        const stored = rows(
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            return yield* db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(eq(SessionTable.id, sessionID))
              .get()
              .pipe(Effect.orDie)
          }),
        )

        // Process B without --force: refused, non-zero, and the session is still there.
        const refused = yield* graphagent.spawn(["session", "delete", sessionID], { env })
        expect(refused.exitCode).toBe(1)
        expect(refused.stderr).toContain(`${sessionID} (pid ${pid})`)
        expect(refused.stderr).toContain("--force")
        expect(refused.stderr).not.toContain(`Session ${sessionID} deleted`)
        expect(yield* stored).toBeDefined()

        // With --force it deletes the database rows, as before. The CLI prints its results on stderr.
        const forced = yield* graphagent.spawn(["session", "delete", sessionID, "--force"], { env })
        graphagent.expectExit(forced, 0, "session delete --force")
        expect(forced.stderr).toContain(`Session ${sessionID} deleted`)
        expect(yield* stored).toBeUndefined()

        // Nothing runs a session that is gone, so the check lets the delete through and it reports what it
        // always did.
        const missing = yield* graphagent.spawn(["session", "delete", sessionID], { env })
        expect(missing.exitCode).toBe(1)
        expect(missing.stderr).toContain(`Session not found: ${sessionID}`)

        run.interrupt()
        yield* run.result
      }),
    180_000,
  )
})
