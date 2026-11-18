// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import path from "path"
import { MAX_HISTORY_ENTRIES, PromptHistoryProvider, usePromptHistory, type PromptInfo } from "../../src/prompt/history"
import { readText } from "../../src/util/persistence"
import { FRAME_WAIT_MS, pause } from "../fixture/frames"
import { TestTuiContexts } from "../fixture/tui-environment"
import { tmpdir } from "../fixture/fixture"

type History = ReturnType<typeof usePromptHistory>

const entry = (input: string): PromptInfo => ({ input, parts: [] })
const jsonl = (entries: readonly PromptInfo[]) => entries.map((item) => JSON.stringify(item)).join("\n") + "\n"

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = FRAME_WAIT_MS) {
  const deadline = performance.now() + timeoutMs
  for (let round = 0; !(await predicate()); round++) {
    if (performance.now() >= deadline) throw new Error(`${what} was not reached within ${timeoutMs}ms`)
    await pause(round)
  }
}

function Probe(props: { ready: (history: History) => void }) {
  props.ready(usePromptHistory())
  return <box />
}

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
  const tmp = await tmpdir()
  const file = path.join(tmp.path, "prompt-history.jsonl")
  await Bun.write(file, jsonl(seed))

  let requested = false
  let release!: (text: string) => void
  const held = new Promise<string>((resolve) => (release = resolve))
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the stub forwards every other call with the arguments it was given.
  const realFile = Bun.file as (...args: unknown[]) => ReturnType<typeof Bun.file>
  const spy = spyOn(Bun, "file").mockImplementation(((target: unknown, ...rest: unknown[]) => {
    const blob = realFile.call(Bun, target, ...rest)
    if (target !== file) return blob
    requested = true
    return Object.assign(blob, { text: () => held })
  }) as typeof Bun.file)

  let history!: History
  let app: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    app = await testRender(
      () => (
        <TestTuiContexts cwd={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
          <PromptHistoryProvider>
            <Probe ready={(value) => (history = value)} />
          </PromptHistoryProvider>
        </TestTuiContexts>
      ),
      { width: 20, height: 5 },
    )
    await waitFor(() => requested, "the provider's startup read through Bun.file(...).text()")
  } catch (error) {
    app?.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
    throw error
  } finally {
    // The provider already holds its read; whatever reads the file from here on must see the real one.
    spy.mockRestore()
  }
  return {
    history,
    file,
    release: () => release(jsonl(seed)),
    /** Waits until the released read has merged into the history and it holds `count` entries. */
    merged: (count: number) => waitFor(() => recalled(history).length === count, `${count} entries in the history`),
    /** Waits for the startup rewrite to leave the file holding exactly `entries`. */
    settled: (entries: readonly PromptInfo[]) =>
      waitFor(async () => (await readText(file)) === jsonl(entries), "the startup rewrite of the history file"),
    async dispose() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
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
  const fixture = await mountWithHeldRead(seed)
  try {
    fixture.history.append(entry("early"))
    fixture.history.appendEphemeral(entry("/btw early"))
    // A write straight to the file would have landed by now; the stale read that resolves after it must not undo it.
    await Bun.sleep(30)
    fixture.release()

    const expected = [...seed, entry("early")]
    await fixture.settled(expected)
    // Neither the rewrite nor a late append changes it afterwards.
    await Bun.sleep(30)
    const text = await readText(fixture.file)
    expect(text).toBe(jsonl(expected))
    expect(text).not.toContain("/btw")
  } finally {
    await fixture.dispose()
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
