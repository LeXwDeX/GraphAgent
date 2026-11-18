// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Hash } from "@graphagent/core/util/hash"
import { McpCatalog } from "@/mcp/catalog"

const pair = (server: string, tool: string) => ({ server, tool })
// The suffix a rewritten key carries: the first 8 hex digits of the hash of the real (server, tool).
const suffix = (server: string, tool: string) => Hash.sha256(server + "\0" + tool).slice(0, 8)

describe("assignToolKeys", () => {
  test("a unique key of at most 64 characters stays the sanitized server and tool joined by an underscore", () => {
    expect(
      McpCatalog.assignToolKeys([pair("my server", "do.it"), pair("paged-server", "tool-one"), pair("srv", "x")]),
    ).toEqual(["my_server_do_it", "paged-server_tool-one", "srv_x"])
  })

  test("a key of exactly 64 characters is kept, one of 65 is cut to 64 with the hash suffix", () => {
    const exact = "t".repeat(60)
    expect(McpCatalog.TOOL_KEY_MAX).toBe(64)
    expect(McpCatalog.assignToolKeys([pair("srv", exact)])).toEqual(["srv_" + exact])

    const long = "t".repeat(61)
    const [key] = McpCatalog.assignToolKeys([pair("srv", long)])
    expect(key).toHaveLength(64)
    expect(key).toBe(("srv_" + long).slice(0, 55) + "_" + suffix("srv", long))
  })

  test("a very long key keeps its sanitized beginning and the hash of the real names", () => {
    const tool = "查询.".repeat(80)
    const [key] = McpCatalog.assignToolKeys([pair("server.with.dots", tool)])
    expect(key).toHaveLength(64)
    expect(key).toMatch(/^server_with_dots_[a-zA-Z0-9_-]{38}_[0-9a-f]{8}$/)
    expect(key.endsWith("_" + suffix("server.with.dots", tool))).toBe(true)
  })

  test("two tools with the same base key both get the hash suffix, whatever the input order", () => {
    // `a.b` + `c` and `a` + `b.c` both sanitize to `a_b_c`.
    const first = pair("a.b", "c")
    const second = pair("a", "b.c")
    expect(McpCatalog.assignToolKeys([first, second])).toEqual([
      `a_b_c_${suffix("a.b", "c")}`,
      `a_b_c_${suffix("a", "b.c")}`,
    ])
    expect(McpCatalog.assignToolKeys([second, first])).toEqual([
      `a_b_c_${suffix("a", "b.c")}`,
      `a_b_c_${suffix("a.b", "c")}`,
    ])
    expect(suffix("a.b", "c")).not.toBe(suffix("a", "b.c"))

    // So do `a` + `b_c` and `a_b` + `c`: the hash keeps the boundary between server and tool.
    const [x, y] = McpCatalog.assignToolKeys([pair("a", "b_c"), pair("a_b", "c")])
    expect(x).toBe(`a_b_c_${suffix("a", "b_c")}`)
    expect(y).toBe(`a_b_c_${suffix("a_b", "c")}`)
    expect(x).not.toBe(y)
  })

  test("a tool that collides with nothing keeps its plain key beside colliding ones", () => {
    expect(McpCatalog.assignToolKeys([pair("a.b", "c"), pair("srv", "other"), pair("a", "b.c")])).toEqual([
      `a_b_c_${suffix("a.b", "c")}`,
      "srv_other",
      `a_b_c_${suffix("a", "b.c")}`,
    ])
  })

  test("colliding long keys are each cut to 64 characters and stay distinct", () => {
    const tool = "t".repeat(70)
    const keys = McpCatalog.assignToolKeys([pair("a.b", tool), pair("a_b", tool)])
    expect(keys.map((key) => key.length)).toEqual([64, 64])
    expect(new Set(keys).size).toBe(2)
  })

  test("a base key that equals a reserved name gets the hash suffix", () => {
    expect(McpCatalog.RESERVED_TOOL_KEYS).toEqual(["mcp_describe", "mcp_call"])
    expect(McpCatalog.assignToolKeys([pair("mcp", "describe"), pair("mcp", "call"), pair("mcp", "callable")])).toEqual([
      `mcp_describe_${suffix("mcp", "describe")}`,
      `mcp_call_${suffix("mcp", "call")}`,
      "mcp_callable",
    ])
  })

  test("a key that still collides after the rewrite stays with the first (server, tool); the rest are blank", () => {
    // The same tool listed twice has one hash, so both rewritten keys are equal.
    expect(McpCatalog.assignToolKeys([pair("srv", "x"), pair("srv", "x")])).toEqual([`srv_x_${suffix("srv", "x")}`, ""])

    // A tool whose plain key is exactly the rewritten key of an overlong one.
    const long = pair("s", "t".repeat(80))
    const plain = pair("s", "t".repeat(53) + "_" + suffix(long.server, long.tool))
    const taken = ("s_" + long.tool).slice(0, 55) + "_" + suffix(long.server, long.tool)
    expect(taken).toBe("s_" + plain.tool)
    // Same server; `_` sorts before `t`, so `plain` is the first of the two.
    expect(McpCatalog.assignToolKeys([long, plain])).toEqual(["", taken])
    expect(McpCatalog.assignToolKeys([plain, long])).toEqual([taken, ""])
  })

  test("the first of a remaining collision is picked by server before tool", () => {
    const long = pair("s.", "t".repeat(80))
    const plain = pair("s_", "t".repeat(52) + "_" + suffix(long.server, long.tool))
    const taken = ("s__" + long.tool).slice(0, 55) + "_" + suffix(long.server, long.tool)
    expect(taken).toBe("s__" + plain.tool)
    // `.` sorts before `_`, so `long` is first although `plain` has the smaller tool name.
    expect(plain.tool < long.tool).toBe(true)
    expect(McpCatalog.assignToolKeys([plain, long])).toEqual(["", taken])
    expect(McpCatalog.assignToolKeys([long, plain])).toEqual([taken, ""])
  })

  test("returns one key per pair, in the input order", () => {
    expect(McpCatalog.assignToolKeys([])).toEqual([])
    const pairs = [pair("z", "last"), pair("a.b", "c"), pair("a", "first"), pair("a", "b.c")]
    const keys = McpCatalog.assignToolKeys(pairs)
    expect(keys).toHaveLength(pairs.length)
    expect(keys[0]).toBe("z_last")
    expect(keys[2]).toBe("a_first")
    expect(keys[1].startsWith("a_b_c_")).toBe(true)
    expect(keys[3].startsWith("a_b_c_")).toBe(true)
  })
})
