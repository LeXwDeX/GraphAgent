// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Hash } from "@graphagent/core/util/hash"
import {
  canonicalize,
  classifyEntryChanges,
  entryLocation,
  escapeLocationPart,
  projectId,
  projectIdentity,
  type FingerprintedEntry,
  type TrustEntry,
} from "@/project/trust"

function entry(id: string): TrustEntry {
  return {
    id,
    category: "hook",
    label: "Stop",
    index: 1,
    source: { file: "hooks.json" },
    canonical: canonicalize("hook", { type: "command", command: "echo hi", event: "Stop" }),
    references: [],
    display: { text: "echo hi", commands: ["echo hi"], urls: [], envKeys: [] },
  }
}

function current(id: string, fingerprint: string): FingerprintedEntry {
  return { entry: entry(id), fingerprint }
}

describe("entryLocation", () => {
  test("joins file, category, label, matcher and index", () => {
    expect(
      entryLocation({ file: "hooks.json", category: "hook", label: "PreToolUse", matcher: "Bash", index: 1 }),
    ).toBe("hooks.json|hook|PreToolUse|Bash|1")
    expect(entryLocation({ file: "mcp.json", category: "mcp", label: "local", index: 2 })).toBe("mcp.json|mcp|local||2")
  })

  test("escapes separators inside a matcher and a path", () => {
    expect(
      entryLocation({ file: "hooks.json", category: "hook", label: "PreToolUse", matcher: "Edit|Write", index: 1 }),
    ).toBe("hooks.json|hook|PreToolUse|Edit%7CWrite|1")
    expect(escapeLocationPart("a%b|c")).toBe("a%25b%7Cc")
    expect(escapeLocationPart("line\nbreak")).toBe("line%0Abreak")
  })
})

describe("classifyEntryChanges", () => {
  const previous = [
    { id: "unchanged", fp: "aa" },
    { id: "modified", fp: "bb" },
    { id: "removed", fp: "cc" },
  ]

  test("reports new, modified, unchanged and removed locations", () => {
    const result = classifyEntryChanges(previous, [
      current("unchanged", "aa"),
      current("modified", "different"),
      current("added", "dd"),
    ])

    expect(result.entries.map((item) => ({ id: item.entry.id, change: item.change, fp: item.fingerprint }))).toEqual([
      { id: "unchanged", change: undefined, fp: "aa" },
      { id: "modified", change: "modified", fp: "different" },
      { id: "added", change: "new", fp: "dd" },
    ])
    expect(result.removed).toEqual(["removed"])
  })

  test("an empty record makes every location new", () => {
    const result = classifyEntryChanges([], [current("one", "aa"), current("two", "bb")])
    expect(result.entries.map((item) => item.change)).toEqual(["new", "new"])
    expect(result.removed).toEqual([])
  })

  test("a vanished project removes every recorded location", () => {
    const result = classifyEntryChanges(previous, [])
    expect(result.entries).toEqual([])
    expect(result.removed).toEqual(["unchanged", "modified", "removed"])
  })
})

describe("project identity", () => {
  test("hashes the resolved root, not the display path", () => {
    const identity = projectIdentity({ root: "/display/repo", realRoot: "/real/repo" })
    expect(identity.id).toBe(Hash.sha256("/real/repo"))
    expect(identity.root).toBe("/display/repo")
    expect(identity.remote).toBeUndefined()
    expect(projectId("/real/repo")).toBe(identity.id)
  })

  test("two clones in different directories are different projects", () => {
    expect(projectId("/real/one")).not.toBe(projectId("/real/two"))
  })

  test("the git remote is display only and optional", () => {
    expect(projectIdentity({ root: "/r", realRoot: "/r", remote: "git@example.com:repo" }).remote).toBe(
      "git@example.com:repo",
    )
    expect(projectIdentity({ root: "/r", realRoot: "/r", remote: "" }).remote).toBeUndefined()
    expect(projectIdentity({ root: "/r", realRoot: "/r", remote: "" }).id).toBe(projectId("/r"))
  })
})
