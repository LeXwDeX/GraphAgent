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