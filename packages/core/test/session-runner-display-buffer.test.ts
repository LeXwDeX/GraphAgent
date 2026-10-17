import { describe, expect, test } from "bun:test"
import { SessionDisplayBuffer } from "@opencode-ai/core/session/runner/display-buffer"

describe("V2 MessageDisplay batching", () => {
  test("interactive emits complete lines across text parts and one final remainder", () => {
    const buffer = SessionDisplayBuffer.create("interactive")
    buffer.start("first")
    expect(buffer.append("first", "hello ")).toBeUndefined()
    buffer.start("second")
    expect(buffer.append("second", "world\nmore")).toEqual({
      textID: "first",
      delta: "hello world\n",
      index: 0,
      final: false,
    })
    expect(buffer.append("second", " text")).toBeUndefined()
    expect(buffer.finish()).toEqual({
      textID: "second",
      delta: "more text",
      index: 1,
      final: true,
    })
    expect(buffer.finish()).toBeUndefined()
  })

  test("noninteractive passes the entire message once at completion", () => {
    const buffer = SessionDisplayBuffer.create("noninteractive")
    buffer.start("first")
    expect(buffer.append("first", "one\n")).toBeUndefined()
    buffer.start("second")
    expect(buffer.append("second", "two")).toBeUndefined()
    expect(buffer.finish()).toEqual({
      textID: "first",
      delta: "one\ntwo",
      index: 0,
      final: true,
    })
    expect(buffer.finish()).toBeUndefined()
  })
})
