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

describe("stream buffer preview slot", () => {
  test("a preview replaces the tail window instead of extending it", () => {
    const stream = createStreamBuffer()
    stream.preview("prt_tool", "line 1\n", 7, 1)
    stream.preview("prt_tool", "line 2\n", 14, 2)
    expect(stream.readPreview("prt_tool")).toEqual({ tail: "line 2\n", totalLength: 14, seq: 2 })
  })

  test("a window that is not newer by seq is stale and ignored", () => {
    const stream = createStreamBuffer()
    stream.preview("prt_tool", "newest", 30, 5)
    stream.bump()
    expect(stream.version()).toBe(1)

    stream.preview("prt_tool", "older", 20, 3)
    stream.preview("prt_tool", "repeat", 30, 5)
    stream.bump()
    expect(stream.readPreview("prt_tool")).toEqual({ tail: "newest", totalLength: 30, seq: 5 })
    // Rejected windows do not request a view refresh either.
    expect(stream.version()).toBe(1)
  })

  test("100 previews of one part reach the version once per frame and keep only the latest window", () => {
    const stream = createStreamBuffer()
    for (let seq = 1; seq <= 100; seq++) stream.preview("prt_tool", `tail ${seq}`, seq * 10, seq)
    expect(stream.version()).toBe(0)

    stream.bump()
    expect(stream.version()).toBe(1)
    expect(stream.readPreview("prt_tool")).toEqual({ tail: "tail 100", totalLength: 1000, seq: 100 })
    stream.bump()
    expect(stream.version()).toBe(1)
  })

  test("previews are tracked per part and independent of text deltas", () => {
    const stream = createStreamBuffer()
    stream.preview("prt_a", "a", 1, 1)
    stream.preview("prt_b", "b", 1, 1)
    stream.append("prt_a", "text", "delta")
    expect(stream.readPreview("prt_a")?.tail).toBe("a")
    expect(stream.readPreview("prt_b")?.tail).toBe("b")
    expect(stream.read({ id: "prt_a", type: "text" })).toBe("delta")
    expect(stream.readPreview("prt_missing")).toBeUndefined()
  })

  test("settling a part drops its preview and asks the views to re-read", () => {
    const stream = createStreamBuffer()
    stream.preview("prt_tool", "running", 7, 1)
    stream.bump()
    expect(stream.version()).toBe(1)

    stream.settle("prt_tool")
    expect(stream.readPreview("prt_tool")).toBeUndefined()
    stream.bump()
    expect(stream.version()).toBe(2)

    // Settling a part without a preview changes nothing visible.
    stream.settle("prt_tool")
    stream.bump()
    expect(stream.version()).toBe(2)
  })

  test("a settled part accepts a fresh sequence from seq 1", () => {
    const stream = createStreamBuffer()
    stream.preview("prt_tool", "first run", 9, 40)
    stream.settle("prt_tool")
    stream.preview("prt_tool", "second run", 10, 1)
    expect(stream.readPreview("prt_tool")).toEqual({ tail: "second run", totalLength: 10, seq: 1 })
  })

  test("clearing parts and clearing everything drop previews", () => {
    const stream = createStreamBuffer()
    stream.preview("prt_1", "one", 3, 1)
    stream.preview("prt_2", "two", 3, 1)
    stream.preview("prt_3", "three", 5, 1)

    stream.clearParts(["prt_1"])
    expect(stream.readPreview("prt_1")).toBeUndefined()
    expect(stream.readPreview("prt_2")?.tail).toBe("two")

    stream.clear()
    expect(stream.readPreview("prt_2")).toBeUndefined()
    expect(stream.readPreview("prt_3")).toBeUndefined()
    stream.bump()
    expect(stream.version()).toBe(1)
  })
})
