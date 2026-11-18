// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { Client } from "@modelcontextprotocol/client"
import { convertTool } from "@/mcp/catalog"
import { mcpHookOptions } from "@/mcp/elicitation-binding"

// A client that only answers `callTool`, with the result the test gives it.
const answering = (result: unknown) => ({ callTool: async () => result }) as unknown as Client
const definition = { name: "probe", description: "", inputSchema: { type: "object" as const, properties: {} } }
const options = () => ({ toolCallId: "call-1", messages: [], abortSignal: new AbortController().signal })

const run = (result: unknown, hook = false) => {
  const tool = convertTool(definition, answering(result), undefined, "srv")
  const next = options()
  return Promise.resolve(tool.execute!({}, hook ? mcpHookOptions(next) : next))
}

const structured = { count: 2, items: ["a", "b"] }

describe("convertTool results", () => {
  test("an error keeps its text and says what else it carried", async () => {
    const result = {
      isError: true,
      content: [
        { type: "text", text: "the call failed" },
        { type: "audio", data: Buffer.alloc(2048).toString("base64"), mimeType: "audio/wav" },
        { type: "resource_link", name: "log", uri: "file:///tmp/log.txt" },
      ],
    }
    const failure = await run(result).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain("the call failed")
    expect(message).toContain("[MCP audio omitted: audio/wav, 2 KB]")
    expect(message).toContain(
      '[MCP resource_link: log file:///tmp/log.txt; read it with read_mcp_resource server="srv" uri="file:///tmp/log.txt"]',
    )
  })

  test("an error with no text still names what it carried", async () => {
    const failure = await run({
      isError: true,
      content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((failure as Error).message).toBe("[MCP audio omitted: audio/wav, 3 B]")
  })

  test("an error with no content keeps its generic message", async () => {
    const failure = await run({ isError: true, content: [] }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((failure as Error).message).toBe("MCP tool returned an error")
  })

  test("structuredContent is shown beside content, not instead of it", async () => {
    const result = { content: [{ type: "text", text: "summary" }], structuredContent: structured }
    const out = (await run(result)) as { content: Array<{ type: string; text: string }>; structuredContent: unknown }
    expect(out.content).toHaveLength(2)
    expect(out.content[0]).toEqual({ type: "text", text: "summary" })
    expect(out.content[1]?.text).toBe(`structuredContent:\n${JSON.stringify(structured, null, 2)}`)
    expect(out.content[1]?.text.split("\n").length).toBeGreaterThan(3)
    expect(out.structuredContent).toEqual(structured)
  })

  test("a text item that is the same JSON is not repeated", async () => {
    const result = {
      content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
      structuredContent: structured,
    }
    expect(await run(result)).toBe(result)
  })

  test("a result without structuredContent is returned as it is", async () => {
    const result = { content: [{ type: "text", text: "plain" }] }
    expect(await run(result)).toBe(result)
  })

  test("a call from a hook still gets one compact JSON line", async () => {
    const result = { content: [{ type: "text", text: "summary" }], structuredContent: structured }
    const out = (await run(result, true)) as { content: Array<{ type: string; text: string }> }
    expect(out.content).toEqual([{ type: "text", text: JSON.stringify(structured) }])
    expect(out.content[0]?.text).not.toContain("\n")
  })

  test("a call from a hook without structuredContent is returned as it is", async () => {
    const result = { content: [{ type: "text", text: "plain" }] }
    expect(await run(result, true)).toBe(result)
  })
})
