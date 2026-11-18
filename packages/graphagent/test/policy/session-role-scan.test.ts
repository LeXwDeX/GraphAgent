// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1288 gate: who a session is (a root, a task subagent, a DAG node, whose root)
// is decided in one place, `SessionRole` (src/session/role.ts). Code under
// the directories below must not read `parentID` to decide it. oxlint cannot
// express that, so this gate scans the sources, following
// test/tool/tool-state-contract.test.ts. A line that only shows, writes, carries
// or walks the parent relation is a read-only relation: it is declared below
// with its reason, per file, and the declaration is exact in both directions.

import { describe, expect, it } from "bun:test"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")

/** The code that decides what a session may do or see: its tools, its child runs, its permissions, its HTTP guard. */
const DECISION_DIRECTORIES = [
  "src/tool",
  "src/session/child",
  "src/permission",
  "src/server/routes/instance/httpapi",
] as const

/**
 * `file` → how many code lines may mention `parentID`, and why none of them
 * decides a role or a root. A new mention fails the gate until the author
 * either asks `SessionRole` instead or declares the relation here; a
 * declaration whose line is gone fails too, so the list only shrinks with the
 * code.
 */
const READ_ONLY_RELATIONS = new Map<string, { readonly lines: number; readonly reason: string }>([
  [
    "src/tool/shell.ts",
    {
      lines: 1,
      reason: "hands the session row's parent to the PR-watch subscriber, whose own check is SessionRole.isChild",
    },
  ],
  [
    "src/tool/task.ts",
    {
      lines: 1,
      reason: "creates the child session under the caller: the relation is written, not read for a decision",
    },
  ],
  [
    "src/server/routes/instance/httpapi/middleware/workspace-routing.ts",
    {
      lines: 1,
      reason: "carries the routed session's row as a SessionRole.Ref hint; the guard decides with SessionRole.isChild",
    },
  ],
  [
    "src/server/routes/instance/httpapi/public.ts",
    { lines: 1, reason: "removes the create-time field the request schema rejects from the generated SDK surface" },
  ],
])

const MENTION = /\bparentID\b/

const isComment = (line: string) => {
  const text = line.trimStart()
  return text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")
}

/** The code lines of a source that mention `parentID`; prose in comments is not a decision. */
function mentionedLines(source: string): ReadonlyArray<number> {
  return source.split("\n").flatMap((line, index) => (!isComment(line) && MENTION.test(line) ? [index + 1] : []))
}

/**
 * Compares the mentions in `sources` (file → text) with the declared
 * relations. `undeclared` names files with more mentioning lines than declared;
 * `stale` names declarations that have more lines than the file has.
 */
function check(sources: ReadonlyMap<string, string>) {
  const undeclared: string[] = []
  const stale: string[] = []
  const files = new Set([...sources.keys(), ...READ_ONLY_RELATIONS.keys()])
  for (const file of [...files].sort()) {
    const lines = mentionedLines(sources.get(file) ?? "")
    const declared = READ_ONLY_RELATIONS.get(file)?.lines ?? 0
    if (lines.length > declared)
      undeclared.push(
        `${file}: line(s) ${lines.join(", ")} read \`parentID\` (${declared} declared). ` +
          "Decide who a session is with SessionRole (src/session/role.ts: isRoot, isChild, roleOf, parentOf, rootOf) " +
          "instead of its parent field; a read that only shows, writes, carries or walks the relation is declared " +
          "in READ_ONLY_RELATIONS with its reason.",
      )
    if (lines.length < declared)
      stale.push(`${file}: ${declared} declared line(s) but ${lines.length} found; update READ_ONLY_RELATIONS`)
  }
  return { undeclared, stale }
}

async function decisionSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>()
  for (const directory of DECISION_DIRECTORIES) {
    const found = await Array.fromAsync(
      new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: path.join(ROOT, directory), onlyFiles: true }),
    )
    for (const relative of found.sort()) {
      const file = `${directory}/${relative}`
      sources.set(file, await Bun.file(path.join(ROOT, file)).text())
    }
  }
  expect(sources.size, "expected source files under the decision directories").toBeGreaterThan(50)
  return sources
}

describe("session role gate (#1288)", () => {
  it("every parentID read under the decision directories is a declared read-only relation", async () => {
    expect(check(await decisionSources()).undeclared).toEqual([])
  })

  it("declares no relation that has gone from the code", async () => {
    expect(check(await decisionSources()).stale).toEqual([])
  })

  it("declares relations inside the scanned directories, each with a reason", () => {
    for (const [file, { lines, reason }] of READ_ONLY_RELATIONS) {
      expect(
        DECISION_DIRECTORIES.some((directory) => file.startsWith(`${directory}/`)),
        `${file} is outside the scanned directories`,
      ).toBe(true)
      expect(lines).toBeGreaterThan(0)
      expect(reason.length).toBeGreaterThan(20)
    }
  })

  it("fails a new decision on parentID, in a declared file and in a new one", async () => {
    const sources = await decisionSources()
    const withDecision = new Map(sources)
    withDecision.set(
      "src/tool/registry.ts",
      `${sources.get("src/tool/registry.ts") ?? ""}\nif (input.session.parentID) continue\n`,
    )
    withDecision.set("src/permission/new-guard.ts", "export const child = (session) => !!session.parentID\n")
    withDecision.set(
      "src/tool/shell.ts",
      `${sources.get("src/tool/shell.ts") ?? ""}\nconst child = session.parentID !== undefined\n`,
    )

    const { undeclared } = check(withDecision)

    expect(undeclared).toHaveLength(3)
    expect(undeclared.map((line) => line.split(":")[0])).toEqual([
      "src/permission/new-guard.ts",
      "src/tool/registry.ts",
      "src/tool/shell.ts",
    ])
    expect(undeclared.every((line) => line.includes("SessionRole"))).toBe(true)
  })

  it("does not count prose or other identifiers", () => {
    const source = [
      "// reads parentID to decide the role",
      "/**",
      " * parentID: the session's parent",
      " */",
      "const parentSessionID = session.parentSessionID",
      "const parentIDs = []",
      "const reallyRead = session.parentID",
    ].join("\n")

    expect(mentionedLines(source)).toEqual([7])
  })
})
