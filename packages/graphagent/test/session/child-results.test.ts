// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { ChildRunTable } from "@graphagent/core/session/child.sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { eq } from "drizzle-orm"
import { Effect, Exit, Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { SessionCancellation } from "@/session/cancellation"
import { SessionInbox } from "@/session/inbox"
import { ChildRegistry } from "@/session/child/registry"
import { ChildStore } from "@/session/child/store"
import { makeChildRuns, ChildRuns } from "@/session/child/run"
import { EngineProcess } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { resultDelivery, type Admitted } from "../lib/child-results"

/**
 * Issue #1026 PR3a: the `child.result` source, the result ledger of detached
 * child runs. The rows are real (in-memory database, foreign keys on); the
 * admission port is the recording stub of `test/lib/child-results.ts`, which
 * commits the ledger mark in a real transaction. The claims are made directly,
 * the way an inbox drain makes them, so every case is deterministic: no clock,
 * no model, no sleeping. The real admission and inbox are covered in
 * `child-results-runtime.test.ts`.
 */

const it = testEffect(Database.layerFromPath(":memory:"))

const DIRECTORY = "/tmp/child-results"
const OTHER_DIRECTORY = "/tmp/child-results-other"

const unique = (name: string) => `${name}_${Math.random().toString(36).slice(2)}`

const seedSession = (db: Database.Interface["db"], id: SessionID, directory = DIRECTORY) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_child_results"), worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.make("prj_child_results"),
        slug: "child-results",
        directory: AbsolutePath.make(directory),
        title: "child results",
        agent: "build",
        version: "0",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

/** A parent, the ChildRuns factory, and the source over the same database. */
const setup = (name: string, options: { readonly directory?: string } = {}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope
    const children = yield* makeChildRuns({ db, scope, cancelSession: () => Effect.void })
    const parent = SessionID.make(unique(`ses_cres_${name}_parent`))
    yield* seedSession(db, parent, options.directory ?? DIRECTORY)
    const delivery = yield* resultDelivery({ directory: DIRECTORY })
    const scoped = children.forParent(parent)
    const newChild = Effect.fn("ChildResultsTest.newChild")(function* () {
      const id = SessionID.make(unique(`ses_cres_${name}_child`))
      yield* seedSession(db, id, options.directory ?? DIRECTORY)
      return id
    })
    /** A detached task run, ended with a report. */
    const finished = Effect.fn("ChildResultsTest.finished")(function* (text = "all done", title = "inspect bug") {
      const child = yield* newChild()
      const run = yield* scoped.start({
        childSessionID: child,
        owner: { kind: "task", toolCallID: "call_1" },
        detached: true,
      })
      yield* run.markRunning
      yield* run.settle({ type: "completed" }, { title, text })
      return { child, run }
    })
    return { db, scope, children, scoped, parent, delivery, newChild, finished }
  })

const rowOf = (db: Database.Interface["db"], runID: string) =>
  db.select().from(ChildRunTable).where(eq(ChildRunTable.id, runID)).get().pipe(Effect.orDie)

const textPartOf = (admitted: Admitted) => {
  const part = admitted.input.parts[0]
  return part?.type === "text" ? part : undefined
}

const textOf = (admitted: Admitted) => textPartOf(admitted)?.text ?? ""

describe("the ledger of a detached run", () => {
  it.effect("keeps a finished run owed, with its report in the row, until the parent has been told", () =>
    Effect.gen(function* () {
      const { db, parent, finished } = yield* setup("owed")
      const { run } = yield* finished("found the cause", "inspect bug")

      const row = yield* rowOf(db, run.id)
      expect(row?.state).toBe("ended")
      expect(row?.detached).toBe(true)
      // Not reported: the old rule (a finished run counts as reported) is gone for a detached run.
      expect(row?.reported_at).toBeNull()
      expect(row?.outcome).toEqual({ type: "completed", report: { title: "inspect bug", text: "found the cause" } })
      expect(yield* ChildStore.unreportedParents(db, DIRECTORY)).toEqual([parent])
    }),
  )

  it.effect("delivers a fresh result once, join_or_start, as the notice of its report, and marks the row", () =>
    Effect.gen(function* () {
      const { db, parent, delivery, finished } = yield* setup("fresh")
      const { child, run } = yield* finished("found the cause", "inspect bug")

      expect(yield* delivery.claim(parent)).toBe(true)

      expect(delivery.admitted).toHaveLength(1)
      const [admitted] = delivery.admitted
      // A turn is meant: the admission carries no noReply, runs under the cancellation fence, and keeps the tool budget.
      expect(admitted.turn).toBe(true)
      expect(admitted.input.sessionID).toBe(parent)
      expect(admitted.input.agent).toBe("build")
      expect(admitted.options).toEqual({ continueToolBudget: true })
      expect(admitted.extras?.request).toBeDefined()
      expect(admitted.extras?.origin).toEqual({ kind: "inbox", source: "child.result", key: run.id })
      const part = admitted.input.parts[0]
      expect(part).toMatchObject({ type: "text", synthetic: true })
      expect(textOf(admitted)).toContain(`<task id="${child}" state="completed">`)
      expect(textOf(admitted)).toContain("<summary>Background task completed: inspect bug</summary>")
      expect(textOf(admitted)).toContain("found the cause")
      // An agent-started run reads as ordinary background work, and the
      // synthetic part says so for consumers (#1057).
      expect(textOf(admitted).startsWith("<task ")).toBe(true)
      expect(textPartOf(admitted)).toMatchObject({
        metadata: {
          backgroundResult: {
            childSessionID: child,
            initiator: "agent",
            title: "inspect bug",
            status: "completed",
          },
        },
      })
      // The mark committed with the message, and the report left memory.
      expect((yield* rowOf(db, run.id))?.reported_at).not.toBeNull()
      expect(ChildRegistry.reportOf(run.id)).toBeUndefined()
      expect(yield* ChildStore.unreportedParents(db, DIRECTORY)).toEqual([])
    }),
  )

  it.effect("presents a user background command result as findings and carries the run in the part metadata", () =>
    Effect.gen(function* () {
      const { parent, delivery, scoped, newChild } = yield* setup("user-command")
      const child = yield* newChild()
      const run = yield* scoped.start({ childSessionID: child, owner: { kind: "task" }, detached: true })
      yield* run.markRunning
      yield* run.settle(
        { type: "completed" },
        {
          title: "review changes",
          text: "FINDING: the retry path drops the last error",
          initiator: "user",
          command: "review",
        },
      )

      expect(yield* delivery.claim(parent)).toBe(true)

      const admitted = delivery.admitted[0]
      if (!admitted) throw new Error("the user background result was not admitted")
      const text = textOf(admitted)
      expect(text.startsWith("The user ran /review in the background and it has finished.")).toBe(true)
      expect(text).toContain("FINDING: the retry path drops the last error")
      const backgroundResult = textPartOf(admitted)?.metadata?.backgroundResult
      expect(backgroundResult).toMatchObject({
        childSessionID: child,
        initiator: "user",
        command: "review",
        title: "review changes",
        status: "completed",
      })
      expect(typeof backgroundResult?.startedAt).toBe("number")
      expect(typeof backgroundResult?.endedAt).toBe("number")
    }),
  )

  it.effect("tells the parent that a background task failed, with the error text, not as a completion", () =>
    Effect.gen(function* () {
      const { parent, delivery, scoped, newChild } = yield* setup("failed")
      const child = yield* newChild()
      const run = yield* scoped.start({ childSessionID: child, owner: { kind: "task" }, detached: true })
      yield* run.markRunning
      yield* run.settle(
        { type: "error", message: "Subagent output truncated" },
        { title: "inspect bug", text: "Subagent output truncated at the output token cap. Partial output: PARTIAL" },
      )

      expect(yield* delivery.claim(parent)).toBe(true)

      const text = textOf(delivery.admitted[0])
      expect(text).toContain('state="error"')
      expect(text).toContain("<summary>Background task failed: inspect bug</summary>")
      expect(text).toContain("<task_error>")
      expect(text).toContain("PARTIAL")
      expect(text).not.toContain('state="completed"')
    }),
  )

  it.effect("delivers once however often it is claimed: repeated, concurrent and replayed claims", () =>
    Effect.gen(function* () {
      const { db, parent, delivery, finished } = yield* setup("once")
      const { run } = yield* finished()

      // Concurrent claims (a nudge and a tick at once): the mark is the compare-and-swap, one message survives.
      const results = yield* Effect.all([delivery.claim(parent), delivery.claim(parent), delivery.claim(parent)], {
        concurrency: "unbounded",
      })
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(delivery.admitted).toHaveLength(1)

      // A tick or a nudge that comes later finds nothing owed.
      expect(yield* delivery.claim(parent)).toBe(false)
      expect(delivery.admitted).toHaveLength(1)

      // A replay after a restart: the next process's source finds the row reported and delivers nothing.
      const replay = yield* resultDelivery({ directory: DIRECTORY })
      expect(replay.drains).toEqual([])
      expect(yield* replay.claim(parent)).toBe(false)
      expect(replay.admitted).toEqual([])
      expect((yield* rowOf(db, run.id))?.reported_at).not.toBeNull()
    }),
  )

  it.effect("two deliveries that read the owed row before either commits: only the first keeps its message", () =>
    Effect.gen(function* () {
      const { db, parent, finished } = yield* setup("race")
      const { run } = yield* finished()
      // Both claims reach the admission port before either commits, so the compare-and-swap decides, not the order of the reads.
      const racing = yield* resultDelivery({ directory: DIRECTORY, barrier: 2 })

      const results = yield* Effect.all([racing.claim(parent), racing.claim(parent)], { concurrency: "unbounded" })

      expect(results.filter(Boolean)).toHaveLength(1)
      expect(racing.admitted).toHaveLength(1)
      expect((yield* rowOf(db, run.id))?.reported_at).not.toBeNull()
    }),
  )

  it.effect("delivers each owed run of one parent as its own message, oldest ending first", () =>
    Effect.gen(function* () {
      const { parent, delivery, finished } = yield* setup("several")
      yield* finished("first answer", "first task")
      yield* TestClock.adjust("5 millis")
      yield* finished("second answer", "second task")

      expect(yield* delivery.claim(parent)).toBe(true)

      expect(delivery.admitted.map(textOf).map((text) => (text.includes("first answer") ? "first" : "second"))).toEqual(
        ["first", "second"],
      )
    }),
  )

  it.effect("a delivery that fails before its message commits leaves the run owed for the next claim", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { parent, delivery, finished } = yield* setup("retry")
      const { run } = yield* finished()
      // The admission's transaction rolls back after the mark ran inside it: the mark must roll back too.
      const failing = yield* resultDelivery({ directory: DIRECTORY, failAfterMark: true })

      const exit = yield* failing.claim(parent).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(failing.admitted).toEqual([])
      expect((yield* rowOf(db, run.id))?.reported_at).toBeNull()
      expect(yield* delivery.claim(parent)).toBe(true)
      expect(delivery.admitted).toHaveLength(1)
      expect((yield* rowOf(db, run.id))?.reported_at).not.toBeNull()
    }),
  )
})

describe("which results enter the parent's turn, and which are only written", () => {
  it.effect("an ESC after the run ended: the result is written without a turn", () =>
    Effect.gen(function* () {
      const { db, parent, delivery, finished } = yield* setup("esc-after")
      const { run } = yield* finished()
      expect(ChildRegistry.reportOf(run.id)?.epoch).toBe(SessionCancellation.epoch(parent))

      // The user cancels the parent between the run's end and its delivery.
      SessionCancellation.begin(parent).finish()

      expect(yield* delivery.claim(parent)).toBe(true)
      expect(delivery.admitted).toHaveLength(1)
      expect(delivery.admitted[0]?.turn).toBe(false)
      expect(delivery.admitted[0]?.input.noReply).toBe(true)
      expect(delivery.admitted[0]?.extras?.request).toBeUndefined()
      expect(textOf(delivery.admitted[0])).toContain('state="completed"')
      expect((yield* rowOf(db, run.id))?.reported_at).not.toBeNull()
    }),
  )

  it.effect("an ESC between the claim and the admission: the fence refuses the turn, the result is still written", () =>
    Effect.gen(function* () {
      const { parent, delivery, scoped, newChild } = yield* setup("esc-fence")
      // The drain observed the epoch, then the user pressed ESC, then the run ended: the run is fresh by its own
      // epoch, but the drain's observation is stale, so only the fence can stop the turn.
      const observed = SessionCancellation.epoch(parent)
      SessionCancellation.begin(parent).finish()
      const child = yield* newChild()
      const run = yield* scoped.start({ childSessionID: child, owner: { kind: "task" }, detached: true })
      yield* run.settle({ type: "completed" }, { title: "late", text: "late answer" })
      expect(ChildRegistry.reportOf(run.id)?.epoch).toBe(SessionCancellation.epoch(parent))

      expect(yield* delivery.claim(parent, observed)).toBe(true)

      // One admission only: the fenced one never reached the port, the write-only one did.
      expect(delivery.admitted).toHaveLength(1)
      expect(delivery.admitted[0]?.turn).toBe(false)
      expect(textOf(delivery.admitted[0])).toContain("late answer")
    }),
  )

  it.effect("a result left from before a restart is written without a turn, also on the first claim", () =>
    Effect.gen(function* () {
      const { db, parent, finished } = yield* setup("restart")
      const { run } = yield* finished("answer that outlived its process", "old task")
      // The process that ended the run is gone: its in-memory report is.
      ChildRegistry.dropReport(run.id)

      const delivery = yield* resultDelivery({ directory: DIRECTORY })
      // The startup scan found the parent owed and woke the inbox for it, without waiting for a tick.
      expect(delivery.drains).toEqual([parent])
      expect(delivery.source().hint(parent)).toBe(true)
      expect(yield* delivery.claim(parent)).toBe(true)

      expect(delivery.admitted).toHaveLength(1)
      expect(delivery.admitted[0]?.turn).toBe(false)
      expect(textOf(delivery.admitted[0])).toContain("answer that outlived its process")
      expect((yield* rowOf(db, run.id))?.reported_at).not.toBeNull()
      // Answered, the hint is quiet again.
      expect(delivery.source().hint(parent)).toBe(false)
    }),
  )

  it.effect("a run its process lost is told to the parent without a turn, and marked reported", () =>
    Effect.gen(function* () {
      const { db, parent, scoped, newChild } = yield* setup("lost")
      const child = yield* newChild()
      const run = yield* scoped.start({ childSessionID: child, owner: { kind: "task" }, detached: true })
      yield* run.markRunning
      // The process died with the run active. The next process recovers it as interrupted.
      yield* db
        .update(ChildRunTable)
        .set({ runner_id: "2147483000:a-process-that-is-gone" })
        .where(eq(ChildRunTable.id, run.id))
        .run()
        .pipe(Effect.orDie)
      yield* ChildRuns.recover({ db })
      const recovered = yield* rowOf(db, run.id)
      expect(recovered).toMatchObject({ state: "ended", outcome: { type: "interrupted", reason: "process-restart" } })
      expect(recovered?.reported_at).toBeNull()

      const delivery = yield* resultDelivery({ directory: DIRECTORY })
      expect(delivery.drains).toEqual([parent])
      expect(yield* delivery.claim(parent)).toBe(true)

      expect(delivery.admitted).toHaveLength(1)
      expect(delivery.admitted[0]?.turn).toBe(false)
      const text = textOf(delivery.admitted[0])
      expect(text).toContain(`<task id="${child}" state="error">`)
      expect(text).toContain("interrupted")
      expect(text).toContain(`task_id="${child}"`)
      expect((yield* rowOf(db, run.id))?.reported_at).not.toBeNull()
      // Told once.
      expect(yield* delivery.claim(parent)).toBe(false)
      expect(delivery.admitted).toHaveLength(1)
      yield* run.settle({ type: "interrupted", reason: "cleanup" })
    }),
  )

  it.effect("a run that ended interrupted in this process never counts as fresh news", () =>
    Effect.gen(function* () {
      const { parent, delivery, scoped, newChild } = yield* setup("interrupted-here")
      const child = yield* newChild()
      const run = yield* scoped.start({ childSessionID: child, owner: { kind: "task" }, detached: true })
      yield* run.settle({ type: "interrupted", reason: "instance-disposed" })
      expect(ChildRegistry.reportOf(run.id)).toBeUndefined()

      expect(yield* delivery.claim(parent)).toBe(true)

      expect(delivery.admitted).toHaveLength(1)
      expect(delivery.admitted[0]?.turn).toBe(false)
    }),
  )
})

describe("what is never delivered", () => {
  it.effect("a run the main agent cancelled delivers nothing and is marked reported at once", () =>
    Effect.gen(function* () {
      const { db, children, parent, delivery, scoped, newChild } = yield* setup("cancelled")
      const child = yield* newChild()
      const run = yield* scoped.start({ childSessionID: child, owner: { kind: "task" }, detached: true })
      yield* run.markRunning

      yield* children.cancel(run.id, { kind: "main_agent_tool", toolCallID: "call_cancel" })
      // The job it carried finished a moment later and tries to settle with a result: it lost the race.
      expect(yield* run.settle({ type: "completed" }, { title: "late", text: "late answer" })).toBe(false)

      const row = yield* rowOf(db, run.id)
      expect(row?.reported_at).not.toBeNull()
      expect(row?.outcome).toEqual({ type: "cancelled", by: { kind: "main_agent_tool", toolCallID: "call_cancel" } })
      expect(yield* ChildStore.unreportedParents(db, DIRECTORY)).toEqual([])
      expect(yield* delivery.claim(parent)).toBe(false)
      expect(delivery.admitted).toEqual([])
      expect(ChildRegistry.reportOf(run.id)).toBeUndefined()
    }),
  )

  it.effect("a foreground run returns to its tool call: reported when it ends, never delivered", () =>
    Effect.gen(function* () {
      const { db, parent, delivery, scoped, newChild } = yield* setup("foreground")
      const child = yield* newChild()
      const run = yield* scoped.start({ childSessionID: child, owner: { kind: "task" }, detached: false })
      yield* run.markRunning
      yield* run.settle({ type: "completed" })

      const row = yield* rowOf(db, run.id)
      expect(row?.reported_at).toBe(row?.time_ended ?? -1)
      expect(yield* delivery.claim(parent)).toBe(false)
      expect(delivery.admitted).toEqual([])
    }),
  )

  it.effect("a DAG node's run is not the task ledger's: never owed here, whatever its ending", () =>
    Effect.gen(function* () {
      const { db, parent, delivery, scoped, newChild } = yield* setup("dag-node")
      const child = yield* newChild()
      const run = yield* scoped.start({
        childSessionID: child,
        owner: { kind: "dag_node", workflowID: "wf_1", nodeID: "node_1", attempt: 1 },
        detached: true,
      })
      yield* run.markRunning

      yield* run.settle({ type: "completed" }, { title: "node", text: "node output" })

      expect(yield* ChildStore.unreportedParents(db, DIRECTORY)).toEqual([])
      expect(yield* delivery.claim(parent)).toBe(false)
      expect(delivery.admitted).toEqual([])
      // And no fresh-news report is kept for a result nobody will deliver from here.
      expect(ChildRegistry.reportOf(run.id)).toBeUndefined()
    }),
  )

  it.effect("a result of another directory's parent is left to the instance that owns it", () =>
    Effect.gen(function* () {
      const { db, parent, delivery, finished } = yield* setup("foreign", { directory: OTHER_DIRECTORY })
      const { run } = yield* finished()

      expect(yield* ChildStore.unreportedParents(db, DIRECTORY)).toEqual([])
      expect(yield* ChildStore.unreportedParents(db, OTHER_DIRECTORY)).toEqual([parent])
      expect(yield* delivery.claim(parent)).toBe(false)
      expect(delivery.admitted).toEqual([])
      expect((yield* rowOf(db, run.id))?.reported_at).toBeNull()
    }),
  )

  it.effect("a deleted parent owes nothing", () =>
    Effect.gen(function* () {
      const { db, parent, delivery, finished } = yield* setup("deleted")
      yield* finished()

      yield* db.delete(SessionTable).where(eq(SessionTable.id, parent)).run().pipe(Effect.orDie)

      expect(yield* delivery.claim(parent)).toBe(false)
      expect(delivery.admitted).toEqual([])
    }),
  )
})

describe("promoting a foreground run", () => {
  it.effect("detach is one-way and idempotent, and a promoted run that ends is owed to the ledger", () =>
    Effect.gen(function* () {
      const { db, parent, delivery, scoped, newChild } = yield* setup("promote")
      const child = yield* newChild()
      const run = yield* scoped.start({ childSessionID: child, owner: { kind: "task" }, detached: false })
      yield* run.markRunning
      expect((yield* rowOf(db, run.id))?.detached).toBe(false)

      expect(yield* run.detach).toBe(true)
      expect(yield* run.detach).toBe(false)
      expect((yield* rowOf(db, run.id))?.detached).toBe(true)

      yield* run.settle({ type: "completed" }, { title: "promoted", text: "finished in the background" })
      expect((yield* rowOf(db, run.id))?.reported_at).toBeNull()
      expect(yield* delivery.claim(parent)).toBe(true)
      expect(textOf(delivery.admitted[0])).toContain("finished in the background")
    }),
  )

  it.effect("a run that ended before it was promoted keeps the report state its ending wrote", () =>
    Effect.gen(function* () {
      const { db, children, parent, delivery, scoped, newChild } = yield* setup("promote-late")
      const child = yield* newChild()
      const run = yield* scoped.start({ childSessionID: child, owner: { kind: "task" }, detached: false })
      yield* run.settle({ type: "completed" })

      // A late promotion marks the row detached but cannot make a returned result owed again.
      expect(yield* children.detach(run.id)).toBe(true)
      expect((yield* rowOf(db, run.id))?.reported_at).not.toBeNull()
      expect(yield* delivery.claim(parent)).toBe(false)
      expect(yield* children.detach("crun_unknown")).toBe(false)
    }),
  )
})

describe("the ledger scan", () => {
  it.effect("lists the parents with owed results in this directory, each once, through the inbox tick", () =>
    Effect.gen(function* () {
      const { parent, delivery, finished } = yield* setup("scan")
      yield* finished("one", "one")
      yield* finished("two", "two")

      const scan = delivery.source().scan
      if (!scan) throw new Error("the child.result source has no scan")
      expect(yield* scan({ directory: DIRECTORY })).toEqual([parent])
      expect(delivery.source().mode).toBe("join_or_start")
      expect(delivery.source().id).toBe("child.result")
    }),
  )

  it.effect("bounds a stored result and says that it did", () =>
    Effect.gen(function* () {
      const { db, scoped, newChild } = yield* setup("bounded")
      const child = yield* newChild()
      const run = yield* scoped.start({ childSessionID: child, owner: { kind: "task" }, detached: true })
      const text = "x".repeat(ChildStore.MAX_REPORT_CHARS + 1_000)

      yield* run.settle({ type: "completed" }, { title: "big", text })

      const stored = ChildStore.parseReport((yield* rowOf(db, run.id))?.outcome)
      expect(stored?.text.length).toBeLessThan(text.length)
      expect(stored?.text.startsWith("x".repeat(ChildStore.MAX_REPORT_CHARS))).toBe(true)
      expect(stored?.text.endsWith("[truncated 1000 characters]")).toBe(true)
    }),
  )

  it.effect("leaves no report in memory once the owner's scope has closed", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const inner = yield* Scope.make()
      const children = yield* makeChildRuns({ db, scope: inner, cancelSession: () => Effect.void })
      const parent = SessionID.make(unique("ses_cres_scope_parent"))
      const child = SessionID.make(unique("ses_cres_scope_child"))
      yield* seedSession(db, parent)
      yield* seedSession(db, child)
      const run = yield* children
        .forParent(parent)
        .start({ childSessionID: child, owner: { kind: "task" }, detached: true })
      yield* run.settle({ type: "completed" }, { title: "t", text: "x" })
      expect(EngineProcess.children.reports.has(run.id)).toBe(true)

      yield* Scope.close(inner, Exit.void)

      expect(EngineProcess.children.reports.has(run.id)).toBe(false)
      // Its row stays owed: the next process delivers it.
      expect(yield* ChildStore.unreportedParents(db, DIRECTORY)).toContain(parent)
    }),
  )
})

// The real inbox: its 30s tick drives the source under the virtual clock. The runs end without an instance in context,
// so the ending cannot nudge the inbox (and the hint stays quiet): only the tick can find the row.
const tickIt = testEffect(Layer.mergeAll(Database.layerFromPath(":memory:"), SessionInbox.defaultLayer))

const instance: InstanceContext = {
  directory: DIRECTORY,
  worktree: DIRECTORY,
  root: DIRECTORY,
  project: { id: Project.ID.global, worktree: DIRECTORY, time: { created: 0, updated: 0 }, sandboxes: [] },
}

describe("the inbox tick", () => {
  tickIt.effect(
    "delivers an owed result whose nudge was missed, and every later tick, drain and nudge adds nothing",
    () =>
      Effect.gen(function* () {
        const inbox = yield* SessionInbox.Service
        const { db } = yield* Database.Service
        const scope = yield* Scope.Scope
        const children = yield* makeChildRuns({ db, scope, cancelSession: () => Effect.void })
        const parent = SessionID.make(unique("ses_cres_tick_parent"))
        const child = SessionID.make(unique("ses_cres_tick_child"))
        yield* seedSession(db, parent)
        yield* seedSession(db, child)

        const delivery = yield* resultDelivery({ directory: DIRECTORY, inbox })
        yield* inbox.init()
        // Ended without an instance in context: no nudge and no hint, as if the nudge had been missed.
        const run = yield* children
          .forParent(parent)
          .start({ childSessionID: child, owner: { kind: "task", toolCallID: "call_tick" }, detached: true })
          .pipe(Effect.provideService(InstanceRef, undefined))
        yield* run.settle({ type: "completed" }, { title: "tick", text: "found by the tick" })
        expect(delivery.admitted).toEqual([])

        // The first tick: one scan, one forced drain of the parent it names.
        yield* TestClock.adjust("30 seconds")
        for (let turns = 0; delivery.admitted.length === 0; turns++) {
          if (turns > 500) yield* Effect.fail(new Error("the tick never delivered the owed result"))
          yield* Effect.yieldNow
        }
        expect(delivery.admitted).toHaveLength(1)
        // The run ended in this process and no ESC came in since: fresh, so the tick delivers it as the nudge would have.
        expect(delivery.admitted[0]?.turn).toBe(true)
        expect(textOf(delivery.admitted[0])).toContain("found by the tick")
        expect((yield* rowOf(db, run.id))?.reported_at).not.toBeNull()

        // Later ticks, drains and nudges find nothing owed.
        for (let tick = 0; tick < 3; tick++) {
          yield* TestClock.adjust("30 seconds")
          for (let turns = 0; turns < 30; turns++) yield* Effect.yieldNow
        }
        yield* inbox.drain(parent)
        yield* inbox.nudge(parent)
        expect(delivery.admitted).toHaveLength(1)
      }).pipe(Effect.provideService(InstanceRef, instance)),
  )
})
