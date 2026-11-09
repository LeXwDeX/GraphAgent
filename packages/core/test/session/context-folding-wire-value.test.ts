// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ContextFoldingPolicy } from "../../src/session/context-folding"
import { serializeWireValue } from "../../src/session/context-folding/wire-value"

describe("context folding wire serialization", () => {
  test("emits stable canonical JSON once while preserving key order and scalar encoding", () => {
    const nullPrototype: Record<string, unknown> = Object.create(null)
    Object.defineProperty(nullPrototype, "z", { value: "last", enumerable: true })
    Object.defineProperty(nullPrototype, "a", { value: "first", enumerable: false })
    const value = {
      z: [null, true, -0, 'quote:" slash:\\ control:\n lone:\ud800'],
      a: nullPrototype,
    }

    const serialized = serializeWireValue(value)
    expect(serialized).toEqual({
      ok: true,
      value: '{"a":{"a":"first","z":"last"},"z":[null,true,0,"quote:\\" slash:\\\\ control:\\n lone:\\ud800"]}',
      inputBytes: serialized.ok ? serialized.inputBytes : -1,
    })
    if (!serialized.ok) throw new Error("expected canonical serialization")
    expect(serialized.inputBytes).toBeGreaterThan(0)
    expect(JSON.parse(serialized.value)).toEqual({
      a: { a: "first", z: "last" },
      z: [null, true, 0, 'quote:" slash:\\ control:\n lone:\ud800'],
    })
  })

  test("keeps the existing fail-closed shape and value rules", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const sparse: unknown[] = []
    sparse.length = 1
    const accessor = {}
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => "hidden" })
    const symbolKey = { safe: true }
    Object.defineProperty(symbolKey, Symbol("hidden"), { value: true })
    const arrayWithExtra = ["value"] as string[] & { extra?: string }
    arrayWithExtra.extra = "extra"

    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      () => undefined,
      Symbol("value"),
      { value: undefined },
      { value: () => undefined },
      cyclic,
      sparse,
      accessor,
      symbolKey,
      arrayWithExtra,
      new Date(0),
    ]) {
      expect(serializeWireValue(value)).toEqual({ ok: false, reason: "unknown-content" })
    }
  })

  test("retains input and depth work limits with one shared traversal budget", () => {
    const oversized = "x".repeat(ContextFoldingPolicy.workLimits.maxInputBytes + 1)
    expect(serializeWireValue(oversized)).toEqual({ ok: false, reason: "work-limit" })

    let deep: unknown = "leaf"
    for (let index = 0; index <= ContextFoldingPolicy.workLimits.maxDepth; index++) deep = { value: deep }
    expect(serializeWireValue(deep)).toEqual({ ok: false, reason: "work-limit" })

    const tooMany = Array.from({ length: ContextFoldingPolicy.workLimits.maxContainerEntries + 1 }, () => null)
    expect(serializeWireValue(tooMany)).toEqual({ ok: false, reason: "work-limit" })
  })
})
