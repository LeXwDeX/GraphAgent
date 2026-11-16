// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { layoutDagBar, type DagBarInput, type DagBarLayout, type DagBarNode } from "../../src/dag/bar"
import { computeWaves } from "../../src/dag/waves"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"

const AMBIGUOUS_WIDTHS: readonly AmbiguousWidth[] = [1, 2]

const state = (status: string, error_class?: string): DagBarNode => (error_class ? { status, error_class } : { status })
const wave = (count: number, status = "completed") => Array.from({ length: count }, () => state(status))

/** Token and text of every segment: the shape a renderer draws. */
const drawn = (layout: DagBarLayout) => layout.segments.map((segment) => [segment.token, segment.text])

/** Everything a layout promises, whatever the input. */
function expectSound(layout: DagBarLayout, input: DagBarInput) {
  const aw = input.ambiguousWidth ?? 1
  expect(layout.text).toBe(layout.segments.map((segment) => segment.text).join(""))
  expect(layout.cells).toBe(layout.segments.reduce((sum, segment) => sum + segment.cells, 0))
  // The width model in `ui/width.ts` is the oracle for every segment and for the whole line.
  for (const segment of layout.segments) expect(cellWidth(segment.text, aw)).toBe(segment.cells)
  expect(cellWidth(layout.text, aw)).toBe(layout.cells)
  expect(layout.cells).toBeLessThanOrEqual(Math.max(0, Math.floor(input.width)))
}

describe("glyph widths", () => {
  test("the widths the layout assumes are the ones the width model gives", () => {
    for (const aw of AMBIGUOUS_WIDTHS) {
      // Box drawing lines are East Asian Ambiguous: wide at ambiguous_width 2.
      expect(cellWidth("━", aw)).toBe(aw)
      expect(cellWidth("─", aw)).toBe(aw)
      // U+254C is Neutral, so it stays narrow; the layout doubles it to keep every state the same width.
      expect(cellWidth("╌", aw)).toBe(1)
      expect(cellWidth("!", aw)).toBe(1)
      expect(cellWidth(" ", aw)).toBe(1)
    }
  })
})

describe("layoutDagBar nodes mode", () => {
  test("starts at 3 slots per node and shrinks to 2 and 1 until every node fits", () => {
    const waves = [wave(3)]
    // 3 nodes: 9, 6 or 3 cells.
    expect(layoutDagBar({ waves, width: 40 })).toMatchObject({ mode: "nodes", per: 3, cells: 9 })
    expect(layoutDagBar({ waves, width: 9 })).toMatchObject({ mode: "nodes", per: 3, cells: 9 })
    expect(layoutDagBar({ waves, width: 8 })).toMatchObject({ mode: "nodes", per: 2, cells: 6 })
    expect(layoutDagBar({ waves, width: 6 })).toMatchObject({ mode: "nodes", per: 2, cells: 6 })
    expect(layoutDagBar({ waves, width: 5 })).toMatchObject({ mode: "nodes", per: 1, cells: 3 })
    expect(layoutDagBar({ waves, width: 3 })).toMatchObject({ mode: "nodes", per: 1, cells: 3 })
  })

  test("a space separates waves and counts against the width", () => {
    const waves = [wave(2), wave(1), wave(2)]
    // 5 nodes at 3 each, 2 spaces.
    expect(layoutDagBar({ waves, width: 17 })).toMatchObject({ mode: "nodes", per: 3, cells: 17 })
    expect(layoutDagBar({ waves, width: 16 })).toMatchObject({ mode: "nodes", per: 2, cells: 12 })
    expect(layoutDagBar({ waves, width: 16 }).text).toBe("━━━━ ━━ ━━━━")
  })

  test("the panel starts at 5 slots per node", () => {
    const waves = [wave(2)]
    expect(layoutDagBar({ waves, width: 60, per: 5 })).toMatchObject({ mode: "nodes", per: 5, cells: 10 })
    expect(layoutDagBar({ waves, width: 9, per: 5 })).toMatchObject({ mode: "nodes", per: 4, cells: 8 })
    expect(layoutDagBar({ waves, width: 60 })).toMatchObject({ mode: "nodes", per: 3, cells: 6 })
  })

  test("colors by state, with the thin line for waiting and the dashed line for skipped, cancelled and aborted", () => {
    const layout = layoutDagBar({
      waves: [
        [
          state("completed"),
          state("failed"),
          state("running"),
          state("queued"),
          state("skipped"),
          state("failed", "cancelled"),
          state("aborted"),
          state("paused"),
        ],
      ],
      width: 8,
    })
    expect(layout).toMatchObject({ mode: "nodes", per: 1 })
    expect(drawn(layout)).toEqual([
      ["success", "━"],
      ["error", "━"],
      ["statusRunning", "━"],
      ["statusQueued", "─"],
      // skipped, cancelled and aborted share color and glyph, so they read as one run.
      ["statusQueued", "╌╌╌"],
      ["statusPaused", "━"],
    ])
  })

  test("neighbouring nodes in one state read as a single run, and a space ends it", () => {
    const layout = layoutDagBar({ waves: [wave(3), wave(2)], width: 40 })
    expect(drawn(layout)).toEqual([
      ["success", "━".repeat(9)],
      [undefined, " "],
      ["success", "━".repeat(6)],
    ])
  })

  test("a node row in a state the table does not know draws as a plain waiting line", () => {
    const layout = layoutDagBar({ waves: [[state("retrying")]], width: 10 })
    expect(drawn(layout)).toEqual([["text", "───"]])
  })

  test("empty waves are skipped and take no space", () => {
    const layout = layoutDagBar({ waves: [[], wave(1), [], wave(1)], width: 40 })
    expect(layout.text).toBe("━━━ ━━━")
  })

  test("no nodes, no bar", () => {
    expect(layoutDagBar({ waves: [], width: 40 })).toMatchObject({ segments: [], text: "", cells: 0 })
    expect(layoutDagBar({ waves: [[], []], width: 40 })).toMatchObject({ segments: [], text: "", cells: 0 })
    expect(layoutDagBar({ waves: [], unplaced: [], width: 40 }).cells).toBe(0)
  })
})

describe("layoutDagBar waves mode", () => {
  test("colors a wave by its worst state and shares the width by node count", () => {
    const layout = layoutDagBar({
      waves: [wave(5), [...wave(4), state("failed")], [...wave(3, "queued"), ...wave(2, "running")]],
      width: 12,
    })
    // 15 nodes and 2 spaces do not fit in 12 cells: 10 slots among 3 waves.
    expect(layout).toMatchObject({ mode: "waves", widths: [4, 3, 3], cells: 12 })
    expect(drawn(layout)).toEqual([
      ["success", "━━━━"],
      [undefined, " "],
      ["error", "━━━"],
      [undefined, " "],
      ["statusRunning", "━━━"],
    ])
  })

  test("the worst state is failed, then running, paused, waiting, skipped, completed", () => {
    const worst = (...statuses: string[]) =>
      layoutDagBar({ waves: [statuses.map((status) => state(status))], width: 1 })
    expect(drawn(worst("completed", "skipped", "queued", "paused", "running", "failed"))).toEqual([["error", "━"]])
    expect(drawn(worst("completed", "skipped", "queued", "paused", "running"))).toEqual([["statusRunning", "━"]])
    expect(drawn(worst("completed", "skipped", "queued", "paused"))).toEqual([["statusPaused", "━"]])
    expect(drawn(worst("completed", "skipped", "queued"))).toEqual([["statusQueued", "─"]])
    expect(drawn(worst("completed", "skipped"))).toEqual([["statusQueued", "╌"]])
    expect(drawn(worst("completed", "completed"))).toEqual([["success", "━"]])
    // A cancelled node is skipped-like, not a failure.
    const cancelled = layoutDagBar({ waves: [[state("completed"), state("failed", "cancelled")]], width: 1 })
    expect(drawn(cancelled)).toEqual([["statusQueued", "╌"]])
  })

  test("every wave keeps at least one slot", () => {
    const layout = layoutDagBar({ waves: [wave(1), wave(1), wave(50), wave(1)], width: 30 })
    expect(layout.mode).toBe("waves")
    if (layout.mode !== "waves") return
    expect(layout.widths.every((slots) => slots >= 1)).toBe(true)
    // 27 slots, shared in proportion to 1:1:50:1 with one slot each guaranteed.
    expect(layout.widths.reduce((sum, slots) => sum + slots, 0)).toBe(27)
    expect(layout.widths[2]).toBeGreaterThan(layout.widths[0])
  })

  test("drops the spaces when there is not even a slot for each wave with them", () => {
    // 40 waves, one node each, 40 cells: 40 slots and no room for 39 spaces.
    const layout = layoutDagBar({ waves: Array.from({ length: 40 }, () => wave(1)), width: 40 })
    expect(layout).toMatchObject({ mode: "waves", cells: 40 })
    expect(layout.text).toBe("━".repeat(40))
    expect(layout.text.includes(" ")).toBe(false)
  })

  test("merges neighbouring waves when even one slot each does not fit", () => {
    const waves = Array.from({ length: 50 }, () => wave(1))
    waves[49] = [state("failed")]
    const layout = layoutDagBar({ waves, width: 20 })
    expect(layout).toMatchObject({ mode: "waves", cells: 20 })
    if (layout.mode !== "waves") return
    expect(layout.widths).toEqual(Array.from({ length: 20 }, () => 1))
    // The failure at the end stays visible in the last segment.
    expect(drawn(layout).at(-1)).toEqual(["error", "━"])
    expect(
      drawn(layout)
        .slice(0, -1)
        .every(([token]) => token === "success"),
    ).toBe(true)
  })
})

describe("layoutDagBar waves outside every wave", () => {
  test("a last group marked with a red ! takes the nodes no wave could place", () => {
    const layout = layoutDagBar({
      waves: [wave(2)],
      unplaced: [state("failed"), state("queued")],
      width: 20,
    })
    expect(layout).toMatchObject({ mode: "nodes", per: 3, cells: 14 })
    expect(drawn(layout)).toEqual([
      ["success", "━━━━━━"],
      [undefined, " "],
      ["error", "!"],
      ["error", "━━━"],
      ["statusQueued", "───"],
    ])
  })

  test("the nodes count with the rest, and so does the mark", () => {
    const input: DagBarInput = { waves: [wave(2)], unplaced: [state("failed"), state("queued")], width: 13 }
    // 4 nodes at 3 slots plus a space and the mark is 14 cells; at 2 slots it is 10.
    expect(layoutDagBar(input)).toMatchObject({ mode: "nodes", per: 2, cells: 10 })
  })

  test("only unplaced nodes still draw", () => {
    const layout = layoutDagBar({ waves: [], unplaced: [state("pending"), state("pending")], width: 20 })
    expect(drawn(layout)).toEqual([
      ["error", "!"],
      ["statusQueued", "──────"],
    ])
  })

  test("in waves mode the group keeps a segment of its own behind the mark", () => {
    const layout = layoutDagBar({ waves: [wave(30), wave(30)], unplaced: [state("failed")], width: 20 })
    expect(layout.mode).toBe("waves")
    expect(layout.text.endsWith("!━")).toBe(true)
    expect(layout.segments.at(-2)).toEqual({ token: "error", text: "!", cells: 1 })
    expect(layout.cells).toBeLessThanOrEqual(20)
  })

  test("when waves are merged the group outside them is not", () => {
    const waves = Array.from({ length: 50 }, () => wave(1))
    const layout = layoutDagBar({ waves, unplaced: [state("failed")], width: 20 })
    expect(layout.cells).toBe(20)
    expect(drawn(layout).slice(-2)).toEqual([
      ["error", "!"],
      ["error", "━"],
    ])
    // 18 merged segments, the mark and the group's slot.
    expect(layout.mode === "waves" && layout.widths).toEqual(Array.from({ length: 19 }, () => 1))
  })

  test("the group outranks the waves when there is room for little else", () => {
    const waves = [wave(3), wave(3)]
    const unplaced = [state("failed")]
    // The mark and one slot; no room for a wave.
    expect(layoutDagBar({ waves, unplaced, width: 2 }).text).toBe("!━")
    // Not even a slot: only the mark.
    expect(layoutDagBar({ waves, unplaced, width: 1 }).text).toBe("!")
    expect(layoutDagBar({ waves, unplaced, width: 0 }).text).toBe("")
  })
})

describe("layoutDagBar ambiguous width", () => {
  test("at 2 every slot is two cells wide whatever its glyph", () => {
    const input: DagBarInput = {
      waves: [[state("completed"), state("queued"), state("skipped")]],
      width: 40,
      ambiguousWidth: 2,
    }
    const layout = layoutDagBar(input)
    expect(layout).toMatchObject({ mode: "nodes", per: 3, cells: 18 })
    expect(drawn(layout)).toEqual([
      ["success", "━━━"],
      ["statusQueued", "───"],
      // U+254C stays one cell wide, so it takes two glyphs per slot.
      ["statusQueued", "╌╌╌╌╌╌"],
    ])
    expectSound(layout, input)
  })

  test("at 1 a slot is a cell and a glyph", () => {
    const layout = layoutDagBar({ waves: [[state("completed"), state("skipped")]], width: 40, ambiguousWidth: 1 })
    expect(layout.text).toBe("━━━╌╌╌")
    expect(layout.cells).toBe(6)
  })

  test("a wider setting narrows the bar sooner", () => {
    const waves = [wave(10)]
    expect(layoutDagBar({ waves, width: 30, ambiguousWidth: 1 })).toMatchObject({ mode: "nodes", per: 3, cells: 30 })
    expect(layoutDagBar({ waves, width: 30, ambiguousWidth: 2 })).toMatchObject({ mode: "nodes", per: 1, cells: 20 })
    expect(layoutDagBar({ waves, width: 19, ambiguousWidth: 2 })).toMatchObject({ mode: "waves", cells: 18 })
  })

  test("an odd cell that no slot can use stays empty", () => {
    const layout = layoutDagBar({ waves: [wave(40)], width: 41, ambiguousWidth: 2 })
    expect(layout).toMatchObject({ mode: "waves", widths: [20], cells: 40 })
    expect(cellWidth(layout.text, 2)).toBe(40)
  })
})

describe("layoutDagBar fits whatever the input", () => {
  // `nodes` nodes in waves of five, as a workflow of that size usually runs.
  const shaped = (nodes: number) => {
    const waves: DagBarNode[][] = []
    for (let left = nodes; left > 0; left -= 5) waves.push(wave(Math.min(5, left)))
    return waves
  }

  test("the size matrix: modes and slots per node follow the rules, and no bar is wider than its width", () => {
    for (const nodes of [5, 20, 60, 200]) {
      for (const width of [40, 80, 120]) {
        for (const aw of AMBIGUOUS_WIDTHS) {
          const waves = shaped(nodes)
          const spaces = waves.length - 1
          const input: DagBarInput = { waves, width, ambiguousWidth: aw }
          const layout = layoutDagBar(input)
          const label = `${nodes} nodes, ${width} cells, ambiguous ${aw}`
          expectSound(layout, input)

          const per = [3, 2, 1].find((candidate) => nodes * candidate * aw + spaces <= width)
          if (per !== undefined) {
            expect(layout, label).toMatchObject({ mode: "nodes", per })
            continue
          }
          expect(layout.mode, label).toBe("waves")
          // The slots that fit are all used: at most one cell, the odd one at 2, is left.
          expect(width - layout.cells, label).toBeLessThan(aw)
        }
      }
    }
  })

  test("the matrix lands where the rules put it", () => {
    const mode = (nodes: number, width: number, aw: AmbiguousWidth) =>
      layoutDagBar({ waves: shaped(nodes), width, ambiguousWidth: aw })
    expect(mode(5, 40, 1)).toMatchObject({ mode: "nodes", per: 3, cells: 15 })
    expect(mode(20, 80, 1)).toMatchObject({ mode: "nodes", per: 3, cells: 63 })
    expect(mode(20, 40, 1)).toMatchObject({ mode: "nodes", per: 1, cells: 23 })
    // 4 waves: 3 spaces leave 37 cells, 18 slots of 2.
    expect(mode(20, 40, 2)).toMatchObject({ mode: "waves", cells: 39 })
    expect(mode(60, 120, 1)).toMatchObject({ mode: "nodes", per: 1, cells: 71 })
    expect(mode(60, 80, 2)).toMatchObject({ mode: "waves", cells: 79 })
    expect(mode(200, 120, 1)).toMatchObject({ mode: "waves", cells: 120 })
    expect(mode(200, 40, 1)).toMatchObject({ mode: "waves", cells: 40 })
  })

  test("in waves mode the segment widths add up to the width that is available", () => {
    for (const width of [40, 80, 120]) {
      const layout = layoutDagBar({ waves: shaped(200), width })
      expect(layout.mode).toBe("waves")
      if (layout.mode !== "waves") return
      const spaces = layout.segments.filter((segment) => segment.token === undefined).length
      expect(layout.widths.reduce((sum, slots) => sum + slots, 0) + spaces).toBe(width)
    }
  })

  test("a very long node count still fits in a few cells", () => {
    for (const count of [5_000, 100_000]) {
      for (const aw of AMBIGUOUS_WIDTHS) {
        for (const width of [0, 1, 2, 3, 7, 80, 120]) {
          const input: DagBarInput = {
            waves: [wave(count), wave(count, "running"), wave(count, "failed")],
            width,
            ambiguousWidth: aw,
          }
          expectSound(layoutDagBar(input), input)
        }
      }
    }
    const layout = layoutDagBar({ waves: [wave(100_000), wave(1, "running")], width: 80 })
    expect(layout.mode).toBe("waves")
    if (layout.mode !== "waves") return
    // One node against a hundred thousand still gets its slot.
    expect(layout.widths).toHaveLength(2)
    expect(layout.widths[1]).toBeGreaterThanOrEqual(1)
    expect(layout.cells).toBe(80)
  })

  test("very narrow widths never overflow and use what they have", () => {
    const waves = [wave(3), wave(2, "running")]
    for (const aw of AMBIGUOUS_WIDTHS) {
      for (let width = 0; width <= 8; width++) {
        const input: DagBarInput = { waves, width, ambiguousWidth: aw }
        const layout = layoutDagBar(input)
        expectSound(layout, input)
        // Two waves and a space need 2 slots and a cell; fewer widths merge the waves into one segment.
        if (width >= aw) expect(layout.cells, `${width}/${aw}`).toBeGreaterThan(0)
        else expect(layout.cells, `${width}/${aw}`).toBe(0)
      }
    }
    expect(layoutDagBar({ waves, width: 0 })).toMatchObject({ text: "", cells: 0 })
    expect(layoutDagBar({ waves, width: 1 })).toMatchObject({ text: "━", cells: 1 })
    expect(layoutDagBar({ waves, width: 1, ambiguousWidth: 2 })).toMatchObject({ text: "", cells: 0 })
    // One slot at 2 is a single wide glyph.
    expect(layoutDagBar({ waves, width: 2, ambiguousWidth: 2 })).toMatchObject({ text: "━", cells: 2 })
  })

  test("odd inputs are tamed: fractions floor, negatives and non-finite numbers mean no room", () => {
    const waves = [wave(3)]
    expect(layoutDagBar({ waves, width: 9.9 }).cells).toBe(9)
    for (const width of [-5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(layoutDagBar({ waves, width }), String(width)).toMatchObject({ text: "", cells: 0 })
    }
    expect(layoutDagBar({ waves, width: 40, per: 0 })).toMatchObject({ mode: "nodes", per: 1 })
    expect(layoutDagBar({ waves, width: 40, per: 2.9 })).toMatchObject({ mode: "nodes", per: 2 })
    expect(layoutDagBar({ waves, width: 40, per: Number.NaN })).toMatchObject({ mode: "nodes", per: 3 })
    expect(layoutDagBar({ waves, width: 40, per: -4 })).toMatchObject({ mode: "nodes", per: 1 })
    // A huge per is capped by the width, with no loop over the sizes in between.
    expect(layoutDagBar({ waves: [wave(1)], width: 80, per: 1e12 })).toMatchObject({
      mode: "nodes",
      per: 80,
      cells: 80,
    })
  })

  test("the same input gives the same layout", () => {
    const input: DagBarInput = { waves: shaped(60), unplaced: [state("failed")], width: 80, ambiguousWidth: 2 }
    expect(layoutDagBar(input)).toEqual(layoutDagBar(input))
  })

  test("random workflows of every shape, at every width and setting", () => {
    let seed = 20260117
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296
      return seed / 4_294_967_296
    }
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]
    const statuses = [
      "pending",
      "queued",
      "running",
      "completed",
      "failed",
      "aborted",
      "skipped",
      "paused",
      "stepping",
      "retrying",
    ]
    const node = () => (random() < 0.1 ? state("failed", "cancelled") : state(pick(statuses)))

    for (let round = 0; round < 3_000; round++) {
      const waves = Array.from({ length: Math.floor(random() * 31) }, () =>
        Array.from({ length: Math.floor(random() * 9) }, node),
      )
      const unplaced = Array.from({ length: random() < 0.3 ? Math.floor(random() * 7) : 0 }, node)
      const aw = pick(AMBIGUOUS_WIDTHS)
      const width = Math.floor(random() * 131)
      const per = pick([undefined, 1, 3, 5])
      const input: DagBarInput = { waves, unplaced, width, ambiguousWidth: aw, ...(per === undefined ? {} : { per }) }
      const layout = layoutDagBar(input)
      expectSound(layout, input)

      const nodes = waves.flat().length + unplaced.length
      const groups = waves.filter((group) => group.length > 0).length + (unplaced.length > 0 ? 1 : 0)
      const mark = unplaced.length > 0 ? 1 : 0
      if (nodes === 0) {
        expect(layout.cells).toBe(0)
        continue
      }
      if (layout.mode === "nodes") {
        // One segment per node: the glyph slots add up, and the next size up would not have fit.
        const slots = layout.segments.reduce((sum, segment) => sum + segment.cells, 0) - (groups - 1) - mark
        expect(slots).toBe(nodes * layout.per * aw)
        expect(layout.per).toBeLessThanOrEqual(per ?? 3)
        if (layout.per < (per ?? 3)) expect(nodes * (layout.per + 1) * aw + groups - 1 + mark).toBeGreaterThan(width)
      } else {
        // Everything that fits is used.
        expect(width - layout.cells).toBeLessThan(aw)
      }
      // There is room for a slot, so something is drawn.
      if (width >= aw + mark) expect(layout.cells).toBeGreaterThan(0)
    }
  })
})

describe("layoutDagBar with real workflows", () => {
  const status = (id: string, depends_on: string[], state: string) => ({ id, name: id, depends_on, status: state })

  test("the example workflow from the design draws as nine nodes in five waves", () => {
    const nodes = [
      status("resolve-version", [], "completed"),
      status("install-deps", [], "completed"),
      status("typecheck", ["install-deps"], "completed"),
      status("e2e-windows", ["install-deps"], "failed"),
      status("unit-core", ["typecheck"], "running"),
      status("unit-tui", ["typecheck"], "running"),
      status("lint", ["typecheck"], "queued"),
      status("package", ["unit-core", "unit-tui"], "queued"),
      status("release", ["package"], "queued"),
    ]
    const { waves, unplaced } = computeWaves(nodes)
    const layout = layoutDagBar({ waves, unplaced, width: 80 })
    expect(waves.map((group) => group.map((node) => node.id))).toEqual([
      ["install-deps", "resolve-version"],
      ["e2e-windows", "typecheck"],
      ["lint", "unit-core", "unit-tui"],
      ["package"],
      ["release"],
    ])
    expect(layout).toMatchObject({ mode: "nodes", per: 3 })
    expect(drawn(layout)).toEqual([
      ["success", "━━━━━━"],
      [undefined, " "],
      ["error", "━━━"],
      ["success", "━━━"],
      [undefined, " "],
      ["statusQueued", "───"],
      ["statusRunning", "━━━━━━"],
      [undefined, " "],
      ["statusQueued", "───"],
      [undefined, " "],
      ["statusQueued", "───"],
    ])
  })

  test("a restored workflow with a cycle still draws every node", () => {
    const nodes = [status("a", [], "completed"), status("x", ["y"], "pending"), status("y", ["x"], "pending")]
    const { waves, unplaced } = computeWaves(nodes)
    const layout = layoutDagBar({ waves, unplaced, width: 40 })
    expect(layout.text).toBe("━━━ !──────")
    expect(layout.text.match(/[━─]/g)).toHaveLength(9)
  })
})
