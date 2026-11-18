// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { MAX_HISTORY_ENTRIES, PromptHistoryProvider, usePromptHistory, type PromptInfo } from "../../src/prompt/history"
import { readText } from "../../src/util/persistence"
import { nextTurn } from "../fixture/frames"
import { interceptDisk, mountStoreWithHeldRead, recordWrites, waitFor } from "../fixture/held-io"

type History = ReturnType<typeof usePromptHistory>

const entry = (input: string): PromptInfo => ({ input, parts: [] })
const jsonl = (entries: readonly PromptInfo[]) => entries.map((item) => JSON.stringify(item)).join("\n") + "\n"

/** What the up arrow walks through, newest first. The history position ends where it began, on the draft. */
function recalled(history: History) {
  const inputs: string[] = []
  for (;;) {
    const next = history.move(-1, inputs.at(-1) ?? "")
    // At the oldest entry `move` stays put and hands the same entry back.
    if (!next || next.input === inputs.at(-1)) break
    inputs.push(next.input)
  }
  for (const input of [...inputs].reverse()) history.move(1, input)
  return inputs
}

/**
 * Mounts the provider over a history file holding `seed`, with the provider's startup read held back: it resolves
 * only when `release` is called, with the text the file had when the read began. Whatever the test adds to the
 * history before that is added while the read is in flight.
 */
async function mountWithHeldRead(seed: readonly PromptInfo[]) {
  const fixture = await mountStoreWithHeldRead({
    name: "prompt-history.jsonl",
    seed: () => jsonl(seed),
    Provider: PromptHistoryProvider,
    use: usePromptHistory,
  })
  const history = fixture.store
  return {
    history,
    file: fixture.file,
    release: fixture.release,
    /** Waits until the released read has merged into the history and it holds `count` entries. */
    merged: (count: number) => waitFor(() => recalled(history).length === count, `${count} entries in the history`),
    /** Waits for the startup rewrite to leave the file holding exactly `entries`. */
    settled: (entries: readonly PromptInfo[]) =>
      waitFor(async () => (await readText(fixture.file)) === jsonl(entries), "the startup rewrite of the history file"),
    dispose: fixture.dispose,
  }
}

test("entries added while the startup read is pending stay recallable behind the file's entries", async () => {
  const seed = [entry("q0"), entry("q1")]
  const fixture = await mountWithHeldRead(seed)
  try {
    fixture.history.append(entry("early"))
    fixture.history.appendEphemeral(entry("/btw early"))
    // The read has not landed, so only what was just added can be recalled.
    expect(recalled(fixture.history)).toEqual(["/btw early", "early"])

    fixture.release()
    await fixture.merged(4)
    expect(recalled(fixture.history)).toEqual(["/btw early", "early", "q1", "q0"])
    await fixture.settled([...seed, entry("early")])
  } finally {
    await fixture.dispose()
  }
})

test("the startup rewrite keeps entries added while the read was pending and never writes an ephemeral one", async () => {
  const seed = [entry("q0"), entry("q1")]
  const writes = recordWrites()
  try {
    const fixture = await mountWithHeldRead(seed)
    try {
      fixture.history.append(entry("early"))
      fixture.history.appendEphemeral(entry("/btw early"))
      // An append is issued synchronously by `append`, so one straight to the file would be recorded already. Nothing
      // may touch the file before the read lands: the stale read resolving after it would undo it.
      expect(writes.to(fixture.file)).toEqual([])
      fixture.release()

      const expected = [...seed, entry("early")]
      await waitFor(() => writes.to(fixture.file).length > 0, "the startup rewrite to be issued")
      await writes.landed()
      // The load's one rewrite persisted the early entry; no append followed it, so nothing changes the file afterwards.
      expect(writes.to(fixture.file).map((item) => item.kind)).toEqual(["write"])
      const text = await readText(fixture.file)
      expect(text).toBe(jsonl(expected))
      expect(text).not.toContain("/btw")
    } finally {
      await fixture.dispose()
    }
  } finally {
    writes.restore()
  }
})

test("merging past the limit keeps only the newest MAX_HISTORY_ENTRIES entries", async () => {
  const seed = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, index) => entry(`q${index}`))
  const fixture = await mountWithHeldRead(seed)
  try {
    fixture.history.append(entry("early"))
    fixture.history.appendEphemeral(entry("/btw early"))
    fixture.release()

    // 50 from the file and 2 added: the two oldest fall off, and the ephemeral entry counts toward the limit.
    await fixture.merged(MAX_HISTORY_ENTRIES)
    const inputs = recalled(fixture.history)
    expect(inputs.slice(0, 2)).toEqual(["/btw early", "early"])
    expect(inputs.at(-1)).toBe("q2")
    await fixture.settled([...seed.slice(2), entry("early")])
  } finally {
    await fixture.dispose()
  }
})

test("an entry added while the read was pending is not repeated when it equals the file's last one", async () => {
  const seed = [entry("q0"), entry("same")]
  const fixture = await mountWithHeldRead(seed)
  try {
    fixture.history.append(entry("same"))
    fixture.history.append(entry("next"))
    fixture.release()

    await fixture.merged(3)
    expect(recalled(fixture.history)).toEqual(["next", "same", "q0"])
    await fixture.settled([...seed, entry("next")])
  } finally {
    await fixture.dispose()
  }
})

test("the load puts the history position back on the draft", async () => {
  const seed = [entry("q0"), entry("q1")]
  const fixture = await mountWithHeldRead(seed)
  try {
    fixture.history.append(entry("early"))
    // The up arrow while the read is pending lands on the entry just added.
    expect(fixture.history.move(-1, "")?.input).toBe("early")

    fixture.release()
    await fixture.settled([...seed, entry("early")])
    // The next up arrow starts from the newest entry again instead of skipping past it.
    expect(fixture.history.move(-1, "")?.input).toBe("early")
  } finally {
    await fixture.dispose()
  }
})

test("an entry added right after the load is appended behind the load's rewrite, not under it", async () => {
  const seed = [entry("q0"), entry("q1")]
  const fixture = await mountWithHeldRead(seed)
  const disk = interceptDisk(fixture.file, "write")
  try {
    fixture.release()
    await waitFor(disk.entered, "the startup rewrite to reach the disk")

    fixture.history.append(entry("late"))
    await nextTurn()
    // The rewrite is still on its way to the disk. An append straight to the file would run under it and be truncated.
    expect(disk.ops).toEqual(["write"])

    disk.release()
    await fixture.settled([...seed, entry("late")])
    expect(disk.ops).toEqual(["write", "append"])
  } finally {
    disk.restore()
    await fixture.dispose()
  }
})
