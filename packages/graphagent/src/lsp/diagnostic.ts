import { structuredPatch } from "diff"
import * as LSPClient from "./client"

// A diagnostic just outside the edited hunk usually still belongs to it: an
// unused import appears at the top of the function that now uses it, a missing
// return type one line below the body that changed. Keep a small halo.
const RELATED_CONTEXT = 2

export interface LineRange {
  /** First line, 1-based and inclusive. */
  start: number
  /** Last line, 1-based and inclusive. */
  end: number
}

export function pretty(diagnostic: LSPClient.Diagnostic) {
  const severityMap = {
    1: "ERROR",
    2: "WARN",
    3: "INFO",
    4: "HINT",
  }

  const severity = severityMap[diagnostic.severity || 1]
  const line = diagnostic.range.start.line + 1
  const col = diagnostic.range.start.character + 1

  return `${severity} [${line}:${col}] ${diagnostic.message}`
}

/**
 * Line ranges in `newText` that differ from `oldText`. Pure deletions anchor at
 * the line that now follows the removed block so diagnostics covering the gap
 * stay reportable.
 */
export function changedRanges(oldText: string, newText: string, file = "file"): LineRange[] {
  if (oldText === newText) return []
  const total = newText.split("\n").length
  // Compare logical lines: a CRLF/LF difference alone must not mark every line
  // as changed and pull unrelated diagnostics into the edit report.
  return structuredPatch(file, file, oldText, newText, "", "", { context: 0, stripTrailingCr: true }).hunks.map(
    (hunk) =>
      hunk.newLines === 0
        ? { start: Math.min(Math.max(1, hunk.newStart), total), end: Math.min(Math.max(1, hunk.newStart), total) }
        : { start: hunk.newStart, end: hunk.newStart + hunk.newLines - 1 },
  )
}

/** Diagnostics that overlap a changed range, with a small halo around it. */
export function related(diagnostics: LSPClient.Diagnostic[], ranges: LineRange[]): LSPClient.Diagnostic[] {
  if (ranges.length === 0) return []
  return diagnostics.filter((diagnostic) => {
    const start = diagnostic.range.start.line + 1
    const end = diagnostic.range.end.line + 1
    return ranges.some((range) => start <= range.end + RELATED_CONTEXT && end >= range.start - RELATED_CONTEXT)
  })
}

const errorsOf = (issues: LSPClient.Diagnostic[]) => issues.filter((item) => item.severity === 1)

export function report(file: string, issues: LSPClient.Diagnostic[]) {
  const errors = errorsOf(issues)
  if (errors.length === 0) return ""
  // No per-block cap: the shared truncation layer bounds the whole tool output
  // and, when it does, saves the complete text with a read continuation.
  return `<diagnostics file="${file}">\n${errors.map(pretty).join("\n")}\n</diagnostics>`
}

/**
 * Diagnostics belonging to an edit: only errors that overlap the lines the
 * edit touched. Errors elsewhere in the file predate the change and saying them
 * again on every edit just teaches the model to ignore diagnostics.
 */
export function afterEdit(file: string, issues: LSPClient.Diagnostic[], oldText: string, newText: string) {
  return report(file, related(issues, changedRanges(oldText, newText, file)))
}

/**
 * Whether the language-server check after a write ran. Only `checked` carries a verdict; the others say why there is
 * none: LSP is off, no server handles the file, or the server did not answer within the wait.
 */
export type CheckStatus = "checked" | "disabled" | "no_server" | "timed_out"

const NOT_CHECKED = {
  disabled: "LSP disabled",
  no_server: "no language server",
  timed_out: "timed out",
} as const

/**
 * The status line of a write result. A check that ran counts the errors the edit is responsible for, the same ones
 * `afterEdit` lists; one that did not run says so, so that "not checked" is never read as "no errors".
 */
export function checkLine(
  status: CheckStatus,
  file: string,
  issues: LSPClient.Diagnostic[],
  oldText: string,
  newText: string,
) {
  if (status !== "checked") return `not checked: ${NOT_CHECKED[status]}`
  const count = errorsOf(related(issues, changedRanges(oldText, newText, file))).length
  if (count === 0) return "checked: clean"
  return `checked: ${count} ${count === 1 ? "error" : "errors"}`
}

export * as Diagnostic from "./diagnostic"
