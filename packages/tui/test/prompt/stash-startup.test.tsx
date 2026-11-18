// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import {
  MAX_STASH_ENTRIES,
  PromptStashProvider,
  parsePromptStash,
  usePromptStash,
  type StashEntry,
} from "../../src/prompt/stash"
import { readText } from "../../src/util/persistence"
import { nextTurn } from "../fixture/frames"
import { interceptDisk, mountStoreWithHeldRead, recordWrites, waitFor } from "../fixture/held-io"

type Stash = ReturnType<typeof usePromptStash>

const stashed = (input: string, timestamp: number): StashEntry => ({ input, parts: [], timestamp })
const jsonl = (entries: readonly StashEntry[]) => entries.map((item) => JSON.stringify(item)).join("\n") + "\n"
const inputs = (stash: Stash) => stash.list().map((item) => item.input)

/**
 * Mounts the provider over a stash file holding `seed`, with the provider's startup read held back: it resolves only
 * when `release` is called, with the text the file had when the read began. Whatever the test does to the stash before
 * that, it does while the read is in flight.
 */
async function mountWithHeldRead(seed: readonly StashEntry[]) {
  const fixture = await mountStoreWithHeldRead({
    name: "prompt-stash.jsonl",
    seed: () => jsonl(seed),
    Provider: PromptStashProvider,
    use: usePromptStash,
  })
  const stash = fixture.store
  return {
    stash,
    file: fixture.file,
    release: fixture.release,
    /** Waits until the released read has merged into the stash and it lists `names`. */
    merged: (names: readonly string[]) =>
      waitFor(() => inputs(stash).join() === names.join(), `${names.join()} in the stash`),
    /** Waits for the file to hold exactly what the stash lists. */
    settled: () =>
      waitFor(async () => (await readText(fixture.file)) === jsonl(stash.list()), "the stash file to match the stash"),
    dispose: fixture.dispose,
  }
}

test("an entry stashed while the startup read is pending is kept behind the file's entries and persisted by the load", async () => {
  const seed = [stashed("s0", 1), stashed("s1", 2)]
  const writes = recordWrites()
  try {
    const fixture = await mountWithHeldRead(seed)
    try {
      fixture.stash.push({ input: "early", parts: [] })
      // The read has not landed, so only what was just stashed is listed. Nothing may touch the file before it does: an
      // append would be read back or lost, and a rewrite from here would hold only what is in memory.
      expect(inputs(fixture.stash)).toEqual(["early"])
      expect(writes.to(fixture.file)).toEqual([])

      fixture.release()
      await fixture.merged(["s0", "s1", "early"])
      await fixture.settled()
      await writes.landed()
      // The load's one rewrite persisted the early entry; no append followed it.
      expect(writes.to(fixture.file).map((item) => item.kind)).toEqual(["write"])
      expect(parsePromptStash(await readText(fixture.file)).map((item) => item.input)).toEqual(["s0", "s1", "early"])
    } finally {
      await fixture.dispose()
    }
  } finally {
    writes.restore()
  }
})

test("entries popped or removed while the startup read is pending never rewrite the file under it", async () => {
  const seed = [stashed("s0", 1), stashed("s1", 2)]
  const writes = recordWrites()
  try {
    const fixture = await mountWithHeldRead(seed)
    try {
      fixture.stash.push({ input: "a", parts: [] })
      fixture.stash.push({ input: "b", parts: [] })
      expect(fixture.stash.pop()?.input).toBe("b")
      fixture.stash.remove(0)
      expect(inputs(fixture.stash)).toEqual([])
      // A rewrite of what is in memory would be an empty file, in place of the entries that were never read.
      expect(writes.to(fixture.file)).toEqual([])

      fixture.release()
      await fixture.merged(["s0", "s1"])
      // The file ends up as the load rewrote it, which is what the seed held.
      await writes.landed()
      expect(await readText(fixture.file)).toBe(jsonl(seed))
    } finally {
      await fixture.dispose()
    }
  } finally {
    writes.restore()
  }
})

test("merging past the limit keeps only the newest MAX_STASH_ENTRIES entries", async () => {
  const seed = Array.from({ length: MAX_STASH_ENTRIES }, (_, index) => stashed(`s${index}`, index))
  const fixture = await mountWithHeldRead(seed)
  try {
    fixture.stash.push({ input: "early", parts: [] })
    fixture.release()

    // 50 from the file and 1 added: the oldest falls off.
    await fixture.merged([...seed.slice(1).map((item) => item.input), "early"])
    await fixture.settled()
    expect(parsePromptStash(await readText(fixture.file))).toHaveLength(MAX_STASH_ENTRIES)
  } finally {
    await fixture.dispose()
  }
})

test("an entry stashed right after the load is appended behind the load's rewrite, not under it", async () => {
  const seed = [stashed("s0", 1), stashed("s1", 2)]
  const fixture = await mountWithHeldRead(seed)
  const disk = interceptDisk(fixture.file, "write")
  try {
    fixture.release()
    await waitFor(disk.entered, "the startup rewrite to reach the disk")

    fixture.stash.push({ input: "late", parts: [] })
    await nextTurn()
    // The rewrite is still on its way to the disk. An append straight to the file would run under it and be truncated.
    expect(disk.ops).toEqual(["write"])

    disk.release()
    await fixture.settled()
    expect(disk.ops).toEqual(["write", "append"])
    expect(parsePromptStash(await readText(fixture.file)).map((item) => item.input)).toEqual(["s0", "s1", "late"])
  } finally {
    disk.restore()
    await fixture.dispose()
  }
})

test("an entry popped right after it was stashed is not put back by the append still on its way", async () => {
  const seed = [stashed("s0", 1), stashed("s1", 2)]
  const writes = recordWrites()
  try {
    const fixture = await mountWithHeldRead(seed)
    const disk = interceptDisk(fixture.file, "append")
    try {
      fixture.release()
      await waitFor(() => writes.to(fixture.file).length === 1, "the startup rewrite to be issued")
      await writes.landed()

      fixture.stash.push({ input: "x", parts: [] })
      await waitFor(disk.entered, "the append to reach the disk")
      expect(fixture.stash.pop()?.input).toBe("x")
      await nextTurn()
      // The rewrite for the pop waits for the append. Unordered, it would land first and the append would put the
      // popped entry back at the end of the file.
      expect(disk.ops).toEqual(["write", "append"])

      disk.release()
      await writes.landed()
      expect(disk.ops).toEqual(["write", "append", "write"])
      expect(await readText(fixture.file)).toBe(jsonl(seed))
    } finally {
      disk.restore()
      await fixture.dispose()
    }
  } finally {
    writes.restore()
  }
})
