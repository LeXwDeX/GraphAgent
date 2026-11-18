// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { isRecord } from "@/util/record"

/**
 * What the model reads when an MCP result carries something that cannot be passed on as text or as a file, and how a
 * result's `structuredContent` is shown beside its `content` (#1447). The model must be told what was left out and,
 * where there is one, how to get it.
 */

/** Bytes of a base64 string once decoded. */
export function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

/** A byte count as the MCP notices write it. */
export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/** The present parts, comma separated; an absent part leaves no gap. */
function joinParts(parts: ReadonlyArray<string | undefined>) {
  return parts.filter((part): part is string => part !== undefined).join(", ")
}

function audioNotice(item: Record<string, unknown>) {
  const detail = joinParts([
    nonEmpty(item.mimeType),
    typeof item.data === "string" ? formatBytes(base64Size(item.data)) : undefined,
  ])
  return detail ? `[MCP audio omitted: ${detail}]` : "[MCP audio omitted]"
}

function linkNotice(item: Record<string, unknown>, server: string | undefined) {
  const name = nonEmpty(item.name)
  const uri = nonEmpty(item.uri)
  const head = [name, uri].filter((part) => part !== undefined).join(" ")
  const detail = joinParts([
    nonEmpty(item.mimeType),
    typeof item.size === "number" && Number.isFinite(item.size) && item.size >= 0 ? formatBytes(item.size) : undefined,
  ])
  const hint =
    server !== undefined && uri !== undefined ? `; read it with read_mcp_resource server="${server}" uri="${uri}"` : ""
  return `[MCP resource_link:${head ? ` ${head}` : ""}${detail ? ` (${detail})` : ""}${hint}]`
}

/**
 * The line that stands where a content item cannot be passed on: an `audio` item, a `resource_link` (with the call
 * that reads it, when the server is known), or an item of a type this client does not know.
 */
export function omitted(item: unknown, server?: string): string {
  const record = isRecord(item) ? item : {}
  if (record.type === "audio") return audioNotice(record)
  if (record.type === "resource_link") return linkNotice(record, server)
  return `[MCP content omitted: type ${JSON.stringify(typeof record.type === "string" ? record.type : "unknown")}]`
}

/** True when a text item of `content` is the JSON of `compact`, however the server spaced it. */
function repeatsAsText(content: ReadonlyArray<unknown>, compact: string) {
  return content.some((item) => {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return false
    try {
      return JSON.stringify(JSON.parse(item.text)) === compact
    } catch {
      return false
    }
  })
}

/**
 * The text item that shows a result's `structuredContent` beside its `content`, so neither replaces the other.
 * `undefined` when there is none, or when a text item of `content` already carries the same JSON (a server that
 * follows the MCP advice to serialize `structuredContent` into a text item too).
 */
export function structured(result: {
  readonly content: ReadonlyArray<unknown>
  readonly structuredContent?: unknown
}): { type: "text"; text: string } | undefined {
  const value = result.structuredContent
  if (value === undefined || value === null) return undefined
  const compact = JSON.stringify(value)
  if (compact === undefined || repeatsAsText(result.content, compact)) return undefined
  return { type: "text", text: "structuredContent:\n" + JSON.stringify(value, null, 2) }
}

export * as McpContent from "./content"
