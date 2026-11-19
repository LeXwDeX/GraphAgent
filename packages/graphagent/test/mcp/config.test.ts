// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "@graphagent/core/global"
import { McpConfig } from "../../src/mcp/config"

let configDir: string
let root: string
let previous: string | undefined

beforeEach(() => {
  configDir = mkdtempSync(path.join(os.tmpdir(), "mcp-config-dir-"))
  root = mkdtempSync(path.join(os.tmpdir(), "mcp-project-root-"))
  previous = process.env.GRAPHAGENT_CONFIG_DIR
  process.env.GRAPHAGENT_CONFIG_DIR = configDir
})

afterEach(() => {
  if (previous === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
  else process.env.GRAPHAGENT_CONFIG_DIR = previous
  rmSync(configDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

function write(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

function errorMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    const message = (error as { data?: { message?: string } }).data?.message
    return message ?? (error instanceof Error ? error.message : String(error))
  }
  throw new Error("expected the call to throw")
}

describe("mcp.json layers", () => {
  test("global entries load from the redirected config directory", () => {
    expect(McpConfig.globalFile()).toBe(path.join(configDir, "mcp.json"))
    write(McpConfig.globalFile(), {
      mcpServers: { remote: { type: "remote", url: "https://example.com/mcp" } },
    })

    expect(McpConfig.load(root)).toEqual({
      remote: expect.objectContaining({ type: "remote", url: "https://example.com/mcp" }),
    })
  })

  test("a same-name project entry replaces the whole user entry", () => {
    write(McpConfig.globalFile(), {
      mcpServers: {
        shared: { type: "remote", url: "https://global.example.com/mcp", headers: { "X-Scope": "global" } },
        "global-only": { type: "local", command: ["echo", "global"] },
      },
    })
    write(McpConfig.projectFile(root), {
      mcpServers: { shared: { type: "local", command: ["echo", "project"] } },
    })

    expect(McpConfig.layers(root).map((layer) => layer.scope)).toEqual(["global", "project"])
    expect(McpConfig.load(root)).toEqual({
      shared: expect.objectContaining({ type: "local", command: ["echo", "project"] }),
      "global-only": expect.objectContaining({ type: "local", command: ["echo", "global"] }),
    })
  })

  test("$HOME/.agents is a user-level directory, never a project layer", () => {
    expect(McpConfig.layers(Global.Path.home).map((layer) => layer.scope)).toEqual(["global"])
  })
})

// Issue #1575: one layer file that cannot be read must not take the other layer's servers down with it.
describe("mcp.json loadValid", () => {
  const entry = (name: string) => ({ mcpServers: { [name]: { type: "local", command: ["echo", name] } } })
  const failed = (loaded: McpConfig.Loaded) => loaded.failures.map((failure) => failure.file)

  test("skips a user layer that cannot be read and keeps the project layer", () => {
    writeFileSync(McpConfig.globalFile(), "{ not json")
    write(McpConfig.projectFile(root), entry("project"))

    const loaded = McpConfig.loadValid(root)

    expect(Object.keys(loaded.servers)).toEqual(["project"])
    expect(failed(loaded)).toEqual([McpConfig.globalFile()])
    expect(errorMessage(() => McpConfig.load(root))).toMatch(/not valid JSONC/)
  })

  test("skips a project layer that cannot be read and keeps the user layer", () => {
    write(McpConfig.globalFile(), entry("user"))
    write(McpConfig.projectFile(root), { server: { type: "local", command: ["echo"] } })

    const loaded = McpConfig.loadValid(root)

    expect(Object.keys(loaded.servers)).toEqual(["user"])
    expect(failed(loaded)).toEqual([McpConfig.projectFile(root)])
    expect(errorMessage(() => McpConfig.load(root))).toMatch(/removed V1 shape/)
  })

  test("reports each layer that cannot be read, in merge order, and has no servers left", () => {
    writeFileSync(McpConfig.globalFile(), "{ not json")
    write(McpConfig.projectFile(root), { mcpServers: {}, extra: true })

    const loaded = McpConfig.loadValid(root)

    expect(loaded.servers).toEqual({})
    expect(loaded.failures).toMatchObject([
      { file: McpConfig.globalFile(), error: { data: { message: expect.stringContaining("not valid JSONC") } } },
      {
        file: McpConfig.projectFile(root),
        error: { data: { message: expect.stringContaining('only accepts "mcpServers"') } },
      },
    ])
  })

  test("a layer with one invalid entry is skipped whole, not entry by entry", () => {
    write(McpConfig.globalFile(), {
      mcpServers: {
        good: { type: "local", command: ["echo", "good"] },
        old: { type: "local", command: ["echo", "old"], enabled: true },
      },
    })
    write(McpConfig.projectFile(root), entry("project"))

    const loaded = McpConfig.loadValid(root)

    expect(Object.keys(loaded.servers)).toEqual(["project"])
    expect(failed(loaded)).toEqual([McpConfig.globalFile()])
  })

  test("a layer that cannot be read as a file is skipped like one that cannot be decoded", () => {
    // A directory where the file should be: `existsSync` is true and `readFileSync` throws EISDIR.
    mkdirSync(McpConfig.globalFile(), { recursive: true })
    write(McpConfig.projectFile(root), entry("project"))

    const loaded = McpConfig.loadValid(root)

    expect(Object.keys(loaded.servers)).toEqual(["project"])
    expect(failed(loaded)).toEqual([McpConfig.globalFile()])
  })

  test("merges the layers that can be read as load does, and has no failures when all can", () => {
    write(McpConfig.globalFile(), {
      mcpServers: {
        shared: { type: "remote", url: "https://global.example.com/mcp" },
        "global-only": { type: "local", command: ["echo", "global"] },
      },
    })
    write(McpConfig.projectFile(root), { mcpServers: { shared: { type: "local", command: ["echo", "project"] } } })

    const loaded = McpConfig.loadValid(root)

    expect(loaded.failures).toEqual([])
    expect(loaded.servers).toEqual(McpConfig.load(root))
    expect(loaded.servers.shared).toMatchObject({ type: "local", command: ["echo", "project"] })
  })

  test("has nothing to load and nothing to report when no layer file exists", () => {
    expect(McpConfig.loadValid(root)).toEqual({ servers: {}, failures: [] })
  })
})

describe("mcp.json upsert", () => {
  const remote = () =>
    McpConfig.decodeDocument(
      JSON.stringify({ mcpServers: { entry: { type: "remote", url: "https://added.example.com/mcp" } } }),
      "fixture.json",
    ).entry

  test("preserves comments and unrelated entries", () => {
    const file = McpConfig.projectFile(root)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      `{
  // existing servers
  "mcpServers": {
    "existing": { "type": "local", "command": ["echo", "existing"] }
  }
}
`,
    )

    McpConfig.upsert(file, "added", remote())

    const text = readFileSync(file, "utf8")
    expect(text).toContain("// existing servers")
    expect(McpConfig.load(root)).toMatchObject({
      existing: { type: "local", command: ["echo", "existing"] },
      added: { type: "remote", url: "https://added.example.com/mcp" },
    })
  })

  test("refuses to half-migrate a V1 document", () => {
    const file = path.join(root, "legacy.json")
    write(file, { server: { type: "local", command: ["echo"] } })

    expect(errorMessage(() => McpConfig.upsert(file, "added", remote()))).toMatch(/removed V1 shape/)
  })
})

// Issue #1458: MCP.tools() runs on every step. A layer file is read again only when its signature changes, and a
// file that cannot be read leaves the last valid servers in place.
describe("mcp.json cache", () => {
  const entry = (name: string) => ({ mcpServers: { [name]: { type: "local", command: ["echo", name] } } })
  const counting = () => {
    const reads = { count: 0 }
    const files = McpConfig.cached((target) => {
      reads.count += 1
      return McpConfig.load(target)
    })
    return { reads, files }
  }

  test("reads the files once while their signature stays the same", () => {
    write(McpConfig.globalFile(), entry("one"))
    const { reads, files } = counting()

    expect(files(root)).toEqual({ servers: { one: expect.objectContaining({ command: ["echo", "one"] }) } })
    expect(files(root).servers).toHaveProperty("one")
    expect(files(root).servers).toHaveProperty("one")

    expect(reads.count).toBe(1)
  })

  test("reads again when a layer file changes size, or the project layer appears", () => {
    write(McpConfig.globalFile(), entry("one"))
    const { reads, files } = counting()
    files(root)

    write(McpConfig.globalFile(), entry("one-with-a-longer-name"))
    expect(Object.keys(files(root).servers)).toEqual(["one-with-a-longer-name"])
    expect(reads.count).toBe(2)

    write(McpConfig.projectFile(root), entry("project"))
    expect(Object.keys(files(root).servers).sort()).toEqual(["one-with-a-longer-name", "project"])
    expect(reads.count).toBe(3)
  })

  test("a missing file is part of the signature", () => {
    expect(McpConfig.signature(root)).toBe(McpConfig.signature(root))
    const absent = McpConfig.signature(root)

    write(McpConfig.globalFile(), entry("one"))

    expect(McpConfig.signature(root)).not.toBe(absent)
  })

  test("keeps the last valid servers when a file becomes unreadable and reports it once", () => {
    write(McpConfig.globalFile(), entry("one"))
    const { reads, files } = counting()
    files(root)

    writeFileSync(McpConfig.globalFile(), "{ not json")
    const broken = files(root)
    expect(Object.keys(broken.servers)).toEqual(["one"])
    expect(broken.error).toBeDefined()
    expect(errorMessage(() => McpConfig.load(root))).toMatch(/not valid JSONC/)

    const again = files(root)
    expect(Object.keys(again.servers)).toEqual(["one"])
    expect(again.error).toBeUndefined()
    // One read for the valid file and one for the broken one; the same broken file is not read again.
    expect(reads.count).toBe(2)

    write(McpConfig.globalFile(), entry("two"))
    const fixed = files(root)
    expect(Object.keys(fixed.servers)).toEqual(["two"])
    expect(fixed.error).toBeUndefined()
    expect(reads.count).toBe(3)
  })

  test("a different broken file is reported again", () => {
    write(McpConfig.globalFile(), entry("one"))
    const { files } = counting()
    files(root)

    writeFileSync(McpConfig.globalFile(), "{ not json")
    expect(files(root).error).toBeDefined()
    writeFileSync(McpConfig.globalFile(), "{ still not json")

    expect(files(root).error).toBeDefined()
  })

  test("has no servers to keep when the first read fails", () => {
    writeFileSync(McpConfig.globalFile(), "{ not json")
    const { reads, files } = counting()

    const first = files(root)
    expect(first.servers).toEqual({})
    expect(first.error).toBeDefined()
    expect(files(root)).toEqual({ servers: {} })
    expect(reads.count).toBe(1)
  })

  // Issue #1575: with no last valid read to keep, the layers that can be read stand in.
  test("serves the layers that can be read when the first read fails, and reports the failure once", () => {
    writeFileSync(McpConfig.globalFile(), "{ not json")
    write(McpConfig.projectFile(root), entry("project"))
    const { reads, files } = counting()

    const first = files(root)
    expect(Object.keys(first.servers)).toEqual(["project"])
    expect(first.error).toMatchObject({ data: { path: McpConfig.globalFile() } })

    // The same broken content: the same servers, no second report, and no second read.
    const again = files(root)
    expect(again.servers).toBe(first.servers)
    expect(again.error).toBeUndefined()
    expect(files(root).servers).toBe(first.servers)
    expect(reads.count).toBe(1)

    // Fixing the file brings its servers in, and the failure is gone.
    write(McpConfig.globalFile(), entry("user"))
    const fixed = files(root)
    expect(Object.keys(fixed.servers).sort()).toEqual(["project", "user"])
    expect(fixed.error).toBeUndefined()
    expect(reads.count).toBe(2)
  })

  test("a different unreadable content is reported again with the layers that can be read", () => {
    writeFileSync(McpConfig.globalFile(), "{ not json")
    const { files } = counting()
    expect(files(root).error).toBeDefined()

    write(McpConfig.projectFile(root), entry("project"))
    const next = files(root)

    expect(Object.keys(next.servers)).toEqual(["project"])
    expect(next.error).toBeDefined()
  })

  test("keeps the last valid servers of every layer, not only of the layers that can still be read", () => {
    write(McpConfig.globalFile(), entry("user"))
    write(McpConfig.projectFile(root), entry("project"))
    const { files } = counting()
    files(root)

    writeFileSync(McpConfig.globalFile(), "{ not json")
    const broken = files(root)

    expect(Object.keys(broken.servers).sort()).toEqual(["project", "user"])
    expect(broken.error).toBeDefined()
    expect(Object.keys(files(root).servers).sort()).toEqual(["project", "user"])
  })
})

// Issue #1459: `deferred` keeps a server's tool definitions out of the tool list and in a one-line catalog.
describe("mcp.json deferred", () => {
  test("accepts a boolean deferred on a local and on a remote entry, and leaves it unset by default", () => {
    const servers = McpConfig.decodeDocument(
      JSON.stringify({
        mcpServers: {
          local: { type: "local", command: ["echo", "test"], deferred: true },
          remote: { type: "remote", url: "https://example.com/mcp", deferred: false },
          plain: { type: "local", command: ["echo", "plain"] },
        },
      }),
      "mcp.json",
    )
    expect(servers.local.deferred).toBe(true)
    expect(servers.remote.deferred).toBe(false)
    expect(servers.plain.deferred).toBeUndefined()
  })

  test("rejects a deferred that is not a boolean, and names the server", () => {
    for (const entry of [
      { type: "local", command: ["echo", "test"], deferred: "yes" },
      { type: "remote", url: "https://example.com/mcp", deferred: 1 },
    ]) {
      const message = errorMessage(() =>
        McpConfig.decodeDocument(JSON.stringify({ mcpServers: { server: entry } }), "mcp.json"),
      )
      expect(message).toContain('mcpServers["server"] is not a valid MCP server entry')
      expect(message).toContain("Expected boolean")
    }
  })
})
