// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { collapseToolOutput, outputOverflows } from "../../src/util/collapse-tool-output"

/** `collapseToolOutput` as it was before `outputOverflows` took over its first check: the reference for the fast path. */
function reference(output: string, maxLines: number, maxChars: number) {
  const lines = output.split("\n")
  return lines.length > maxLines || Array.from(output).length > maxChars
}

const lines = (count: number, text = "line") =>
  Array.from({ length: count }, (_, index) => `${text} ${index}`).join("\n")

test("folds an output past the line cap and not one at it", () => {
  expect(outputOverflows(lines(10), 10, 10_000)).toBe(false)
  expect(outputOverflows(lines(11), 10, 10_000)).toBe(true)
  // The first lines alone: the hint under the block opens with the `…` that marks the cut.
  expect(collapseToolOutput(lines(11), 10, 10_000)).toEqual({ output: lines(10), overflow: true, hidden: 1 })
  expect(collapseToolOutput(lines(10), 10, 10_000)).toEqual({ output: lines(10), overflow: false, hidden: 0 })
})

test("counts the lines the fold leaves out", () => {
  expect(collapseToolOutput(lines(15), 10, 10_000).hidden).toBe(5)
  expect(collapseToolOutput(lines(37), 3, 10_000).hidden).toBe(34)
  // An empty line is a line, as it is to the cap.
  expect(collapseToolOutput(`${lines(10)}\n\n`, 10, 10_000)).toEqual({ output: lines(10), overflow: true, hidden: 2 })
  expect(collapseToolOutput(lines(10), 10, 10_000).hidden).toBe(0)
  expect(collapseToolOutput("", 10, 10_000)).toEqual({ output: "", overflow: false, hidden: 0 })
})

test("folds an output past the character cap and not one at it", () => {
  expect(outputOverflows("x".repeat(100), 10, 100)).toBe(false)
  expect(outputOverflows("x".repeat(101), 10, 100)).toBe(true)
  // Cut inside a line, the `…` stays in the text, and no line is left out.
  expect(collapseToolOutput("x".repeat(101), 10, 100)).toEqual({
    output: `${"x".repeat(99)}…`,
    overflow: true,
    hidden: 0,
  })
  const wrapped = ["x".repeat(80), "y".repeat(80), "z"].join("\n")
  expect(collapseToolOutput(wrapped, 10, 100)).toEqual({
    // 99 characters: the first line, the break after it and 18 of the second.
    output: `${"x".repeat(80)}\n${"y".repeat(18)}…`,
    overflow: true,
    hidden: 0,
  })
})

test("an output past both caps keeps the cut inside its text and still counts the lines past the cap", () => {
  const output = [
    ...Array.from({ length: 3 }, () => "w".repeat(50)),
    ...Array.from({ length: 7 }, (_, i) => `l${i}`),
  ].join("\n")
  // Ten lines fit the line cap, but not 100 characters; seven more lines are left out.
  const folded = collapseToolOutput(`${output}\n${lines(7)}`, 10, 100)
  expect(folded.overflow).toBe(true)
  expect(folded.output).toEndWith("…")
  expect(folded.output.split("\n").at(-1)).not.toBe("…")
  expect(Array.from(folded.output)).toHaveLength(100)
  expect(folded.hidden).toBe(7)
})

test("the ellipsis row is for the caller that asks for it, and only after a cut by lines", () => {
  const asked = { ellipsisRow: true }
  expect(collapseToolOutput(lines(11), 10, 10_000, asked)).toEqual({
    output: `${lines(10)}\n…`,
    overflow: true,
    hidden: 1,
  })
  // A cut inside a line carries its `…`, and a block that does not fold has nothing to close.
  expect(collapseToolOutput("x".repeat(101), 10, 100, asked)).toEqual(collapseToolOutput("x".repeat(101), 10, 100))
  expect(collapseToolOutput(lines(10), 10, 10_000, asked)).toEqual({ output: lines(10), overflow: false, hidden: 0 })
})

test("counts characters and not UTF-16 units", () => {
  // Fifty astral characters are a hundred units and fifty characters.
  const astral = "😀".repeat(50)
  expect(astral.length).toBe(100)
  expect(outputOverflows(astral, 10, 50)).toBe(false)
  expect(outputOverflows(astral, 10, 49)).toBe(true)
})

test("a cap of no lines folds everything, as the full split did", () => {
  expect(outputOverflows("", 0, 100)).toBe(true)
  expect(collapseToolOutput("a", 0, 100)).toEqual({ output: "", overflow: true, hidden: 1 })
  expect(collapseToolOutput("a", 0, 100, { ellipsisRow: true })).toEqual({ output: "…", overflow: true, hidden: 1 })
})

test("agrees with the full split on every combination of lines and characters around the caps", () => {
  const samples = [
    "",
    "a",
    "a\n",
    "\n",
    "\n\n\n",
    lines(9),
    lines(10),
    lines(11),
    lines(40, "x".repeat(30)),
    "y".repeat(299),
    "y".repeat(300),
    "y".repeat(301),
    "😀".repeat(150),
    "😀".repeat(151),
    `${lines(9)}\n${"z".repeat(500)}`,
    "é".repeat(300),
  ]
  for (const sample of samples) {
    for (const maxLines of [1, 3, 10]) {
      for (const maxChars of [20, 300, 940]) {
        expect({
          sample: sample.slice(0, 12),
          maxLines,
          maxChars,
          folds: outputOverflows(sample, maxLines, maxChars),
        }).toEqual({
          sample: sample.slice(0, 12),
          maxLines,
          maxChars,
          folds: reference(sample, maxLines, maxChars),
        })
        expect(collapseToolOutput(sample, maxLines, maxChars).overflow).toBe(reference(sample, maxLines, maxChars))
      }
    }
  }
})

test("stops at the first line over the cap", () => {
  // A hundred thousand lines: the answer comes from the first eleven, not from a split of the whole string.
  const long = lines(100_000)
  const start = performance.now()
  for (let pass = 0; pass < 200; pass++) expect(outputOverflows(long, 10, 10_000)).toBe(true)
  expect(performance.now() - start).toBeLessThan(250)
})
