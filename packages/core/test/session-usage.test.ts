// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@graphagent/core/database/database"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { findRoot, rootUsage } from "@graphagent/core/session/usage"

const id = (value: string) => SessionSchema.ID.make(value)
const byId = (name: string) => eq(SessionTable.id, id(name))

interface Usage {
  cost?: number
  input?: number
  output?: number
  reasoning?: number
  read?: number
  write?: number
}

/** One `session` row with the usage columns `applyUsage` would have accumulated. */
function row(name: string, parent: string | undefined, usage: Usage = {}) {
  return {
    id: id(name),
    project_id: Project.ID.make("project-1"),
    ...(parent === undefined ? {} : { parent_id: id(parent) }),
    slug: name,
    directory: AbsolutePath.make(process.cwd()),
    title: name,
    version: "test",
    cost: usage.cost ?? 0,
    tokens_input: usage.input ?? 0,
    tokens_output: usage.output ?? 0,
    tokens_reasoning: usage.reasoning ?? 0,
    tokens_cache_read: usage.read ?? 0,
    tokens_cache_write: usage.write ?? 0,
  }
}

/** Inserts the project and the rows, parents before the children that name them. */
function seed(rows: ReadonlyArray<ReturnType<typeof row>>) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("project-1"), worktree: AbsolutePath.make(process.cwd()), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    for (const value of rows) yield* db.insert(SessionTable).values(value).run().pipe(Effect.orDie)
  })
}

/**
 * Two trees:
 *
 *   ses_root ── ses_task ── ses_grand      (task child, grandchild)
 *            └─ ses_dag                    (DAG attempt)
 *   ses_other ── ses_other_child           (an unrelated root)
 */
const tree = [
  row("ses_root", undefined, { cost: 1, input: 100, output: 50, reasoning: 10, read: 20, write: 5 }),
  row("ses_task", "ses_root", { cost: 0.5, input: 40, output: 20, reasoning: 4, read: 8, write: 2 }),
  row("ses_grand", "ses_task", { cost: 0.25, input: 10, output: 5, reasoning: 1, read: 2, write: 1 }),
  row("ses_dag", "ses_root", { cost: 0.125, input: 4, output: 2, reasoning: 0, read: 1, write: 0 }),
  row("ses_other", undefined, { cost: 7, input: 1000, output: 500, reasoning: 100, read: 200, write: 50 }),
  row("ses_other_child", "ses_other", { cost: 3, input: 300, output: 100, reasoning: 0, read: 0, write: 0 }),
]

const run = <A>(effect: Effect.Effect<A, never, Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped))

describe("rootUsage", () => {
  test("sums the root, its task child, the grandchild and the DAG attempt, and nothing from another root", async () => {
    const usage = await run(
      Effect.gen(function* () {
        yield* seed(tree)
        const { db } = yield* Database.Service
        return yield* rootUsage(db, id("ses_root"))
      }),
    )
    expect(usage).toEqual({
      rootID: id("ses_root"),
      sessions: 4,
      cost: 1.875,
      costUnknown: false,
      tokens: { input: 154, output: 77, reasoning: 15, cache: { read: 31, write: 8 } },
    })
  })

  test("another root keeps its own tree", async () => {
    const usage = await run(
      Effect.gen(function* () {
        yield* seed(tree)
        const { db } = yield* Database.Service
        return yield* rootUsage(db, id("ses_other"))
      }),
    )
    expect(usage.sessions).toBe(2)
    expect(usage.cost).toBe(10)
    expect(usage.tokens).toEqual({ input: 1300, output: 600, reasoning: 100, cache: { read: 200, write: 50 } })
  })

  test("a subtree reads from its own head, a leaf is one session", async () => {
    const [middle, leaf] = await run(
      Effect.gen(function* () {
        yield* seed(tree)
        const { db } = yield* Database.Service
        return [yield* rootUsage(db, id("ses_task")), yield* rootUsage(db, id("ses_grand"))] as const
      }),
    )
    expect(middle.sessions).toBe(2)
    expect(middle.cost).toBe(0.75)
    expect(leaf.sessions).toBe(1)
    expect(leaf.cost).toBe(0.25)
  })

  test("a missing root is an empty tree, not an error", async () => {
    const usage = await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* rootUsage(db, id("ses_nobody"))
      }),
    )
    expect(usage).toEqual({
      rootID: id("ses_nobody"),
      sessions: 0,
      cost: 0,
      costUnknown: false,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
  })

  describe("costUnknown", () => {
    const unknown = (rows: ReadonlyArray<ReturnType<typeof row>>, root: string) =>
      run(
        Effect.gen(function* () {
          yield* seed(rows)
          const { db } = yield* Database.Service
          return (yield* rootUsage(db, id(root))).costUnknown
        }),
      )

    test("is false while every session with tokens has a cost", async () => {
      expect(await unknown(tree, "ses_root")).toBe(false)
    })

    test("is false for sessions with neither tokens nor cost", async () => {
      expect(await unknown([row("ses_idle", undefined), row("ses_idle_child", "ses_idle")], "ses_idle")).toBe(false)
    })

    test("is true when one session in the tree recorded tokens at zero cost", async () => {
      const rows = [
        row("ses_root", undefined, { cost: 1, input: 10 }),
        row("ses_task", "ses_root", { cost: 0.5, output: 3 }),
        row("ses_free", "ses_task", { input: 7 }),
      ]
      expect(await unknown(rows, "ses_root")).toBe(true)
    })

    test("counts any of the five token kinds", async () => {
      for (const kind of ["input", "output", "reasoning", "read", "write"] as const) {
        expect(await unknown([row("ses_one", undefined, { [kind]: 1 })], "ses_one")).toBe(true)
      }
    })

    test("is not set by an unpriced session in another tree", async () => {
      const rows = [row("ses_root", undefined, { cost: 1, input: 10 }), row("ses_stranger", undefined, { input: 99 })]
      expect(await unknown(rows, "ses_root")).toBe(false)
      expect(await unknown(rows, "ses_stranger")).toBe(true)
    })
  })

  test("a negative sum (a refund drift) reads as zero cost", async () => {
    const usage = await run(
      Effect.gen(function* () {
        yield* seed([row("ses_drift", undefined, { cost: -0.25, input: 1 })])
        const { db } = yield* Database.Service
        return yield* rootUsage(db, id("ses_drift"))
      }),
    )
    expect(usage.cost).toBe(0)
  })

  test("terminates on a corrupted parent cycle", async () => {
    const usage = await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seed([row("ses_a", undefined, { cost: 1 }), row("ses_b", "ses_a", { cost: 2 })])
        // Corrupt the data after the fact: a points back at its own child.
        yield* db
          .update(SessionTable)
          .set({ parent_id: id("ses_b") })
          .where(byId("ses_a"))
          .run()
          .pipe(Effect.orDie)
        return yield* rootUsage(db, id("ses_a"))
      }),
    )
    expect(usage.sessions).toBe(2)
    expect(usage.cost).toBe(3)
  })
})

describe("findRoot", () => {
  const rootOf = (rows: ReadonlyArray<ReturnType<typeof row>>, name: string) =>
    run(
      Effect.gen(function* () {
        yield* seed(rows)
        const { db } = yield* Database.Service
        return yield* findRoot(db, id(name))
      }),
    )

  test("climbs from a grandchild, a DAG attempt and a task child to the same root", async () => {
    expect(await rootOf(tree, "ses_grand")).toBe(id("ses_root"))
    expect(await rootOf(tree, "ses_dag")).toBe(id("ses_root"))
    expect(await rootOf(tree, "ses_task")).toBe(id("ses_root"))
  })

  test("a root is its own root, and another tree has another root", async () => {
    expect(await rootOf(tree, "ses_root")).toBe(id("ses_root"))
    expect(await rootOf(tree, "ses_other_child")).toBe(id("ses_other"))
  })

  test("stops at the highest session that still exists when a parent row is gone", async () => {
    const rows = [row("ses_orphan", "ses_gone"), row("ses_leaf", "ses_orphan")]
    // `ses_gone` was deleted: the FK-less parent column dangles.
    expect(await rootOf(rows, "ses_leaf")).toBe(id("ses_orphan"))
  })

  test("an unknown id is its own root", async () => {
    expect(await rootOf([], "ses_nobody")).toBe(id("ses_nobody"))
  })

  test("terminates on a corrupted parent cycle", async () => {
    const root = await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seed([row("ses_a", undefined), row("ses_b", "ses_a")])
        yield* db
          .update(SessionTable)
          .set({ parent_id: id("ses_b") })
          .where(byId("ses_a"))
          .run()
          .pipe(Effect.orDie)
        return yield* findRoot(db, id("ses_b"))
      }),
    )
    // Either end of the loop is an acceptable stopping point; the call must return.
    expect(["ses_a", "ses_b"]).toContain(root)
  })
})
