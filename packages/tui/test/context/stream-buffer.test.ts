// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { createStreamBuffer } from "../../src/context/stream-buffer"

describe("stream buffer", () => {
  test("appends deltas without touching the store", () => {
    const stream = createStreamBuffer()
    stream.append("prt_1", "text", "hello")
    stream.append("prt_1", "text", " world")
    expect(stream.read({ id: "prt_1", type: "text" })).toBe("hello world")
  })

  test("reads the settled store snapshot plus un-settled deltas", () => {
    const stream = createStreamBuffer()
    stream.append("prt_1", "text", "delta")
    expect(stream.read({ id: "prt_1", type: "text", text: "snapshot " })).toBe("snapshot delta")
  })

  test("keeps 1000 deltas out of the reactive version until a frame bump", () => {
    const stream = createStreamBuffer()
    for (let index = 0; index < 1000; index++) stream.append("prt_1", "text", "x")
    expect(stream.read({ id: "prt_1", type: "text" })).toHaveLength(1000)
    expect(stream.version()).toBe(0)

    stream.bump()
    expect(stream.version()).toBe(1)
    stream.bump()
    expect(stream.version()).toBe(1)

    stream.append("prt_1", "text", "y")
    stream.bump()
    expect(stream.version()).toBe(2)
  })

  test("settling a part drops its buffered deltas", () => {
    const stream = createStreamBuffer()
    stream.append("prt_1", "text", "draft")
    stream.settle("prt_1")
    expect(stream.read({ id: "prt_1", type: "text", text: "final" })).toBe("final")
  })

  test("clearing selected parts leaves other buffers intact", () => {
    const stream = createStreamBuffer()
    stream.append("prt_1", "text", "one")
    stream.append("prt_2", "text", "two")
    stream.clearParts(["prt_1"])
    expect(stream.read({ id: "prt_1", type: "text" })).toBe("")
    expect(stream.read({ id: "prt_2", type: "text" })).toBe("two")
  })

  test("clearing everything drops all buffers", () => {
    const stream = createStreamBuffer()
    stream.append("prt_1", "text", "one")
    stream.append("prt_2", "reasoning", "two")
    stream.clear()
    expect(stream.read({ id: "prt_1", type: "text" })).toBe("")
    expect(stream.read({ id: "prt_2", type: "reasoning" })).toBe("")
  })

  test("separates text and reasoning fields", () => {
    const stream = createStreamBuffer()
    stream.append("prt_1", "text", "body")
    stream.append("prt_1", "reasoning", "thought")
    expect(stream.read({ id: "prt_1", type: "text" })).toBe("body")
    expect(stream.read({ id: "prt_1", type: "reasoning" })).toBe("thought")
  })

  test("hook display text wins over raw deltas", () => {
    const stream = createStreamBuffer()
    stream.append("prt_1", "text", "raw delta")
    expect(stream.read({ id: "prt_1", type: "text", text: "raw", displayText: "rendered" })).toBe("rendered")
  })

  test("ignores empty deltas", () => {
    const stream = createStreamBuffer()
    stream.append("prt_1", "text", "")
    stream.bump()
    expect(stream.version()).toBe(0)
  })
})
