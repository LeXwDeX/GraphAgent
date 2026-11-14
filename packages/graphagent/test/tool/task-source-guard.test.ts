// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import * as ts from "typescript"

/**
 * Issue #1026 PR3b: the task tool and the DAG drive their child sessions
 * through child runs, not through the `promptOps` bag of a tool context. The
 * bag stays for the shell tool's background mode, which prompts its own
 * session; nothing new may read it. `watch_pr` left the list in #1071 PR4: it
 * registers a durable watch instead of polling and prompting in-process.
 *
 * Source guards: they read the files, so a consumer that comes back fails
 * here whatever its tests say.
 */

const SRC = path.resolve(import.meta.dir, "../../src")

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [full] : []
  })

/** Whether code (not a comment, not a string) in the file uses an identifier named `name`. */
function usesIdentifier(file: string, name: string): boolean {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (ts.isIdentifier(node) && node.text === name) found = true
    else ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const relative = (file: string) => path.relative(SRC, file).replaceAll(path.sep, "/")

describe("promptOps source guard", () => {
  test("the task tool does not mention promptOps at all", () => {
    expect(readFileSync(path.join(SRC, "tool/task.ts"), "utf8")).not.toContain("promptOps")
  })

  test("the DAG does not use promptOps", () => {
    const users = sourceFiles(path.join(SRC, "dag")).filter((file) => usesIdentifier(file, "promptOps"))
    expect(users.map(relative)).toEqual([])
  })

  // The consumers that remain: the plumbing that hands the bag to a tool (`SessionTools`, the loop, the request
  // builder, the shell session) and the shell tool that prompts its own session. A new file here needs a reason
  // that is not "the task tool did it": drive a child session through `ctx.children`.
  const ALLOWED = new Set([
    "session/shell.ts",
    "session/tools.ts",
    "session/turn/loop.ts",
    "session/turn/prepare.ts",
    "tool/pipeline.ts",
    "tool/shell.ts",
  ])

  test("no new consumer reads it", () => {
    const users = sourceFiles(SRC)
      .filter((file) => usesIdentifier(file, "promptOps"))
      .map(relative)
    expect(users.filter((file) => !ALLOWED.has(file))).toEqual([])
    // The list only shrinks: a file that no longer uses the bag leaves it.
    expect(users.length).toBeGreaterThan(0)
  })

  test("the guard sees what it guards against", () => {
    const file = path.join(SRC, "tool/shell.ts")
    expect(usesIdentifier(file, "promptOps")).toBe(true)
    expect(usesIdentifier(file, "noSuchIdentifierAnywhere")).toBe(false)
  })
})
