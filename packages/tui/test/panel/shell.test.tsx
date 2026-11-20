// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { ActiveBinding } from "@opentui/keymap"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { setLanguage } from "../../src/i18n"
import { useBindings } from "../../src/keymap"
import { hintEntries, joinPairKeys, PanelShell, panelMaxRows, type PanelHint } from "../../src/panel/shell"
import { renderUntilFrame } from "../fixture/frames"
import { shellState } from "../shell/contexts"
import { contentWidth, framedInnerWidth } from "../../src/ui/layout"
import { cellWidth } from "../../src/ui/width"
import { PanelSurface, panelRows, renderPanel } from "./contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

type Binding = Pick<ActiveBinding, "sequence">
type Bindings = ReadonlyMap<string, readonly Binding[]>

/** A binding of one stroke, written the way the keymap parses it: "ctrl+n" is the key n with ctrl held. */
function stroke(key: string): Binding {
  const parts = key.split("+")
  const name = parts.pop() ?? key
  return {
    sequence: [
      {
        stroke: { name, ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), meta: false, super: false },
        display: key,
        match: key,
      },
    ],
  }
}

/** A two-stroke sequence, which is never one bare key. */
function chord(first: string, second: string): Binding {
  return { sequence: [...stroke(first).sequence, ...stroke(second).sequence] }
}

function bound(entries: Record<string, readonly Binding[]>): Bindings {
  return new Map(Object.entries(entries))
}

const SYMBOLS: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" }

/** The way the keymap writes the bindings of a command: each one in the given style, repeats left out, joined by ", ". */
function written(bindings: readonly Binding[] | undefined, style: (part: Binding["sequence"][number]) => string) {
  if (!bindings?.length) return undefined
  return [...new Set(bindings.map((binding) => binding.sequence.map(style).join(" ")))].join(", ")
}

/** Key names as words: what a style that writes names and not symbols gives `joinPairKeys` to tell apart. */
const asNames = (bindings: readonly Binding[] | undefined) => written(bindings, (part) => part.display)

/** Key names as symbols, for the arrows to run together in the entry of a pair. */
const asSymbols = (bindings: readonly Binding[] | undefined) =>
  written(
    bindings,
    ({ stroke }) =>
      `${stroke.ctrl ? "⌃" : ""}${stroke.shift ? "⇧" : ""}${SYMBOLS[stroke.name] ?? stroke.name.toUpperCase()}`,
  )

const pair: PanelHint = { key: "move.previous", also: "move.next", label: "选择" }

test("a panel shows 45% of the terminal height in rows unless it asks for another number, and never more than 14", () => {
  // The rows of the default 12, 24 and 40 row terminals, and where the cap starts.
  expect([12, 24, 40, 31, 32, 100].map(panelMaxRows)).toEqual([5, 10, 14, 13, 14, 14])
})

test("joinPairKeys runs symbols together and tells names apart", () => {
  expect(joinPairKeys("↑", "↓")).toBe("↑↓")
  expect(joinPairKeys("←", "→")).toBe("←→")
  expect(joinPairKeys("up", "down")).toBe("up/down")
  expect(joinPairKeys("left", "right")).toBe("left/right")
  // A key of more than one symbol and a mixed pair are told apart too: they would not read as one.
  expect(joinPairKeys("⌃P", "⌃N")).toBe("⌃P/⌃N")
  expect(joinPairKeys("↑", "down")).toBe("↑/down")
})

test("a pair of opposite arrow keys is one entry, up before down and left before right", () => {
  const vertical = bound({ "move.previous": [stroke("up")], "move.next": [stroke("down")] })
  expect(hintEntries(pair, vertical, asSymbols)).toEqual(["↑↓ 选择"])
  expect(hintEntries(pair, vertical, asNames)).toEqual(["up/down 选择"])

  const horizontal = bound({ "tab.previous": [stroke("left")], "tab.next": [stroke("right")] })
  const tabs: PanelHint = { key: "tab.previous", also: "tab.next", label: "切换标签" }
  expect(hintEntries(tabs, horizontal, asSymbols)).toEqual(["←→ 切换标签"])
  expect(hintEntries(tabs, horizontal, asNames)).toEqual(["left/right 切换标签"])
})

test("layers that bind the same arrow twice still make a pair", () => {
  const layered = bound({
    "move.previous": [stroke("up"), stroke("up")],
    "move.next": [stroke("down"), stroke("down")],
  })
  expect(hintEntries(pair, layered, asSymbols)).toEqual(["↑↓ 选择"])
})

test("a pair that is not the two opposite arrow keys is two entries, each with the label", () => {
  // The user rebinds the second command to a key that is not down: no "↑↓" is drawn.
  const rebound = bound({ "move.previous": [stroke("up")], "move.next": [stroke("ctrl+n")] })
  expect(hintEntries(pair, rebound, asSymbols)).toEqual(["↑ 选择", "⌃N 选择"])
  expect(hintEntries(pair, rebound, asNames)).toEqual(["up 选择", "ctrl+n 选择"])

  // Both are rebound, to keys that read as a pair to nobody in particular.
  expect(hintEntries(pair, bound({ "move.previous": [stroke("k")], "move.next": [stroke("j")] }), asSymbols)).toEqual([
    "K 选择",
    "J 选择",
  ])

  // The second command has another key besides down, so the entry would leave it out.
  const extra = bound({ "move.previous": [stroke("up")], "move.next": [stroke("down"), stroke("j")] })
  expect(hintEntries(pair, extra, asSymbols)).toEqual(["↑ 选择", "↓, J 选择"])

  // A modified arrow, a chord, and the same arrow on both commands.
  const modified = bound({ "move.previous": [stroke("shift+up")], "move.next": [stroke("shift+down")] })
  expect(hintEntries(pair, modified, asSymbols)).toEqual(["⇧↑ 选择", "⇧↓ 选择"])
  const chorded = bound({ "move.previous": [chord("ctrl+x", "up")], "move.next": [chord("ctrl+x", "down")] })
  expect(hintEntries(pair, chorded, asSymbols)).toEqual(["⌃X ↑ 选择", "⌃X ↓ 选择"])
  const same = bound({ "move.previous": [stroke("up")], "move.next": [stroke("up")] })
  expect(hintEntries(pair, same, asSymbols)).toEqual(["↑ 选择", "↑ 选择"])
})

test("a command with no binding writes nothing, and its partner is written alone", () => {
  expect(hintEntries(pair, bound({ "move.previous": [stroke("up")] }), asSymbols)).toEqual(["↑ 选择"])
  expect(hintEntries(pair, bound({ "move.next": [stroke("down")] }), asSymbols)).toEqual(["↓ 选择"])
  expect(hintEntries(pair, bound({}), asSymbols)).toEqual([])
  expect(hintEntries({ key: "move.previous", label: "上移" }, bound({}), asSymbols)).toEqual([])
})

test("a hint without a partner is the keys and the label, as it always was", () => {
  const single = bound({ "panel.submit": [stroke("return")], "panel.toggle": [stroke("space"), stroke("x")] })
  expect(hintEntries({ key: "panel.submit", label: "确认" }, single, asNames)).toEqual(["return 确认"])
  expect(hintEntries({ key: "panel.toggle", label: "勾选" }, single, asNames)).toEqual(["space, x 勾选"])
})

/** Puts a pair of commands on the keys given, and a shell whose hint row names them. */
function PairShell(props: { previous: string; next: string; extra?: readonly PanelHint[] }) {
  useBindings(() => ({
    commands: [
      { name: "test.previous", title: "Previous", category: "Test", run: () => {} },
      { name: "test.next", title: "Next", category: "Test", run: () => {} },
    ],
    bindings: [
      { key: props.previous, cmd: "test.previous" },
      { key: props.next, cmd: "test.next" },
    ],
  }))
  return (
    <PanelShell
      title="成对"
      hints={[{ key: "test.previous", also: "test.next", label: "选择" }, ...(props.extra ?? [])]}
    >
      <text>内容</text>
    </PanelShell>
  )
}

/** The hint row of the panel: the text on the line above the bottom border, between the border and the padding. */
function hintRow(frame: string) {
  const lines = panelRows(frame)
  const bottom = lines.findIndex((line) => line.includes("╰"))
  return lines[bottom - 1].slice(1, -1).trim()
}

async function rowOf(previous: string, next: string, extra?: readonly PanelHint[]) {
  await using tmp = await shellState()
  const app = await renderPanel(
    () => <PanelSurface spec={{ render: () => <PairShell previous={previous} next={next} extra={extra} /> }} />,
    { width: 80, height: 24, state: tmp.path },
  )
  try {
    return hintRow(await renderUntilFrame(app, (frame) => frame.includes("内容"), "the shell"))
  } finally {
    app.renderer.destroy()
  }
}

test("the shell writes the keys of a pair of arrow keys as one entry, in each language", async () => {
  expect(await rowOf("up", "down")).toBe("↑↓ 选择 · esc 关闭")
  setLanguage("en")
  expect(await rowOf("left", "right")).toBe("←→ 选择 · esc Close")
})

test("the shell writes a pair with a rebound key as two entries, each with the label", async () => {
  expect(await rowOf("up", "ctrl+n")).toBe("↑ 选择 · ⌃N 选择 · esc 关闭")
  setLanguage("en")
  expect(await rowOf("ctrl+p", "ctrl+n")).toBe("⌃P 选择 · ⌃N 选择 · esc Close")
})

test("a command that a pair names is not written again by another hint", async () => {
  const again: PanelHint = { key: "test.next", label: "下移" }
  expect(await rowOf("up", "down", [again])).toBe("↑↓ 选择 · esc 关闭")
})

/** Eight commands, each on a shifted or an alt arrow key, and a hint for each: `⇧↑ ab`, `⌥→ ab`. */
function ArrowShell() {
  const names = Array.from({ length: 8 }, (_, index) => `test.arrow.${index}`)
  const keys = ["shift+up", "shift+down", "shift+left", "shift+right", "alt+up", "alt+down", "alt+left", "alt+right"]
  useBindings(() => ({
    commands: names.map((name) => ({ name, title: name, category: "Test", run: () => {} })),
    bindings: names.map((name, index) => ({ key: keys[index], cmd: name })),
  }))
  return (
    <PanelShell title="箭头" hints={names.map((name) => ({ key: name, label: "ab" }))}>
      <text>内容</text>
    </PanelShell>
  )
}

// `⇧` and the arrows take two cells each at ambiguous_width 2: the same hints are 72 cells wide at 1, and 84 at 2, where
// the 72 of an 80-column panel's text do not hold them. The row is cut by cells, and at 1 not cut at all.
for (const ambiguousWidth of [1, 2] as const) {
  test(`the hint row of shifted arrow keys is cut by cells at 80 columns with ambiguous_width ${ambiguousWidth}`, async () => {
    await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
    const app = await renderPanel(() => <PanelSurface spec={{ render: () => <ArrowShell /> }} />, {
      width: 80,
      height: 24,
      state: tmp.path,
    })
    try {
      const row = hintRow(await renderUntilFrame(app, (frame) => frame.includes("内容"), "the shell"))
      expect(cellWidth(row, ambiguousWidth)).toBeLessThanOrEqual(framedInnerWidth(contentWidth(80)))
      if (ambiguousWidth === 1) {
        expect(row).toBe("⇧↑ ab · ⇧↓ ab · ⇧← ab · ⇧→ ab · ⌥↑ ab · ⌥↓ ab · ⌥← ab · ⌥→ ab · esc 关闭")
      } else {
        expect(row).toStartWith("⇧↑ ab · ⇧↓ ab · ⇧← ab")
        expect(row).toEndWith("…")
      }
    } finally {
      app.renderer.destroy()
    }
  })
}
