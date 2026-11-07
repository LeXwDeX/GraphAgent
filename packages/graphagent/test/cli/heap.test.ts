import { describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import path from "node:path"
import { Heap } from "@/cli/heap"
import { tmpdir } from "../fixture/fixture"

describe("heap snapshot rotation", () => {
  test("prunes old snapshots keeping only the newest", async () => {
    await using dir = await tmpdir()
    const names = [
      "heap-111-20260101T000000000Z",
      "heap-111-20260102T000000000Z",
      "heap-111-20260103T000000000Z",
      "heap-111-20260104T000000000Z",
    ]
    for (const name of names) await fs.writeFile(path.join(dir.path, `${name}.heapsnapshot`), "x")
    await fs.writeFile(path.join(dir.path, "heap-not-a-snapshot.log"), "x")
    await fs.writeFile(path.join(dir.path, "other-20260101T000000000Z.heapsnapshot"), "x")

    await Heap.pruneHeapSnapshots(dir.path)

    expect((await fs.readdir(dir.path)).sort()).toEqual([
      "heap-111-20260103T000000000Z.heapsnapshot",
      "heap-111-20260104T000000000Z.heapsnapshot",
      "heap-not-a-snapshot.log",
      "other-20260101T000000000Z.heapsnapshot",
    ])
  })

  test("leaves fewer snapshots than the retention limit untouched", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(path.join(dir.path, "heap-111-20260101T000000000Z.heapsnapshot"), "x")

    await Heap.pruneHeapSnapshots(dir.path)

    expect(await fs.readdir(dir.path)).toEqual(["heap-111-20260101T000000000Z.heapsnapshot"])
  })

  test("prunes by embedded timestamp when pids differ across runs", async () => {
    await using dir = await tmpdir()
    // Lexicographic order of the full names puts heap-1000-* before heap-999-*,
    // so a name-sorted prune would delete the NEWEST snapshot (1000-0103).
    const names = [
      "heap-999-20260101T000000000Z",
      "heap-999-20260102T000000000Z",
      "heap-1000-20260103T000000000Z",
    ]
    for (const name of names) await fs.writeFile(path.join(dir.path, `${name}.heapsnapshot`), "x")

    await Heap.pruneHeapSnapshots(dir.path)

    expect((await fs.readdir(dir.path)).sort()).toEqual([
      "heap-1000-20260103T000000000Z.heapsnapshot",
      "heap-999-20260102T000000000Z.heapsnapshot",
    ])
  })

  test("tolerates a missing log directory", async () => {
    await expect(Heap.pruneHeapSnapshots(path.join("/", "opencode-missing-log-dir"))).resolves.toBeUndefined()
  })
})
