import { describe, expect, test } from "bun:test"
import { readDisplayPartText, readPartText } from "./message-part-text"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("readDisplayPartText", () => {
  test("renders the hook replacement while preserving raw accumulated text for other consumers", () => {
    const part = { id: "part_1", text: "raw", displayText: "  shown  " }
    expect(readDisplayPartText({ part_1: "raw streaming" }, part)).toBe("shown")
    expect(readPartText({ part_1: "raw streaming" }, part)).toBe("raw streaming")
  })

  test("honors an empty replacement and falls back when no replacement exists", () => {
    expect(readDisplayPartText({ part_1: "raw" }, { id: "part_1", text: "raw", displayText: "" })).toBe("")
    expect(readDisplayPartText({ part_1: "stream" }, { id: "part_1", text: "raw" })).toBe("stream")
  })
})
