// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1072: `/remind` through the real CLI process. In-process tests build their
// own layer graphs; this one spans argv parsing -> server boot -> `session.command`
// -> the built-in dispatch -> the reminder clock the server graph provides ->
// the SQLite file the process wrote, so a clock missing from the server graph
// (the `serviceOption` would silently find nothing) fails here.
//
// Harness notes (mirrors test/cli/run/early-return-command.test.ts):
// - run.ts resolves its directory from process.env.PWD, so arms pin PWD to the fixture home.
// - GRAPHAGENT_DB points at a file under the isolated home so the test can read the row back.
// - The first arms stub one LLM reply only so the CLI has a default model to resolve; `/remind`
//   never calls it. The restart arm uses it: the delivered reminder starts a real turn.
import { Database } from "bun:sqlite"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpBody, HttpClient } from "effect/http"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { pollWithTimeout } from "../../lib/effect"

interface Row {
  readonly id: string
  readonly session_id: string
  readonly text: string
  readonly fire_at: number
  readonly every_ms: number | null
  readonly status: string
  readonly creator: string
}

// `run` joins its positional words into the command's arguments, and quotes a word that contains a
// space: the arguments of `/remind 30m check` are separate words, never one quoted string.
const words = (line: string) => line.split(" ")

const rowsOf = (file: string): Row[] => {
  const db = new Database(file, { readonly: true })
  try {
    return db
      .query<Row, []>(
        "SELECT id, session_id, text, fire_at, every_ms, status, creator FROM reminder ORDER BY created_at",
      )
      .all()
  } finally {
    db.close()
  }
}

const SessionRef = Schema.Struct({ id: Schema.String })

const statusOf = (file: string, sessionID: string): Effect.Effect<string | undefined> =>
  Effect.sync(() => {
    const db = new Database(file, { readonly: true })
    try {
      return db.query<{ status: string }, [string]>("SELECT status FROM reminder WHERE session_id = ?").get(sessionID)
        ?.status
    } finally {
      db.close()
    }
  })

/** Parts of the session's messages that carry reminder metadata, as the HTTP API returns them. */
const reminderParts = (messages: unknown): ReadonlyArray<{ text: string; metadata: Record<string, unknown> }> => {
  if (!Array.isArray(messages)) return []
  return messages
    .flatMap((message: unknown) =>
      typeof message === "object" && message !== null && "parts" in message && Array.isArray(message.parts)
        ? (message.parts as unknown[])
        : [],
    )
    .filter(
      (part): part is { text: string; metadata: Record<string, unknown> } =>
        typeof part === "object" &&
        part !== null &&
        "metadata" in part &&
        typeof part.metadata === "object" &&
        part.metadata !== null &&
        "reminder" in part.metadata &&
        "text" in part &&
        typeof part.text === "string",
    )
}

describe("/remind through the run CLI (#1072)", () => {
  cliIt.live(
    "creates a durable reminder, prints its receipt, and lists only its own session's reminders",
    ({ llm, home, graphagent }) =>
      Effect.gen(function* () {
        yield* llm.text("unused")
        const file = path.join(home, "remind.db")
        const env = { PWD: home, GRAPHAGENT_DB: file }
        const before = Date.now()

        const created = yield* graphagent.run("", {
          command: "remind",
          extraArgs: words("30m check the L5 smoke test"),
          env,
          timeoutMs: 30_000,
        })
        expect(created.exitCode, created.stderr).toBe(0)
        expect(created.stdout).toMatch(/已设置提醒 rmd_[0-9a-f]{8}：/)
        expect(created.stdout).toContain("check the L5 smoke test")

        // The row is durable and the user's: it is what a restart resumes from.
        const rows = rowsOf(file)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          text: "check the L5 smoke test",
          every_ms: null,
          status: "scheduled",
          creator: "user",
        })
        expect(created.stdout).toContain(rows[0].id)
        expect(rows[0].fire_at).toBeGreaterThanOrEqual(before + 29 * 60_000)
        expect(rows[0].fire_at).toBeLessThanOrEqual(Date.now() + 30 * 60_000)

        // A second run is a new session: it does not see the first session's reminder.
        const listed = yield* graphagent.run("", { command: "remind", extraArgs: ["list"], env, timeoutMs: 30_000 })
        expect(listed.exitCode, listed.stderr).toBe(0)
        expect(listed.stdout).toContain("本会话没有待触发的提醒。")
        expect(rowsOf(file)).toHaveLength(1)
        // A command that only answers locally never reaches the model.
        expect(yield* llm.calls).toBe(0)
      }),
    120_000,
  )

  cliIt.live(
    "explains an unreadable time and writes nothing",
    ({ llm, home, graphagent }) =>
      Effect.gen(function* () {
        yield* llm.text("unused")
        const file = path.join(home, "remind-error.db")
        const result = yield* graphagent.run("", {
          command: "remind",
          extraArgs: words("someday check"),
          env: { PWD: home, GRAPHAGENT_DB: file },
          timeoutMs: 30_000,
        })
        expect(result.exitCode, result.stderr).toBe(0)
        expect(result.stdout).toContain("无法识别时间")
        expect(rowsOf(file)).toEqual([])
      }),
    120_000,
  )

  // The restart, with real processes: one server creates the reminder and goes away, the
  // reminder comes due while nothing runs, and the next server delivers it, marked late, exactly
  // once. Every start after that finds it delivered.
  cliIt.live(
    "delivers a reminder that came due while the server was down once on the next start, marked late",
    ({ llm, home, graphagent }) =>
      Effect.gen(function* () {
        const file = path.join(home, "remind-restart.db")
        const env = { GRAPHAGENT_DB: file }
        const client = yield* HttpClient.HttpClient
        const headers = { "x-graphagent-directory": encodeURIComponent(home) }

        // Process one: the user sets a reminder in a session, then the process ends.
        const sessionID = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* graphagent.host({ env })
            const created = yield* client.post(`${server.url}/session`, { body: HttpBody.jsonUnsafe({}), headers })
            const session = Schema.decodeUnknownSync(SessionRef)(yield* created.json)
            const res = yield* client.post(`${server.url}/session/${session.id}/command`, {
              body: HttpBody.jsonUnsafe({ command: "remind", arguments: "30m check the L5 smoke test" }),
              headers,
            })
            expect(res.status).toBe(200)
            return session.id
          }),
        )
        expect(yield* statusOf(file, sessionID)).toBe("scheduled")

        // Forty minutes pass with no process running: the reminder came due ten minutes ago.
        yield* Effect.sync(() => {
          const db = new Database(file)
          try {
            db.run("UPDATE reminder SET fire_at = ? WHERE session_id = ?", [Date.now() - 40 * 60_000, sessionID])
          } finally {
            db.close()
          }
        })

        // Process two starts. Its clock moves the reminder, and the instance that loads the session delivers it.
        yield* llm.text("The reminder says to check the L5 smoke test.")
        const messagesOf = (url: string) =>
          client.get(`${url}/session/${sessionID}/message`, { headers }).pipe(Effect.flatMap((res) => res.json))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const second = yield* graphagent.host({ env })
            yield* client.get(`${second.url}/session/${sessionID}`, { headers })
            yield* pollWithTimeout(
              statusOf(file, sessionID).pipe(Effect.map((status) => (status === "delivered" ? status : undefined))),
              "the restarted server did not deliver the reminder",
              "60 seconds",
            )
            const parts = reminderParts(yield* messagesOf(second.url))
            expect(parts).toHaveLength(1)
            expect(parts[0].text).toContain("(delayed 40 minutes)")
            expect(parts[0].text.endsWith("\n\ncheck the L5 smoke test")).toBe(true)
            expect(parts[0].metadata).toMatchObject({ reminder: { creator: "user", delayedMinutes: 40 } })
          }),
        )

        // Process three: nothing is owed any more, so nothing is delivered again.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const third = yield* graphagent.host({ env })
            yield* client.get(`${third.url}/session/${sessionID}`, { headers })
            yield* Effect.sleep("3 seconds")
            expect(reminderParts(yield* messagesOf(third.url))).toHaveLength(1)
          }),
        )
        expect(yield* statusOf(file, sessionID)).toBe("delivered")
      }),
    240_000,
  )
})
