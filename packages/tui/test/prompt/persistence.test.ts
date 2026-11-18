import { expect, test } from "bun:test"
import path from "path"
import { mkdtemp, readdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { appendText, readJson, readText, writeJsonAtomic, writeText } from "../../src/util/persistence"
import { tmpdir as scratch } from "../fixture/fixture"
import { nextTurn } from "../fixture/frames"
import { interceptDisk, waitFor } from "../fixture/held-io"

test("persistence creates parent directories and supports text, append, and JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "graphagent-tui-persistence-"))
  try {
    const textPath = path.join(root, "nested", "state.jsonl")
    await writeText(textPath, "one\n")
    await appendText(textPath, "two\n")
    expect(await readText(textPath)).toBe("one\ntwo\n")

    const jsonPath = path.join(root, "other", "state.json")
    await writeJsonAtomic(jsonPath, { value: 1 })
    expect(await readJson<{ value: number }>(jsonPath)).toEqual({ value: 1 })
    await writeJsonAtomic(jsonPath, { value: 2 })
    expect(await readJson<{ value: number }>(jsonPath)).toEqual({ value: 2 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// Writes to one file run in the order they were issued. The disk is stood in for by `interceptDisk`: a write that is free
// to run reaches it within one turn of the event loop, so `ops` after `nextTurn()` says which ones have started.

test("an append behind a rewrite that is still running lands after it", async () => {
  await using tmp = await scratch()
  const file = path.join(tmp.path, "state.jsonl")
  const disk = interceptDisk(file, "write")
  try {
    const rewrite = writeText(file, "one\n")
    const append = appendText(file, "two\n")
    await nextTurn()
    // Only the rewrite has reached the disk. Unordered, the append would already have run and be truncated by it.
    expect(disk.ops).toEqual(["write"])

    disk.release()
    await Promise.all([rewrite, append])
    expect(disk.ops).toEqual(["write", "append"])
    expect(await readText(file)).toBe("one\ntwo\n")
  } finally {
    disk.restore()
  }
})

test("a rewrite behind an append that is still running replaces it", async () => {
  await using tmp = await scratch()
  const file = path.join(tmp.path, "state.jsonl")
  const disk = interceptDisk(file, "append")
  try {
    const append = appendText(file, "old\n")
    const rewrite = writeText(file, "new\n")
    await nextTurn()
    expect(disk.ops).toEqual(["append"])

    disk.release()
    await Promise.all([append, rewrite])
    expect(disk.ops).toEqual(["append", "write"])
    // Unordered, the rewrite would land first and the append would then put a line back that it had replaced.
    expect(await readText(file)).toBe("new\n")
  } finally {
    disk.restore()
  }
})

test("a failed write does not hold up the writes behind it and rejects only its own caller", async () => {
  await using tmp = await scratch()
  const file = path.join(tmp.path, "state.jsonl")
  const disk = interceptDisk(file, "write")
  try {
    const failed = writeText(file, "lost\n").then(
      () => undefined,
      (error: unknown) => error,
    )
    const behind = appendText(file, "kept\n")
    await nextTurn()
    // The write behind it starts only once the failing one has ended.
    expect(disk.ops).toEqual(["write"])

    disk.fail(new Error("disk full"))
    expect(await failed).toMatchObject({ message: "disk full" })
    await behind
    expect(disk.ops).toEqual(["write", "append"])
    expect(await readText(file)).toBe("kept\n")

    // The failure left nothing behind: a write issued later runs and succeeds.
    await writeText(file, "later\n")
    expect(await readText(file)).toBe("later\n")
  } finally {
    disk.restore()
  }
})

test("writes to different files do not wait for each other", async () => {
  await using tmp = await scratch()
  const held = path.join(tmp.path, "held.jsonl")
  const other = path.join(tmp.path, "other.jsonl")
  const disk = interceptDisk(held, "write")
  try {
    const stuck = writeText(held, "held\n")
    let written = false
    void writeText(other, "other\n").then(() => (written = true))
    await waitFor(() => written, "the write to the other file")
    expect(await readText(other)).toBe("other\n")
    expect(disk.ops).toEqual(["write"])

    disk.release()
    await stuck
    expect(await readText(held)).toBe("held\n")
  } finally {
    disk.restore()
  }
})

test("one file named in two ways shares a queue", async () => {
  await using tmp = await scratch()
  const file = path.join(tmp.path, "state.jsonl")
  const disk = interceptDisk(file, "write")
  try {
    const rewrite = writeText(file, "one\n")
    const append = appendText(`${tmp.path}/./state.jsonl`, "two\n")
    await nextTurn()
    expect(disk.ops).toEqual(["write"])

    disk.release()
    await Promise.all([rewrite, append])
    expect(await readText(file)).toBe("one\ntwo\n")
  } finally {
    disk.restore()
  }
})

test("an atomic JSON write behind another one for the same file waits for it and leaves its own value", async () => {
  await using tmp = await scratch()
  const file = path.join(tmp.path, "state.json")
  const disk = interceptDisk(file, "write")
  try {
    const first = writeJsonAtomic(file, { value: 1 })
    const second = writeJsonAtomic(file, { value: 2 })
    await nextTurn()
    // Only the first one's temporary file has been started. Unordered, the second would already be on its way, could
    // be renamed in before the first, and the first would then leave its older value in the file.
    expect(disk.ops).toEqual(["write"])

    disk.release()
    await Promise.all([first, second])
    expect(disk.ops).toEqual(["write", "rename", "write", "rename"])
    expect(await readJson<{ value: number }>(file)).toEqual({ value: 2 })
    // Each replacement renamed its temporary file away.
    expect(await readdir(tmp.path)).toEqual(["state.json"])
  } finally {
    disk.restore()
  }
})

test("a failed atomic JSON write does not hold up the next one for the same file", async () => {
  await using tmp = await scratch()
  const file = path.join(tmp.path, "state.json")
  const disk = interceptDisk(file, "write")
  try {
    const failed = writeJsonAtomic(file, { value: 1 }).then(
      () => undefined,
      (error: unknown) => error,
    )
    const behind = writeJsonAtomic(file, { value: 2 })
    await nextTurn()
    expect(disk.ops).toEqual(["write"])

    disk.fail(new Error("disk full"))
    expect(await failed).toMatchObject({ message: "disk full" })
    await behind
    // The failed write never got to its rename; the one behind it ran in full.
    expect(disk.ops).toEqual(["write", "write", "rename"])
    expect(await readJson<{ value: number }>(file)).toEqual({ value: 2 })
    expect(await readdir(tmp.path)).toEqual(["state.json"])
  } finally {
    disk.restore()
  }
})
