// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Database as BunSqlite } from "bun:sqlite"
import { Database } from "@graphagent/core/database/database"
import { Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"

// `PRAGMA data_version` is the cross-connection fence HistoryView uses to
// detect writes made outside this process. The contract both drivers must
// satisfy: the value is connection-local, a connection's own commits do not
// change its own value, another connection's commit makes the next read
// increase, and read-only statements change nothing.

interface Probe {
  readonly aAfterOpen: number
  readonly bAfterOpen: number
  readonly aAfterOwnWrite: number
  readonly bAfterOwnWrite: number
  readonly aAfterOtherWrite: number
  readonly bAfterOtherWrite: number
  readonly aAfterRead: number
  readonly bAfterRead: number
}

const bunProbe = (filename: string, wal: boolean): Probe => {
  const a = new BunSqlite(filename, { create: true })
  const b = new BunSqlite(filename)
  try {
    if (wal) a.run("PRAGMA journal_mode = WAL")
    a.run("CREATE TABLE IF NOT EXISTS probe (value INTEGER)")
    const version = (db: BunSqlite) =>
      db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version
    const aAfterOpen = version(a)
    const bAfterOpen = version(b)
    a.run("INSERT INTO probe VALUES (1)")
    const aAfterOwnWrite = version(a)
    const bAfterOwnWrite = version(b)
    b.run("INSERT INTO probe VALUES (2)")
    const aAfterOtherWrite = version(a)
    const bAfterOtherWrite = version(b)
    b.query("SELECT count(*) FROM probe").get()
    const aAfterRead = version(a)
    const bAfterRead = version(b)
    return {
      aAfterOpen,
      bAfterOpen,
      aAfterOwnWrite,
      bAfterOwnWrite,
      aAfterOtherWrite,
      bAfterOtherWrite,
      aAfterRead,
      bAfterRead,
    }
  } finally {
    a.close()
    b.close()
  }
}

const NODE_PROBE = `
import { DatabaseSync } from "node:sqlite"
const [file, wal] = process.argv.slice(1)
const a = new DatabaseSync(file)
const b = new DatabaseSync(file)
const version = (db) => db.prepare("PRAGMA data_version").get().data_version
try {
  if (wal === "1") a.exec("PRAGMA journal_mode = WAL")
  a.exec("CREATE TABLE IF NOT EXISTS probe (value INTEGER)")
  const aAfterOpen = version(a)
  const bAfterOpen = version(b)
  a.exec("INSERT INTO probe VALUES (1)")
  const aAfterOwnWrite = version(a)
  const bAfterOwnWrite = version(b)
  b.exec("INSERT INTO probe VALUES (2)")
  const aAfterOtherWrite = version(a)
  const bAfterOtherWrite = version(b)
  b.prepare("SELECT count(*) FROM probe").get()
  const aAfterRead = version(a)
  const bAfterRead = version(b)
  console.log(JSON.stringify({
    aAfterOpen, bAfterOpen,
    aAfterOwnWrite, bAfterOwnWrite,
    aAfterOtherWrite, bAfterOtherWrite,
    aAfterRead, bAfterRead,
  }))
} finally {
  a.close()
  b.close()
}
`

const nodeProbe = (filename: string, wal: boolean): Probe | undefined => {
  const node = Bun.which("node")
  if (!node) return undefined
  const version = Bun.spawnSync([node, "--version"], { stdout: "pipe", stderr: "pipe" })
  if (version.exitCode !== 0) return undefined
  const major = Number(version.stdout.toString().trim().replace(/^v/, "").split(".")[0])
  if (!Number.isFinite(major) || major < 22) return undefined
  const child = Bun.spawnSync([node, "--input-type=module", "-e", NODE_PROBE, filename, wal ? "1" : "0"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (child.exitCode !== 0) throw new Error(`node probe failed: ${child.stderr.toString()}`)
  return JSON.parse(child.stdout.toString().trim()) as Probe
}

const expectContract = (probe: Probe) => {
  // Opening the second connection and reading does not constitute a write.
  expect(probe.aAfterOwnWrite).toBe(probe.aAfterOpen)
  expect(probe.bAfterOwnWrite).toBeGreaterThan(probe.bAfterOpen)
  // b's commit changes a's view, and b's own value stays stable.
  expect(probe.bAfterOtherWrite).toBe(probe.bAfterOwnWrite)
  expect(probe.aAfterOtherWrite).toBeGreaterThan(probe.aAfterOwnWrite)
  // A read-only statement changes nothing.
  expect(probe.aAfterRead).toBe(probe.aAfterOtherWrite)
  expect(probe.bAfterRead).toBe(probe.bAfterOtherWrite)
}

describe("PRAGMA data_version", () => {
  for (const wal of [true, false]) {
    test(`bun:sqlite reports cross-connection commits (${wal ? "WAL" : "journal"})`, async () => {
      await using tmp = await tmpdir()
      expectContract(bunProbe(path.join(tmp.path, "probe.db"), wal))
    })

    test(`node:sqlite reports cross-connection commits (${wal ? "WAL" : "journal"})`, async () => {
      await using tmp = await tmpdir()
      const probe = nodeProbe(path.join(tmp.path, "probe.db"), wal)
      if (!probe) {
        // Older Node versions do not ship node:sqlite; CI pins one that does.
        expect(probe).toBeUndefined()
        return
      }
      expectContract(probe)
    })
  }

  test("the Database service exposes the same fence through its drizzle handle", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "service.db")

    const program = Effect.gen(function* () {
      const a = yield* Layer.build(Database.layerFromPath(filename))
      const dbA = Context.get(a, Database.Service)
      const b = yield* Layer.build(Database.layerFromPath(filename))
      const dbB = Context.get(b, Database.Service)
      const read = (db: Database.Interface["db"]) =>
        db.get<{ data_version: number }>(sql`PRAGMA data_version`).pipe(Effect.map((row) => row!.data_version))

      yield* dbA.db.run("CREATE TABLE IF NOT EXISTS service_probe (value INTEGER)")
      const a0 = yield* read(dbA.db)
      const b0 = yield* read(dbB.db)
      yield* dbA.db.run("INSERT INTO service_probe VALUES (1)")
      const a1 = yield* read(dbA.db)
      const b1 = yield* read(dbB.db)
      yield* dbB.db.run("INSERT INTO service_probe VALUES (2)")
      const a2 = yield* read(dbA.db)
      const b2 = yield* read(dbB.db)
      return { a0, b0, a1, b1, a2, b2 }
    }).pipe(Effect.scoped)

    const observed = await Effect.runPromise(program)
    expect(observed.a1).toBe(observed.a0)
    expect(observed.b1).toBeGreaterThan(observed.b0)
    expect(observed.b2).toBe(observed.b1)
    expect(observed.a2).toBeGreaterThan(observed.a1)
  })
})