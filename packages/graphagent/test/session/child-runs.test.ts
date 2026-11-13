// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { ChildBindingTable, ChildRunTable } from "@graphagent/core/session/child.sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Exit, Option, Scope } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance } from "@/effect/instance-registry"
import type { InstanceContext } from "@/project/instance-context"
import { ChildRegistry } from "@/session/child/registry"
import { ChildStore } from "@/session/child/store"
import { boundedCancel } from "@/session/child/cancel"
import { ChildRuns, makeChildRuns } from "@/session/child/run"
import { EngineProcess } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

/**
 * Issue #1026 PR1: the thin core of the child runs. Rows are real (in-memory
 * database, foreign keys on); the session cancellation is a recording stub
 * because this file owns the ownership, state and race semantics, not the turn
 * loop.
 */

const it = testEffect(Database.layerFromPath(":memory:"))

const parentID = (name: string) => SessionID.make(`ses_cr_${name}_parent_${Math.random().toString(36).slice(2)}`)
const childID = (name: string) => SessionID.make(`ses_cr_${name}_child_${Math.random().toString(36).slice(2)}`)

const ensureSession = (db: Database.Interface["db"], sessionID: SessionID) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_child_runs"), worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.make("prj_child_runs"),
        slug: "child-runs",
        directory: AbsolutePath.make("/tmp"),
        title: "child runs",
        version: "0",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

interface Cancelled {
  readonly sessionID: string
  readonly reason: string | undefined
  readonly actor: string | undefined
}

/** One parent with the ChildRuns factory over the test database and a recording session cancellation. */
const setup = (name: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope
    const cancelled: Cancelled[] = []
    const children = yield* makeChildRuns({
      db,
      scope,
      cancelSession: (sessionID, options) =>
        Effect.sync(() => {
          cancelled.push({ sessionID, reason: options?.reason?.reason, actor: options?.reason?.actor })
        }),
    })
    const parent = parentID(name)
    yield* ensureSession(db, parent)
    const scoped = children.forParent(parent)
    /** Creates a child session row (the task tool creates the real session before it registers a run). */
    const newChild = Effect.fn("ChildRunsTest.newChild")(function* (label = name) {
      const id = childID(label)
      yield* ensureSession(db, id)
      return id
    })
    return { db, children, scoped, parent, cancelled, newChild }
  })

const runRows = (db: Database.Interface["db"], childSessionID: SessionID) =>
  db.select().from(ChildRunTable).where(eq(ChildRunTable.child_session_id, childSessionID)).all().pipe(Effect.orDie)

const bindingRows = (db: Database.Interface["db"], childSessionID: SessionID) =>
  db
    .select()
    .from(ChildBindingTable)
    .where(eq(ChildBindingTable.child_session_id, childSessionID))
    .all()
    .pipe(Effect.orDie)

const taskOwner = { kind: "task" as const, toolCallID: "call_1" }

describe("ChildRuns.start", () => {
  it.effect("writes one binding and one queued run, then walks queued, running, ended", () =>
    Effect.gen(function* () {
      const { db, scoped, parent, newChild } = yield* setup("lifecycle")
      const child = yield* newChild()

      const handle = yield* scoped.start({ childSessionID: child, owner: taskOwner, detached: true })

      const queued = yield* runRows(db, child)
      expect(queued).toHaveLength(1)
      expect(queued[0]).toMatchObject({
        id: handle.id,
        child_session_id: child,
        parent_session_id: parent,
        owner_kind: "task",
        owner_id: "call_1",
        attempt: 1,
        state: "queued",
        detached: true,
        runner_id: EngineProcess.runner.id,
        outcome: null,
        reported_at: null,
        time_ended: null,
      })
      const bindings = yield* bindingRows(db, child)
      expect(bindings).toHaveLength(1)
      expect(bindings[0]).toMatchObject({ parent_session_id: parent, owner_kind: "task", owner_ref: "call_1" })
      expect(ChildRegistry.activeFor(child)?.phase).toBe("queued")

      expect(yield* handle.markRunning).toBe(true)
      expect((yield* runRows(db, child))[0]?.state).toBe("running")
      expect(ChildRegistry.activeFor(child)?.phase).toBe("running")

      expect(yield* handle.settle({ type: "completed" })).toBe(true)
      const ended = (yield* runRows(db, child))[0]
      expect(ended?.state).toBe("ended")
      expect(ended?.outcome).toEqual({ type: "completed" })
      expect(ended?.time_ended).not.toBeNull()
      // A finished run counts as reported the moment it ends.
      expect(ended?.reported_at).toBe(ended?.time_ended ?? -1)
      expect(ChildRegistry.activeFor(child)).toBeUndefined()
      expect(EngineProcess.children.byRun.has(handle.id)).toBe(false)
      expect(yield* handle.settled).toEqual({ type: "completed" })
    }),
  )

  it.effect("keeps an interrupted ending unreported so a later PR can still deliver it", () =>
    Effect.gen(function* () {
      const { db, scoped, newChild } = yield* setup("unreported")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: taskOwner, detached: true })
      yield* handle.settle({ type: "interrupted", reason: "test" })
      const row = (yield* runRows(db, child))[0]
      expect(row?.outcome).toEqual({ type: "interrupted", reason: "test" })
      expect(row?.reported_at).toBeNull()
    }),
  )

  it.effect("bounds a stored error message instead of persisting the whole failure text", () =>
    Effect.gen(function* () {
      const { db, scoped, newChild } = yield* setup("bounded-error")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: taskOwner, detached: false })
      yield* handle.settle({ type: "error", message: "x".repeat(5_000) })
      const outcome = ChildStore.parseOutcome((yield* runRows(db, child))[0]?.outcome)
      expect(outcome?.type).toBe("error")
      if (outcome?.type === "error") expect(outcome.message.length).toBeLessThan(1_100)
    }),
  )
})

describe("run settlement races", () => {
  it.effect("settles exactly once: the later settlement loses and changes nothing", () =>
    Effect.gen(function* () {
      const { db, scoped, newChild } = yield* setup("settle-race")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: taskOwner, detached: false })
      yield* handle.markRunning

      const [first, second] = yield* Effect.all([
        handle.settle({ type: "completed" }),
        handle.settle({ type: "error", message: "late" }),
      ])

      expect([first, second]).toEqual([true, false])
      expect((yield* runRows(db, child))[0]?.outcome).toEqual({ type: "completed" })
    }),
  )

  it.effect("cancel and completion racing leave one terminal state; cancellation wins when it swaps first", () =>
    Effect.gen(function* () {
      const { db, children, scoped, newChild } = yield* setup("cancel-race")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: taskOwner, detached: true })
      yield* handle.markRunning

      // Cancellation swaps the state synchronously; the completion that arrives
      // afterwards is the later settlement.
      const cancelResult = yield* children.cancel(handle.id, { kind: "main_agent_tool", toolCallID: "call_2" })
      const completed = yield* handle.settle({ type: "completed" })

      expect(cancelResult).toBe("cancelled")
      expect(completed).toBe(false)
      const rows = yield* runRows(db, child)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.state).toBe("ended")
      expect(rows[0]?.outcome).toEqual({ type: "cancelled", by: { kind: "main_agent_tool", toolCallID: "call_2" } })
      expect(yield* handle.settled).toEqual({
        type: "cancelled",
        by: { kind: "main_agent_tool", toolCallID: "call_2" },
      })
    }),
  )

  it.effect("completion that swaps first keeps its state and a later cancel is a no-op", () =>
    Effect.gen(function* () {
      const { db, children, scoped, cancelled, newChild } = yield* setup("complete-first")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: taskOwner, detached: true })
      yield* handle.settle({ type: "completed" })

      expect(yield* children.cancel(handle.id, { kind: "main_agent_tool", toolCallID: "call_3" })).toBe("not_active")
      expect((yield* runRows(db, child))[0]?.outcome).toEqual({ type: "completed" })
      expect(cancelled).toEqual([])
    }),
  )
})

describe("ChildRuns.cancel", () => {
  it.effect("ends the run cancelled, revokes the credential, fires the signal and cancels the child turn", () =>
    Effect.gen(function* () {
      const { db, children, scoped, cancelled, newChild } = yield* setup("cancel")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: taskOwner, detached: true })
      yield* handle.markRunning
      const entry = ChildRegistry.activeFor(child)
      expect(entry).toBeDefined()
      expect(ChildRegistry.credentialOf(child)).toBe(entry?.credential)

      const by = { kind: "main_agent_tool" as const, toolCallID: "call_4" }
      expect(yield* children.cancel(handle.id, by)).toBe("cancelled")

      expect(entry?.credential.revoked).toBe(true)
      expect(ChildRegistry.credentialOf(child)).toBeUndefined()
      expect(EngineProcess.children.byRun.size).toBe(0)
      expect(yield* handle.cancelled).toEqual(by)
      const row = (yield* runRows(db, child))[0]
      expect(row?.state).toBe("ended")
      expect(row?.outcome).toEqual({ type: "cancelled", by })
      expect(row?.reported_at).toBe(row?.time_ended ?? -1)
      // The child's own turn is cancelled with a reason naming who asked.
      yield* Effect.yieldNow
      expect(cancelled).toEqual([{ sessionID: child, reason: "task-cancelled", actor: "main-agent" }])
      expect(yield* children.cancel(handle.id, by)).toBe("not_active")
    }),
  )

  it.effect("returns once the run is swapped, without waiting for the child turn to stop", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const scope = yield* Scope.Scope
      const stuck = yield* Deferred.make<void>()
      const children = yield* makeChildRuns({
        db,
        scope,
        cancelSession: () => Deferred.await(stuck),
      })
      const parent = parentID("signal")
      const child = childID("signal")
      yield* ensureSession(db, parent)
      yield* ensureSession(db, child)
      const handle = yield* children.start({
        parentSessionID: parent,
        childSessionID: child,
        owner: taskOwner,
        detached: true,
      })

      const result = yield* children.cancel(handle.id, { kind: "engine", reason: "Parent Cancelled!" })

      expect(result).toBe("cancelled")
      expect((yield* runRows(db, child))[0]?.outcome).toEqual({
        type: "cancelled",
        by: { kind: "engine", reason: "Parent Cancelled!" },
      })
      yield* Deferred.succeed(stuck, undefined)
    }),
  )

  it.effect("maps an engine reason onto a valid abort slug", () =>
    Effect.gen(function* () {
      const { children, scoped, cancelled, newChild } = yield* setup("slug")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: taskOwner, detached: true })
      yield* children.cancel(handle.id, { kind: "engine", reason: "Session_Deleted!" })
      yield* Effect.yieldNow
      expect(cancelled).toEqual([{ sessionID: child, reason: "session-deleted", actor: "child-runs" }])
    }),
  )

  it.effect("a scoped view cannot cancel another parent's run", () =>
    Effect.gen(function* () {
      const { db, children, scoped, newChild } = yield* setup("scoped-cancel")
      const child = yield* newChild()
      const handle = yield* scoped.start({ childSessionID: child, owner: taskOwner, detached: true })
      const other = parentID("scoped-cancel-other")
      yield* ensureSession(db, other)

      const result = yield* children
        .forParent(other)
        .cancel(handle.id, { kind: "main_agent_tool", toolCallID: "call_5" })

      expect(result).toBe("not_active")
      expect(ChildRegistry.activeFor(child)?.phase).toBe("queued")
      expect((yield* runRows(db, child))[0]?.state).toBe("queued")
    }),
  )

  // Real clock: the bound is a timer.
  it.live("the bounded cancellation returns when its time runs out", () =>
    Effect.gen(function* () {
      const exit = yield* boundedCancel(Effect.never, "test", 10).pipe(Effect.timeoutOption("2 seconds"), Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(Option.isSome(exit.value)).toBe(true)
    }),
  )
})

describe("ChildRuns.adopt", () => {
  const refuse = Effect.fn("ChildRunsTest.refuse")(function* (
    scoped: ChildRuns.Scoped,
    childSessionID: SessionID,
    owner: ChildRuns.ChildOwner = taskOwner,
  ) {
    const exit = yield* scoped.adopt({ childSessionID, owner, detached: false }).pipe(Effect.exit)
    return Exit.isFailure(exit) ? exit : undefined
  })

  it.effect("refuses every session this parent did not start as a task and writes no run", () =>
    Effect.gen(function* () {
      const { db, children, scoped, parent, newChild } = yield* setup("not-owner")
      const topLevel = parentID("not-owner-top")
      yield* ensureSession(db, topLevel)
      const mine = yield* newChild("mine")
      yield* scoped.start({ childSessionID: mine, owner: taskOwner, detached: false })
      const sibling = parentID("not-owner-sibling")
      yield* ensureSession(db, sibling)
      const theirs = yield* newChild("theirs")
      const theirHandle = yield* children
        .forParent(sibling)
        .start({ childSessionID: theirs, owner: taskOwner, detached: false })
      yield* theirHandle.settle({ type: "completed" })
      const dagNode = yield* newChild("dag")
      const dagHandle = yield* scoped.start({
        childSessionID: dagNode,
        owner: { kind: "dag_node", workflowID: "wf_1", nodeID: "node_1", attempt: 1 },
        detached: true,
      })
      yield* dagHandle.settle({ type: "completed" })
      const unregistered = yield* newChild("unregistered")

      // Another conversation's task, a top-level session, this very session, a
      // DAG node, and a child session that was never registered.
      const targets: Array<[string, SessionID]> = [
        ["another conversation's task", theirs],
        ["a top-level session", topLevel],
        ["the caller itself", parent],
        ["a DAG node session", dagNode],
        ["a session without a binding", unregistered],
      ]
      for (const [label, target] of targets) {
        const before = (yield* runRows(db, target)).length
        const failure = yield* refuse(scoped, target)
        expect(failure !== undefined, label).toBe(true)
        expect(String(failure), label).toContain("ChildRunNotOwner")
        expect((yield* runRows(db, target)).length, label).toBe(before)
      }
      // The refused attempts left the legitimate rows alone.
      expect(yield* runRows(db, theirs)).toHaveLength(1)
      expect(ChildRegistry.activeFor(mine)?.phase).toBe("queued")
    }),
  )

  it.effect("a running child answers ActiveRunExists; a finished one gets attempt 2 and keeps one binding", () =>
    Effect.gen(function* () {
      const { db, scoped, newChild } = yield* setup("adopt")
      const child = yield* newChild()
      const first = yield* scoped.start({ childSessionID: child, owner: taskOwner, detached: false })

      const busy = yield* refuse(scoped, child)
      expect(String(busy)).toContain("ChildRunActive")
      // The refusal leaves the running run alone: still one row, still queued.
      const refused = yield* runRows(db, child)
      expect(refused).toHaveLength(1)
      expect(refused[0]?.state).toBe("queued")
      expect(refused[0]?.outcome).toBeNull()

      yield* first.settle({ type: "completed" })
      const second = yield* scoped.adopt({
        childSessionID: child,
        owner: { kind: "task", toolCallID: "call_resume" },
        detached: true,
      })

      expect(second.attempt).toBe(2)
      const rows = (yield* runRows(db, child)).toSorted((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0))
      expect(rows.map((row) => [row.attempt, row.state, row.owner_id, row.detached])).toEqual([
        [1, "ended", "call_1", false],
        [2, "queued", "call_resume", true],
      ])
      expect(yield* bindingRows(db, child)).toHaveLength(1)
      yield* second.settle({ type: "completed" })
    }),
  )

  it.effect("releases an active row nobody drives and keeps a live foreign process's row", () =>
    Effect.gen(function* () {
      const { db, scoped, parent, newChild } = yield* setup("orphan")
      const orphan = yield* newChild("orphan")
      const live = yield* newChild("live")
      for (const [child, runner] of [
        [orphan, `${process.pid}:previous-life`],
        [live, `${process.ppid}:other-process`],
      ] as const) {
        yield* db
          .insert(ChildBindingTable)
          .values({ child_session_id: child, parent_session_id: parent, owner_kind: "task" })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(ChildRunTable)
          .values({
            id: `crun_seed_${child}`,
            child_session_id: child,
            parent_session_id: parent,
            owner_kind: "task",
            attempt: 1,
            state: "running",
            runner_id: runner,
          })
          .run()
          .pipe(Effect.orDie)
      }

      const adopted = yield* scoped.adopt({ childSessionID: orphan, owner: taskOwner, detached: false })
      expect(adopted.attempt).toBe(2)
      const orphanRows = (yield* runRows(db, orphan)).toSorted((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0))
      expect(orphanRows[0]?.state).toBe("ended")
      expect(orphanRows[0]?.outcome).toEqual({ type: "interrupted", reason: "orphaned" })

      const blocked = yield* refuse(scoped, live)
      expect(String(blocked)).toContain("ChildRunActive")
      expect((yield* runRows(db, live))[0]?.state).toBe("running")
      yield* adopted.settle({ type: "completed" })
    }),
  )

  // Codex review on #1275: two resumes race; the loser passes the registry check
  // before the winner registers, then reads the winner's freshly inserted row.
  // That row belongs to a registered run of this process and must not be ended
  // as an orphan. The winner's entry is keyed to another session here so the
  // loser's session check misses it, as it did at the moment of the race.
  it.effect("does not release a row whose run this process has registered", () =>
    Effect.gen(function* () {
      const { db, scoped, parent, newChild } = yield* setup("racing")
      const child = yield* newChild("racing")
      const elsewhere = yield* newChild("elsewhere")
      const runID = `crun_seed_${child}`
      yield* db
        .insert(ChildBindingTable)
        .values({ child_session_id: child, parent_session_id: parent, owner_kind: "task" })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ChildRunTable)
        .values({
          id: runID,
          child_session_id: child,
          parent_session_id: parent,
          owner_kind: "task",
          attempt: 1,
          state: "queued",
          runner_id: EngineProcess.runner.id,
        })
        .run()
        .pipe(Effect.orDie)
      const winner = ChildRegistry.create({
        id: runID,
        childSessionID: elsewhere,
        parentSessionID: parent,
        directory: undefined,
        owner: {},
      })
      expect(ChildRegistry.register(winner)).toBe(true)

      const blocked = yield* refuse(scoped, child)
      expect(String(blocked)).toContain("ChildRunActive")
      const rows = yield* runRows(db, child)
      expect(rows.map((row) => [row.id, row.state, row.outcome])).toEqual([[runID, "queued", null]])

      ChildRegistry.end(winner, { type: "completed" })
      ChildRegistry.release(winner)
    }),
  )
})

describe("ChildRuns.recover", () => {
  it.effect("ends the runs of an earlier life and a dead pid, and leaves this process and live foreign ones", () =>
    Effect.gen(function* () {
      const { db, children, parent, newChild } = yield* setup("recover")
      const cases = [
        ["own", EngineProcess.runner.id, "running"],
        ["earlier-life", `${process.pid}:an-earlier-life`, "running"],
        ["bare-own-pid", String(process.pid), "queued"],
        ["dead-pid", "2147483647:nonce", "running"],
        ["missing-runner", null, "queued"],
        ["foreign-alive", `${process.ppid}:some-nonce`, "running"],
      ] as const
      const ids = new Map<string, SessionID>()
      const idOf = (label: string) => {
        const id = ids.get(label)
        if (!id) throw new Error(`no child session for ${label}`)
        return id
      }
      for (const [label, runner, state] of cases) {
        const child = yield* newChild(label)
        ids.set(label, child)
        yield* db
          .insert(ChildBindingTable)
          .values({ child_session_id: child, parent_session_id: parent, owner_kind: "task" })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(ChildRunTable)
          .values({
            id: `crun_${label}`,
            child_session_id: child,
            parent_session_id: parent,
            owner_kind: "task",
            attempt: 1,
            state,
            detached: true,
            runner_id: runner,
          })
          .run()
          .pipe(Effect.orDie)
      }
      const done = yield* newChild("done")
      yield* db
        .insert(ChildBindingTable)
        .values({ child_session_id: done, parent_session_id: parent, owner_kind: "task" })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ChildRunTable)
        .values({
          id: "crun_done",
          child_session_id: done,
          parent_session_id: parent,
          owner_kind: "task",
          attempt: 1,
          state: "ended",
          outcome: { type: "completed" },
          runner_id: "2147483647:nonce",
        })
        .run()
        .pipe(Effect.orDie)

      yield* children.recover()

      const state = (label: string) =>
        runRows(db, idOf(label)).pipe(Effect.map((rows) => [rows[0]?.state, rows[0]?.outcome] as const))
      expect(yield* state("own")).toEqual(["running", null])
      expect(yield* state("foreign-alive")).toEqual(["running", null])
      for (const label of ["earlier-life", "bare-own-pid", "dead-pid", "missing-runner"]) {
        expect(yield* state(label), label).toEqual(["ended", { type: "interrupted", reason: "process-restart" }])
      }
      const swept = (yield* runRows(db, idOf("dead-pid")))[0]
      expect(swept?.time_ended).not.toBeNull()
      // An interrupted detached run was never reported.
      expect(swept?.reported_at).toBeNull()
      expect((yield* runRows(db, done))[0]?.outcome).toEqual({ type: "completed" })
    }),
  )
})

describe("registry cleanup", () => {
  it.effect("a deleted parent ends its runs and leaves no registry entry; the rows cascade away", () =>
    Effect.gen(function* () {
      const { db, children, scoped, parent, newChild } = yield* setup("delete-parent")
      const first = yield* newChild("a")
      const second = yield* newChild("b")
      const a = yield* scoped.start({ childSessionID: first, owner: taskOwner, detached: true })
      const b = yield* scoped.start({ childSessionID: second, owner: taskOwner, detached: false })
      const entryA = ChildRegistry.get(a.id)
      yield* a.markRunning

      yield* db.delete(SessionTable).where(eq(SessionTable.id, parent)).run().pipe(Effect.orDie)
      yield* children.forget(parent)

      expect(EngineProcess.children.byRun.size).toBe(0)
      expect(EngineProcess.children.bySession.size).toBe(0)
      expect(entryA?.credential.revoked).toBe(true)
      expect(yield* a.cancelled).toEqual({ kind: "engine", reason: "session-deleted" })
      expect(yield* b.settled).toEqual({
        type: "cancelled",
        by: { kind: "engine", reason: "session-deleted" },
      })
      expect(yield* bindingRows(db, first)).toHaveLength(0)
      expect(yield* runRows(db, first)).toHaveLength(0)
      expect(yield* runRows(db, second)).toHaveLength(0)
    }),
  )

  it.effect("a deleted child session ends only its own run", () =>
    Effect.gen(function* () {
      const { db, children, scoped, newChild } = yield* setup("delete-child")
      const gone = yield* newChild("gone")
      const stays = yield* newChild("stays")
      yield* scoped.start({ childSessionID: gone, owner: taskOwner, detached: true })
      yield* scoped.start({ childSessionID: stays, owner: taskOwner, detached: true })

      yield* db.delete(SessionTable).where(eq(SessionTable.id, gone)).run().pipe(Effect.orDie)
      yield* children.forget(gone)

      expect(ChildRegistry.activeFor(gone)).toBeUndefined()
      expect(ChildRegistry.activeFor(stays)?.phase).toBe("queued")
    }),
  )

  // The child runs read only `directory` from the instance context.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- partial instance context for a registry directory
  const instance = (directory: string): InstanceContext => ({ directory }) as InstanceContext

  it.effect("disposing the instance ends its runs as interrupted and leaves other instances alone", () =>
    Effect.gen(function* () {
      const { db, scoped, newChild } = yield* setup("dispose")
      const here = yield* newChild("here")
      const elsewhere = yield* newChild("elsewhere")
      const mine = yield* scoped
        .start({ childSessionID: here, owner: taskOwner, detached: true })
        .pipe(Effect.provideService(InstanceRef, instance("/tmp/child-runs-instance-a")))
      yield* scoped
        .start({ childSessionID: elsewhere, owner: taskOwner, detached: true })
        .pipe(Effect.provideService(InstanceRef, instance("/tmp/child-runs-instance-b")))
      yield* mine.markRunning

      yield* Effect.promise(() => disposeInstance("/tmp/child-runs-instance-a"))

      expect(ChildRegistry.activeFor(here)).toBeUndefined()
      const row = (yield* runRows(db, here))[0]
      expect(row?.state).toBe("ended")
      expect(row?.outcome).toEqual({ type: "interrupted", reason: "instance-disposed" })
      expect(ChildRegistry.activeFor(elsewhere)?.phase).toBe("queued")
      expect((yield* runRows(db, elsewhere))[0]?.state).toBe("queued")
    }),
  )

  it.effect("closing the scope that owns the child runs leaves no active row or entry behind", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const inner = yield* Scope.make()
      const children = yield* makeChildRuns({ db, scope: inner, cancelSession: () => Effect.void })
      const parent = parentID("close")
      const child = childID("close")
      yield* ensureSession(db, parent)
      yield* ensureSession(db, child)
      const handle = yield* children.start({
        parentSessionID: parent,
        childSessionID: child,
        owner: taskOwner,
        detached: true,
      })
      yield* handle.markRunning

      yield* Scope.close(inner, Exit.void)

      expect(EngineProcess.children.byRun.size).toBe(0)
      const row = (yield* runRows(db, child))[0]
      expect(row?.state).toBe("ended")
      expect(row?.outcome).toEqual({ type: "interrupted", reason: "runtime-closed" })
    }),
  )
})
