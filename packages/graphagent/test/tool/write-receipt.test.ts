// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { createTwoFilesPatch, diffLines, structuredPatch } from "diff"
import { LSP } from "@/lsp/lsp"
import { WriteReceipt } from "@/tool/write-receipt"

const file = "/project/src/sample.ts"

/** `count` lines named `<prefix> 1` .. `<prefix> <count>`, with the trailing newline of a text file. */
const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`)
const text = (items: string[]) => items.join("\n") + "\n"
/** The text of `count` lines where the 1-based `changed` lines read `LINE <n>`. */
const withChanged = (count: number, changed: number[]) =>
  text(lines(count).map((item, i) => (changed.includes(i + 1) ? `LINE ${i + 1}` : item)))

describe("WriteReceipt.boundedDiff", () => {
  test("keeps three lines of context around a change and numbers the hunk", () => {
    const diff = WriteReceipt.boundedDiff(file, text(lines(20)), withChanged(20, [10]), 40)

    expect(diff.text.split("\n")).toEqual([
      "@@ -7,7 +7,7 @@",
      " line 7",
      " line 8",
      " line 9",
      "-line 10",
      "+LINE 10",
      " line 11",
      " line 12",
      " line 13",
    ])
    expect(diff.shown).toBe(9)
  })

  test("writes each hunk under its own header", () => {
    const diff = WriteReceipt.boundedDiff(file, text(lines(40)), withChanged(40, [2, 30]), 40)

    expect(diff.text.match(/^@@ .* @@$/gm)).toEqual(["@@ -1,5 +1,5 @@", "@@ -27,7 +27,7 @@"])
    expect(diff.shown).toBe(diff.text.split("\n").length)
  })

  test("keeps the first lines of a change of 60 lines and says where to read on", () => {
    const old = text(lines(60))
    const next = text(lines(60, "changed"))

    const diff = WriteReceipt.boundedDiff(file, old, next, 40)

    const shown = diff.text.split("\n")
    // The header and 39 removed lines, then the sentence: 121 lines in all (the header, 60 removed, 60 added).
    expect(shown).toHaveLength(41)
    expect(shown[0]).toBe("@@ -1,60 +1,60 @@")
    expect(shown[1]).toBe("-line 1")
    expect(shown[39]).toBe("-line 39")
    expect(shown[40]).toBe(`[diff cut at 40 of 121 lines; read ${file} from line 1 to see the rest.]`)
    expect(diff.shown).toBe(40)
  })

  test("points at the first hunk, numbered as the file is now", () => {
    const old = text(lines(100))
    const next = text(lines(100).map((item, i) => (i >= 49 && i < 99 ? `new ${i + 1}` : item)))

    const diff = WriteReceipt.boundedDiff(file, old, next, 10)

    // The first hunk starts three lines above the first changed line, 50. It has the header, 3 lines of context
    // before the change, 50 removed and 50 added lines, and the 1 line of context after it.
    expect(diff.text.split("\n").at(-1)).toBe(
      `[diff cut at 10 of 105 lines; read ${file} from line 47 to see the rest.]`,
    )
  })

  test("is not cut when the diff fits the budget exactly", () => {
    const diff = WriteReceipt.boundedDiff(file, "a\nb\n", "a\nB\n", 4)

    expect(diff.text).toBe("@@ -1,2 +1,2 @@\n a\n-b\n+B")
    expect(diff.shown).toBe(4)
  })

  test("with no budget left only says where to read on", () => {
    const diff = WriteReceipt.boundedDiff(file, "a\nb\n", "a\nB\n", 0)

    expect(diff.text).toBe(`[diff cut at 0 of 4 lines; read ${file} from line 1 to see the rest.]`)
    expect(diff.shown).toBe(0)
  })

  test("cuts a line of more than 200 code points and marks the cut", () => {
    const diff = WriteReceipt.boundedDiff(file, "a\nb\nc\n", `a\n${"y".repeat(250)}\nc\n`, 40)

    const added = diff.text.split("\n").find((item) => item.startsWith("+"))
    // 200 code points kept, the plus sign among them, then the mark.
    expect(added).toBe(`+${"y".repeat(199)}…`)
  })

  test("never cuts a character in half", () => {
    const diff = WriteReceipt.boundedDiff(file, "a\nb\nc\n", `a\n${"😀".repeat(250)}\nc\n`, 40)

    const added = diff.text.split("\n").find((item) => item.startsWith("+"))
    expect(added).toBe(`+${"😀".repeat(199)}…`)
    expect(Array.from(added ?? "")).toHaveLength(201)
  })

  test("leaves a line of exactly 200 code points whole", () => {
    const diff = WriteReceipt.boundedDiff(file, "a\nb\nc\n", `a\n${"y".repeat(199)}\nc\n`, 40)

    expect(diff.text.split("\n")).toContain(`+${"y".repeat(199)}`)
    expect(diff.text).not.toContain("…")
  })

  test("is empty when the texts are the same", () => {
    expect(WriteReceipt.boundedDiff(file, "a\nb\n", "a\nb\n", 40)).toEqual({ text: "", shown: 0 })
  })

  test("does not show carriage returns, or a line ending that did not change", () => {
    const diff = WriteReceipt.boundedDiff(file, "a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n", 40)

    expect(diff.text).toBe("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c")
  })
})

describe("WriteReceipt.writeReceipt", () => {
  const old = "a\nb\nc\n"
  const next = "a\nB\nc\n"
  const diff = ["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"].join("\n")

  test("says where an exact edit landed, how much it added and removed, and shows the diff", () => {
    const receipt = WriteReceipt.writeReceipt({
      file,
      oldText: old,
      newText: next,
      reformatted: false,
      replacements: 1,
    })

    expect(receipt.text).toBe(`Lines 2-2 changed. Replacements: 1. Additions: 1. Deletions: 1.\n${diff}`)
    expect(receipt.diffLines).toBe(5)
  })

  test("leaves out the replacements when the tool does not count them", () => {
    const receipt = WriteReceipt.writeReceipt({ file, oldText: old, newText: next, reformatted: false })

    expect(receipt.text).toBe(`Lines 2-2 changed. Additions: 1. Deletions: 1.\n${diff}`)
  })

  test("says a match was not exact, between the landing line and the diff", () => {
    const receipt = WriteReceipt.writeReceipt({
      file,
      oldText: old,
      newText: next,
      reformatted: false,
      replacements: 1,
      fuzzy: { strategy: "line_trimmed", line: 2 },
    })

    expect(receipt.text.split("\n").slice(0, 3)).toEqual([
      "Lines 2-2 changed. Replacements: 1. Additions: 1. Deletions: 1.",
      "Matched by fuzzy strategy line_trimmed at line 2 (not an exact match); check the diff below.",
      "@@ -1,3 +1,3 @@",
    ])
  })

  test("says the formatter rewrote the file, after the fuzzy sentence", () => {
    const receipt = WriteReceipt.writeReceipt({
      file,
      oldText: old,
      newText: next,
      reformatted: true,
      replacements: 1,
      fuzzy: { strategy: "block_anchor", line: 2 },
    })

    expect(receipt.text.split("\n").slice(0, 4)).toEqual([
      "Lines 2-2 changed. Replacements: 1. Additions: 1. Deletions: 1.",
      "Matched by fuzzy strategy block_anchor at line 2 (not an exact match); check the diff below.",
      "File was reformatted by the formatter after this write.",
      "@@ -1,3 +1,3 @@",
    ])
  })

  test("says nothing about the formatter or a fuzzy match for an exact, unformatted edit", () => {
    const receipt = WriteReceipt.writeReceipt({
      file,
      oldText: old,
      newText: next,
      reformatted: false,
      replacements: 1,
    })

    expect(receipt.text).not.toContain("fuzzy")
    expect(receipt.text).not.toContain("reformatted")
  })

  test("writes no diff for a new file", () => {
    const receipt = WriteReceipt.writeReceipt({ file, oldText: "", newText: "a\nb\nc\n", reformatted: false })

    expect(receipt.text).toBe("Lines 1-3 changed. Additions: 3. Deletions: 0.")
    expect(receipt.diffLines).toBe(0)
  })

  test("still says a new file was reformatted", () => {
    const receipt = WriteReceipt.writeReceipt({ file, oldText: "", newText: "a\nb\n", reformatted: true })

    expect(receipt.text).toBe(
      "Lines 1-2 changed. Additions: 2. Deletions: 0.\nFile was reformatted by the formatter after this write.",
    )
  })

  test("is empty when the text did not change", () => {
    expect(WriteReceipt.writeReceipt({ file, oldText: old, newText: old, reformatted: false })).toEqual({
      text: "",
      diffLines: 0,
    })
  })

  test("has no landing line or diff when only the line endings changed", () => {
    const crlf = "a\r\nb\r\n"
    const lf = "a\nb\n"

    expect(WriteReceipt.writeReceipt({ file, oldText: crlf, newText: lf, reformatted: true })).toEqual({
      text: "File was reformatted by the formatter after this write.",
      diffLines: 0,
    })
    expect(WriteReceipt.writeReceipt({ file, oldText: crlf, newText: lf, reformatted: false }).text).toBe("")
  })

  test("lists the landing ranges of a change in several places", () => {
    const receipt = WriteReceipt.writeReceipt({
      file,
      oldText: text(lines(12)),
      newText: withChanged(12, [2, 6, 10]),
      reformatted: false,
    })

    expect(receipt.text.split("\n")[0]).toBe("Lines 2-2, 6-6, 10-10 changed. Additions: 3. Deletions: 3.")
  })

  test("lists the first five ranges and says how many there are", () => {
    const receipt = WriteReceipt.writeReceipt({
      file,
      oldText: text(lines(14)),
      newText: withChanged(14, [1, 3, 5, 7, 9, 11, 13]),
      reformatted: false,
    })

    expect(receipt.text.split("\n")[0]).toBe(
      "Lines 1-1, 3-3, 5-5, 7-7, 9-9, ... (7 in total) changed. Additions: 7. Deletions: 7.",
    )
  })

  test("counts the lines of a range that spans several lines", () => {
    const receipt = WriteReceipt.writeReceipt({
      file,
      oldText: text(lines(10)),
      newText: text(lines(10).map((item, i) => (i >= 2 && i < 5 ? `LINE ${i + 1}` : item))),
      reformatted: false,
      replacements: 1,
    })

    expect(receipt.text.split("\n")[0]).toBe("Lines 3-5 changed. Replacements: 1. Additions: 3. Deletions: 3.")
  })

  test("takes the diff from what is left of the budget and reports what it used", () => {
    const receipt = WriteReceipt.writeReceipt({
      file,
      oldText: old,
      newText: next,
      reformatted: false,
      diffBudget: 3,
    })

    expect(receipt.diffLines).toBe(3)
    expect(receipt.text.split("\n").slice(1)).toEqual([
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      `[diff cut at 3 of 5 lines; read ${file} from line 1 to see the rest.]`,
    ])
  })

  test("shows at most 40 diff lines unless told otherwise", () => {
    const receipt = WriteReceipt.writeReceipt({
      file,
      oldText: text(lines(60)),
      newText: text(lines(60, "changed")),
      reformatted: false,
    })

    expect(receipt.diffLines).toBe(40)
    expect(receipt.text).toContain("[diff cut at 40 of 121 lines;")
  })
})

// #1451: the diff of a write is run once, by the tool for its permission request, and the receipt is made from the
// hunks of that run instead of running the diff again. A rewrite in which every line changes costs seconds to diff.
describe("WriteReceipt from the diff the tool ran", () => {
  const unified = (oldText: string, newText: string) => WriteReceipt.unifiedDiff(file, oldText, newText)

  test("unifiedDiff writes the patch createTwoFilesPatch writes", () => {
    const cases: [string, string][] = [
      [text(lines(20)), withChanged(20, [10])],
      ["", "a\nb\nc\n"],
      ["a\nb\nc\n", ""],
      ["a\nb", "a\nB\n"],
      ["a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n"],
      [text(lines(40)), withChanged(40, [2, 30])],
    ]
    for (const [oldText, newText] of cases) {
      expect(unified(oldText, newText).text).toBe(createTwoFilesPatch(file, file, oldText, newText))
    }
  })

  test("unifiedDiff keeps the hunks as the diff found them, not as the patch text numbers them", () => {
    // The patch text writes the start of a hunk without old lines one lower; the hunks keep the number of the line.
    const created = unified("", "a\nb\nc\n")

    expect(created.text).toContain("@@ -0,0 +1,3 @@")
    expect(created.changes.hunks).toEqual(structuredPatch(file, file, "", "a\nb\nc\n").hunks)
    expect(created.changes.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3 })
  })

  /** A deterministic pseudo-random source, so that a failing case can be run again. */
  const random = (seed: number) => {
    let state = seed >>> 0
    return (below: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return Math.floor((state / 2 ** 32) * below)
    }
  }
  const vocabulary = ["", "a", "b", "c", "}", "{", "  x = 1", "  x = 2", "return", "end"]
  /** Two texts of one line ending, the second made from the first by a few edits; either may lack the final newline. */
  const pair = (seed: number, ending: string) => {
    const pick = random(seed)
    const before = Array.from({ length: pick(26) }, () => vocabulary[pick(vocabulary.length)])
    const after = [...before]
    for (let edits = pick(6); edits > 0; edits--) {
      const at = pick(after.length + 1)
      const kind = pick(3)
      if (kind === 0) after.splice(at, 1)
      else if (kind === 1) after.splice(at, 0, vocabulary[pick(vocabulary.length)])
      else after.splice(at, 1, vocabulary[pick(vocabulary.length)])
    }
    const join = (items: string[]) => (items.length === 0 ? "" : items.join(ending) + (pick(4) === 0 ? "" : ending))
    return [join(before), join(after)] as const
  }
  const cases = Array.from({ length: 600 }, (_, i) => [i, i % 2 === 0 ? "\n" : "\r\n"] as const)

  test("the diff of the receipt is the one it would have run itself, whatever the line ending", () => {
    for (const [seed, ending] of cases) {
      const [oldText, newText] = pair(seed, ending)
      const reference = structuredPatch(file, file, oldText, newText, "", "", {
        context: 3,
        stripTrailingCr: true,
      }).hunks.flatMap((hunk) => [
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...hunk.lines,
      ])

      const diff = WriteReceipt.boundedDiff(file, oldText, newText, Infinity, unified(oldText, newText).changes)

      expect({ seed, lines: diff.text === "" ? [] : diff.text.split("\n") }).toEqual({ seed, lines: reference })
      expect(diff.shown).toBe(reference.length)
    }
  })

  test("the landing lines and the counts of the receipt are the ones changedRanges and diffLines give", () => {
    for (const [seed, ending] of cases) {
      const [oldText, newText] = pair(seed, ending)
      const counted = diffLines(oldText, newText).reduce(
        (sum, change) => ({
          additions: sum.additions + (change.added ? change.count : 0),
          deletions: sum.deletions + (change.removed ? change.count : 0),
        }),
        { additions: 0, deletions: 0 },
      )

      const summary = WriteReceipt.summarize(unified(oldText, newText).changes, newText)

      expect({ seed, ...summary }).toEqual({
        seed,
        ranges: LSP.Diagnostic.changedRanges(oldText, newText, file),
        ...counted,
      })
    }
  })

  test("a receipt made from the diff of the tool is the receipt the receipt would have made itself", () => {
    for (const [seed, ending] of cases) {
      const [oldText, newText] = pair(seed, ending)
      const input = { file, oldText, newText, reformatted: false, replacements: 1 }

      const reused = WriteReceipt.writeReceipt({ ...input, changes: unified(oldText, newText).changes })

      expect({ seed, ...reused }).toEqual({ seed, ...WriteReceipt.writeReceipt(input) })
    }
  })

  test("a diff of the tool above the cap still gives counts and a diff, since the tool paid for it already", () => {
    const oldText = text(lines(600))
    const newText = text(lines(600, "changed"))

    const receipt = WriteReceipt.writeReceipt({
      file,
      oldText,
      newText,
      reformatted: false,
      changes: unified(oldText, newText).changes,
    })

    expect(receipt.text.split("\n").slice(0, 2)).toEqual([
      "Lines 1-600 changed. Additions: 600. Deletions: 600.",
      "@@ -1,600 +1,600 @@",
    ])
    expect(receipt.diffLines).toBe(40)
  })

  test("without a diff of the tool, a change above the cap is not compared line by line", () => {
    const oldText = text(lines(600))
    const newText = text(lines(600, "changed"))

    const receipt = WriteReceipt.writeReceipt({ file, oldText, newText, reformatted: true })

    expect(receipt).toEqual({
      text: [
        "Lines 1-600 changed. The change is too large to compare line by line, so counts and diff are left out.",
        "File was reformatted by the formatter after this write.",
      ].join("\n"),
      diffLines: 0,
    })
  })

  test("the lines named for a change that is too large run from the first to the last that differ", () => {
    const head = lines(50, "keep")
    const tail = lines(50, "end")
    const oldText = text([...head, ...lines(600), ...tail])
    const newText = text([...head, ...lines(600, "changed"), ...tail])

    const receipt = WriteReceipt.writeReceipt({ file, oldText, newText, reformatted: false })

    expect(receipt.text.split("\n")[0]).toMatch(/^Lines 51-650 changed\. The change is too large/)
  })

  test("a change just under the cap is compared line by line, and gives the same receipt as the diff of the tool", () => {
    const oldText = text(lines(240))
    const newText = text(lines(240, "changed"))
    const input = { file, oldText, newText, reformatted: false }

    const own = WriteReceipt.writeReceipt(input)

    expect(own.text.split("\n")[0]).toBe("Lines 1-240 changed. Additions: 240. Deletions: 240.")
    expect(own).toEqual(WriteReceipt.writeReceipt({ ...input, changes: unified(oldText, newText).changes }))
  })

  test("a new file is counted without a diff, however long it is", () => {
    const receipt = WriteReceipt.writeReceipt({ file, oldText: "", newText: text(lines(5000)), reformatted: false })

    expect(receipt).toEqual({ text: "Lines 1-5000 changed. Additions: 5000. Deletions: 0.", diffLines: 0 })
  })

  test("a new file without a final newline counts its last line", () => {
    const receipt = WriteReceipt.writeReceipt({ file, oldText: "", newText: "a\nb\nc", reformatted: false })

    expect(receipt.text).toBe("Lines 1-3 changed. Additions: 3. Deletions: 0.")
  })
})
