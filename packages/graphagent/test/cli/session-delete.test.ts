// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Branded DB rows and a narrow Session service mock exercise the delete guard, not the session service.

import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { SessionTurnTable } from "@graphagent/core/session/turn.sql"
import { setLanguage } from "@graphagent/tui/i18n"
import { EngineProcess } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { refuseForeignRuns, sessionTree } from "../../src/cli/cmd/session"
import { testEffect } from "../lib/effect"

// #1584: `session delete` cancels only this process's runs (#1558). It must refuse while another live process still
// runs a turn anywhere below the session, DAG node sessions included, and the check must see exactly the sessions
// `Session.remove` is about to delete.

const id = (label: string) => SessionID.make(`ses_cli_delete_${label}`)

/** root -> [child, sibling], child -> [node], node -> [leaf]; `node` is the session of a DAG node. */
const tree: Record<string, readonly string[]> = {
  [id("root")]: [id("child"), id("sibling")],
  [id("child")]: [id("node")],
  [id("node")]: [id("leaf")],
}
const children = (parentID: SessionID) =>
  Effect.succeed((tree[parentID] ?? []).map((child) => ({ id: SessionID.make(child) })))

const sessions = Layer.mock(Session.Service, {
  children: (parentID) => children(parentID).pipe(Effect.map((found) => found as Session.Info[])),
})
const it = testEffect(Layer.mergeAll(Database.layerFromPath(":memory:"), sessions))

// The refusal names the flag and the pid in any language; pin one so the assertions read the same everywhere.
beforeEach(() => setLanguage("en"))
afterEach(() => setLanguage("en"))

/** The FK parents a `session_turn` row needs, and one `running` turn owned by `runner`. */
const seedRunning = (db: Database.Interface["db"], label: string, runner: string) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: "prj_cli_delete" as never, worktree: "/tmp" as never, sandboxes: ["/tmp"] as never })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: id(label),
        project_id: "prj_cli_delete" as never,
        slug: label,
        directory: "/tmp" as never,
        title: label,
        version: "0",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTurnTable)
      .values({
        id: `turn-cli-delete-${label}`,
        session_id: id(label),
        origin: JSON.stringify({ kind: "user", via: "prompt" }),
        state: "running",
        runner_id: runner,
        time_started: Date.now(),
      })
      .run()
      .pipe(Effect.orDie)
  })

describe("sessionTree", () => {
  it.effect("lists the root and every session below it, however deep, in level order", () =>
    Effect.gen(function* () {
      expect(yield* sessionTree(children, id("root"))).toEqual([
        id("root"),
        id("child"),
        id("sibling"),
        id("node"),
        id("leaf"),
      ])
    }),
  )

  it.effect("lists a session with no children on its own", () =>
    Effect.gen(function* () {
      expect(yield* sessionTree(children, id("leaf"))).toEqual([id("leaf")])
    }),
  )

  it.effect("lists a session that is not stored on its own, as `children` finds nothing for it", () =>
    Effect.gen(function* () {
      expect(yield* sessionTree(children, id("missing"))).toEqual([id("missing")])
    }),
  )

  it.effect("does not loop on a parent link that points back into the tree", () =>
    Effect.gen(function* () {
      const loop = (parentID: SessionID) =>
        children(parentID).pipe(
          Effect.map((found) => (parentID === id("leaf") ? [...found, { id: id("root") }] : found)),
        )
      expect(yield* sessionTree(loop, id("root"))).toEqual([
        id("root"),
        id("child"),
        id("sibling"),
        id("node"),
        id("leaf"),
      ])
    }),
  )
})

describe("refuseForeignRuns", () => {
  it.effect("refuses when another live process runs a turn below the session, and names the session and the pid", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      // The DAG node session: nothing above it is running, the delete would still orphan this turn.
      yield* seedRunning(db, "node", `${process.ppid}:other-process`)

      const error = yield* refuseForeignRuns(id("root")).pipe(Effect.flip)

      expect(error._tag).toBe("CliError")
      expect(error.exitCode).toBe(1)
      expect(error.message).toContain(`${id("node")} (pid ${process.ppid})`)
      expect(error.message).toContain("--force")
    }),
  )

  it.effect("lists every session that another process runs", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedRunning(db, "sibling", `${process.ppid}:a`)
      yield* seedRunning(db, "leaf", `${process.ppid}:b`)

      const error = yield* refuseForeignRuns(id("root")).pipe(Effect.flip)

      expect(error.message).toContain(`${id("sibling")} (pid ${process.ppid}), ${id("leaf")} (pid ${process.ppid})`)
    }),
  )

  it.effect("lets a delete through when the running turns are this process's, dead, or outside the tree", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedRunning(db, "child", EngineProcess.runner.id)
      yield* seedRunning(db, "node", "2147483647:some-nonce")
      yield* seedRunning(db, "elsewhere", `${process.ppid}:other-process`)

      yield* refuseForeignRuns(id("root"))
    }),
  )

  it.effect("lets a delete through when nothing runs", () =>
    Effect.gen(function* () {
      yield* refuseForeignRuns(id("root"))
    }),
  )
})
