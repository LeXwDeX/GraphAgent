// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1557: a pending permission request keeps its `metadata` as JSON, so what one tool puts into it (an optional
// argument copied in as `undefined`, a `movePath` that is not a move) cannot make the pending list unreadable.
import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { Schema } from "effect"
import { jsonMetadata } from "../../src/permission/metadata"
import { SessionID } from "../../src/session/schema"

// What `GET /permission` does with the list: HttpApi encodes the success schema with the strict JSON codec.
const encodeList = Schema.encodeUnknownSync(Schema.toCodecJson(Schema.Array(PermissionV1.Request)))

const pending = (metadata: Record<string, unknown>) => ({
  id: PermissionV1.ID.make("per_metadata"),
  sessionID: SessionID.make("ses_metadata"),
  permission: "edit",
  patterns: ["a.txt"],
  metadata,
  always: ["*"],
})

describe("jsonMetadata", () => {
  test("the strict JSON encoding of the list rejects an undefined leaf, and accepts the normalized form", () => {
    const raw = { filepath: "a.txt", files: [{ type: "update", movePath: undefined }] }
    expect(() => encodeList([pending(raw)])).toThrow("Expected JSON value")
    expect(() => encodeList([pending(jsonMetadata(raw))])).not.toThrow()
  })

  test("drops undefined properties at every depth and keeps everything else", () => {
    const result = jsonMetadata({
      url: "https://example.com",
      timeout: undefined,
      nested: { keep: 1, gone: undefined, files: [{ type: "update", patch: "p", movePath: undefined }] },
    })
    expect(result).toStrictEqual({
      url: "https://example.com",
      nested: { keep: 1, files: [{ type: "update", patch: "p" }] },
    })
    expect(Object.hasOwn(result, "timeout")).toBe(false)
  })

  test("keeps array positions: an undefined slot becomes null, and so does a hole", () => {
    const sparse: unknown[] = [1, undefined, 3]
    sparse[4] = 5
    expect(jsonMetadata({ list: sparse })).toStrictEqual({ list: [1, null, 3, null, 5] })
  })

  test("keeps plain values as they are and returns a copy", () => {
    const files = [{ type: "move", movePath: "/work/b.txt" }]
    const input = { n: 0, ok: false, none: null, text: "", files }
    const result = jsonMetadata(input)
    expect(result).toStrictEqual({
      n: 0,
      ok: false,
      none: null,
      text: "",
      files: [{ type: "move", movePath: "/work/b.txt" }],
    })
    expect(result).not.toBe(input)
    expect(result.files).not.toBe(files)
  })

  test("gives non-JSON values the form JSON.stringify gives them, and a bigint its digits", () => {
    const result = jsonMetadata({
      at: new Date(Date.UTC(2026, 10, 19)),
      ratio: Number.NaN,
      limit: Number.POSITIVE_INFINITY,
      big: 10n,
      run: () => 1,
      tag: Symbol("tag"),
      seen: new Set([1]),
      error: new Error("boom"),
      custom: { toJSON: () => ({ shown: true, hidden: undefined }) },
      vanishes: { toJSON: () => undefined },
    })
    expect(result).toStrictEqual({
      at: "2026-11-19T00:00:00.000Z",
      ratio: null,
      limit: null,
      big: "10",
      seen: {},
      error: {},
      custom: { shown: true },
    })
  })

  test("breaks a cycle instead of throwing, and keeps a repeated but acyclic reference", () => {
    const loop: Record<string, unknown> = { name: "loop" }
    loop.self = loop
    const shared = { n: 1 }
    expect(jsonMetadata({ loop, first: shared, second: shared })).toStrictEqual({
      loop: { name: "loop", self: "[Circular]" },
      first: { n: 1 },
      second: { n: 1 },
    })
    const top: Record<string, unknown> = { a: 1 }
    top.again = top
    expect(jsonMetadata(top)).toStrictEqual({ a: 1, again: "[Circular]" })
  })

  test("an own __proto__ key stays an own key and does not become the prototype", () => {
    const result = jsonMetadata(JSON.parse('{"__proto__": {"x": 1}, "y": 2}'))
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.keys(result)).toEqual(["__proto__", "y"])
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toStrictEqual({ x: 1 })
  })

  test("everything it returns passes the strict JSON encoding of a pending request", () => {
    const loop: Record<string, unknown> = {}
    loop.self = loop
    const metadata = jsonMetadata({
      files: [{ movePath: undefined, patch: "p", additions: Number.NaN }],
      at: new Date(0),
      big: 1n,
      loop,
      list: [undefined, () => 1],
    })
    expect(() => encodeList([pending(metadata)])).not.toThrow()
  })
})
