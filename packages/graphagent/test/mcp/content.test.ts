// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { McpContent } from "@/mcp/content"

const base64 = (bytes: number) => Buffer.alloc(bytes).toString("base64")

describe("McpContent.omitted", () => {
  test("names an audio item by type and size", () => {
    expect(McpContent.omitted({ type: "audio", data: base64(2048), mimeType: "audio/wav" })).toBe(
      "[MCP audio omitted: audio/wav, 2 KB]",
    )
    expect(McpContent.omitted({ type: "audio", data: base64(10), mimeType: "audio/mpeg" }, "srv")).toBe(
      "[MCP audio omitted: audio/mpeg, 10 B]",
    )
  })

  test("leaves out the fields an audio item lacks", () => {
    expect(McpContent.omitted({ type: "audio", mimeType: "audio/wav" })).toBe("[MCP audio omitted: audio/wav]")
    expect(McpContent.omitted({ type: "audio", data: base64(2048) })).toBe("[MCP audio omitted: 2 KB]")
    expect(McpContent.omitted({ type: "audio" })).toBe("[MCP audio omitted]")
  })

  test("names a resource link and the call that reads it", () => {
    const link = {
      type: "resource_link",
      name: "report",
      uri: "file:///tmp/report.pdf",
      mimeType: "application/pdf",
      size: 2048,
    }
    expect(McpContent.omitted(link, "docs")).toBe(
      '[MCP resource_link: report file:///tmp/report.pdf (application/pdf, 2 KB); read it with read_mcp_resource server="docs" uri="file:///tmp/report.pdf"]',
    )
  })

  test("leaves out the read call when the server is not known", () => {
    expect(
      McpContent.omitted({ type: "resource_link", name: "report", uri: "file:///a", mimeType: "text/plain", size: 10 }),
    ).toBe("[MCP resource_link: report file:///a (text/plain, 10 B)]")
  })

  test("leaves out the fields a resource link lacks, and the parentheses when both are missing", () => {
    expect(McpContent.omitted({ type: "resource_link", name: "n", uri: "u", mimeType: "text/plain" }, "s")).toBe(
      '[MCP resource_link: n u (text/plain); read it with read_mcp_resource server="s" uri="u"]',
    )
    expect(McpContent.omitted({ type: "resource_link", name: "n", uri: "u", size: 3_000_000 }, "s")).toBe(
      '[MCP resource_link: n u (3 MB); read it with read_mcp_resource server="s" uri="u"]',
    )
    expect(McpContent.omitted({ type: "resource_link", name: "n", uri: "u" }, "s")).toBe(
      '[MCP resource_link: n u; read it with read_mcp_resource server="s" uri="u"]',
    )
  })

  test("names the type of an item it does not know", () => {
    expect(McpContent.omitted({ type: "video", data: "x" })).toBe('[MCP content omitted: type "video"]')
    expect(McpContent.omitted({ data: "x" })).toBe('[MCP content omitted: type "unknown"]')
    expect(McpContent.omitted("plain")).toBe('[MCP content omitted: type "unknown"]')
    expect(McpContent.omitted({ type: 'a"]\nb' })).toBe('[MCP content omitted: type "a\\"]\\nb"]')
  })
})

describe("McpContent.structured", () => {
  const value = { count: 2, items: ["a", "b"] }

  test("has nothing to show without structuredContent", () => {
    expect(McpContent.structured({ content: [{ type: "text", text: "x" }] })).toBeUndefined()
    expect(McpContent.structured({ content: [], structuredContent: undefined })).toBeUndefined()
    expect(McpContent.structured({ content: [], structuredContent: null })).toBeUndefined()
  })

  test("shows structuredContent as indented JSON beside the content", () => {
    const extra = McpContent.structured({ content: [{ type: "text", text: "done" }], structuredContent: value })
    expect(extra).toEqual({ type: "text", text: `structuredContent:\n${JSON.stringify(value, null, 2)}` })
    expect(extra?.text.split("\n").length).toBeGreaterThan(3)
  })

  test("does not repeat a text item that is the same JSON, however it is spaced", () => {
    expect(
      McpContent.structured({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }),
    ).toBeUndefined()
    expect(
      McpContent.structured({
        content: [{ type: "text", text: JSON.stringify(value, null, 4) }],
        structuredContent: value,
      }),
    ).toBeUndefined()
  })

  test("shows it when no text item is the same JSON or a text item is not JSON", () => {
    for (const content of [
      [],
      [{ type: "text", text: JSON.stringify({ count: 3 }) }],
      [{ type: "text", text: "not json {" }],
      [{ type: "image", data: "eA==", mimeType: "image/png" }],
    ]) {
      expect(McpContent.structured({ content, structuredContent: value })?.type).toBe("text")
    }
  })
})
