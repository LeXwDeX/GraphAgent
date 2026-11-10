// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as McpConfig from "./config"

import { Cause, Exit, Schema } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { ConfigMCP } from "@graphagent/core/config/mcp"
import { Flag } from "@graphagent/core/flag/flag"
import { Global } from "@graphagent/core/global"
import { InvalidError } from "@graphagent/core/v1/config/error"
import { PROJECT_DIR } from "@graphagent/core/brand"
import { hasProjectLayer } from "@/project/project-root"

/** A server entry as written in `mcp.json`. */
export type Server = Schema.Schema.Type<typeof ConfigMCP.Server>
export type Servers = Record<string, Server>
export type Scope = "global" | "project"

export interface Layer {
  readonly scope: Scope
  readonly file: string
}

/** The user-level file. `GRAPHAGENT_CONFIG_DIR` overrides the platform config directory. */
export function globalFile() {
  return path.join(Flag.GRAPHAGENT_CONFIG_DIR ?? Global.Path.config, "mcp.json")
}

/** The project-layer file, committed at `<root>/.agents/mcp.json`. */
export function projectFile(root: string) {
  return path.join(root, PROJECT_DIR, "mcp.json")
}

/**
 * Layer candidates in merge order: global first, project (when the root is a
 * real project layer) second. `$HOME/.agents` is the user-level shared
 * directory, never a project layer, so mcp.json entries there are not read
 * twice.
 */
export function layers(root: string): Layer[] {
  const global: Layer = { scope: "global", file: globalFile() }
  if (!hasProjectLayer(root, Global.Path.home)) return [global]
  return [global, { scope: "project", file: projectFile(root) }]
}

/**
 * Load and merge `mcp.json` from the user and project layers. A same-name
 * project entry replaces the whole user entry; there is no field-level
 * deep merge. A removed V1 shape throws a ConfigInvalidError naming the file
 * and the field that moved, never silently ignored.
 */
export function load(root: string): Servers {
  const servers: Servers = {}
  for (const layer of layers(root)) {
    if (!existsSync(layer.file)) continue
    Object.assign(servers, readLayer(layer.file))
  }
  return servers
}

/** The project-layer document as written, before schema decoding. */
export interface ProjectLayerDocument {
  /** Path relative to `<root>/.agents`, POSIX separators. */
  readonly relative: string
  readonly value: unknown
}

/**
 * The raw project-layer `mcp.json` value, for the project-trust enumeration.
 * The decoder applies schema defaults and rejects unknown fields, so its output
 * can never match the canonical value the enumeration fingerprinted; the gate
 * must read exactly what the file declares. Undefined when the root has no
 * project layer, the file is missing, or it does not parse — the loader reports
 * the parse error when it reads the same file.
 */
export function projectLayer(root: string): ProjectLayerDocument | undefined {
  if (!hasProjectLayer(root, Global.Path.home)) return undefined
  const file = projectFile(root)
  if (!existsSync(file)) return undefined
  const errors: ParseError[] = []
  const value = parse(readFileSync(file, "utf8"), errors, { allowTrailingComma: true })
  if (errors.length) return undefined
  return { relative: "mcp.json", value }
}

function readLayer(filepath: string): Servers {
  const text = readFileSync(filepath, "utf8")
  return decodeDocument(text, filepath)
}

/**
 * Decode one `mcp.json` document. Exported for the CLI writer and tests.
 */
export function decodeDocument(text: string, filepath: string): Servers {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    throw invalid(filepath, `mcp.json is not valid JSONC: ${errors.map(parseErrorMessage).join("; ")}`)
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(filepath, `mcp.json must be a JSON object with an "mcpServers" map.`)
  }

  const doc = value as Record<string, unknown>
  // V1 put the server-name map at the top level (or under a `mcp` key).
  if (!Object.hasOwn(doc, "mcpServers")) {
    const looksLikeV1 = Object.keys(doc).some((key) => key !== "$schema" && isRecord(doc[key]) && "type" in doc[key])
    throw invalid(
      filepath,
      looksLikeV1
        ? `mcp.json uses the removed V1 shape (server names at the top level). Move every entry under "mcpServers".`
        : `mcp.json must define servers under the "mcpServers" map.`,
    )
  }
  const extra = Object.keys(doc).filter((key) => key !== "$schema" && key !== "mcpServers")
  if (extra.length) {
    throw invalid(filepath, `mcp.json only accepts "mcpServers" (and optional "$schema"); remove: ${extra.join(", ")}.`)
  }

  const raw = doc.mcpServers
  if (raw === undefined) return {}
  if (!isRecord(raw)) throw invalid(filepath, `"mcpServers" must be an object keyed by server name.`)

  const servers: Servers = {}
  for (const [name, entry] of Object.entries(raw)) {
    const decoded = Schema.decodeUnknownExit(ConfigMCP.Server)(entry, { onExcessProperty: "error" })
    if (Exit.isSuccess(decoded)) {
      servers[name] = decoded.value
      continue
    }
    throw invalid(filepath, entryError(name, entry, Cause.squash(decoded.cause)))
  }
  return servers
}

function entryError(name: string, entry: unknown, error: unknown): string {
  const fields = isRecord(entry) ? Object.keys(entry) : []
  if (fields.includes("enabled")) {
    return `mcpServers["${name}"] uses the removed "enabled" field; use "disabled": true to turn a server off.`
  }
  if (fields.includes("protocol")) {
    return `mcpServers["${name}"] uses the removed "protocol" field; protocol negotiation is automatic.`
  }
  const detail = error instanceof Error ? error.message : String(error)
  return `mcpServers["${name}"] is not a valid MCP server entry: ${detail}`
}

function parseErrorMessage(error: ParseError): string {
  return `offset ${error.offset} (error ${error.error})`
}

function invalid(filepath: string, message: string) {
  return new InvalidError({ path: filepath, message })
}

/**
 * Write (or replace) one server entry in `mcp.json` while preserving comments
 * and unrelated keys. Refuses to patch a document that is not already in the
 * `mcpServers` shape so a V1 file is never half-migrated.
 */
export function upsert(file: string, name: string, server: Server): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : `{\n  "mcpServers": {}\n}\n`
  assertWritableShape(existing, file)
  const edits = modify(existing, ["mcpServers", name], JSON.parse(JSON.stringify(server)), {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const next = applyEdits(existing, edits)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, next.endsWith("\n") ? next : next + "\n")
}

function assertWritableShape(text: string, filepath: string) {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) throw invalid(filepath, `mcp.json is not valid JSONC; fix it before adding a server.`)
  if (!isRecord(value)) {
    throw invalid(filepath, `mcp.json must be a JSON object with an "mcpServers" map.`)
  }
  const keys = Object.keys(value).filter((key) => key !== "$schema")
  if (keys.length === 0) return
  if (!Object.hasOwn(value, "mcpServers")) {
    throw invalid(filepath, `mcp.json uses the removed V1 shape; move server entries under "mcpServers" first.`)
  }
  const extra = keys.filter((key) => key !== "mcpServers")
  if (extra.length) {
    throw invalid(filepath, `mcp.json only accepts "mcpServers" (and optional "$schema"); remove: ${extra.join(", ")}.`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}