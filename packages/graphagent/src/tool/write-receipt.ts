// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { formatPatch, structuredPatch } from "diff"
import { changedRanges } from "@/lsp/diagnostic"

/**
 * What a write tool tells the model about the change it just made (#1451): where it landed, how much was added and
 * removed, whether the text was found by a fuzzy strategy, whether the formatter rewrote it, and a diff of at most
 * a fixed number of lines. The model reads this instead of assuming the file now holds what it asked for. Every
 * part is bounded, so the receipt goes into the result as it is.
 *
 * Diffing a file in which nearly every line changed takes seconds, so a receipt does not run a diff when the tool has
 * run one already: the tool diffs the text for its permission request with `unifiedDiff` and keeps the hunks
 * (`Changes`), and the receipt is made from them. Only a file that the formatter rewrote has no diff to take, and
 * the diff of its receipt is capped at `MAX_EDITS`: a change of more is named by the lines it spans, without counts
 * and diff. The lines that the language-server check places its errors by (#1572) are read from the same hunks
 * (`lazyRanges`).
 */

/** The diff lines a result shows, a patch of several files together. */
export const DIFF_LINES = 40

/** The most line edits the diff of a receipt looks for; a change of more is not compared line by line. */
export const MAX_EDITS = 500

const DIFF_CONTEXT = 3
const MAX_DIFF_LINE = 200
const MAX_RANGES = 5

/** One hunk of a diff, as `structuredPatch` makes it: its lines begin with ` `, `+` or `-`; one without a newline is followed by `\ No newline at end of file`. */
export interface Hunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly string[]
}

/** A diff that was run: its hunks, with at least three lines of context each. */
export interface Changes {
  readonly hunks: readonly Hunk[]
}

/** Lines of the new text, first and last, both 1-based and inclusive. */
export interface LineRange {
  start: number
  end: number
}

/**
 * The unified diff of `oldText` into `newText`, as `createTwoFilesPatch` writes it, with the hunks it was written
 * from, so that the receipt of the write does not have to run the diff again. Runs the diff once.
 */
export function unifiedDiff(file: string, oldText: string, newText: string): { text: string; changes: Changes } {
  const patch = structuredPatch(file, file, oldText, newText)
  // `formatPatch` moves the start of a hunk without old or new lines one line up, in place: copy the hunks first.
  const hunks = patch.hunks.map((hunk) => ({ ...hunk }))
  return { text: formatPatch(patch), changes: { hunks } }
}

/** The diff of the two texts for a receipt, or nothing when it takes more than `MAX_EDITS` line edits. */
function changesOf(file: string, oldText: string, newText: string): Changes | undefined {
  const patch = structuredPatch(file, file, oldText, newText, "", "", {
    context: DIFF_CONTEXT,
    stripTrailingCr: true,
    maxEditLength: MAX_EDITS,
  })
  return patch && { hunks: patch.hunks }
}

/** One line of a hunk with the numbers it has in the old and in the new text, and the line that says it has no newline. */
interface Row {
  readonly line: string
  readonly kind: string
  readonly note: string | undefined
  readonly oldNo: number
  readonly newNo: number
}

function rowsOf(hunk: Hunk): Row[] {
  const rows: Row[] = []
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  for (const line of hunk.lines) {
    const last = rows.at(-1)
    if (line.startsWith("\\") && last) {
      rows[rows.length - 1] = { ...last, note: line }
      continue
    }
    const kind = line.charAt(0)
    rows.push({ line, kind, note: undefined, oldNo, newNo })
    if (kind !== "+") oldNo += 1
    if (kind !== "-") newNo += 1
  }
  return rows
}

function hunkOf(rows: readonly Row[]): Hunk {
  return {
    oldStart: rows[0].oldNo,
    oldLines: rows.filter((row) => row.kind !== "+").length,
    newStart: rows[0].newNo,
    newLines: rows.filter((row) => row.kind !== "-").length,
    lines: rows.flatMap((row) => (row.note === undefined ? [row.line] : [row.line, row.note])),
  }
}

/**
 * The hunks with `context` lines of context: cut down from a diff that has more, and split where two changes are
 * more than twice that far apart, which is what a diff run with that context makes of them.
 */
function withContext(hunks: readonly Hunk[], context: number): Hunk[] {
  return hunks.flatMap((hunk) => {
    const rows = rowsOf(hunk)
    const keep = rows.map((row) => row.kind !== " ")
    rows.forEach((row, at) => {
      if (row.kind === " ") return
      for (let i = at - 1; i >= Math.max(0, at - context) && rows[i].kind === " "; i--) keep[i] = true
      for (let i = at + 1; i <= Math.min(rows.length - 1, at + context) && rows[i].kind === " "; i++) keep[i] = true
    })
    const pieces: Row[][] = []
    let open = false
    rows.forEach((row, at) => {
      if (keep[at] && open) pieces[pieces.length - 1].push(row)
      else if (keep[at]) pieces.push([row])
      open = keep[at]
    })
    return pieces.map(hunkOf)
  })
}

/** `line` without the carriage return of a CRLF file, cut to 200 code points with `…` after the cut. A character is never cut in half. */
function clip(line: string): string {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line
  if (text.length <= MAX_DIFF_LINE) return text
  let kept = 0
  let end = 0
  for (const char of text) {
    if (kept === MAX_DIFF_LINE) return `${text.slice(0, end)}…`
    kept += 1
    end += char.length
  }
  return text
}

/**
 * The diff of `oldText` into `newText`: each hunk under its `@@ -a,b +c,d @@` header, at most `maxLines` lines in
 * all, headers counted. When it is longer, the sentence at the end says how many lines were cut and where in the
 * file to read on. `shown` is the number of diff lines in `text`, without that sentence. `changes` is the diff when
 * it was run already; without it one is run here, and a change of more than `MAX_EDITS` line edits has no diff.
 */
export function boundedDiff(
  file: string,
  oldText: string,
  newText: string,
  maxLines: number,
  changes: Changes | undefined = changesOf(file, oldText, newText),
): { text: string; shown: number } {
  if (!changes) return { text: "", shown: 0 }
  const hunks = withContext(changes.hunks, DIFF_CONTEXT)
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

function newlines(text: string): number {
  let count = 0
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count += 1
  return count
}

/** How many lines the text has, the way `read` counts them: a final newline does not start another. */
const lineCount = (text: string) => newlines(text) + (text.endsWith("\n") ? 0 : 1)

function landing(run: { start: number; added: number }, total: number): LineRange {
  if (run.added > 0) return { start: run.start, end: run.start + run.added - 1 }
  // Pure deletions anchor at the line that now follows the removed block.
  const at = Math.min(Math.max(1, run.start), total)
  return { start: at, end: at }
}

/**
 * The lines of the new text the change touched, each run of changed lines as one range (the same ranges
 * `LSP.Diagnostic.changedRanges` gives for a diff that compares logical lines, see `lazyRanges`), and how many lines it
 * added and removed, counted the way `diffLines` counts.
 */
export function summarize(
  changes: Changes,
  newText: string,
): { ranges: LineRange[]; additions: number; deletions: number } {
  const total = newlines(newText) + 1
  const ranges: LineRange[] = []
  let additions = 0
  let deletions = 0
  for (const hunk of changes.hunks) {
    let next = hunk.newStart
    let run: { start: number; added: number } | undefined
    for (const line of hunk.lines) {
      const kind = line.charAt(0)
      if (kind === "\\") continue
      if (kind === " ") {
        if (run) ranges.push(landing(run, total))
        run = undefined
        next += 1
        continue
      }
      run ??= { start: next, added: 0 }
      if (kind === "+") {
        additions += 1
        run.added += 1
        next += 1
      } else {
        deletions += 1
      }
    }
    if (run) ranges.push(landing(run, total))
  }
  return { ranges, additions, deletions }
}

/**
 * Where a write landed, for the language-server check of its result: the lines of `newText` that differ from `oldText`,
 * the ranges `LSP.Diagnostic.changedRanges` gives. It returns a function that works them out the first time it is called
 * and keeps them. The check calls it only for a file that has an error, so a write without one costs no diff here.
 *
 * `changes` is the diff the tool ran for its permission request, when the text is still what that diff was made from
 * (the formatter did not change it): the lines are then read from it, and no other diff runs. That holds only while
 * neither text has a CRLF line ending. `changedRanges` compares logical lines, and the diff of the tool compares lines
 * as they are; a patch writes the lines of its chunk without their carriage return, so the lines around the one it
 * changed differ from the old ones by their ending alone, and the hunks span the whole chunk where `changedRanges`
 * names only the line that changed. Texts with CRLF, and a write that has no diff, are compared by `changedRanges`.
 */
export function lazyRanges(file: string, oldText: string, newText: string, changes?: Changes): () => LineRange[] {
  let found: LineRange[] | undefined
  return () => {
    found ??=
      changes && !oldText.includes("\r\n") && !newText.includes("\r\n")
        ? summarize(changes, newText).ranges
        : changedRanges(oldText, newText, file)
    return found
  }
}

/** The first five ranges as `start-end`, and how many there are when some are left out. */
function rangeList(ranges: readonly LineRange[]): string {
  const shown = ranges.slice(0, MAX_RANGES).map((range) => `${range.start}-${range.end}`)
  return ranges.length > MAX_RANGES ? `${shown.join(", ")}, ... (${ranges.length} in total)` : shown.join(", ")
}

function landingSentence(
  summary: { ranges: readonly LineRange[]; additions: number; deletions: number },
  replacements: number | undefined,
): string {
  const counted = replacements === undefined ? "" : ` Replacements: ${replacements}.`
  return `Lines ${rangeList(summary.ranges)} changed.${counted} Additions: ${summary.additions}. Deletions: ${summary.deletions}.`
}

function logicalLines(text: string): string[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/** The sentence for a change that was not compared: the lines from the first to the last that differ, found by looking at the top and the bottom only. */
function tooLarge(oldText: string, newText: string): string {
  const before = logicalLines(oldText)
  const after = logicalLines(newText)
  let top = 0
  while (top < before.length && top < after.length && before[top] === after[top]) top += 1
  let bottom = 0
  while (
    bottom < before.length - top &&
    bottom < after.length - top &&
    before[before.length - 1 - bottom] === after[after.length - 1 - bottom]
  ) {
    bottom += 1
  }
  const start = top + 1
  const end = Math.max(start, after.length - bottom)
  return `Lines ${start}-${end} changed. The change is too large to compare line by line, so counts and diff are left out.`
}

/**
 * The receipt of one written file, as lines joined by `\n`: where the change landed, how much it added and removed
 * (`replacements` only for a tool that counts them), that the match was fuzzy (`fuzzy`), that the formatter rewrote
 * the file (`reformatted`), and the diff. A file that was empty or new has nothing to compare with, so no diff.
 * `changes` is the diff of exactly these two texts when the tool has run it, and then the receipt runs none; without
 * it one is run, capped at `MAX_EDITS` edits (see the top of the file). `diffLines` is how many lines of the budget
 * the diff used, for a caller that spends it over several files. `text` is empty when the text did not change.
 */
export function writeReceipt(input: {
  file: string
  oldText: string
  newText: string
  reformatted: boolean
  replacements?: number
  fuzzy?: { strategy: string; line: number }
  diffBudget?: number
  changes?: Changes
}): { text: string; diffLines: number } {
  if (input.oldText === input.newText) return { text: "", diffLines: 0 }
  const created = input.oldText === ""
  const found = created ? undefined : (input.changes ?? changesOf(input.file, input.oldText, input.newText))
  const parts: string[] = []
  if (created) {
    const lines = lineCount(input.newText)
    parts.push(
      landingSentence({ ranges: [{ start: 1, end: lines }], additions: lines, deletions: 0 }, input.replacements),
    )
  } else if (found) {
    // A change that only moved line endings has no range to name.
    const summary = summarize(found, input.newText)
    if (summary.ranges.length > 0) parts.push(landingSentence(summary, input.replacements))
  } else {
    parts.push(tooLarge(input.oldText, input.newText))
  }
  if (input.fuzzy) {
    parts.push(
      `Matched by fuzzy strategy ${input.fuzzy.strategy} at line ${input.fuzzy.line} (not an exact match); check the diff below.`,
    )
  }
  if (input.reformatted) parts.push("File was reformatted by the formatter after this write.")
  const diff = found
    ? boundedDiff(input.file, input.oldText, input.newText, input.diffBudget ?? DIFF_LINES, found)
    : { text: "", shown: 0 }
  if (diff.text) parts.push(diff.text)
  return { text: parts.join("\n"), diffLines: diff.shown }
}

export * as WriteReceipt from "./write-receipt"
