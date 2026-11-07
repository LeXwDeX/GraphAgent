// Regression test for #404: headless /init never stamped project.time_initialized,
// leaving MEMORY fail-closed inert. Root cause: `opencode run "/init"` and serve
// text prompts deliver "/init" as a plain text part at POST /session/:id/message —
// slash routing existed only in the TUI (client-side), so SessionPrompt.command
// never ran, Command.Event.Executed never fired, and the project init listener in
// src/project/project.ts never stamped the row.
//
// Fix under test: the server-side prompt endpoints route single-text-part
// prompts that name a registered command through SessionPrompt.command.
//
// Harness notes (all arms):
// - The project row only exists for git worktrees — a bare temp dir resolves to
//   the global project (src/project/project.ts fromDirectory), so each arm
//   git-inits the fixture home first.
// - test/preload.ts sets GRAPHAGENT_DB=":memory:" globally and the CLI fixture
//   spawns children with the runner env merged in; overriding GRAPHAGENT_DB to ""
//   (falsy → default path) restores the file-backed DB under the isolated home.
// - run.ts resolves its directory from process.env.PWD (leaked from the runner
//   by the fixture), so run arms pin PWD to the fixture home.
// - The row's worktree is Filesystem.resolve'd (realpath); on macOS the fixture
//   home can still be a symlinked path (/var → /private/var), so both
//   spellings are accepted when matching.
import { describe, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { Effect, Schema } from "effect"
import { HttpBody, HttpClient } from "effect/http"
import { cliIt } from "../../lib/cli-process"
import { pollWithTimeout } from "../../lib/effect"

const dbPath = (home: string) => path.join(home, ".local/share/graphagent/graphagent-local.db")

const ProjectRow = Schema.Struct({
  worktree: Schema.String,
  time_initialized: Schema.NullOr(Schema.Number),
})

const SessionRef = Schema.Struct({ id: Schema.String })

const gitInit = (home: string) => Effect.promise(() => Bun.$`git -C ${home} init -q`.quiet().text())

function worktreeCandidates(home: string) {
  try {
    return [home, realpathSync(home)]
  } catch {
    return [home]
  }
}

// Returns time_initialized for the fixture worktree, or undefined while the DB
// file / row / stamp is not there yet.
const stampOf = (home: string) =>
  Effect.sync(() => {
    if (!existsSync(dbPath(home))) return undefined
    const candidates = worktreeCandidates(home)
    const db = new Database(dbPath(home), { readonly: true })
    try {
      const rows = Schema.decodeUnknownSync(Schema.Array(ProjectRow))(
        db.query("SELECT worktree, time_initialized FROM project").all(),
      )
      return rows.find((row) => candidates.includes(row.worktree) && row.time_initialized !== null)?.time_initialized
    } finally {
      db.close()
    }
  })

const expectStamped = (home: string, what: string) =>
  pollWithTimeout(stampOf(home), `${what} did not stamp project.time_initialized`, "10 seconds").pipe(
    Effect.flatMap((stamp) => Effect.sync(() => expect(stamp).toBeGreaterThan(0))),
  )

describe("headless /init stamps project.time_initialized (#404)", () => {
  // The #404 repro: "/init" as a plain text prompt through the run CLI.
  // RED before the fix (the text path never reached SessionPrompt.command).
  cliIt.live(
    'opencode run "/init" stamps the project row',
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        yield* gitInit(home)
        yield* llm.text("AGENTS.md initialized")
        const result = yield* opencode.run("/init", { env: { PWD: home, GRAPHAGENT_DB: "" } })
        opencode.expectExit(result, 0)
        yield* expectStamped(home, 'opencode run "/init"')
      }),
    180_000,
  )

  // Control: the explicit --command flag always used the /command endpoint.
  cliIt.live(
    "opencode run --command init stamps the project row",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        yield* gitInit(home)
        yield* llm.text("AGENTS.md initialized")
        const result = yield* opencode.run("", { command: "init", env: { PWD: home, GRAPHAGENT_DB: "" } })
        opencode.expectExit(result, 0)
        yield* expectStamped(home, "opencode run --command init")
      }),
    180_000,
  )

  // Control: the /command endpoint (what the TUI uses) stamps in a fully
  // headless serve process — proves the stamp chain works without a TUI.
  cliIt.live(
    "serve POST /session/:id/command stamps the project row",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        yield* gitInit(home)
        const server = yield* opencode.host({ env: { GRAPHAGENT_DB: "" } })
        const client = yield* HttpClient.HttpClient
        const headers = { "x-opencode-directory": encodeURIComponent(home) }

        yield* llm.text("AGENTS.md initialized")
        const created = yield* client.post(`${server.url}/session`, { body: HttpBody.jsonUnsafe({}), headers })
        const session = Schema.decodeUnknownSync(SessionRef)(yield* created.json)
        const res = yield* client.post(`${server.url}/session/${session.id}/command`, {
          body: HttpBody.jsonUnsafe({ command: "init", arguments: "" }),
          headers,
        })
        expect(res.status).toBe(200)
        yield* expectStamped(home, "serve /command init")
      }),
    240_000,
  )

  // The #404 serve repro: "/init" as a plain text part at the message endpoint.
  // RED before the fix (the stamp landed only via the /command endpoint).
  cliIt.live(
    'serve POST /session/:id/message with text "/init" stamps the project row',
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        yield* gitInit(home)
        const server = yield* opencode.host({ env: { GRAPHAGENT_DB: "" } })
        const client = yield* HttpClient.HttpClient
        const headers = { "x-opencode-directory": encodeURIComponent(home) }

        yield* llm.text("AGENTS.md initialized")
        const created = yield* client.post(`${server.url}/session`, { body: HttpBody.jsonUnsafe({}), headers })
        const session = Schema.decodeUnknownSync(SessionRef)(yield* created.json)
        const res = yield* client.post(`${server.url}/session/${session.id}/message`, {
          body: HttpBody.jsonUnsafe({ parts: [{ type: "text", text: "/init" }] }),
          headers,
        })
        expect(res.status).toBe(200)
        yield* expectStamped(home, 'serve message "/init"')
      }),
    240_000,
  )
})
