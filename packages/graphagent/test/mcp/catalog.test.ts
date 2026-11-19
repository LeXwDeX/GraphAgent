// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { asSchema } from "ai"
import { describe, expect, test } from "bun:test"
import { Effect, Logger } from "effect"
import { Client } from "@modelcontextprotocol/client"
import { McpCatalog } from "@/mcp/catalog"

const client = () => new Client({ name: "fixture", version: "0" })

// The JSON schema a model is told for a server tool whose input schema is `inputSchema`.
const advertised = async (inputSchema: { type: "object"; [key: string]: unknown }) => {
  const tool = McpCatalog.convertTool({ name: "x", inputSchema }, client())
  return Promise.resolve(asSchema(tool.inputSchema).jsonSchema)
}

describe("convertTool additionalProperties (B2)", () => {
  test("keeps additionalProperties: true", async () => {
    const schema = await advertised({ type: "object", additionalProperties: true })
    expect(schema.additionalProperties).toBe(true)
  })

  test("keeps additionalProperties: false and a schema the server declared", async () => {
    expect((await advertised({ type: "object", additionalProperties: false })).additionalProperties).toBe(false)
    const declared = await advertised({ type: "object", additionalProperties: { type: "string" } })
    expect(declared.additionalProperties).toEqual({ type: "string" })
  })

  test("writes false only when the server declared nothing, after the server's own keys", async () => {
    const input = { type: "object" as const, properties: { q: { type: "string" } }, required: ["q"] }
    const schema = await advertised(input)
    expect(schema.additionalProperties).toBe(false)
    expect(JSON.stringify(schema)).toBe(JSON.stringify({ ...input, additionalProperties: false }))
    // A schema with no `properties` still gets an empty set, as before.
    expect(JSON.stringify(await advertised({ type: "object" }))).toBe(
      JSON.stringify({ type: "object", properties: {}, additionalProperties: false }),
    )
  })
})

const warned = <A, E>(effect: Effect.Effect<A, E>) => {
  const warnings: unknown[] = []
  const collector = Logger.make((entry) => {
    if (entry.logLevel === "Warn") warnings.push(entry.message)
  })
  return Effect.runPromise(effect.pipe(Effect.provide(Logger.layer([collector])))).then((result) => ({
    result,
    warnings,
  }))
}

describe("fetch with sanitized keys (B3)", () => {
  test("keeps the first of two prompts that share a command key and warns about the other", async () => {
    const { result, warnings } = await warned(
      McpCatalog.fetch("srv", client(), async () => [{ name: "a.b" }, { name: "a_b" }], "prompts"),
    )
    expect(Object.keys(result ?? {})).toEqual(["srv:a_b"])
    expect(result?.["srv:a_b"]?.name).toBe("a.b")
    expect(warnings).toHaveLength(1)
    expect(JSON.stringify(warnings[0])).toContain("a_b")
  })

  test("the first listed wins whichever name it is", async () => {
    const { result } = await warned(
      McpCatalog.fetch("srv", client(), async () => [{ name: "a_b" }, { name: "a.b" }, { name: "a b" }], "prompts"),
    )
    expect(result?.["srv:a_b"]?.name).toBe("a_b")
    expect(Object.keys(result ?? {})).toEqual(["srv:a_b"])
  })

  test("distinct names are all kept, with the client, and nothing is warned about", async () => {
    const { result, warnings } = await warned(
      McpCatalog.fetch("srv", client(), async () => [{ name: "one" }, { name: "two.x" }], "prompts"),
    )
    expect(result).toEqual({
      "srv:one": { name: "one", client: "srv" },
      "srv:two_x": { name: "two.x", client: "srv" },
    })
    expect(warnings).toEqual([])
  })

  test("a listing that names its own key keeps the later of two equal keys, as before", async () => {
    const { result, warnings } = await warned(
      McpCatalog.fetch(
        "srv",
        client(),
        async () => [
          { name: "first", uri: "file:///a" },
          { name: "second", uri: "file:///a" },
        ],
        "resources",
        (item) => item.uri,
      ),
    )
    expect(Object.keys(result ?? {})).toEqual(["srv:file:///a"])
    expect(result?.["srv:file:///a"]?.name).toBe("second")
    expect(warnings).toEqual([])
  })

  test("a listing that fails still resolves to undefined", async () => {
    const { result } = await warned(
      McpCatalog.fetch(
        "srv",
        client(),
        async () => {
          throw new Error("list failed")
        },
        "prompts",
      ),
    )
    expect(result).toBeUndefined()
  })
})

describe("definitionBytes (#1459)", () => {
  test("warns above 16384 bytes", () => {
    expect(McpCatalog.MCP_DEFINITION_WARN_BYTES).toBe(16384)
  })

  test("is the bytes of the description plus the bytes of the schema as JSON", () => {
    const inputSchema = { type: "object" as const, properties: { q: { type: "string" } }, required: ["q"] }
    expect(McpCatalog.definitionBytes({ description: "find it", inputSchema })).toBe(
      Buffer.byteLength("find it") + Buffer.byteLength(JSON.stringify(inputSchema)),
    )
    expect(McpCatalog.definitionBytes({ description: "find it", inputSchema })).toBe(
      "find it".length + '{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}'.length,
    )
  })

  test("counts bytes and not characters, in the description and in the schema", () => {
    // é is 2 bytes, € is 3 and an emoji is 4.
    const inputSchema = { type: "object" as const, properties: { "€": {} } }
    expect(McpCatalog.definitionBytes({ description: "é€\u{1F600}", inputSchema })).toBe(
      2 + 3 + 4 + Buffer.byteLength('{"type":"object","properties":{"€":{}}}'),
    )
    expect(Buffer.byteLength('{"type":"object","properties":{"€":{}}}')).toBe(
      '{"type":"object","properties":{"€":{}}}'.length + 2,
    )
  })

  test("takes a missing description as empty", () => {
    const inputSchema = { type: "object" as const }
    expect(McpCatalog.definitionBytes({ inputSchema })).toBe(Buffer.byteLength('{"type":"object"}'))
    expect(McpCatalog.definitionBytes({ description: "", inputSchema })).toBe(
      McpCatalog.definitionBytes({ inputSchema }),
    )
  })
})
