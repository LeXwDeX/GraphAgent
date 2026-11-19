// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { ToolCallId } from "../../src/provider/tool-call-id"

const nine = { charset: "alnum", length: 9 } as const
const dash = { charset: "alnum_dash" } as const
const bare = { charset: "alnum" } as const
const any = { charset: "any" } as const

// sha256 of the ids used below, computed outside the implementation
const BASH = "8497fe9cce69aff0aa7025efd9339081215bcf45c16fb3eea4a41636101af415" // functions.bash:0

describe("ToolCallId.compliant", () => {
  test("any holds for every id", () => {
    for (const id of ["", "a.b:c", "functions.bash:0", "é", "a b\n"]) expect(ToolCallId.compliant(id, any)).toBe(true)
  })

  test("alnum_dash matches the whole id against [A-Za-z0-9_-]", () => {
    for (const id of ["abc", "abc-DEF_123", "_", "-"]) expect(ToolCallId.compliant(id, dash)).toBe(true)
    for (const id of ["", "a.b", "a:b", "a b", "é", "abc\n"]) expect(ToolCallId.compliant(id, dash)).toBe(false)
  })

  test("alnum matches the whole id against [A-Za-z0-9]", () => {
    for (const id of ["abc", "ABC123", "8497fe9cc"]) expect(ToolCallId.compliant(id, bare)).toBe(true)
    for (const id of ["", "a_b", "a-b", "a.b", "abc\n"]) expect(ToolCallId.compliant(id, bare)).toBe(false)
  })

  test("alnum with a length asks for exactly that length: shorter and longer ids both fail", () => {
    expect(ToolCallId.compliant("8497fe9cc", nine)).toBe(true)
    expect(ToolCallId.compliant("8497fe9c", nine)).toBe(false)
    expect(ToolCallId.compliant("8497fe9cc0", nine)).toBe(false)
    expect(ToolCallId.compliant("8497fe9c_", nine)).toBe(false)
  })

  test("a length that is not a positive integer counts as not set", () => {
    for (const length of [0, -9, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const constraint = { charset: "alnum", length } as const
      expect(ToolCallId.compliant("abc", constraint)).toBe(true)
      expect(ToolCallId.compliant("a_c", constraint)).toBe(false)
    }
  })
})

describe("ToolCallId.project", () => {
  test("an id that meets the constraint is returned as it is, however short or long", () => {
    expect(ToolCallId.project("call.1:x", any)).toBe("call.1:x")
    expect(ToolCallId.project("call_1-x", dash)).toBe("call_1-x")
    expect(ToolCallId.project("call1x", bare)).toBe("call1x")
    expect(ToolCallId.project("abcdefghi", nine)).toBe("abcdefghi")
    expect(ToolCallId.project("toolu_01CBhTTz95qkd9LJMdC9sf8t", dash)).toBe("toolu_01CBhTTz95qkd9LJMdC9sf8t")
  })

  test("alnum_dash: the unfit characters become _, followed by the first 8 digest characters", () => {
    expect(ToolCallId.project("functions.bash:0", dash)).toBe("functions_bash_0_8497fe9c")
    expect(ToolCallId.project("call.1:x", dash)).toBe("call_1_x_574a15ed")
    expect(ToolCallId.project("a.b:c-d_e", dash)).toBe("a_b_c-d_e_038b8084")
  })

  test("alnum with a length: the digest, repeated and cut to the length", () => {
    expect(ToolCallId.project("functions.bash:0", nine)).toBe("8497fe9cc")
    expect(ToolCallId.project("toolu_01CBhTTz95qkd9LJMdC9sf8t", nine)).toBe("8dc9cde44")
    // an id that is too short is no longer padded with 0, and one that is too long is no longer cut
    expect(ToolCallId.project("abc", nine)).toBe("ba7816bf8")
    expect(ToolCallId.project("abcdefghij", nine)).not.toBe("abcdefghi")
    expect(ToolCallId.project("abcdefghij", nine)).toHaveLength(9)
    // the digest has 64 characters, so a longer length repeats it
    const long = ToolCallId.project("functions.bash:0", { charset: "alnum", length: 70 })
    expect(long).toBe(BASH + BASH.slice(0, 6))
    expect(long).toHaveLength(70)
  })

  test("alnum without a length: the id without its unfit characters, followed by the first 8 digest characters", () => {
    expect(ToolCallId.project("call.1:x", bare)).toBe("call1x574a15ed")
    expect(ToolCallId.project("call.1:xyz_0123456789", bare)).toBe("call1xyz012345678919297b8b")
    expect(ToolCallId.project("...", bare)).toMatch(/^[0-9a-f]{8}$/)
  })

  test("a length that is not a positive integer takes the form without a length", () => {
    for (const length of [0, -9, Number.NaN]) {
      expect(ToolCallId.project("a.b", { charset: "alnum", length })).toBe("ab2e7336dc")
    }
  })

  test("is idempotent: the result meets the constraint, so it stays as it is", () => {
    const constraints = [dash, bare, nine, { charset: "alnum", length: 70 }, { charset: "alnum", length: 3 }] as const
    for (const constraint of constraints) {
      for (const id of [
        "functions.bash:0",
        "a.b",
        "",
        "abc",
        "abc0",
        "toolu_01CBhTTz95qkd9LJMdC9sf8t",
        "é😀",
        "x\ny",
      ]) {
        const once = ToolCallId.project(id, constraint)
        expect(ToolCallId.compliant(once, constraint)).toBe(true)
        expect(ToolCallId.project(once, constraint)).toBe(once)
      }
    }
  })

  test("abc and abc0 stay apart, which the zero padding made one id", () => {
    expect(ToolCallId.project("abc", nine)).toBe("ba7816bf8")
    expect(ToolCallId.project("abc0", nine)).toBe("56abfbd7d")
  })

  test("the id is hashed whole: ids that differ only in the unfit characters stay apart", () => {
    expect(ToolCallId.project("a.b", dash)).toBe("a_b_2e7336dc")
    expect(ToolCallId.project("a:b", dash)).toBe("a_b_6783a31e")
  })
})

describe("ToolCallId.plan", () => {
  test("an id that meets the constraint keeps its place, even when another id would map onto it", () => {
    const planned = ToolCallId.plan(["functions.bash:0", "8497fe9cc"], nine)
    expect(planned.get("8497fe9cc")).toBe("8497fe9cc")
    // 8497fe9cc is what functions.bash:0 maps to alone, so it takes the next candidate: the digest of id#1
    expect(planned.get("functions.bash:0")).toBe("7a7c5acf9")
    expect(ToolCallId.plan(["8497fe9cc", "functions.bash:0"], nine)).toEqual(planned)
  })

  test("ids that the same rule would map to one result get different results", () => {
    const planned = ToolCallId.plan(["a.b", "a:b"], dash)
    expect(planned.get("a.b")).toBe("a_b_2e7336dc")
    expect(planned.get("a:b")).toBe("a_b_6783a31e")
    // the old rule made both a_b; the zero padding of the old Mistral rule made functions.* one id
    const mistral = ToolCallId.plan(["functions.bash:0", "functions.read:1"], nine)
    expect(mistral.get("functions.bash:0")).toBe("8497fe9cc")
    expect(mistral.get("functions.read:1")).toBe("08bea9710")
  })

  test("a second collision moves to the next number", () => {
    // 8497fe9cc is taken by a compliant id, 7a7c5acf9 (id#1) by another one, so the third candidate is id#2
    const planned = ToolCallId.plan(["functions.bash:0", "8497fe9cc", "7a7c5acf9"], nine)
    expect(planned.get("functions.bash:0")).toBe("759fbdf4d")
  })

  test("the same original id always gets the same result; ids that are appended leave earlier results alone", () => {
    const ids = ["functions.bash:0", "functions.read:1", "call_1", "x.y"]
    const base = ToolCallId.plan(ids, nine)
    expect(ToolCallId.plan(ids, nine)).toEqual(base)
    for (const next of ["functions.write:2", "zzzzzzzzz", "new.one:9"]) {
      const grown = ToolCallId.plan([...ids, next], nine)
      for (const id of ids) expect(grown.get(id)).toBe(base.get(id))
    }
  })

  test("an appended id changes an earlier result only when it meets the constraint and equals that result", () => {
    const base = ToolCallId.plan(["functions.bash:0", "functions.read:1"], nine)
    expect(base.get("functions.bash:0")).toBe("8497fe9cc")
    const grown = ToolCallId.plan(["functions.bash:0", "functions.read:1", "8497fe9cc"], nine)
    expect(grown.get("functions.bash:0")).toBe("7a7c5acf9")
    expect(grown.get("functions.read:1")).toBe(base.get("functions.read:1"))
  })

  test("any keeps every id", () => {
    const ids = ["a.b", "a:b", "functions.bash:0"]
    expect(ToolCallId.plan(ids, any)).toEqual(new Map(ids.map((id) => [id, id])))
  })

  test("a repeated id is planned once", () => {
    const planned = ToolCallId.plan(["a.b", "a.b"], dash)
    expect([...planned]).toEqual([["a.b", "a_b_2e7336dc"]])
  })

  test("distinct ids stay distinct, with results that meet the constraint", () => {
    const originals = Array.from({ length: 400 }, (_, index) => `functions.tool${index % 40}:${index}`)
    for (const constraint of [dash, bare, nine, { charset: "alnum", length: 3 }] as const) {
      // ids that meet the constraint and sit on the results of other ids force the numbered candidates
      const squatters = originals.slice(0, 120).map((id) => ToolCallId.project(id, constraint))
      const ids = [...originals, ...squatters]
      const planned = ToolCallId.plan(ids, constraint)
      expect(planned.size).toBe(new Set(ids).size)
      expect(new Set(planned.values()).size).toBe(planned.size)
      for (const [original, mapped] of planned) {
        expect(ToolCallId.compliant(mapped, constraint)).toBe(true)
        if (ToolCallId.compliant(original, constraint)) expect(mapped).toBe(original)
      }
    }
  })
})

describe("ToolCallId.plan with a small id space", () => {
  const one = { charset: "alnum", length: 1 } as const

  test("ids beyond the 16 hex digits still get distinct one-character ids from the whole alphabet", () => {
    const ids = Array.from({ length: 62 }, (_, i) => `call_${i}`)
    const mapped = ToolCallId.plan(ids, one)
    const results = ids.map((id) => mapped.get(id)!)
    expect(new Set(results).size).toBe(62)
    for (const r of results) expect(ToolCallId.compliant(r, one)).toBe(true)
  })

  test("more ids than the id space holds is an error, not an endless search", () => {
    const ids = Array.from({ length: 63 }, (_, i) => `call_${i}`)
    expect(() => ToolCallId.plan(ids, one)).toThrow("only 62 exist")
  })

  test("compliant ids count against the space", () => {
    const ids = [
      ...Array.from({ length: 62 }, (_, i) => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[i]),
      "call_x",
    ]
    expect(() => ToolCallId.plan(ids, one)).toThrow("only 62 exist")
  })
})

describe("ToolCallId.remap", () => {
  const call = (id: string, name = "read") => ({
    type: "tool-call" as const,
    toolCallId: id,
    toolName: name,
    input: {},
  })
  const result = (id: string, name = "read") => ({
    type: "tool-result" as const,
    toolCallId: id,
    toolName: name,
    output: { type: "text" as const, value: "ok" },
  })
  const history = (): ModelMessage[] => [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "text", text: "run" }, call("functions.bash:0", "bash")] },
    { role: "tool", content: [result("functions.bash:0", "bash")] },
    { role: "assistant", content: [call("functions.read:1"), call("abc")] },
    { role: "tool", content: [result("functions.read:1"), result("abc")] },
    { role: "assistant", content: "done" },
  ]
  const ids = (msgs: ModelMessage[]) =>
    msgs.flatMap((msg) =>
      Array.isArray(msg.content) ? msg.content.flatMap((part) => ("toolCallId" in part ? [part.toolCallId] : [])) : [],
    )

  test("any returns the same array", () => {
    const input = history()
    expect(ToolCallId.remap(input, any)).toBe(input)
  })

  test("a tool call and its tool result get the same id, in assistant and in tool messages", () => {
    expect(ids(ToolCallId.remap(history(), nine))).toEqual([
      "8497fe9cc",
      "8497fe9cc",
      "08bea9710",
      "ba7816bf8",
      "08bea9710",
      "ba7816bf8",
    ])
  })

  test("a tool result the provider executed, inside an assistant message, is mapped too", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [call("a.b", "web_search"), result("a.b", "web_search")] },
    ]
    expect(ids(ToolCallId.remap(input, dash))).toEqual(["a_b_2e7336dc", "a_b_2e7336dc"])
  })

  test("does not touch its input, and returns a message as it is when none of its ids changes", () => {
    const input = history()
    const before = structuredClone(input)
    const mapped = ToolCallId.remap(input, dash)
    expect(input).toEqual(before)
    expect(mapped).not.toBe(input)
    // no tool parts at all
    expect(mapped[0]).toBe(input[0])
    expect(mapped[5]).toBe(input[5])
    // ids that change
    expect(mapped[1]).not.toBe(input[1])
    expect(mapped[2]).not.toBe(input[2])

    const fine: ModelMessage[] = [
      { role: "assistant", content: [call("abc")] },
      { role: "tool", content: [result("abc")] },
    ]
    const same = ToolCallId.remap(fine, dash)
    expect(same[0]).toBe(fine[0])
    expect(same[1]).toBe(fine[1])
  })

  test("only the ids change: the other parts and the message fields stay", () => {
    const input: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "run" },
          { ...call("a.b"), providerOptions: { x: { y: 1 } } },
        ],
        providerOptions: { z: { w: 2 } },
      },
    ]
    expect(ToolCallId.remap(input, dash)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "run" },
          { ...call("a_b_2e7336dc"), providerOptions: { x: { y: 1 } } },
        ],
        providerOptions: { z: { w: 2 } },
      },
    ])
  })

  test("the mapping is made over the whole request: ids that would collide stay distinct across messages", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [call("a.b")] },
      { role: "tool", content: [result("a.b")] },
      { role: "assistant", content: [call("a:b")] },
      { role: "tool", content: [result("a:b")] },
    ]
    expect(ids(ToolCallId.remap(input, dash))).toEqual(["a_b_2e7336dc", "a_b_2e7336dc", "a_b_6783a31e", "a_b_6783a31e"])
  })

  test("an id that meets the constraint in another message is not taken over by the projection of a different id", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [call("functions.bash:0", "bash")] },
      { role: "tool", content: [result("functions.bash:0", "bash")] },
      { role: "assistant", content: [call("8497fe9cc")] },
      { role: "tool", content: [result("8497fe9cc")] },
    ]
    // 8497fe9cc is what functions.bash:0 maps to alone
    expect(ids(ToolCallId.remap(input, nine))).toEqual(["7a7c5acf9", "7a7c5acf9", "8497fe9cc", "8497fe9cc"])
  })

  test("an id depends only on the ids of the request, in the order they first appear", () => {
    const first = ids(ToolCallId.remap(history(), nine))
    const longer = ids(
      ToolCallId.remap([...history(), { role: "assistant", content: [call("functions.write:2")] }], nine),
    )
    expect(longer.slice(0, first.length)).toEqual(first)
  })
})
