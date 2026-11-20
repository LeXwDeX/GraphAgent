// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

// #1606 (#1030 D3 acceptance): the workflow tool is split into one module per
// action group so each file stays reviewable. PR #1312 declared the 400-line
// cap, and render.ts later grew past it unnoticed; this test keeps the cap.
const MAX_LINES = 400
const directory = path.resolve(import.meta.dir, "../../src/tool/workflow")

/** The line count `wc -l` reports: newline-terminated lines. */
function lineCount(text: string) {
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
}

const sources = [...new Bun.Glob("*.ts").scanSync({ cwd: directory })].sort()

describe("workflow tool module size", () => {
  test("the scan finds the modules it is meant to read", () => {
    // An empty or partial scan would make the cap below pass for the wrong reason.
    for (const name of ["index.ts", "schema.ts", "render.ts", "render-result.ts", "control.ts", "inspect.ts"])
      expect(sources, name).toContain(name)
  })

  test(`no module under src/tool/workflow exceeds ${MAX_LINES} lines`, () => {
    const over = sources
      .map((name) => ({ name, lines: lineCount(readFileSync(path.join(directory, name), "utf8")) }))
      .filter((entry) => entry.lines > MAX_LINES)
      .map((entry) => `${entry.name}: ${entry.lines} lines`)
    expect(over).toEqual([])
  })
})
