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
    for (const [status, line] of [
      ["disabled", "not checked: LSP disabled"],
      ["no_server", "not checked: no language server"],
      ["timed_out", "not checked: timed out"],
    ] as const) {
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
