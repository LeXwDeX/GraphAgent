// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { diffLines, structuredPatch } from "diff"
import { LSP } from "@/lsp/lsp"

/**
 * What a write tool tells the model about the change it just made (#1451): where it landed, how much was added and
 * removed, whether the text was found by a fuzzy strategy, whether the formatter rewrote it, and a diff of at most
 * a fixed number of lines. The model reads this instead of assuming the file now holds what it asked for. Every
 * part is bounded, so the receipt goes into the result as it is.
 */

/** The diff lines a result shows, a patch of several files together. */
export const DIFF_LINES = 40

const DIFF_CONTEXT = 3
const MAX_DIFF_LINE = 200
const MAX_RANGES = 5

/** `line` cut to 200 code points with `…` after the cut. A character is never cut in half. */
function clip(line: string): string {
  if (line.length <= MAX_DIFF_LINE) return line
  let kept = 0
  let end = 0
  for (const char of line) {
    if (kept === MAX_DIFF_LINE) return `${line.slice(0, end)}…`
    kept += 1
    end += char.length
  }
  return line
}

/**
 * The diff of `oldText` into `newText`: each hunk under its `@@ -a,b +c,d @@` header, at most `maxLines` lines in
 * all, headers counted. When it is longer, the sentence at the end says how many lines were cut and where in the
 * file to read on. `shown` is the number of diff lines in `text`, without that sentence.
 */
export function boundedDiff(
  file: string,
  oldText: string,
  newText: string,
  maxLines: number,
): { text: string; shown: number } {
  const { hunks } = structuredPatch(file, file, oldText, newText, "", "", {
    context: DIFF_CONTEXT,
    stripTrailingCr: true,
  })
  const all = hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ])
  const shown = Math.max(0, Math.min(all.length, maxLines))
  const kept = all.slice(0, shown).map(clip)
  if (all.length > shown) {
    const from = Math.max(1, hunks.at(0)?.newStart ?? 1)
    kept.push(`[diff cut at ${shown} of ${all.length} lines; read ${file} from line ${from} to see the rest.]`)
  }
  return { text: kept.join("\n"), shown }
}

/** The first five ranges as `start-end`, and how many there are when some are left out. */
function rangeList(ranges: readonly LSP.Diagnostic.LineRange[]): string {
  const shown = ranges.slice(0, MAX_RANGES).map((range) => `${range.start}-${range.end}`)
  return ranges.length > MAX_RANGES ? `${shown.join(", ")}, ... (${ranges.length} in total)` : shown.join(", ")
}

/** Added and removed lines, counted the way the `filediff` of an edit result counts them. */
function lineCounts(oldText: string, newText: string) {
  let additions = 0
  let deletions = 0
  for (const change of diffLines(oldText, newText)) {
    if (change.added) additions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  return { additions, deletions }
}

/**
 * The receipt of one written file, as lines joined by `\n`: where the change landed, how much it added and removed
 * (`replacements` only for a tool that counts them), that the match was fuzzy (`fuzzy`), that the formatter rewrote
 * the file (`reformatted`), and the diff. A file that was empty or new has nothing to compare with, so no diff.
 * `diffLines` is how many lines of the budget the diff used, for a caller that spends it over several files. `text`
 * is empty when the text did not change.
 */
export function writeReceipt(input: {
  file: string
  oldText: string
  newText: string
  reformatted: boolean
  replacements?: number
  fuzzy?: { strategy: string; line: number }
  diffBudget?: number
}): { text: string; diffLines: number } {
  if (input.oldText === input.newText) return { text: "", diffLines: 0 }
  const parts: string[] = []
  // A change that only moved line endings has no range to name.
  const ranges = LSP.Diagnostic.changedRanges(input.oldText, input.newText, input.file)
  if (ranges.length > 0) {
    const { additions, deletions } = lineCounts(input.oldText, input.newText)
    const counted = input.replacements === undefined ? "" : ` Replacements: ${input.replacements}.`
    parts.push(`Lines ${rangeList(ranges)} changed.${counted} Additions: ${additions}. Deletions: ${deletions}.`)
  }
  if (input.fuzzy) {
    parts.push(
      `Matched by fuzzy strategy ${input.fuzzy.strategy} at line ${input.fuzzy.line} (not an exact match); check the diff below.`,
    )
  }
  if (input.reformatted) parts.push("File was reformatted by the formatter after this write.")
  const diff =
    input.oldText === ""
      ? { text: "", shown: 0 }
      : boundedDiff(input.file, input.oldText, input.newText, input.diffBudget ?? DIFF_LINES)
  if (diff.text) parts.push(diff.text)
  return { text: parts.join("\n"), diffLines: diff.shown }
}

export * as WriteReceipt from "./write-receipt"
