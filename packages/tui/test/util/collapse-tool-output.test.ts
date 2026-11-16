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
  expect(collapseToolOutput(lines(11), 10, 10_000)).toEqual({
    output: `${lines(10)}\n…`,
    overflow: true,
  })
  expect(collapseToolOutput(lines(10), 10, 10_000)).toEqual({ output: lines(10), overflow: false })
})

test("folds an output past the character cap and not one at it", () => {
  expect(outputOverflows("x".repeat(100), 10, 100)).toBe(false)
  expect(outputOverflows("x".repeat(101), 10, 100)).toBe(true)
  expect(collapseToolOutput("x".repeat(101), 10, 100)).toEqual({ output: `${"x".repeat(99)}…`, overflow: true })
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
  expect(collapseToolOutput("a", 0, 100)).toEqual({ output: "…", overflow: true })
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
