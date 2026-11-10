// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "fs"
import path from "path"
import {
  canonicalize,
  enumerateProjectEntries,
  fingerprint,
  MISSING_FILE_MARKER,
  referencedFiles,
  type FingerprintFileSystem,
  type FingerprintInput,
  type TrustEntry,
} from "@/project/trust"
import { tmpdir } from "../fixture/fixture"

const files: FingerprintFileSystem = {
  realpath: (candidate) => {
    try {
      return realpathSync(candidate)
    } catch {
      return undefined
    }
  },
  isFile: (resolved) => {
    try {
      return statSync(resolved).isFile()
    } catch {
      return false
    }
  },
  read: (resolved) => {
    try {
      return readFileSync(resolved)
    } catch {
      return undefined
    }
  },
}

function query(root: string): FingerprintInput {
  return { root, realRoot: root, files }
}

function write(root: string, file: string, contents: string) {
  const target = path.join(root, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

function entry(overrides: Partial<TrustEntry> = {}): TrustEntry {
  return {
    id: "hooks.json|hook|Stop||1",
    category: "hook",
    label: "Stop",
    index: 1,
    source: { file: "hooks.json" },
    canonical: canonicalize("hook", { type: "command", command: "echo hi", event: "Stop" }),
    references: [],
    display: { text: "echo hi", commands: ["echo hi"], urls: [], envKeys: [] },
    ...overrides,
  }
}

describe("fingerprint", () => {
  test("is a stable sha256 hex string", async () => {
    await using tmp = await tmpdir()
    const item = entry()
    const first = fingerprint(item, query(tmp.path))
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprint(item, query(tmp.path))).toBe(first)
  })

  test("command, args, cwd, url, matcher and event changes change the fingerprint", async () => {
    await using tmp = await tmpdir()
    const input = query(tmp.path)
    const hook = (overrides: Record<string, unknown>) =>
      fingerprint(
        entry({
          canonical: canonicalize("hook", { type: "command", command: "echo hi", event: "Stop", ...overrides }),
        }),
        input,
      )
    const reference = hook({})
    expect(hook({ command: "echo changed" })).not.toBe(reference)
    expect(hook({ args: ["extra"] })).not.toBe(reference)
    expect(hook({ url: "https://example.com" })).not.toBe(reference)
    expect(hook({ matcher: "Bash" })).not.toBe(reference)
    expect(hook({ event: "PreToolUse" })).not.toBe(reference)

    const mcp = (overrides: Record<string, unknown>) =>
      fingerprint(
        entry({
          category: "mcp",
          mcpType: "local",
          canonical: canonicalize("mcp", { type: "local", command: ["bun"], ...overrides }),
        }),
        input,
      )
    const mcpReference = mcp({})
    expect(mcp({ cwd: "tools" })).not.toBe(mcpReference)
    expect(mcp({ environment: { TOKEN: "x" } })).not.toBe(mcpReference)
    expect(mcp({ headers: { Authorization: "x" } })).not.toBe(mcpReference)
  })

  test("environment and header values do not change the fingerprint", async () => {
    await using tmp = await tmpdir()
    const input = query(tmp.path)
    const first = fingerprint(
      entry({
        category: "mcp",
        mcpType: "local",
        canonical: canonicalize("mcp", {
          type: "local",
          command: ["bun"],
          environment: { TOKEN: "one" },
          headers: { Authorization: "one" },
        }),
      }),
      input,
    )
    const second = fingerprint(
      entry({
        category: "mcp",
        mcpType: "local",
        canonical: canonicalize("mcp", {
          type: "local",
          command: ["bun"],
          environment: { TOKEN: "two" },
          headers: { Authorization: "two" },
        }),
      }),
      input,
    )
    expect(second).toBe(first)
  })

  test("key order and comments do not change the fingerprint", async () => {
    await using tmp = await tmpdir()
    write(tmp.path, "guard.sh", "echo guard")
    const plain = `{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"./guard.sh"}]}]}`
    const commented = `{
      // a comment
      "Stop": [
        {
          "matcher": "*",
          "hooks": [
            { "command": "./guard.sh", "type": "command" } // trailing
          ]
        }
      ]
    }`
    const enumerated = (text: string) =>
      enumerateProjectEntries({
        files: [{ file: "hooks.json", text }],
        isTracked: () => false,
      }).entries[0]
    expect(fingerprint(enumerated(commented), query(tmp.path))).toBe(fingerprint(enumerated(plain), query(tmp.path)))
  })
})

describe("referenced files", () => {
  test("a referenced project script is hashed and its content change changes the fingerprint", async () => {
    await using tmp = await tmpdir()
    const input = query(tmp.path)
    const item = entry({ references: ["./scripts/guard.sh"] })
    write(tmp.path, "scripts/guard.sh", "one")

    const first = fingerprint(item, input)
    expect(referencedFiles(item, input)).toEqual([
      { path: "scripts/guard.sh", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ])

    write(tmp.path, "scripts/guard.sh", "two")
    expect(fingerprint(item, input)).not.toBe(first)
  })

  test("a missing referenced file records a marker; creating it changes the fingerprint", async () => {
    await using tmp = await tmpdir()
    const input = query(tmp.path)
    const item = entry({ references: ["./scripts/later.sh"] })

    expect(referencedFiles(item, input)).toEqual([{ path: "scripts/later.sh", sha256: MISSING_FILE_MARKER }])
    const before = fingerprint(item, input)
    write(tmp.path, "scripts/later.sh", "now here")
    expect(fingerprint(item, input)).not.toBe(before)
  })

  test("directories are not hashed", async () => {
    await using tmp = await tmpdir()
    mkdirSync(path.join(tmp.path, "scripts"), { recursive: true })
    write(tmp.path, "scripts/tool.sh", "one")
    const item = entry({ references: ["./scripts"] })
    expect(referencedFiles(item, query(tmp.path))).toEqual([])
  })

  test("paths outside the project are not hashed", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    write(outside.path, "outside.sh", "one")
    const item = entry({ references: [path.join(outside.path, "outside.sh")] })

    expect(referencedFiles(item, query(tmp.path))).toEqual([])
    const before = fingerprint(item, query(tmp.path))
    write(outside.path, "outside.sh", "two")
    expect(fingerprint(item, query(tmp.path))).toBe(before)
  })

  test(".agents/worktree files are not hashed", async () => {
    await using tmp = await tmpdir()
    const item = entry({ references: [".agents/worktree/guard.sh"] })
    write(tmp.path, ".agents/worktree/guard.sh", "one")

    expect(referencedFiles(item, query(tmp.path))).toEqual([])
    const before = fingerprint(item, query(tmp.path))
    write(tmp.path, ".agents/worktree/guard.sh", "two")
    expect(fingerprint(item, query(tmp.path))).toBe(before)
  })

  test("a symlink that resolves outside the project is not hashed", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    write(outside.path, "target.sh", "one")
    symlinkSync(path.join(outside.path, "target.sh"), path.join(tmp.path, "link.sh"))
    const item = entry({ references: ["./link.sh"] })

    expect(referencedFiles(item, query(tmp.path))).toEqual([])
    const before = fingerprint(item, query(tmp.path))
    write(outside.path, "target.sh", "two")
    expect(fingerprint(item, query(tmp.path))).toBe(before)
  })

  test("a symlink that resolves inside the project hashes the target content", async () => {
    await using tmp = await tmpdir()
    write(tmp.path, "scripts/guard.sh", "one")
    symlinkSync(path.join(tmp.path, "scripts/guard.sh"), path.join(tmp.path, "link.sh"))
    const item = entry({ references: ["./link.sh"] })
    const input = query(tmp.path)

    expect(referencedFiles(item, input)).toEqual([
      { path: "scripts/guard.sh", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ])
    const before = fingerprint(item, input)
    write(tmp.path, "scripts/guard.sh", "two")
    expect(fingerprint(item, input)).not.toBe(before)
  })

  test("relative references resolve from the entry cwd", async () => {
    await using tmp = await tmpdir()
    const input = query(tmp.path)
    write(tmp.path, "tools/server.ts", "one")
    const item = entry({
      category: "mcp",
      mcpType: "local",
      cwd: "tools",
      canonical: canonicalize("mcp", { type: "local", command: ["bun"], cwd: "tools" }),
      references: ["server.ts"],
    })

    expect(referencedFiles(item, input)).toEqual([
      { path: "tools/server.ts", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ])
    const before = fingerprint(item, input)
    write(tmp.path, "tools/server.ts", "two")
    expect(fingerprint(item, input)).not.toBe(before)
  })

  test("an indirect reference inside a script does not participate", async () => {
    await using tmp = await tmpdir()
    const input = query(tmp.path)
    const item = entry({ references: ["./a.sh"] })
    write(tmp.path, "a.sh", "sh ./b.sh")
    write(tmp.path, "b.sh", "echo one")

    const before = fingerprint(item, input)
    write(tmp.path, "b.sh", "echo two")
    expect(fingerprint(item, input)).toBe(before)

    write(tmp.path, "a.sh", "sh ./b.sh --changed")
    expect(fingerprint(item, input)).not.toBe(before)
  })

  test("duplicate references are hashed once", async () => {
    await using tmp = await tmpdir()
    write(tmp.path, "guard.sh", "one")
    const once = entry({ references: ["./guard.sh"] })
    const twice = entry({ references: ["./guard.sh", "./guard.sh"] })
    expect(referencedFiles(twice, query(tmp.path))).toEqual(referencedFiles(once, query(tmp.path)))
    expect(fingerprint(twice, query(tmp.path))).toBe(fingerprint(once, query(tmp.path)))
  })
})
