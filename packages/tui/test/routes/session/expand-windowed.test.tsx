// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextRenderable, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import type { Part } from "@graphagent/sdk"
import { WINDOW_MIN_ROWS } from "../../../src/routes/session/rows"
import { createFixture, type PerfFixture } from "../../perf/fixtures"
import { mountHarness, type PerfHarness } from "../../perf/harness"
import { settleScroll } from "../../perf/scenarios"
import { readFrame } from "../dag-mode-harness"

/**
 * `view.expand.toggle` in a windowed transcript (#886 4.4, section 5). Past `WINDOW_MIN_ROWS` rows the transcript
 * mounts the viewport, its overscan and the last four rows, and unmounts every other block. The blocks the key
 * has to open are mostly among those: it reads the parts in the store, opens one by its view flag, and the flag
 * pins the row, which then mounts open wherever the viewport is.
 */

type Block = { index: number; kind: "bash" | "reasoning" | "edit" }

/**
 * The XL fixture with plain text everywhere but at `blocks`: 2200 parts, 22 to each of 100 messages, so the
 * transcript is windowed and the blocks are the only things in it that fold. The reasoning carries its index as
 * the title of its header, a bash call as the command and the lines it prints, and an edit as the file it changed.
 */
function windowedWith(blocks: readonly Block[]): PerfFixture {
  const fixture = createFixture("XL")
  const kinds = new Map(blocks.map((block) => [block.index, block.kind]))
  for (const entry of fixture.messages) {
    entry.parts = entry.parts.map((part): Part => {
      const index = Number(part.id.slice(part.id.lastIndexOf("_") + 1))
      const base = { id: part.id, sessionID: part.sessionID, messageID: part.messageID }
      const time = { start: index, end: index + 1 }
      const kind = kinds.get(index)
      if (kind === "reasoning") {
        return { ...base, type: "reasoning", text: `**Block ${index}**\n\nThe reasoning of block ${index}.`, time }
      }
      if (kind === "bash") {
        const output = Array.from({ length: 30 }, (_, line) => `block ${index} line ${line}`).join("\n")
        return {
          ...base,
          type: "tool",
          callID: `call_${index}`,
          tool: "bash",
          state: {
            status: "completed",
            input: { command: `printf block-${index}` },
            output,
            title: "Deterministic tool",
            metadata: { output },
            time,
          },
        }
      }
      if (kind === "edit") {
        const file = `src/edit-${index}.ts`
        const diff = ["--- a", "+++ b", "@@ -1 +1 @@", `-old ${index}`, `+new ${index}`, ""].join("\n")
        return {
          ...base,
          type: "tool",
          callID: `call_${index}`,
          tool: "edit",
          state: {
            status: "completed",
            input: { filePath: file },
            output: "Edit applied successfully.",
            title: "Deterministic edit",
            metadata: { diff, filediff: { file, patch: diff, additions: 1, deletions: 1 }, diagnostics: {} },
            time,
          },
        }
      }
      return { ...base, type: "text", text: `Plain row ${index}.`, time }
    })
  }
  return fixture
}

function texts(node: Renderable): string[] {
  return [...(node instanceof TextRenderable ? [node.plainText] : []), ...node.getChildren().flatMap(texts)]
}

/** The mounted child of the scroll box that holds `text`. Rows outside the window are not there. */
function holding(scroll: ScrollBoxRenderable, text: string) {
  return scroll.getChildren().find((row) => texts(row).some((line) => line.includes(text)))
}

/**
 * The blocks that are open, among the rows that are mounted. An open block is pinned, so it is mounted wherever
 * the viewport is; a folded one is mounted only inside the window, which holds plain text here.
 */
function openBlocks(scroll: ScrollBoxRenderable) {
  const open: string[] = []
  for (const row of scroll.getChildren()) {
    const text = texts(row).join("\n")
    const bash = /Bash printf block-(\d+)/.exec(text)
    if (bash && text.includes("ctrl+o collapse")) open.push(`bash ${bash[1]}`)
    const reasoning = /- Thought: Block (\d+)/.exec(text)
    if (reasoning) open.push(`reasoning ${reasoning[1]}`)
    const edit = /Edit src\/edit-(\d+)\.ts/.exec(text)
    if (edit && text.includes("ctrl+o collapse")) open.push(`edit ${edit[1]}`)
  }
  return open.sort()
}

/** The session as the reader has it configured: the scroll box follows the end, and the viewport is there. */
async function atTheEnd(harness: PerfHarness) {
  await harness.reset()
  // The session route scrolls to the last message 50ms after mount; let that timer run first.
  await Bun.sleep(60)
  const scroll = harness.scroll()!
  scroll.stickyScroll = true
  scroll.scrollTo(Infinity)
  await settleScroll(harness)
  return scroll
}

async function pressExpand(harness: PerfHarness) {
  harness.app.mockInput.pressKey("o", { ctrl: true })
  await settleScroll(harness)
}

/** Reasonings and bash calls spread over the transcript, the latest 49 rows before the end. */
const BLOCKS: readonly Block[] = [
  { index: 60, kind: "reasoning" },
  { index: 900, kind: "bash" },
  { index: 1500, kind: "reasoning" },
  { index: 2100, kind: "bash" },
  { index: 2150, kind: "reasoning" },
]

test("the most recent block opens although a long plain tail has unmounted it", async () => {
  const fixture = windowedWith(BLOCKS)
  expect(fixture.rows).toBeGreaterThanOrEqual(WINDOW_MIN_ROWS)
  const harness = await mountHarness(fixture)
  try {
    const scroll = await atTheEnd(harness)
    // The premise: windowed, with the viewport at the end, and the latest blocks far from what is mounted.
    const seen = await readFrame(harness.app)
    expect(seen).toContain("Plain row 2199")
    expect(scroll.getChildren().length).toBeLessThan(120)
    expect(holding(scroll, "Block 2150")).toBeUndefined()
    expect(holding(scroll, "printf block-2100")).toBeUndefined()
    expect(openBlocks(scroll)).toEqual([])

    await pressExpand(harness)
    expect(openBlocks(scroll)).toEqual(["reasoning 2150"])
    // The open block is above the viewport, which follows the end and stays where it was.
    expect(await readFrame(harness.app)).toBe(seen)
  } finally {
    await harness.dispose()
  }
}, 120_000)

test("each press opens the block before the last one, unmounted or not, and all open it closes the latest", async () => {
  const harness = await mountHarness(windowedWith(BLOCKS))
  try {
    const scroll = await atTheEnd(harness)
    const order = ["reasoning 2150", "bash 2100", "reasoning 1500", "bash 900", "reasoning 60"]

    for (let pressed = 1; pressed <= order.length; pressed++) {
      await pressExpand(harness)
      expect(openBlocks(scroll)).toEqual(order.slice(0, pressed).sort())
    }

    // Every block is open: the key closes the most recent one and leaves the others.
    await pressExpand(harness)
    expect(openBlocks(scroll)).toEqual(order.slice(1).sort())

    // The one it closed is the most recent folded block again.
    await pressExpand(harness)
    expect(openBlocks(scroll)).toEqual(order.slice().sort())
  } finally {
    await harness.dispose()
  }
}, 120_000)

test("a block opened by the key shows its whole output when the reader scrolls to it", async () => {
  const harness = await mountHarness(windowedWith(BLOCKS))
  try {
    const scroll = await atTheEnd(harness)
    await pressExpand(harness)
    await pressExpand(harness)
    expect(openBlocks(scroll)).toEqual(["bash 2100", "reasoning 2150"])

    // The row is mounted open, so it holds the whole output and the label that closes it.
    const row = holding(scroll, "printf block-2100")!
    expect(texts(row).some((line) => line.includes("block 2100 line 29"))).toBe(true)
    expect(texts(row).some((line) => line.includes("ctrl+o collapse"))).toBe(true)
  } finally {
    await harness.dispose()
  }
}, 120_000)

test("an edit opens by the key although a long plain tail has unmounted it, and stays open where it is", async () => {
  const harness = await mountHarness(
    windowedWith([
      { index: 900, kind: "edit" },
      { index: 2100, kind: "bash" },
    ]),
  )
  try {
    const scroll = await atTheEnd(harness)
    // The premise: the edit is far from what is mounted, and its row has to be reached from the parts in the store.
    expect(holding(scroll, "src/edit-900.ts")).toBeUndefined()
    expect(openBlocks(scroll)).toEqual([])

    await pressExpand(harness)
    expect(openBlocks(scroll)).toEqual(["bash 2100"])
    await pressExpand(harness)
    // The key flips the flag a click flips: the row is pinned, so it is mounted, and it is mounted open.
    expect(openBlocks(scroll)).toEqual(["bash 2100", "edit 900"])
    const row = holding(scroll, "src/edit-900.ts")!
    expect(texts(row).some((line) => line.includes("+1 \u22121"))).toBe(true)

    // Every block is open: the next press closes the latest one, which is the bash call.
    await pressExpand(harness)
    expect(openBlocks(scroll)).toEqual(["edit 900"])
  } finally {
    await harness.dispose()
  }
}, 120_000)
