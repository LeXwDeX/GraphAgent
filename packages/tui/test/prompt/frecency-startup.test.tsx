// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import path from "path"
import { FrecencyProvider, MAX_FRECENCY_ENTRIES, parseFrecency, useFrecency } from "../../src/prompt/frecency"
import { readText } from "../../src/util/persistence"
import { nextTurn } from "../fixture/frames"
import { interceptDisk, mountStoreWithHeldRead, recordWrites, waitFor } from "../fixture/held-io"

type Entry = ReturnType<typeof parseFrecency>[number]

// 2100-01-01: later than the `lastOpen` of any access the test records.
const FUTURE = 4_102_444_800_000
const jsonl = (entries: readonly Entry[]) => entries.map((item) => JSON.stringify(item)).join("\n") + "\n"

/**
 * Mounts the provider over a frecency file holding the entries `seed` makes for the state directory, with the
 * provider's startup read held back: it resolves only when `release` is called, with the text the file had when the
 * read began. Whatever the test records before that, it records while the read is in flight.
 */
async function mountWithHeldRead(seed: (directory: string) => readonly Entry[]) {
  const fixture = await mountStoreWithHeldRead({
    name: "frecency.jsonl",
    seed: (directory) => jsonl(seed(directory)),
    Provider: FrecencyProvider,
    use: useFrecency,
  })
  const frecency = fixture.store
  const stored = async () => parseFrecency(await readText(fixture.file))
  return {
    frecency,
    file: fixture.file,
    directory: fixture.directory,
    release: fixture.release,
    stored,
    /** The paths the file holds, newest first, relative to the state directory. */
    names: async () => (await stored()).map((item) => path.relative(fixture.directory, item.path)),
    dispose: fixture.dispose,
  }
}

const at = (directory: string, name: string, frequency: number, lastOpen: number): Entry => ({
  path: path.join(directory, name),
  frequency,
  lastOpen,
})

test("a path recorded while the startup read is pending is kept and persisted by the load", async () => {
  const writes = recordWrites()
  try {
    const fixture = await mountWithHeldRead((directory) => [
      at(directory, "b.ts", 1, 2000),
      at(directory, "a.ts", 3, 1000),
    ])
    try {
      fixture.frecency.updateFrecency("early.ts")
      expect(fixture.frecency.getFrecency("early.ts")).toBeGreaterThan(0)
      // Nothing may touch the file before the read lands: an append would be read back or truncated by the load's
      // rewrite, which is what persists the record.
      expect(writes.to(fixture.file)).toEqual([])

      fixture.release()
      await waitFor(() => fixture.frecency.getFrecency("a.ts") > 0, "the load to merge the file's entries")
      expect(fixture.frecency.getFrecency("early.ts")).toBeGreaterThan(0)
      await waitFor(async () => (await fixture.names()).length === 3, "the startup rewrite of the frecency file")
      await writes.landed()
      expect(writes.to(fixture.file).map((item) => item.kind)).toEqual(["write"])
      expect(await fixture.names()).toEqual(["early.ts", "b.ts", "a.ts"])
    } finally {
      await fixture.dispose()
    }
  } finally {
    writes.restore()
  }
})

test("a path recorded while the read was pending and also in the file keeps the record with the later lastOpen", async () => {
  const writes = recordWrites()
  try {
    const fixture = await mountWithHeldRead((directory) => [
      at(directory, "kept.ts", 7, FUTURE),
      at(directory, "stale.ts", 9, 1000),
      at(directory, "other.ts", 2, 500),
    ])
    try {
      fixture.frecency.updateFrecency("kept.ts")
      fixture.frecency.updateFrecency("stale.ts")
      fixture.release()
      await waitFor(() => fixture.frecency.getFrecency("other.ts") > 0, "the load to merge the file's entries")
      await writes.landed()

      const data = fixture.frecency.data()
      const kept = path.join(fixture.directory, "kept.ts")
      const stale = path.join(fixture.directory, "stale.ts")
      // The file's record is the later one: the access recorded before the read does not replace it.
      expect({ ...data[kept] }).toEqual({ frequency: 7, lastOpen: FUTURE })
      // The recorded access is the later one: it replaces the file's record, and starts again from one.
      expect(data[stale]?.frequency).toBe(1)
      expect(data[stale]?.lastOpen).toBeGreaterThan(1000)

      const persisted = await fixture.stored()
      expect(persisted.find((item) => item.path === kept)).toEqual({ path: kept, frequency: 7, lastOpen: FUTURE })
      expect(persisted.find((item) => item.path === stale)).toEqual({
        path: stale,
        frequency: 1,
        lastOpen: data[stale]?.lastOpen,
      })
      expect(persisted).toHaveLength(3)
    } finally {
      await fixture.dispose()
    }
  } finally {
    writes.restore()
  }
})

test("merging past the limit keeps only the newest MAX_FRECENCY_ENTRIES paths", async () => {
  const writes = recordWrites()
  try {
    const fixture = await mountWithHeldRead((directory) =>
      Array.from({ length: MAX_FRECENCY_ENTRIES }, (_, index) =>
        at(directory, `p${index}`, 1, MAX_FRECENCY_ENTRIES - index),
      ),
    )
    try {
      fixture.frecency.updateFrecency("early.ts")
      fixture.release()
      await waitFor(() => fixture.frecency.getFrecency("p0") > 0, "the load to merge the file's entries")
      await writes.landed()

      // 1000 from the file and 1 recorded: the path with the oldest lastOpen falls off.
      const oldest = `p${MAX_FRECENCY_ENTRIES - 1}`
      expect(fixture.frecency.getFrecency(oldest)).toBe(0)
      expect(fixture.frecency.getFrecency("early.ts")).toBeGreaterThan(0)
      const names = await fixture.names()
      expect(names).toHaveLength(MAX_FRECENCY_ENTRIES)
      expect(names[0]).toBe("early.ts")
      expect(names).not.toContain(oldest)
    } finally {
      await fixture.dispose()
    }
  } finally {
    writes.restore()
  }
})

test("a path recorded right after the load is appended behind the load's rewrite, not under it", async () => {
  const fixture = await mountWithHeldRead((directory) => [
    at(directory, "b.ts", 1, 2000),
    at(directory, "a.ts", 3, 1000),
  ])
  const disk = interceptDisk(fixture.file, "write")
  try {
    fixture.release()
    await waitFor(disk.entered, "the startup rewrite to reach the disk")

    fixture.frecency.updateFrecency("late.ts")
    await nextTurn()
    // The rewrite is still on its way to the disk. An append straight to the file would run under it and be truncated.
    expect(disk.ops).toEqual(["write"])

    disk.release()
    await waitFor(async () => (await fixture.names()).includes("late.ts"), "the appended record in the frecency file")
    expect(disk.ops).toEqual(["write", "append"])
    // Each path once: the file is the rewrite plus the one appended line.
    expect((await readText(fixture.file)).trim().split("\n")).toHaveLength(3)
  } finally {
    disk.restore()
    await fixture.dispose()
  }
})

test("a path recorded past the limit is not repeated by the append still on its way when the file is rewritten", async () => {
  const writes = recordWrites()
  try {
    const fixture = await mountWithHeldRead((directory) =>
      Array.from({ length: MAX_FRECENCY_ENTRIES }, (_, index) =>
        at(directory, `p${index}`, 1, MAX_FRECENCY_ENTRIES - index),
      ),
    )
    const disk = interceptDisk(fixture.file, "append")
    try {
      fixture.release()
      await waitFor(() => writes.to(fixture.file).length === 1, "the startup rewrite to be issued")
      await writes.landed()

      // The new path goes over the limit: its record is appended, then the file is rewritten without the oldest path.
      fixture.frecency.updateFrecency("new.ts")
      await nextTurn()
      // The rewrite waits for the append. Unordered, it would land first and the append would then repeat the new path.
      expect(disk.ops).toEqual(["write", "append"])

      disk.release()
      await writes.landed()
      expect(disk.ops).toEqual(["write", "append", "write"])
      const names = await fixture.names()
      expect(names).toHaveLength(MAX_FRECENCY_ENTRIES)
      expect(names.filter((name) => name === "new.ts")).toHaveLength(1)
      expect((await readText(fixture.file)).trim().split("\n")).toHaveLength(MAX_FRECENCY_ENTRIES)
    } finally {
      disk.restore()
      await fixture.dispose()
    }
  } finally {
    writes.restore()
  }
})
