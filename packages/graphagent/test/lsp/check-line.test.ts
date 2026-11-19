// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { Diagnostic } from "@/lsp/client"
import { LSP } from "@/lsp/lsp"

const file = "/project/src/sample.ts"
const oldText = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n")
// Line 5 changed.
const newText = ["a", "b", "c", "d", "E", "f", "g", "h", "i", "j"].join("\n")

/** A diagnostic that starts on the 1-based `line`. */
const at = (line: number, severity: Diagnostic["severity"] = 1): Diagnostic => ({
  severity,
  message: `issue on line ${line}`,
  range: { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 1 } },
})

const check = (issues: Diagnostic[]) => LSP.Diagnostic.checkLine("checked", file, issues, oldText, newText)

describe("Diagnostic.checkLine", () => {
  test("says why a check did not run", () => {
    const cases: [Exclude<LSP.Diagnostic.CheckStatus, "checked">, string][] = [
      ["disabled", "not checked: LSP disabled"],
      ["no_server", "not checked: no language server"],
      ["timed_out", "not checked: timed out"],
    ]
    for (const [status, line] of cases) {
      // The diagnostics on hand are stale when nothing ran: none of them may turn into a verdict.
      expect(LSP.Diagnostic.checkLine(status, file, [at(5)], oldText, newText)).toBe(line)
      expect(LSP.Diagnostic.checkLine(status, file, [], oldText, newText)).toBe(line)
    }
  })

  test("a check that ran and found nothing is clean", () => {
    expect(check([])).toBe("checked: clean")
  })

  test("counts the errors on and around the changed lines, singular and plural", () => {
    expect(check([at(5)])).toBe("checked: 1 error")
    expect(check([at(5), at(6)])).toBe("checked: 2 errors")
    // The same two-line halo afterEdit reports.
    expect(check([at(3)])).toBe("checked: 1 error")
    expect(check([at(7)])).toBe("checked: 1 error")
  })

  test("ignores errors the edit is not responsible for and anything below error severity", () => {
    expect(check([at(1), at(10)])).toBe("checked: clean")
    expect(check([at(5, 2), at(5, 3), at(5, 4)])).toBe("checked: clean")
    expect(check([at(5), at(5, 2), at(10)])).toBe("checked: 1 error")
  })

  test("counts what afterEdit reports", () => {
    const issues = [at(4), at(5, 2), at(6), at(9)]
    const block = LSP.Diagnostic.afterEdit(file, issues, oldText, newText)
    expect(block.match(/^ERROR /gm)?.length).toBe(2)
    expect(check(issues)).toBe("checked: 2 errors")
  })

  test("a file with no previous text counts every error in it", () => {
    expect(LSP.Diagnostic.checkLine("checked", file, [at(1), at(2)], "", "x\ny\n")).toBe("checked: 2 errors")
  })
})

// #1572: a tool that has the changed lines already gives them as ranges, or as a function that finds them, and no diff
// runs here.
describe("Diagnostic with the changed lines given", () => {
  const ranges = LSP.Diagnostic.changedRanges(oldText, newText, file)
  const issues = [at(1), at(4), at(5, 2), at(6), at(9)]

  /** A function for the lines that counts its calls. */
  const counting = (found: LSP.Diagnostic.LineRange[] = ranges) => {
    const calls = { count: 0 }
    return {
      calls,
      lines: () => {
        calls.count += 1
        return found
      },
    }
  }

  test("ranges give the line and the report that the two texts give", () => {
    expect(LSP.Diagnostic.checkLine("checked", file, issues, ranges)).toBe(
      LSP.Diagnostic.checkLine("checked", file, issues, oldText, newText),
    )
    expect(LSP.Diagnostic.afterEdit(file, issues, ranges)).toBe(
      LSP.Diagnostic.afterEdit(file, issues, oldText, newText),
    )
    expect(LSP.Diagnostic.checkLine("checked", file, issues, ranges)).toBe("checked: 2 errors")
  })

  test("a function gives them too, and is called once for each call that needs the lines", () => {
    const { calls, lines } = counting()

    expect(LSP.Diagnostic.checkLine("checked", file, issues, lines)).toBe("checked: 2 errors")
    expect(LSP.Diagnostic.afterEdit(file, issues, lines)).toBe(LSP.Diagnostic.afterEdit(file, issues, ranges))
    expect(calls.count).toBe(2)
  })

  test("the lines are not looked for when the file has no error to place", () => {
    const { calls, lines } = counting()

    expect(LSP.Diagnostic.checkLine("checked", file, [], lines)).toBe("checked: clean")
    expect(LSP.Diagnostic.checkLine("checked", file, [at(5, 2), at(5, 3), at(5, 4)], lines)).toBe("checked: clean")
    expect(LSP.Diagnostic.afterEdit(file, [], lines)).toBe("")
    expect(LSP.Diagnostic.afterEdit(file, [at(5, 2)], lines)).toBe("")
    expect(calls.count).toBe(0)
  })

  test("the lines are not looked for when the check did not run", () => {
    const { calls, lines } = counting()

    for (const status of ["disabled", "no_server", "timed_out"] as const) {
      expect(LSP.Diagnostic.checkLine(status, file, issues, lines)).toStartWith("not checked: ")
    }
    expect(calls.count).toBe(0)
  })

  test("an error outside the given lines is not counted", () => {
    expect(LSP.Diagnostic.checkLine("checked", file, [at(10)], ranges)).toBe("checked: clean")
    expect(LSP.Diagnostic.checkLine("checked", file, [at(10)], [{ start: 9, end: 10 }])).toBe("checked: 1 error")
    expect(LSP.Diagnostic.afterEdit(file, [at(10)], [])).toBe("")
  })
})
