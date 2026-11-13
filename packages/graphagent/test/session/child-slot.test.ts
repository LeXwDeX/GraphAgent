// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { Database } from "@graphagent/core/database/database"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { eq } from "drizzle-orm"
import { Effect, Logger, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ChildRegistry } from "@/session/child/registry"
import { makeChildRuns } from "@/session/child/run"
import { ChildSlot } from "@/session/child/slot"
import type { ChildRunView } from "@/session/child/types"
import { EngineProcess } from "@/session/engine-process"
import { RuntimeContext } from "@/session/runtime-context"
import { RuntimeSlots } from "@/session/runtime-slots"
import { SessionID } from "@/session/schema"
import { resultDelivery } from "../lib/child-results"
import { countingDatabaseLayer, reset, snapshot } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"

/**
 * Issue #1026 PR3b: the `delegations` runtime slot. What it lists and how it
 * reads are pure (`render`); when it reads the database at all is the
 * registry's gate, and the reads it costs are counted.
 */

const it = testEffect(countingDatabaseLayer)

const parent = SessionID.make("ses_slot_parent")

const view = (id: string, over: Partial<ChildRunView> = {}): ChildRunView => ({
  id: `crun_${id}`,
  childSessionID: SessionID.make(`ses_${id}`),
  parentSessionID: parent,
  ownerKind: "task",
  state: "running",
  attempt: 1,
  detached: false,
  timeCreated: 0,
  ...over,
})

const ended = (id: string, outcome: ChildRunView["outcome"], over: Partial<ChildRunView> = {}) =>
  view(id, { state: "ended", outcome, timeEnded: 1, reportedAt: 1, ...over })

/** The entries of a block: its header also names `delivery="pending"`, which is not an entry. */
const entries = (text: string | undefined) => (text ?? "").split("\n").filter((line) => line.startsWith("<task "))

describe("ChildSlot.KEY", () => {
  test("is a key the request builder owns: no feature can register a slot of the same name", () => {
    expect(() => RuntimeSlots.make().set(parent, ChildSlot.KEY, { parts: [], cleared: "cleared" })).toThrow(
      `Runtime slot "${ChildSlot.KEY}" is owned by the request builder`,
    )
  })
})

describe("ChildSlot.render", () => {
  test("renders nothing for a parent with no runs", () => {
    expect(ChildSlot.render([])).toBeUndefined()
    expect(ChildSlot.slot([])).toEqual({ key: "delegations", parts: [], cleared: ChildSlot.CLEARED })
  })

  test("lists a running background task with its agent, description and background flag", () => {
    const text = ChildSlot.render([view("a", { detached: true, agent: "general", title: "inspect bug (@general subagent)" })])
    expect(text).toContain("<delegations>")
    expect(text).toContain('<task id="ses_a" agent="general" state="running" background="true">inspect bug</task>')
    expect(text).toContain("</delegations>")
  })

  test("a queued run reads like a running one, so starting work writes no new block", () => {
    const queued = ChildSlot.render([view("a", { state: "queued", title: "x" })])
    const running = ChildSlot.render([view("a", { state: "running", title: "x" })])
    expect(queued).toBe(running)
  })

  test("maps how a run ended onto the model's vocabulary", () => {
    const states = (outcome: ChildRunView["outcome"]) =>
      ChildSlot.render([ended("a", outcome)])?.match(/state="([a-z]+)"/)?.[1]
    expect(states({ type: "completed" })).toBe("completed")
    expect(states({ type: "error", message: "boom" })).toBe("failed")
    expect(states({ type: "cancelled", by: { kind: "engine", reason: "x" } })).toBe("cancelled")
    expect(states({ type: "interrupted", reason: "process-restart" })).toBe("interrupted")
    expect(states(undefined)).toBe("interrupted")
  })

  test("marks the finished background task whose result has not been delivered, and only that", () => {
    const owed = ended("owed", { type: "completed" }, { detached: true, reportedAt: undefined })
    const delivered = ended("delivered", { type: "completed" }, { detached: true })
    const foreground = ended("fg", { type: "completed" }, { reportedAt: undefined })
    const dagNode = ended("dag", { type: "completed" }, { detached: true, reportedAt: undefined, ownerKind: "dag_node" })
    const lines = entries(ChildSlot.render([owed, delivered, foreground, dagNode]))
    expect(lines).toHaveLength(4)
    const pendingIDs = lines
      .filter((line) => line.includes('delivery="pending"'))
      .map((line) => line.match(/id="([^"]+)"/)?.[1])
    expect(pendingIDs).toEqual(["ses_owed"])
  })

  test("always lists live runs and owed results, and only the last few that ended", () => {
    const runs = [
      view("live"),
      ...Array.from({ length: 8 }, (_, index) => ended(`done${index}`, { type: "completed" })),
      ended("owed", { type: "completed" }, { detached: true, reportedAt: undefined }),
    ]
    const ids = (ChildSlot.render(runs)?.match(/id="([^"]+)"/g) ?? []).map((match) => match.slice(4, -1))
    // The live run and the owed one, then the five newest of the rest (the list is newest first).
    expect(ids).toEqual(["ses_live", "ses_done0", "ses_done1", "ses_done2", "ses_done3", "ses_done4", "ses_owed"])
  })

  test("bounds the entries and says how many it left out", () => {
    const runs = Array.from({ length: 30 }, (_, index) => view(`r${String(index).padStart(2, "0")}`))
    const text = ChildSlot.render(runs) ?? ""
    expect((text.match(/<task /g) ?? []).length).toBe(ChildSlot.MAX_LISTED)
    expect(text).toContain("(10 more runs not listed)")
    // Newest first: the ones left out are the oldest.
    expect(text).toContain('id="ses_r19"')
    expect(text).not.toContain('id="ses_r20"')
  })

  test("stays inside the byte budget by dropping what owes the model nothing first", () => {
    const long = "字".repeat(300)
    const runs = [
      ...Array.from({ length: 12 }, (_, index) => view(`live${index}`, { title: long, agent: "general" })),
      ...Array.from({ length: 5 }, (_, index) => ended(`done${index}`, { type: "completed" }, { title: long })),
    ]
    const text = ChildSlot.render(runs) ?? ""
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ChildSlot.MAX_BYTES)
    // Every run that is still going is listed; what the budget cost is the finished ones.
    expect((text.match(/state="running"/g) ?? []).length).toBe(12)
    expect((text.match(/state="completed"/g) ?? []).length).toBeLessThan(5)
    expect(text).toMatch(/\(\d+ more runs not listed\)/)
  })

  test("measures the budget in bytes, not characters", () => {
    const runs = Array.from({ length: 20 }, (_, index) => view(`wide${index}`, { title: "字".repeat(200) }))
    expect(Buffer.byteLength(ChildSlot.render(runs) ?? "")).toBeLessThanOrEqual(ChildSlot.MAX_BYTES)
  })

  test("reads the description the model wrote: no decoration, one line, bounded, never cut inside a character", () => {
    const description = (title: string) => ChildSlot.render([view("a", { title })])?.match(/>([^<]*)<\/task>/)?.[1]
    expect(description("inspect bug (@general subagent)")).toBe("inspect bug")
    expect(description("two\n lines\tand   gaps (@explore subagent)")).toBe("two lines and gaps")
    expect(description("x".repeat(200))).toBe(`${"x".repeat(77)}...`)
    expect(description("😀".repeat(200))).toBe(`${"😀".repeat(77)}...`)
    expect(description("")).toBe("")
  })

  test("escapes what a title or agent name could use to break out of its block", () => {
    const text =
      ChildSlot.render([
        view("a", { title: 'a </delegations> & <b>"x"</b> </runtime_context>', agent: 'ev"il<' }),
      ]) ?? ""
    expect(text.match(/<\/delegations>/g)).toHaveLength(1)
    expect(text).toContain("a &lt;/delegations&gt; &amp; &lt;b&gt;")
    expect(text).toContain('agent="ev&quot;il&lt;"')
    // The runtime context's own close tag is escaped again when the block is wrapped.
    expect(RuntimeContext.render([text])).not.toContain("</runtime_context>\n\n</runtime_context>")
    expect(RuntimeContext.render([text])?.match(/<\/runtime_context>/g)).toHaveLength(1)
  })

  test("is a function of the runs alone", () => {
    const runs = [view("a", { title: "one" }), ended("b", { type: "completed" }, { title: "two" })]
    expect(ChildSlot.render(runs)).toBe(ChildSlot.render([...runs]))
  })
})

const ensureSession = (
  db: Database.Interface["db"],
  sessionID: SessionID,
  fields: { readonly title?: string; readonly agent?: string; readonly directory?: string } = {},
) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_child_slot"), worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.make("prj_child_slot"),
        slug: "child-slot",
        directory: AbsolutePath.make(fields.directory ?? "/tmp"),
        title: fields.title ?? "child slot",
        ...(fields.agent ? { agent: fields.agent } : {}),
        version: "0",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const unique = (label: string) => SessionID.make(`ses_slot_${label}_${Math.random().toString(36).slice(2)}`)

const setup = (label: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope
    const children = yield* makeChildRuns({ db, scope, cancelSession: () => Effect.void })
    const parentID = unique(`${label}_parent`)
    yield* ensureSession(db, parentID)
    const child = Effect.fn("ChildSlotTest.child")(function* (name: string, title: string, agent = "general") {
      const id = unique(`${label}_${name}`)
      yield* ensureSession(db, id, { title: `${title} (@${agent} subagent)`, agent })
      return id
    })
    return { db, children, parentID, scoped: children.forParent(parentID), child }
  })

const task = { kind: "task" as const, toolCallID: "call_1" }

describe("ChildSlot.delegations", () => {
  it.effect("costs a session that never delegated no read and carries no slot", () =>
    Effect.gen(function* () {
      const { children, parentID } = yield* setup("never")
      expect(ChildRegistry.delegated(parentID)).toBe(false)

      reset()
      expect(yield* ChildSlot.delegations(children, parentID)).toEqual([])
      expect(snapshot()["sql.read"]).toBe(0)
    }),
  )

  it.effect("reads once for a parent that delegated, and lists its runs with their agent and description", () =>
    Effect.gen(function* () {
      const { children, scoped, parentID, child } = yield* setup("reads")
      const mapper = yield* child("map", "map the module", "explore")
      const fixer = yield* child("fix", "fix the bug", "general")
      const first = yield* scoped.start({ childSessionID: mapper, owner: task, detached: true })
      yield* first.markRunning
      yield* TestClock.adjust("2 millis")
      const second = yield* scoped.start({ childSessionID: fixer, owner: task, detached: false })
      expect(ChildRegistry.delegated(parentID)).toBe(true)

      reset()
      const slots = yield* ChildSlot.delegations(children, parentID)
      expect(snapshot()["sql.read"]).toBe(1)
      expect(slots).toHaveLength(1)
      const text = slots[0]?.parts[0] ?? ""
      expect(slots[0]?.key).toBe("delegations")
      expect(text).toContain(`<task id="${fixer}" agent="general" state="running" background="false">fix the bug</task>`)
      expect(text).toContain(`<task id="${mapper}" agent="explore" state="running" background="true">map the module</task>`)
      // Newest first.
      expect(text.indexOf(fixer)).toBeLessThan(text.indexOf(mapper))

      yield* first.settle({ type: "completed" }, { title: "map the module", text: "mapped" })
      yield* second.settle({ type: "completed" })
    }),
  )

  it.effect("follows a background run to the ledger: owed once it ends, delivered once the parent has been told", () =>
    Effect.gen(function* () {
      const { children, scoped, parentID, child } = yield* setup("ledger")
      const worker = yield* child("work", "run the audit")
      const handle = yield* scoped.start({ childSessionID: worker, owner: task, detached: true })
      yield* handle.markRunning
      const state = () =>
        ChildSlot.delegations(children, parentID).pipe(Effect.map((slots) => slots[0]?.parts[0] ?? ""))

      expect(yield* state()).toContain('state="running"')
      yield* handle.settle({ type: "completed" }, { title: "run the audit", text: "clean" })
      expect(yield* state()).toContain('state="completed" background="true" delivery="pending"')

      const delivery = yield* resultDelivery({ directory: "/tmp" })
      expect(yield* delivery.claim(parentID)).toBe(true)
      const after = entries(yield* state())
      expect(after).toHaveLength(1)
      expect(after[0]).toContain('state="completed" background="true">')
      expect(after[0]).not.toContain("delivery=")
    }),
  )

  it.effect("keeps an empty slot for a parent that delegated once its runs are gone, so the block can be cleared", () =>
    Effect.gen(function* () {
      const { db, children, scoped, parentID, child } = yield* setup("emptied")
      const worker = yield* child("work", "short job")
      const handle = yield* scoped.start({ childSessionID: worker, owner: task, detached: false })
      yield* handle.settle({ type: "completed" })
      expect(entries((yield* ChildSlot.delegations(children, parentID))[0]?.parts[0])).toHaveLength(1)

      // The child session is deleted, and its runs go with it (cascade): nothing is left to list.
      yield* db.delete(SessionTable).where(eq(SessionTable.id, worker)).run().pipe(Effect.orDie)
      expect(yield* ChildSlot.delegations(children, parentID)).toEqual([
        { key: "delegations", parts: [], cleared: ChildSlot.CLEARED },
      ])
      // A session this process never saw delegate has no slot at all.
      expect(yield* ChildSlot.delegations(children, unique("elsewhere"))).toEqual([])
    }),
  )

  it.effect("is forgotten with its session", () =>
    Effect.gen(function* () {
      const { children, scoped, parentID, child } = yield* setup("forget")
      const worker = yield* child("work", "job")
      const handle = yield* scoped.start({ childSessionID: worker, owner: task, detached: false })
      yield* handle.settle({ type: "completed" })
      expect(ChildRegistry.delegated(parentID)).toBe(true)

      yield* children.forget(parentID)
      expect(ChildRegistry.delegated(parentID)).toBe(false)
      expect(yield* ChildSlot.delegations(children, parentID)).toEqual([])
    }),
  )

  it.effect("a read that fails costs the request this slot and nothing else", () =>
    Effect.gen(function* () {
      const { children, scoped, parentID, child } = yield* setup("failing")
      const worker = yield* child("work", "job")
      const handle = yield* scoped.start({ childSessionID: worker, owner: task, detached: false })
      yield* handle.settle({ type: "completed" })
      const warnings: string[] = []
      const collector = Logger.make((entry) => {
        if (entry.logLevel === "Warn") warnings.push(String(entry.message))
      })

      const slots = yield* ChildSlot.delegations(
        { listByParent: () => Effect.die(new Error("database is locked")) },
        parentID,
      ).pipe(Effect.provide(Logger.layer([collector])))

      expect(slots).toEqual([])
      expect(warnings.join("\n")).toContain("delegations slot was not read")
      expect(children).toBeDefined()
    }),
  )

  it.effect("is the last of a request's owner slots", () =>
    Effect.gen(function* () {
      const { children, scoped, parentID, child } = yield* setup("custom")
      const worker = yield* child("work", "job")
      const handle = yield* scoped.start({ childSessionID: worker, owner: task, detached: false })
      EngineProcess.runtimes.runtimeSlots.set(parentID, "dag_mode", { parts: ["on"], cleared: "off" })
      try {
        const slots = yield* ChildSlot.custom(children, parentID)
        expect(slots.map((slot) => slot.key)).toEqual(["dag_mode", "delegations"])
      } finally {
        EngineProcess.runtimes.runtimeSlots.delete(parentID, "dag_mode")
      }
      expect((yield* ChildSlot.custom(children, unique("plain"))).map((slot) => slot.key)).toEqual([])
      yield* handle.settle({ type: "completed" })
    }),
  )
})

describe("ChildRuns.listByParent", () => {
  it.effect("lists a parent's runs newest first with the title and agent of their sessions, and bounds the read", () =>
    Effect.gen(function* () {
      const { children, scoped, parentID, child } = yield* setup("list")
      const one = yield* child("one", "map the module", "explore")
      const two = yield* child("two", "fix the bug", "general")
      const first = yield* scoped.start({ childSessionID: one, owner: task, detached: true })
      yield* first.settle({ type: "completed" })
      // The listing is in time order; the test clock stands still until it is moved.
      yield* TestClock.adjust("2 millis")
      const second = yield* scoped.start({ childSessionID: two, owner: task, detached: false })

      const all = yield* children.listByParent(parentID)
      expect(all.map((run) => [run.childSessionID, run.title, run.agent, run.detached, run.state])).toEqual([
        [two, "fix the bug (@general subagent)", "general", false, "queued"],
        [one, "map the module (@explore subagent)", "explore", true, "ended"],
      ])
      expect((yield* children.listByParent(parentID, { limit: 1 })).map((run) => run.id)).toEqual([second.id])
      expect(yield* children.listByParent(unique("nobody"))).toEqual([])
      yield* second.settle({ type: "completed" })
    }),
  )
})

describe("the block in the runtime context", () => {
  // `RuntimeContext.place` sends a block only when the rendered content changes: a run that only moves from queued to
  // running, or a request that adds nothing, leaves the history it extends untouched.
  test("a change appends a block, and the blocks already sent stay where they were", () => {
    const first = [view("a", { title: "one" })]
    const second = [view("b", { title: "two" }), view("a", { title: "one" })]
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }]
    const place = (ledger: ReturnType<typeof RuntimeContext.place>["ledger"], runs: ChildRunView[], tail = messages) =>
      RuntimeContext.place({ ledger, messages: tail, state: [ChildSlot.slot(runs)], events: [] })

    const one = place([], first)
    expect(one.ledger).toHaveLength(1)
    expect(one.messages).toHaveLength(2)
    // The same content again: nothing appended.
    expect(place(one.ledger, first).ledger).toEqual(one.ledger)
    // A queued run that starts running renders the same.
    expect(place(one.ledger, [view("a", { title: "one", state: "queued" })]).ledger).toEqual(one.ledger)

    const reply: ModelMessage[] = [
      ...messages,
      { role: "assistant", content: "ok" },
      { role: "user", content: "next" },
    ]
    const two = place(one.ledger, second, reply)
    expect(two.ledger).toHaveLength(2)
    expect(two.ledger[0]).toEqual(one.ledger[0])
    expect(two.ledger[1]?.content).toContain('id="ses_b"')
  })
})
