// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- partial agent, session and processor fixtures use `as never`.
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import { describe, expect, test } from "bun:test"
import { asSchema, jsonSchema, tool, type Tool, type ToolExecutionOptions } from "ai"
import { Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { SettingsHook } from "@/hook"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { SafetyGuard } from "@/permission/safety-guard"
import { ProviderProfile } from "@/provider/profile"
import { ProviderTransform } from "@/provider/transform"
import { MessageID, SessionID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { classifyToolError } from "@/session/tool-outcome"
import * as McpDeferred from "@/tool/mcp-deferred"
import { ModelContext } from "@/tool/model-context"
import { ToolRegistry, type ToolEntry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { mcpEntries } from "../fixture/tool-registry"
import { pollWithTimeout, testEffect } from "../lib/effect"

const { ArgumentsError, MCP_DEFERRED_IDS, MCP_DEFERRED_TOOLS } = McpDeferred

/**
 * #1459 PR2: a deferred server's tools stay out of the tool list. The model reads their one-line catalog in the
 * description of `mcp_describe`, loads a schema with it, and calls the tool through `mcp_call`. The call is the
 * target's own call in every other respect: its permission question, its hooks and its forced ask use the target's
 * key.
 */

describe("the helper names", () => {
  test("are the names a server tool may not take", () => {
    expect([...McpCatalog.RESERVED_TOOL_KEYS]).toEqual([...MCP_DEFERRED_IDS])
    expect([...MCP_DEFERRED_IDS]).toEqual([MCP_DEFERRED_TOOLS.describe, MCP_DEFERRED_TOOLS.call])
  })

  test("ArgumentsError is classed by the engine as an invalid-arguments fault, not an execution error", () => {
    const error = new ArgumentsError("bad")
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe("bad")
    expect(error.name).toBe("ToolInvalidArgumentsError")
    expect(classifyToolError(error)).toBe("validation_error")
  })
})

describe("catalogLine", () => {
  const line = McpDeferred.catalogLine

  test("takes the first sentence of the first line, with its stop", () => {
    expect(line("srv_a", "Look things up. Then more text.")).toBe("- srv_a: Look things up.")
    expect(line("srv_a", "Is it there? Maybe.")).toBe("- srv_a: Is it there?")
    expect(line("srv_a", "Stop now! Really.")).toBe("- srv_a: Stop now!")
    expect(line("srv_a", "Ends with a stop.")).toBe("- srv_a: Ends with a stop.")
  })

  test("a stop that no space follows is not the end of a sentence", () => {
    expect(line("srv_a", "Reads v1.2 files. More.")).toBe("- srv_a: Reads v1.2 files.")
    expect(line("srv_a", "See https://example.com/a.b for more")).toBe("- srv_a: See https://example.com/a.b for more")
  })

  test("a full-width stop ends a sentence without a space after it", () => {
    expect(line("srv_a", "查询天气。其余说明")).toBe("- srv_a: 查询天气。")
    expect(line("srv_a", "真的吗？是的")).toBe("- srv_a: 真的吗？")
    expect(line("srv_a", "停下！然后")).toBe("- srv_a: 停下！")
  })

  test("the first line only, and the whole line when it has no stop", () => {
    expect(line("srv_a", "No stop on this line\nSecond line. Third.")).toBe("- srv_a: No stop on this line")
    expect(line("srv_a", "First line\r\nSecond line.")).toBe("- srv_a: First line")
    // A sentence that runs over a line break is cut at the break, not at the stop on the next line.
    expect(line("srv_a", "Alpha\ndoes it. Second.")).toBe("- srv_a: Alpha")
  })

  test("white space becomes one space", () => {
    expect(line("srv_a", "  Many   spaces\t here.  Next.")).toBe("- srv_a: Many spaces here.")
  })

  test("an empty description has a stand-in", () => {
    expect(line("srv_a", "")).toBe("- srv_a: (no description)")
    expect(line("srv_a", "  \n\t ")).toBe("- srv_a: (no description)")
  })

  test("a line over 120 code points is cut to 119 and an ellipsis", () => {
    const prefix = "- srv_a: "
    const exact = "y".repeat(120 - prefix.length)
    expect(line("srv_a", exact)).toBe(prefix + exact)
    expect(Array.from(line("srv_a", exact))).toHaveLength(120)

    const over = line("srv_a", "y".repeat(121 - prefix.length))
    expect(Array.from(over)).toHaveLength(120)
    expect(over.endsWith("y…")).toBe(true)
    expect(over).toBe(prefix + "y".repeat(119 - prefix.length) + "…")
  })

  test("counts code points, so a character outside the basic plane is one", () => {
    const prefix = "- srv_a: "
    const text = "😀".repeat(200)
    const cut = line("srv_a", text)
    expect(Array.from(cut)).toHaveLength(120)
    expect(cut).toBe(prefix + "😀".repeat(119 - prefix.length) + "…")
  })
})

describe("makeChecker", () => {
  const schema: JSONSchema7 = {
    type: "object",
    properties: {
      name: { type: "string" },
      mode: { type: "string", enum: ["fast", "slow"] },
      level: { type: "integer", minimum: 1 },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["name"],
    additionalProperties: false,
  }

  test("returns nothing for a value that fits", () => {
    const check = McpDeferred.makeChecker()
    expect(check(schema, { name: "a", mode: "fast", level: 2, tags: ["x"] })).toBeUndefined()
    expect(check(schema, { name: "a" })).toBeUndefined()
  })

  test("names the root as (root) and the others by their path", () => {
    const check = McpDeferred.makeChecker()
    expect(check(schema, {})).toBe("(root) must have required property 'name'")
    expect(check(schema, { name: 1 })).toBe("/name must be string")
    expect(check(schema, { name: "a", tags: ["x", 2] })).toBe("/tags/1 must be string")
    expect(check(schema, { name: "a", extra: true })).toBe("(root) must NOT have additional properties")
  })

  test("lists the allowed values of an enum with the engine's wording", () => {
    const check = McpDeferred.makeChecker()
    expect(check(schema, { name: "a", mode: "nope" })).toBe('/mode must be one of "fast", "slow"')
    const many = { type: "string", enum: Array.from({ length: 25 }, (_, index) => `v${index}`) } as const
    const detail = check({ type: "object", properties: { v: many } }, { v: "zzz" })
    expect(detail?.startsWith('/v must be one of "v0", "v1"')).toBe(true)
    expect(detail).toContain("(first 20 of 25)")
    // An enum of anything but strings, numbers and booleans keeps the validator's own words.
    expect(check({ type: "object", properties: { v: { enum: [null, { a: 1 }] } } }, { v: 2 })).toBe(
      "/v must be equal to one of the allowed values",
    )
  })

  test("never repeats the value it refused", () => {
    const check = McpDeferred.makeChecker()
    for (const value of [
      { name: "a", mode: "SECRET_VALUE_1" },
      { name: "SECRET_VALUE_2", level: "SECRET_VALUE_3" },
      { name: "a", extra: "SECRET_VALUE_4" },
    ]) {
      const detail = check(schema, value) ?? ""
      expect(detail).not.toBe("")
      expect(detail).not.toContain("SECRET_VALUE")
    }
  })

  test("reports the first four faults, joined by a semicolon", () => {
    const check = McpDeferred.makeChecker()
    const detail = check(
      { type: "object", properties: Object.fromEntries("abcdef".split("").map((key) => [key, { type: "string" }])) },
      { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 },
    )
    expect(detail).toBe("/a must be string; /b must be string; /c must be string; /d must be string")
  })

  test("cuts the detail at 480 characters", () => {
    const check = McpDeferred.makeChecker()
    const key = "k".repeat(150)
    const detail = check(
      {
        type: "object",
        properties: Object.fromEntries(["1", "2", "3", "4"].map((n) => [key + n, { type: "string" }])),
      },
      Object.fromEntries(["1", "2", "3", "4"].map((n) => [key + n, 0])),
    )
    expect(Array.from(detail ?? "")).toHaveLength(480)
  })

  test("accepts what the server's own schema accepts: declared extras, other dialects, unknown formats", () => {
    const check = McpDeferred.makeChecker()
    expect(
      check({ type: "object", properties: {}, additionalProperties: true }, { anything: [1, { a: 2 }] }),
    ).toBeUndefined()
    expect(
      check(
        {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { when: { type: "string", format: "no-such-format" } },
        },
        { when: "later" },
      ),
    ).toBeUndefined()
    expect(
      check(
        { type: "object", properties: { n: { $ref: "#/$defs/n" } }, $defs: { n: { type: "integer" } } },
        { n: "x" },
      ),
    ).toBe("/n must be integer")
  })

  test("does not check against a schema that does not compile", () => {
    const check = McpDeferred.makeChecker()
    const broken: JSONSchema7 = { type: "object", properties: { a: { $ref: "#/definitions/missing" } } }
    expect(check(broken, { a: 1 })).toBeUndefined()
    // The same schema again is not retried into a different answer.
    expect(check(broken, { a: 2 })).toBeUndefined()
  })

  test("keeps a compiled schema per schema object, so a repeated call gives the same answer", () => {
    const check = McpDeferred.makeChecker()
    for (let round = 0; round < 3; round++) expect(check(schema, {})).toBe("(root) must have required property 'name'")
  })
})

describe("recordedInput", () => {
  test("is the proxied call's key and arguments for a proxied call, and the arguments themselves otherwise", () => {
    const proxied = new WeakMap<ToolExecutionOptions, string>()
    const options = { toolCallId: "call-1", messages: [] } satisfies ToolExecutionOptions
    const other = { toolCallId: "call-2", messages: [] } satisfies ToolExecutionOptions
    const args = { query: "x" }
    expect(McpDeferred.recordedInput(proxied, options, args)).toBe(args)
    proxied.set(options, "srv_lookup")
    expect(McpDeferred.recordedInput(proxied, options, args)).toEqual({ tool: "srv_lookup", arguments: args })
    expect(McpDeferred.recordedInput(proxied, other, args)).toBe(args)
  })
})

const entry = (id: string, deferred: boolean | undefined, description = `remote ${id}`) =>
  ({
    id,
    source: {
      kind: "mcp" as const,
      server: "srv",
      tool: id,
      source: "unknown",
      canonicalName: `mcp__srv__${id}`,
      requiresUserInteraction: false,
      ...(deferred === undefined ? {} : { deferred }),
    },
    effects: "unknown" as const,
    description,
    jsonSchema: { type: "object", properties: {} } satisfies JSONSchema7,
    rawSchema: { type: "object", properties: {} } satisfies JSONSchema7,
    tool: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }) }),
  }) satisfies ToolEntry

const builtin = (id: string): ToolEntry => ({
  id,
  source: { kind: "builtin", registrationID: `builtin:0:${id}` },
  effects: "read",
  description: id,
  jsonSchema: { type: "object", properties: {} },
  definition: { id } as never,
})

describe("settle", () => {
  const identity = (schema: JSONSchema7) => schema
  const everything = () => true
  // `settle` with no limit declared, and only the entries it returns.
  const settleEntries = (input: Omit<Parameters<typeof McpDeferred.settle>[0], "limits">) =>
    McpDeferred.settle({ ...input, limits: {} }).entries

  test("changes nothing while no entry is deferred: the same entries, in the same order", () => {
    const entries = [builtin("read"), entry("a_one", undefined), entry("a_two", false), builtin("zeta")]
    const settled = settleEntries({ entries, visible: everything, transform: identity })
    expect(settled).toEqual(entries)
    expect(settled.map((item) => item.id)).toEqual(["read", "a_one", "a_two", "zeta"])
  })

  test("keeps only the entries that are visible", () => {
    const entries = [builtin("read"), entry("a_one", undefined), entry("a_two", true)]
    const settled = settleEntries({ entries, visible: (id) => id !== "a_one", transform: identity })
    expect(settled.map((item) => item.id)).toEqual(["read", "a_two", "mcp_describe", "mcp_call"])
  })

  test("keeps deferred entries in place and adds describe, then call, after everything else", () => {
    const entries = [entry("b_two", true), builtin("read"), entry("a_one", true), entry("c_live", undefined)]
    const settled = settleEntries({
      entries: new Map(entries.map((item) => [item.id, item])).values(),
      visible: everything,
      transform: identity,
    })
    expect(settled.map((item) => item.id)).toEqual(["b_two", "read", "a_one", "c_live", "mcp_describe", "mcp_call"])
    const describe = settled.find((item) => item.id === "mcp_describe")
    expect(describe?.description).toBe(
      [
        "Read the input schema of deferred MCP tools before calling them with mcp_call.",
        "Deferred tools:",
        "- a_one: remote a_one",
        "- b_two: remote b_two",
      ].join("\n"),
    )
    expect(describe?.source).toEqual({
      kind: "mcp-deferred",
      op: "describe",
      registrationID: "mcp-deferred:mcp_describe",
    })
    expect(describe?.effects).toBe("read")
    const call = settled.find((item) => item.id === "mcp_call")
    expect(call?.description).toBe("Call a deferred MCP tool by its catalog name.")
    expect(call?.source).toEqual({ kind: "mcp-deferred", op: "call", registrationID: "mcp-deferred:mcp_call" })
    expect(call?.effects).toBe("unknown")
  })

  test("adds no helper when either helper name is not visible, and keeps the deferred entries", () => {
    const entries = [entry("a_one", true), builtin("read")]
    for (const hidden of MCP_DEFERRED_IDS) {
      const settled = settleEntries({ entries, visible: (id) => id !== hidden, transform: identity })
      expect(settled.map((item) => item.id)).toEqual(["a_one", "read"])
    }
  })

  test("adds no helper when no deferred entry is visible", () => {
    const entries = [entry("a_one", true), builtin("read")]
    const settled = settleEntries({ entries, visible: (id) => id !== "a_one", transform: identity })
    expect(settled.map((item) => item.id)).toEqual(["read"])
  })

  test("puts the helpers' schemas through the transform, and nothing else", () => {
    const seen: JSONSchema7[] = []
    const settled = settleEntries({
      entries: [entry("a_one", true)],
      visible: everything,
      transform: (schema) => {
        seen.push(schema)
        return { ...schema, description: "transformed" }
      },
    })
    expect(seen).toHaveLength(2)
    for (const id of MCP_DEFERRED_IDS) {
      expect(settled.find((item) => item.id === id)?.jsonSchema).toMatchObject({ description: "transformed" })
    }
    // The server tool's own entry is not rewritten here: the registry transformed it already.
    expect(settled.find((item) => item.id === "a_one")?.jsonSchema).toEqual({ type: "object", properties: {} })
  })

  test("lists the catalog by key, whatever order the entries come in", () => {
    const keys = ["m_z", "m_a", "m_m", "m_b"]
    const orders = [keys, [...keys].reverse(), ["m_m", "m_a", "m_z", "m_b"]]
    const catalogs = orders.map((order) => {
      const settled = settleEntries({
        entries: order.map((key) => entry(key, true)),
        visible: everything,
        transform: identity,
      })
      return settled.find((item) => item.id === "mcp_describe")?.description
    })
    expect(new Set(catalogs).size).toBe(1)
    expect(catalogs[0]?.split("\n").slice(2)).toEqual([
      "- m_a: remote m_a",
      "- m_b: remote m_b",
      "- m_m: remote m_m",
      "- m_z: remote m_z",
    ])
  })

  test("the helpers' parameters: describe takes 1 to 10 names, call a name and optional arguments", () => {
    const settled = settleEntries({ entries: [entry("a_one", true)], visible: everything, transform: identity })
    const schemas = Object.fromEntries(settled.map((item) => [item.id, item.jsonSchema]))
    const describeProps = schemas.mcp_describe.properties as Record<string, JSONSchema7>
    expect(schemas.mcp_describe).toMatchObject({
      type: "object",
      required: ["tools"],
      additionalProperties: false,
    })
    expect(describeProps.tools).toMatchObject({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 })
    expect(typeof describeProps.tools.description).toBe("string")
    const callProps = schemas.mcp_call.properties as Record<string, JSONSchema7>
    expect(schemas.mcp_call).toMatchObject({ type: "object", required: ["tool"], additionalProperties: false })
    expect(callProps.tool).toMatchObject({ type: "string" })
    expect(callProps.arguments).toMatchObject({ type: "object" })
    expect(typeof callProps.tool.description).toBe("string")
    expect(typeof callProps.arguments.description).toBe("string")
  })
})

describe("settle with the limits of a model", () => {
  const identity = (schema: JSONSchema7) => schema
  const everything = () => true
  const resource = (id: string): ToolEntry => ({
    id,
    source: { kind: "mcp-resource", op: "list", registrationID: `mcp-resource:${id}` },
    effects: "read",
    description: id,
    jsonSchema: { type: "object", properties: {} },
  })
  const run = (entries: ToolEntry[], limits: McpDeferred.ToolLimits, visible: (id: string) => boolean = everything) =>
    McpDeferred.settle({ entries, visible, transform: identity, limits })
  const deferredOf = (entries: ReadonlyArray<ToolEntry>) =>
    entries.flatMap((item) => (item.source.kind === "mcp" && item.source.deferred === true ? [item.id] : []))
  // Three tools that are not MCP tools, `invalid` among them, and one MCP resource tool: three the model is sent.
  const natives = () => [builtin("invalid"), builtin("read"), builtin("grep"), resource("mcp_list")]
  const NATIVE = 3

  test("moves nothing and says so while no limit is declared, whatever the tools", () => {
    const entries = [...natives(), entry("a_" + "x".repeat(80), undefined), entry("b_two", undefined)]
    for (const limits of [{}, { maxTools: undefined, nameMaxLength: undefined, namePattern: undefined }]) {
      const settled = run(entries, limits)
      expect(settled.entries).toEqual(entries)
      // Not copies: every entry is the one that went in.
      for (const [index, item] of entries.entries()) expect(settled.entries[index]).toBe(item)
      expect(settled.moved).toEqual({ byCount: 0, byName: 0 })
    }
  })

  test("moves a tool by name as a copy: the entry the caller holds is not changed, and the tool is shared", () => {
    const long = entry("a_long_name", undefined)
    const short = entry("a_b", undefined)
    const settled = run([long, short], { nameMaxLength: 5 })
    expect(deferredOf(settled.entries)).toEqual(["a_long_name"])
    expect(settled.moved).toEqual({ byCount: 0, byName: 1 })
    expect(long.source).not.toHaveProperty("deferred")
    const moved = settled.entries.find((item) => item.id === "a_long_name")
    expect(moved).not.toBe(long)
    expect(moved).toMatchObject({ tool: long.tool, description: long.description, jsonSchema: long.jsonSchema })
    // The tool that fits is the entry itself.
    expect(settled.entries.find((item) => item.id === "a_b")).toBe(short)
  })

  test("keeps a key of exactly nameMaxLength, and checks the pattern as a search, not a full match", () => {
    expect(
      deferredOf(run([entry("abcd", undefined), entry("abcde", undefined)], { nameMaxLength: 4 }).entries),
    ).toEqual(["abcde"])
    const search = run([entry("x_ok", undefined), entry("x_NO", undefined)], { namePattern: "[a-z]$" })
    expect(deferredOf(search.entries)).toEqual(["x_NO"])
    expect(search.moved).toEqual({ byCount: 0, byName: 1 })
    // Anchors in the pattern are the pattern's own.
    expect(deferredOf(run([entry("ab", undefined), entry("abc", undefined)], { namePattern: "^ab$" }).entries)).toEqual(
      ["abc"],
    )
  })

  test("takes a pattern that does not compile as none, and an empty one as matching everything", () => {
    const entries = [entry("a_one", undefined), entry("b_two", undefined)]
    expect(run(entries, { namePattern: "(" })).toEqual({ entries, moved: { byCount: 0, byName: 0 } })
    expect(run(entries, { namePattern: "" })).toEqual({ entries, moved: { byCount: 0, byName: 0 } })
  })

  test("does not count a tool its server deferred as moved, whatever its key", () => {
    const entries = [entry("a_" + "x".repeat(70), true), entry("b_two", undefined)]
    const settled = run(entries, { nameMaxLength: 10 })
    expect(settled.moved).toEqual({ byCount: 0, byName: 0 })
    expect(deferredOf(settled.entries)).toEqual(["a_" + "x".repeat(70)])
  })

  test("counts the tools the model is sent: the native ones but `invalid`, the MCP ones that stay, two helpers", () => {
    const mcp = ["m_a", "m_b", "m_c", "m_d"].map((key) => entry(key, undefined))
    // NATIVE + 4 MCP tools is NATIVE + 4 tools, and no helper is needed: it fits exactly.
    expect(run([...natives(), ...mcp], { maxTools: NATIVE + 4 }).moved).toEqual({ byCount: 0, byName: 0 })
    // One short: the helpers come in, so the room is the limit less the native tools less the two helpers: one tool.
    const tight = run([...natives(), ...mcp], { maxTools: NATIVE + 3 })
    expect(deferredOf(tight.entries)).toEqual(["m_b", "m_c", "m_d"])
    expect(tight.moved).toEqual({ byCount: 3, byName: 0 })
    // What the model is sent is exactly the limit: the native tools, the one tool and the two helpers.
    const sent = tight.entries.filter((item) => item.id !== "invalid" && !deferredOf(tight.entries).includes(item.id))
    expect(sent.map((item) => item.id)).toEqual(["read", "grep", "mcp_list", "m_a", "mcp_describe", "mcp_call"])
    expect(sent).toHaveLength(NATIVE + 3)
  })

  test("leaves room for the helpers when a server already deferred a tool", () => {
    const entries = [
      ...natives(),
      entry("m_a", undefined),
      entry("m_b", undefined),
      entry("m_c", undefined),
      entry("d_z", true),
    ]
    // Three live tools and two helpers on NATIVE need NATIVE + 5: one short moves one tool, the last by key.
    const settled = run(entries, { maxTools: NATIVE + 4 })
    expect(deferredOf(settled.entries)).toEqual(["m_c", "d_z"])
    expect(settled.moved).toEqual({ byCount: 1, byName: 0 })
    // At the limit nothing moves.
    expect(run(entries, { maxTools: NATIVE + 5 }).moved).toEqual({ byCount: 0, byName: 0 })
  })

  test("a limit that the helpers alone exceed leaves no tool live, and the room never goes negative", () => {
    const entries = [...natives(), entry("m_a", undefined), entry("m_b", undefined)]
    for (const maxTools of [NATIVE + 1, NATIVE, 0, -3]) {
      const settled = run(entries, { maxTools })
      expect(deferredOf(settled.entries)).toEqual(["m_a", "m_b"])
      expect(settled.moved).toEqual({ byCount: 2, byName: 0 })
    }
  })

  test("keeps the first tools by key whatever order the entries come in", () => {
    const keys = ["m_e", "m_a", "m_d", "m_c", "m_b"]
    for (const order of [keys, [...keys].reverse(), ["m_c", "m_e", "m_b", "m_a", "m_d"]]) {
      // Room for two tools: the limit less the natives less the helpers.
      const settled = run([...natives(), ...order.map((key) => entry(key, undefined))], { maxTools: NATIVE + 4 })
      expect(deferredOf(settled.entries).toSorted()).toEqual(["m_c", "m_d", "m_e"])
      expect(settled.moved).toEqual({ byCount: 3, byName: 0 })
    }
  })

  test("moves by name before it counts, and reports the two apart", () => {
    const entries = [...natives(), entry("m_a", undefined), entry("m_b", undefined), entry("m_long_name", undefined)]
    // The name moves one tool; m_a, m_b and the helpers then fit NATIVE + 4.
    const fits = run(entries, { nameMaxLength: 4, maxTools: NATIVE + 4 })
    expect(fits.moved).toEqual({ byCount: 0, byName: 1 })
    expect(deferredOf(fits.entries)).toEqual(["m_long_name"])
    // One tool fewer allowed: the count moves the later of the two that are left.
    const tighter = run(entries, { nameMaxLength: 4, maxTools: NATIVE + 3 })
    expect(tighter.moved).toEqual({ byCount: 1, byName: 1 })
    expect(deferredOf(tighter.entries)).toEqual(["m_b", "m_long_name"])
  })

  test("moves nothing when either helper name is not visible, and says so", () => {
    const entries = [...natives(), entry("m_a", undefined), entry("m_long_name", undefined)]
    for (const hidden of MCP_DEFERRED_IDS) {
      const settled = run(entries, { nameMaxLength: 3, maxTools: 1 }, (id) => id !== hidden)
      expect(settled.entries).toEqual(entries)
      expect(settled.moved).toEqual({ byCount: 0, byName: 0 })
    }
  })

  test("counts only the tools that are visible", () => {
    const entries = [...natives(), entry("m_a", undefined), entry("m_b", undefined), entry("m_c", undefined)]
    // Three tools do not fit NATIVE + 2 once the helpers are counted; with one of them hidden the two left fit.
    expect(run(entries, { maxTools: NATIVE + 2 }).moved).toEqual({ byCount: 3, byName: 0 })
    const settled = run(entries, { maxTools: NATIVE + 2 }, (id) => id !== "m_c")
    expect(settled.moved).toEqual({ byCount: 0, byName: 0 })
    expect(settled.entries.map((item) => item.id)).toEqual(["invalid", "read", "grep", "mcp_list", "m_a", "m_b"])
  })

  test("adds the helpers once the limits made a catalog, with the moved tools in it", () => {
    const entries = [...natives(), entry("m_a", undefined), entry("m_long_name", undefined)]
    const settled = run(entries, { nameMaxLength: 4 })
    expect(settled.entries.slice(-2).map((item) => item.id)).toEqual(["mcp_describe", "mcp_call"])
    expect(settled.entries.find((item) => item.id === "mcp_describe")?.description).toBe(
      [
        "Read the input schema of deferred MCP tools before calling them with mcp_call.",
        "Deferred tools:",
        "- m_long_name: remote m_long_name",
      ].join("\n"),
    )
    // A limit nothing breaks adds no helper.
    expect(run(entries, { nameMaxLength: 20 }).entries.map((item) => item.id)).toEqual(entries.map((item) => item.id))
  })
})

describe("movedNotice", () => {
  test("names the number moved and the model, one tool in the singular", () => {
    expect(McpDeferred.movedNotice(3, "acme/model-x")).toEqual({
      title: "MCP tools moved to the deferred catalog",
      message: "3 tools do not fit the limits of acme/model-x",
    })
    expect(McpDeferred.movedNotice(1, "acme/model-x").message).toBe("1 tool does not fit the limits of acme/model-x")
  })
})

// ---- the helpers as the model's runtime runs them -----------------------------------------------------------------

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))

const REWRITTEN = "srv_call_1a2b3c4d"
const LOOKUP_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1 } },
  required: ["query"],
  additionalProperties: false,
}

/** What the tools did and were asked, reset for every session. */
const seen = {
  runs: [] as Array<{ tool: string; args: unknown }>,
  truncations: [] as Array<{ text: string; options: unknown }>,
  hooks: [] as Array<{ event: string; toolName: string | undefined; toolInput: unknown }>,
  recorded: new Map<string, unknown>(),
}

const makeMcp = (
  name: string,
  options: {
    description?: string
    schema?: JSONSchema7
    requiresUserInteraction?: boolean
    baseKey?: string
    /** The server answers every call with this error. */
    fails?: string
  } = {},
) =>
  McpCatalog.bindTool(
    tool({
      description: options.description,
      inputSchema: jsonSchema(options.schema ?? { type: "object", properties: {} }),
      execute: async (args) => {
        seen.runs.push({ tool: name, args })
        if (options.fails !== undefined) throw new Error(options.fails)
        return { content: [{ type: "text" as const, text: `RAN ${name} ${JSON.stringify(args)}` }] }
      },
    }),
    {
      server: "srv",
      tool: name,
      source: "unknown",
      ...(options.requiresUserInteraction ? { requiresUserInteraction: true } : {}),
      ...(options.baseKey === undefined ? {} : { baseKey: options.baseKey }),
    },
  )

const DEFERRED_KEYS = new Set(["srv_lookup", "srv_guarded", REWRITTEN, "srv_blank", "srv_open", "srv_broken"])
// `resolve` wraps server tools in place, so each case needs fresh instances.
let mcpTools: Record<string, ReturnType<typeof makeMcp>> = {}
let deferredKeys = DEFERRED_KEYS
// The limits of the model the registry stand-in below settles the entries under.
let toolLimits: McpDeferred.ToolLimits = {}
// The provider's rewrite of a schema; the registry applies it to the entries it returns.
let rewrite: (schema: JSONSchema7) => JSONSchema7 = (schema) => schema

/** What the registry returns for the tools above: its entries, with the deferred ones marked and the helpers added. */
const resolvedEntries = () =>
  McpDeferred.settle({
    entries: mcpEntries(mcpTools, (schema) => rewrite(schema)).map((item) =>
      deferredKeys.has(item.id) ? { ...item, source: { ...item.source, deferred: true } } : item,
    ),
    visible: () => true,
    transform: (schema) => rewrite(schema),
    limits: toolLimits,
  }).entries

const model = ProviderTest.model()
const it = testEffect(
  Layer.mergeAll(
    Permission.layer.pipe(
      Layer.provide(database),
      Layer.provide(bridge),
      Layer.provide(SafetyGuard.layer),
      Layer.provide(TestConfig.layer()),
    ),
    database,
    events,
    bridge,
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.sync(() => mcpTools) }),
    Layer.mock(Truncate.Service, {
      output: (text: string, options: unknown) =>
        Effect.sync(() => {
          seen.truncations.push({ text, options })
          return { content: text, truncated: false as const }
        }),
    }),
    Layer.mock(ToolRegistry.Service, {
      tools: () => Effect.succeed([]),
      resolve: () => Effect.sync(resolvedEntries),
    }),
  ),
)

const ALLOW_ALL = [{ permission: "*", pattern: "*", action: "allow" as const }]
const rule = (permission: string, action: PermissionV1.Rule["action"]): PermissionV1.Rule => ({
  permission,
  pattern: "*",
  action,
})

type Result = { output?: string; metadata?: Record<string, unknown> }
type Tools = Record<string, { execute: (args: unknown, options: unknown) => Promise<Result> }>

const recordingHooks: SettingsHook.Interface = {
  trigger: (payload) =>
    Effect.sync(() => {
      seen.hooks.push({
        event: payload.event,
        toolName: "toolName" in payload ? payload.toolName : undefined,
        toolInput: "toolInput" in payload ? payload.toolInput : undefined,
      })
      return { additionalContexts: [], systemMessages: [] }
    }),
  list: () => Effect.succeed([]),
}

/** The tools of one session as the model's runtime would run them, wrapped by the real pipeline. */
const resolveTools = (
  rules: ReadonlyArray<PermissionV1.Rule> = ALLOW_ALL,
  options: {
    hooks?: SettingsHook.Interface
    keys?: Set<string>
    rewrite?: (schema: JSONSchema7) => JSONSchema7
    limits?: McpDeferred.ToolLimits
    /** Server tools beside the suite's own. */
    tools?: Record<string, ReturnType<typeof makeMcp>>
  } = {},
) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const sessionID = SessionID.descending()
    seen.runs = []
    seen.truncations = []
    seen.hooks = []
    seen.recorded = new Map()
    deferredKeys = options.keys ?? DEFERRED_KEYS
    rewrite = options.rewrite ?? ((schema) => schema)
    toolLimits = options.limits ?? {}
    mcpTools = {
      srv_lookup: makeMcp("lookup", {
        description: "Look things up in the index. Second sentence.",
        schema: LOOKUP_SCHEMA,
      }),
      srv_guarded: makeMcp("guarded", { description: "Guarded tool.", requiresUserInteraction: true }),
      [REWRITTEN]: makeMcp("call", { description: "Rewritten key.", baseKey: "srv_call", schema: LOOKUP_SCHEMA }),
      srv_blank: makeMcp("blank"),
      srv_broken: makeMcp("broken", { fails: "BOOM from the server" }),
      srv_live: makeMcp("live", { description: "Always loaded." }),
      srv_open: makeMcp("open", {
        schema: { type: "object", properties: {}, additionalProperties: true },
        description: "Takes anything.",
      }),
      ...options.tools,
    }
    return (yield* SessionTools.resolve({
      agent: { name: "general", permission: rules, options: {} } as never,
      model,
      session: { id: sessionID, directory: instance.directory, permission: [] } as never,
      processor: {
        message: { id: MessageID.ascending(), sessionID },
        updateToolCall: (callID: string, update: (part: unknown) => { state: { input: unknown } }) =>
          Effect.sync(() => {
            seen.recorded.set(callID, update({ state: { status: "running", input: {} } }).state.input)
          }),
        completeToolCall: () => Effect.void,
      } as never,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
      ...(options.hooks ? { hooks: options.hooks } : {}),
    })) as unknown as Tools
  })

const callOptions = (callID: string) => ({
  toolCallId: callID,
  messages: [],
  abortSignal: new AbortController().signal,
})

/** What one call comes to: its result, or the error the pipeline rejects with. */
const attempt = (tools: Tools, name: string, args: unknown, callID = `call-${name}`) =>
  Effect.promise((): Promise<Outcome> =>
    tools[name].execute(args, callOptions(callID)).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    ),
  )

type Outcome = { ok: true; value: Result } | { ok: false; error: unknown }

const failureOf = (result: Outcome) => {
  if (result.ok) throw new Error(`expected the call to fail, got ${JSON.stringify(result.value)}`)
  return result.error instanceof Error ? result.error : new Error(String(result.error))
}

const start = (tools: Tools, name: string, args: unknown, callID = `call-${name}`) =>
  Effect.promise(() => tools[name].execute(args, callOptions(callID))).pipe(Effect.forkScoped)

const pendingRequest = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* pollWithTimeout(permission.list().pipe(Effect.map((list) => list[0])), "the call did not ask the user")
})

const INVALID = (tool: string, detail: string) =>
  `The ${tool} tool was called with invalid arguments: ${detail}. Fix them and call ${tool} again.`
const SCHEMA_HINT = " Call mcp_describe for the schema."
const UNKNOWN = (requested: string, available: string[]) =>
  `Unknown tool "${requested}". Available tools: ${available.join(", ")}. Use one of them.`
const ALL_DEFERRED = ["srv_blank", "srv_broken", REWRITTEN, "srv_guarded", "srv_lookup", "srv_open"]

describe("the tool list a deferred server leaves", () => {
  it.instance("holds the eager tools and both helpers, and none of the deferred tools", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()
      expect(Object.keys(tools).toSorted()).toEqual(["mcp_call", "mcp_describe", "srv_live"])
    }),
  )

  it.instance("holds a tool that a limit of the model moved into the catalog out of the list, and reaches it", () =>
    Effect.gen(function* () {
      // No server is deferred; the keys longer than 8 characters do not fit the model, `srv_live` and `srv_open` do.
      const tools = yield* resolveTools(ALLOW_ALL, { keys: new Set(), limits: { nameMaxLength: 8 } })
      expect(Object.keys(tools).toSorted()).toEqual(["mcp_call", "mcp_describe", "srv_live", "srv_open"])

      const described = yield* attempt(tools, "mcp_describe", { tools: ["srv_lookup"] })
      expect(described.ok && described.value.output).toContain("Look things up in the index.")
      const called = yield* attempt(tools, "mcp_call", { tool: "srv_lookup", arguments: { query: "x" } })
      expect(called.ok && called.value.output).toBe('RAN lookup {"query":"x"}')
      // A tool that stayed is called as it always was.
      const direct = yield* attempt(tools, "srv_live", {})
      expect(direct.ok && direct.value.output).toBe("RAN live {}")
    }),
  )

  it.instance("holds no helper while nothing is deferred", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools(ALLOW_ALL, { keys: new Set() })
      expect(Object.keys(tools).toSorted()).toEqual(
        ["srv_blank", "srv_broken", REWRITTEN, "srv_guarded", "srv_live", "srv_lookup", "srv_open"].toSorted(),
      )
    }),
  )
})

describe("mcp_describe", () => {
  it.instance("returns each tool's name, full description and schema, in the order asked, once each", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()
      const result = yield* attempt(tools, "mcp_describe", { tools: ["srv_lookup", "srv_blank", "srv_lookup"] })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.output).toBe(
        [
          "srv_lookup",
          "Look things up in the index. Second sentence.",
          'Input schema: {"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1}},"required":["query"],"additionalProperties":false}',
          "",
          "srv_blank",
          "(no description)",
          'Input schema: {"type":"object","properties":{}}',
        ].join("\n"),
      )
      expect(result.value.metadata).toMatchObject({ truncated: false })
      // It never asks and runs no hook.
      expect(seen.runs).toEqual([])
    }),
  )

  it.instance("cuts the output once, within the model's window", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()
      yield* attempt(tools, "mcp_describe", { tools: ["srv_lookup", "srv_guarded"] })
      expect(seen.truncations).toHaveLength(1)
      expect(seen.truncations[0].options).toEqual({ context: ModelContext.contextOfModel(model) })
    }),
  )

  it.instance("says exactly what is wrong with its own arguments, and not what was in them", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()
      const cases: Array<[unknown, string]> = [
        [{}, "(root) must have required property 'tools'"],
        [{ tools: [] }, "/tools must NOT have fewer than 1 items"],
        [
          { tools: Array.from({ length: 11 }, (_, index) => `srv_${index}`) },
          "/tools must NOT have more than 10 items",
        ],
        [{ tools: ["srv_lookup", 7] }, "/tools/1 must be string"],
        [{ tools: "srv_lookup" }, "/tools must be array"],
        [{ tools: ["srv_lookup"], note: "SECRET_NOTE" }, "(root) must NOT have additional properties"],
      ]
      for (const [args, detail] of cases) {
        const error = failureOf(yield* attempt(tools, "mcp_describe", args))
        expect(error.message).toBe(INVALID("mcp_describe", detail))
        expect(error.message).not.toContain("SECRET_NOTE")
        expect(error).toBeInstanceOf(ArgumentsError)
        expect(error.name).toBe("ToolInvalidArgumentsError")
        expect(classifyToolError(error)).toBe("validation_error")
      }
    }),
  )

  it.instance("holds its arguments to its own bounds even where the provider's rewrite dropped them", () =>
    Effect.gen(function* () {
      // What an OpenAI model is shown: no `minItems`, no `maxItems`.
      const lowered = (schema: JSONSchema7): JSONSchema7 =>
        JSON.parse(
          JSON.stringify(schema, (key, value) => (key === "minItems" || key === "maxItems" ? undefined : value)),
        )
      const tools = yield* resolveTools(ALLOW_ALL, { rewrite: lowered })
      expect(JSON.stringify(resolvedEntries().find((item) => item.id === "mcp_describe")?.jsonSchema)).not.toContain(
        "minItems",
      )
      expect(failureOf(yield* attempt(tools, "mcp_describe", { tools: [] })).message).toBe(
        INVALID("mcp_describe", "/tools must NOT have fewer than 1 items"),
      )
      expect(
        failureOf(
          yield* attempt(tools, "mcp_describe", { tools: Array.from({ length: 11 }, (_, index) => `srv_${index}`) }),
        ).message,
      ).toBe(INVALID("mcp_describe", "/tools must NOT have more than 10 items"))
    }),
  )

  it.instance("names the first tool it does not know and lists the deferred ones by key", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()
      const error = failureOf(yield* attempt(tools, "mcp_describe", { tools: ["srv_lookup", "nope", "also_nope"] }))
      expect(error.message).toBe(UNKNOWN("nope", ALL_DEFERRED))
      expect(error.name).toBe("ToolInvalidArgumentsError")
      expect(classifyToolError(error)).toBe("validation_error")
      // An eager tool is not in the catalog.
      expect(failureOf(yield* attempt(tools, "mcp_describe", { tools: ["srv_live"] })).message).toBe(
        UNKNOWN("srv_live", ALL_DEFERRED),
      )
      // Nothing was cut or run for a call that failed.
      expect(seen.truncations).toEqual([])
    }),
  )
})

describe("mcp_call", () => {
  it.instance("calls the tool with the arguments and returns what the tool returns, cut once", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()
      const result = yield* attempt(tools, "mcp_call", { tool: "srv_lookup", arguments: { query: "x", limit: 3 } })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.output).toBe('RAN lookup {"query":"x","limit":3}')
      expect(seen.runs).toEqual([{ tool: "lookup", args: { query: "x", limit: 3 } }])
      // The tool's own wrapper cut its result; the proxy did not cut it again.
      expect(seen.truncations).toHaveLength(1)
      expect(seen.truncations[0].text).toBe('RAN lookup {"query":"x","limit":3}')
    }),
  )

  it.instance("takes missing arguments as none, and lets a tool that declared extras have them", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()
      const none = yield* attempt(tools, "mcp_call", { tool: "srv_blank" })
      expect(none.ok).toBe(true)
      expect(seen.runs).toEqual([{ tool: "blank", args: {} }])
      const extra = yield* attempt(tools, "mcp_call", { tool: "srv_open", arguments: { anything: [1, 2] } })
      expect(extra.ok).toBe(true)
      expect(seen.runs[1]).toEqual({ tool: "open", args: { anything: [1, 2] } })
    }),
  )

  it.instance("says exactly what is wrong with its own arguments", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()
      const cases: Array<[unknown, string]> = [
        [{}, "(root) must have required property 'tool'"],
        [{ tool: 5 }, "/tool must be string"],
        [{ tool: "srv_lookup", arguments: "x" }, "/arguments must be object"],
        [{ tool: "srv_lookup", arguments: [] }, "/arguments must be object"],
        [{ tool: "srv_lookup", extra: 1 }, "(root) must NOT have additional properties"],
      ]
      for (const [args, detail] of cases) {
        const error = failureOf(yield* attempt(tools, "mcp_call", args))
        expect(error.message).toBe(INVALID("mcp_call", detail) + SCHEMA_HINT)
        expect(classifyToolError(error)).toBe("validation_error")
      }
      expect(seen.runs).toEqual([])
    }),
  )

  it.instance("names an unknown tool and lists the deferred ones, without the schema hint", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()
      for (const name of ["nope", "srv_live", "mcp_call", "SRV_LOOKUP"]) {
        const error = failureOf(yield* attempt(tools, "mcp_call", { tool: name, arguments: { query: "x" } }))
        expect(error.message).toBe(UNKNOWN(name, ALL_DEFERRED))
        expect(error.name).toBe("ToolInvalidArgumentsError")
        expect(classifyToolError(error)).toBe("validation_error")
      }
      expect(seen.runs).toEqual([])
    }),
  )

  it.instance("checks the arguments against the tool's own schema and names that tool", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()
      const cases: Array<[unknown, string]> = [
        [undefined, "(root) must have required property 'query'"],
        [{}, "(root) must have required property 'query'"],
        [{ query: 5 }, "/query must be string"],
        [{ query: "x", limit: 0 }, "/limit must be >= 1"],
        [{ query: "x", limit: "SECRET_LIMIT" }, "/limit must be integer"],
        [{ query: "x", other: "SECRET_OTHER" }, "(root) must NOT have additional properties"],
      ]
      for (const [args, detail] of cases) {
        const error = failureOf(
          yield* attempt(
            tools,
            "mcp_call",
            args === undefined ? { tool: "srv_lookup" } : { tool: "srv_lookup", arguments: args },
          ),
        )
        expect(error.message).toBe(INVALID("srv_lookup", detail) + SCHEMA_HINT)
        expect(error.message).not.toContain("SECRET")
        expect(classifyToolError(error)).toBe("validation_error")
      }
      // A call that was refused never reached the tool, and no hook or question saw it.
      expect(seen.runs).toEqual([])
      expect(seen.hooks).toEqual([])
      expect(seen.truncations).toEqual([])
    }),
  )

  it.instance("an error of the tool itself is the tool's error, not an invalid-arguments fault", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()
      const error = failureOf(yield* attempt(tools, "mcp_call", { tool: "srv_broken" }))
      expect(error.message).toBe("BOOM from the server")
      expect(error).not.toBeInstanceOf(ArgumentsError)
      expect(classifyToolError(error)).toBe("execution_error")
      expect(seen.runs).toEqual([{ tool: "broken", args: {} }])
    }),
  )
})

describe("a deferred tool under a provider that rewrites schemas (#1576)", () => {
  // A server's schema that the OpenAI downgrade changes in meaning: an array without `items`, an enum of numbers
  // without a `type`, and a boolean sub-schema.
  const LOOSE_SCHEMA: JSONSchema7 = {
    type: "object",
    properties: { rows: { type: "array" }, level: { enum: [1, 2, 3] }, anything: true },
  }
  const LOOSE_TEXT = '{"type":"object","properties":{"rows":{"type":"array"},"level":{"enum":[1,2,3]},"anything":true}}'
  // What the model is sent: the rewrite of a model whose profile asks for the OpenAI downgrade.
  const openai = ProviderTest.model()
  const downgrade = (schema: JSONSchema7) => ProviderTransform.schema(openai, schema)
  // Arguments the server's schema accepts and the rewritten one does not.
  const FITS = { rows: [{ id: 1 }, { id: 2 }], level: 2, anything: 7 }
  const loose = (keys: string[] = ["srv_loose"]) =>
    resolveTools(ALLOW_ALL, {
      keys: new Set(keys),
      rewrite: downgrade,
      tools: { srv_loose: makeMcp("loose", { description: "Takes loose arguments.", schema: LOOSE_SCHEMA }) },
    })

  test("the rewrite does change what the server wrote", () => {
    expect(ProviderProfile.profileOf(openai).schemaFixes).toContain("openai")
    expect(downgrade(LOOSE_SCHEMA)).toEqual({
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "string" } },
        level: { type: "string", enum: [1, 2, 3] },
        anything: { type: "string" },
      },
    })
  })

  it.instance("mcp_call holds the arguments to the server's own schema, not to the rewrite of it", () =>
    Effect.gen(function* () {
      const tools = yield* loose()
      const result = yield* attempt(tools, "mcp_call", { tool: "srv_loose", arguments: FITS })
      expect(result.ok).toBe(true)
      expect(seen.runs).toEqual([{ tool: "loose", args: FITS }])
    }),
  )

  it.instance("mcp_call still refuses what the server's own schema refuses", () =>
    Effect.gen(function* () {
      const tools = yield* loose()
      const cases: Array<[unknown, string]> = [
        [{ rows: "x" }, "/rows must be array"],
        [{ level: 4 }, "/level must be one of 1, 2, 3"],
      ]
      for (const [args, detail] of cases) {
        const error = failureOf(yield* attempt(tools, "mcp_call", { tool: "srv_loose", arguments: args }))
        expect(error.message).toBe(INVALID("srv_loose", detail) + SCHEMA_HINT)
      }
      expect(seen.runs).toEqual([])
    }),
  )

  it.instance("mcp_describe shows the server's own schema, without what the rewrite added", () =>
    Effect.gen(function* () {
      const tools = yield* loose()
      const result = yield* attempt(tools, "mcp_describe", { tools: ["srv_loose"] })
      expect(result.ok && result.value.output).toBe(
        ["srv_loose", "Takes loose arguments.", `Input schema: ${LOOSE_TEXT}`].join("\n"),
      )
      expect(result.ok && result.value.output).not.toContain('"items"')
    }),
  )

  it.instance("a tool that is not deferred is still sent the rewritten schema", () =>
    Effect.gen(function* () {
      const tools = yield* loose([])
      const sent = asSchema((tools.srv_loose as unknown as Tool).inputSchema).jsonSchema
      expect(sent).toEqual(downgrade(LOOSE_SCHEMA))
    }),
  )
})

describe("a call through mcp_call is the target's call", () => {
  it.instance("asks for the target's key, not mcp_call, and runs only after the answer", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const tools = yield* resolveTools([...ALLOW_ALL, rule("srv_lookup", "ask")])
      const call = yield* start(tools, "mcp_call", { tool: "srv_lookup", arguments: { query: "x" } }, "call-proxied")
      const request = yield* pendingRequest
      expect(request.permission).toBe("srv_lookup")
      expect(request.metadata).toMatchObject({ source: "mcp" })
      expect(request.tool?.callID).toBe("call-proxied")
      expect(seen.runs).toEqual([])
      yield* permission.reply({ requestID: request.id, reply: "once" })
      expect(Exit.isSuccess(yield* Fiber.await(call))).toBe(true)
      expect(seen.runs).toEqual([{ tool: "lookup", args: { query: "x" } }])
    }),
  )

  it.instance("a deny of the target refuses the call", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools([...ALLOW_ALL, rule("srv_lookup", "deny")])
      const error = failureOf(yield* attempt(tools, "mcp_call", { tool: "srv_lookup", arguments: { query: "x" } }))
      expect(error.message).toContain("The user has specified a rule")
      expect(seen.runs).toEqual([])
    }),
  )

  it.instance("a rewritten key keeps the rules of the key it had before, as it does when called directly", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service

      const denied = yield* resolveTools([...ALLOW_ALL, rule("srv_call", "deny")])
      const refused = failureOf(yield* attempt(denied, "mcp_call", { tool: REWRITTEN, arguments: { query: "x" } }))
      expect(refused.message).toContain("The user has specified a rule")
      expect(seen.runs).toEqual([])

      const asked = yield* resolveTools([...ALLOW_ALL, rule("srv_call", "ask")])
      const call = yield* start(asked, "mcp_call", { tool: REWRITTEN, arguments: { query: "x" } })
      const request = yield* pendingRequest
      expect(request.permission).toBe(REWRITTEN)
      expect(seen.runs).toEqual([])
      yield* permission.reply({ requestID: request.id, reply: "once" })
      expect(Exit.isSuccess(yield* Fiber.await(call))).toBe(true)
      expect(seen.runs).toEqual([{ tool: "call", args: { query: "x" } }])
    }),
  )

  it.instance("a tool the server marked as needing the user is asked about even where everything is allowed", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const tools = yield* resolveTools(ALLOW_ALL)
      const call = yield* start(tools, "mcp_call", { tool: "srv_guarded" })
      const request = yield* pendingRequest
      expect(request.permission).toBe("srv_guarded")
      expect(request.metadata).toEqual({
        requiresUserInteraction: true,
        mcpServer: "srv",
        mcpTool: "guarded",
        source: "mcp",
      })
      expect(seen.runs).toEqual([])
      yield* permission.reply({ requestID: request.id, reply: "once" })
      expect(Exit.isSuccess(yield* Fiber.await(call))).toBe(true)
      expect(seen.runs).toEqual([{ tool: "guarded", args: {} }])
    }),
  )

  it.instance("mcp_describe and mcp_call do not ask, whatever the rules say about them", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const tools = yield* resolveTools([...ALLOW_ALL, rule("mcp_describe", "ask"), rule("mcp_call", "ask")])
      expect((yield* attempt(tools, "mcp_describe", { tools: ["srv_lookup"] })).ok).toBe(true)
      expect((yield* attempt(tools, "mcp_call", { tool: "srv_blank" })).ok).toBe(true)
      expect(yield* permission.list()).toEqual([])
      expect(seen.runs).toEqual([{ tool: "blank", args: {} }])
    }),
  )

  it.instance("the hooks see the target's key and arguments; mcp_describe and mcp_call trigger none of their own", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools(ALLOW_ALL, { hooks: recordingHooks })
      yield* attempt(tools, "mcp_describe", { tools: ["srv_lookup"] })
      expect(seen.hooks).toEqual([])

      yield* attempt(tools, "mcp_call", { tool: "srv_lookup", arguments: { query: "x" } })
      expect(seen.hooks.map(({ event, toolName }) => [event, toolName])).toEqual([
        ["PreToolUse", "srv_lookup"],
        ["PostToolUse", "srv_lookup"],
      ])
      expect(seen.hooks[0].toolInput).toEqual({ query: "x" })
      expect(seen.hooks[1].toolInput).toEqual({ query: "x" })

      // A call that was refused for its arguments triggers nothing.
      seen.hooks = []
      failureOf(yield* attempt(tools, "mcp_call", { tool: "srv_lookup", arguments: {} }))
      failureOf(yield* attempt(tools, "mcp_call", { tool: "nope" }))
      expect(seen.hooks).toEqual([])
    }),
  )

  it.instance("the transcript keeps the model's own call, { tool, arguments }, not the target's arguments", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()
      yield* attempt(tools, "mcp_call", { tool: "srv_lookup", arguments: { query: "x" } }, "call-proxied")
      expect(seen.recorded.get("call-proxied")).toEqual({ tool: "srv_lookup", arguments: { query: "x" } })

      // A tool called directly is recorded as it always was: by its own arguments.
      yield* attempt(tools, "srv_live", {}, "call-direct")
      expect(seen.recorded.get("call-direct")).toEqual({})
    }),
  )
})
