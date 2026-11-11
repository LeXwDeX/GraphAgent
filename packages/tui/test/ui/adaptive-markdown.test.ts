// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import {
  FINAL_MARKDOWN_MAX,
  STREAM_MARKDOWN_MAX,
  markdownMode,
} from "../../src/ui/adaptive-markdown"

describe("markdown thresholds", () => {
  test("pins the documented byte limits", () => {
    expect(STREAM_MARKDOWN_MAX).toBe(4 * 1024)
    expect(FINAL_MARKDOWN_MAX).toBe(64 * 1024)
  })
})

describe("markdownMode", () => {
  test("keeps streaming content at the limit in markdown mode", () => {
    expect(markdownMode("a".repeat(STREAM_MARKDOWN_MAX), true)).toBe("markdown")
  })

  test("degrades streaming content one byte above the limit", () => {
    expect(markdownMode("a".repeat(STREAM_MARKDOWN_MAX + 1), true)).toBe("plain")
  })

  test("keeps completed content at the final limit in markdown mode", () => {
    expect(markdownMode("a".repeat(FINAL_MARKDOWN_MAX), false)).toBe("markdown")
  })

  test("keeps completed content one byte above the final limit plain", () => {
    expect(markdownMode("a".repeat(FINAL_MARKDOWN_MAX + 1), false)).toBe("plain")
  })

  test("upgrades completed content above the streaming limit to markdown", () => {
    expect(markdownMode("a".repeat(STREAM_MARKDOWN_MAX + 1), false)).toBe("markdown")
  })

  test("counts UTF-8 bytes rather than characters", () => {
    const char = "中" // three bytes
    const overStream = Math.floor(STREAM_MARKDOWN_MAX / 3) + 1
    expect(Buffer.byteLength(char.repeat(overStream), "utf8")).toBeGreaterThan(STREAM_MARKDOWN_MAX)
    expect(overStream).toBeLessThan(STREAM_MARKDOWN_MAX)
    expect(markdownMode(char.repeat(overStream), true)).toBe("plain")
  })
})