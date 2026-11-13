// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { ChildBindingTable, ChildRunTable } from "@graphagent/core/session/child.sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { Effect, Scope } from "effect"
import { makeChildRuns } from "@/session/child/run"
import { SessionID } from "@/session/schema"
import { countingDatabaseLayer, reset, snapshot } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { resultDelivery } from "../lib/child-results"

/**
 * Issue #1026 PR1: what one child run costs in statements, pinned like the H0
 * engine counts. The child session is written once (`child_binding`, 1 write);
 * every run is three writes (insert queued, update running, update ended). A
 * resumed run adds those three and no binding. A change here is a design
 * change: declare it in the PR, do not widen the numbers.
 *
 * PR3a (the result ledger) adds to that, and only for detached runs: the
 * ending still is one write (it leaves `reported_at` empty instead of setting
 * it), and telling the parent is one more, the compare-and-swap that marks the
 * row reported inside the transaction that commits the transcript message.
 * Promoting a foreground run is one write too (`detach`). A foreground run
 * costs what it always did.
 *
 * The scenarios S1-S7 of `engine-counts.test.ts` contain no task-tool child
 * session (S5's background tasks are created directly), so they stay as they
 * were; this probe is the only place the per-run cost is measured.
 */

const it = testEffect(countingDatabaseLayer)

const seedSessions = (db: Database.Interface["db"], ids: ReadonlyArray<SessionID>) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_child_run_writes"), worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    for (const id of ids)
      yield* db
        .insert(SessionTable)
        .values({
          id,
          project_id: Project.ID.make("prj_child_run_writes"),
          slug: "child-run-writes",
          directory: AbsolutePath.make("/tmp"),
          title: "child run writes",
          version: "0",
        })
        .run()
        .pipe(Effect.orDie)
  })

describe("child run statements", () => {
  it.effect("one binding write and three run writes per run, no binding for a resumed run", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const scope = yield* Scope.Scope
      const children = yield* makeChildRuns({ db, scope, cancelSession: () => Effect.void })
      const parent = SessionID.make("ses_child_run_writes_parent")
      const child = SessionID.make("ses_child_run_writes_child")
      yield* seedSessions(db, [parent, child])
      const scoped = children.forParent(parent)

      reset()
      const first = yield* scoped.start({
        childSessionID: child,
        owner: { kind: "task", toolCallID: "call_1" },
        detached: false,
      })
      // Registration: the binding and the queued run.
      expect(snapshot()["sql.write"]).toBe(2)
      yield* first.markRunning
      expect(snapshot()["sql.write"]).toBe(3)
      yield* first.settle({ type: "completed" })
      const firstRun = snapshot()
      expect(firstRun["sql.write"]).toBe(4)
      // The ending is one statement; a second settlement of the same run writes nothing.
      expect(yield* first.settle({ type: "error", message: "late" })).toBe(false)
      expect(snapshot()["sql.write"]).toBe(4)

      reset()
      const second = yield* scoped.adopt({
        childSessionID: child,
        owner: { kind: "task", toolCallID: "call_2" },
        detached: false,
      })
      const adopted = snapshot()
      // Resuming reads the binding and the latest run, and writes only the queued run.
      expect(adopted["sql.write"]).toBe(1)
      expect(adopted["sql.read"]).toBe(2)
      yield* second.markRunning
      yield* second.settle({ type: "completed" })
      expect(snapshot()["sql.write"]).toBe(3)

      const bindings = yield* db.select().from(ChildBindingTable).all().pipe(Effect.orDie)
      const runs = yield* db.select().from(ChildRunTable).all().pipe(Effect.orDie)
      expect(bindings).toHaveLength(1)
      expect(runs.map((row) => `${row.attempt}:${row.state}`).toSorted((a, b) => a.localeCompare(b))).toEqual([
        "1:ended",
        "2:ended",
      ])
    }),
  )

  it.effect(
    "a detached run costs the foreground run's writes plus one for the delivery mark; a promotion is one write",
    () =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const scope = yield* Scope.Scope
        const children = yield* makeChildRuns({ db, scope, cancelSession: () => Effect.void })
        const parent = SessionID.make("ses_child_run_writes_ledger_parent")
        const child = SessionID.make("ses_child_run_writes_ledger_child")
        const promoted = SessionID.make("ses_child_run_writes_ledger_promoted")
        yield* seedSessions(db, [parent, child, promoted])
        const scoped = children.forParent(parent)
        const delivery = yield* resultDelivery({ directory: "/tmp" })

        reset()
        const run = yield* scoped.start({
          childSessionID: child,
          owner: { kind: "task", toolCallID: "call_1" },
          detached: true,
        })
        yield* run.markRunning
        yield* run.settle({ type: "completed" }, { title: "ledger", text: "done" })
        // Binding + queued run, running, ended: the same four writes as a foreground run. Left owed, not reported.
        expect(snapshot()["sql.write"]).toBe(4)

        // The delivery: the claim reads the parent and the owed rows, and the mark is its only write besides the
        // admission's own transaction (the stub port writes no message row).
        reset()
        expect(yield* delivery.claim(parent)).toBe(true)
        const claim = snapshot()
        expect(claim["sql.read"]).toBe(2)
        expect(claim["sql.write"]).toBe(1)
        // Nothing is owed any more: a second claim reads the parent and the owed rows again and writes nothing.
        reset()
        expect(yield* delivery.claim(parent)).toBe(false)
        expect(snapshot()["sql.write"]).toBe(0)

        // Promoting a foreground run: one write, and a second promotion writes nothing that changes the row.
        reset()
        const fg = yield* scoped.start({ childSessionID: promoted, owner: { kind: "task" }, detached: false })
        expect(snapshot()["sql.write"]).toBe(2)
        reset()
        expect(yield* fg.detach).toBe(true)
        expect(snapshot()["sql.write"]).toBe(1)
        expect(yield* fg.detach).toBe(false)
      }),
  )

  it.effect("cancelling a run is one write for its ending, not a second one for the child turn", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const scope = yield* Scope.Scope
      const children = yield* makeChildRuns({ db, scope, cancelSession: () => Effect.void })
      const parent = SessionID.make("ses_child_run_writes_cancel_parent")
      const child = SessionID.make("ses_child_run_writes_cancel_child")
      yield* seedSessions(db, [parent, child])
      const run = yield* children.start({
        parentSessionID: parent,
        childSessionID: child,
        owner: { kind: "task" },
        detached: true,
      })
      yield* run.markRunning

      reset()
      yield* children.cancel(run.id, { kind: "main_agent_tool", toolCallID: "call_cancel" })

      expect(snapshot()["sql.write"]).toBe(1)
    }),
  )
})
