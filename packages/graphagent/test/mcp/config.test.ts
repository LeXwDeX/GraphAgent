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
