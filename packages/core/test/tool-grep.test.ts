import { describe, expect, test } from "bun:test"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { RelativePath } from "@opencode-ai/core/schema"
import { GrepTool } from "@opencode-ai/core/tool/grep"

const match = (text: string, textLength?: number) =>
  FileSystem.Match.make({
    entry: FileSystem.Entry.make({ path: RelativePath.make("src/app.ts"), type: "file" }),
    line: 7,
    offset: 0,
    text,
    ...(textLength === undefined ? {} : { textLength }),
    submatches: [],
  })

describe("GrepTool.toModelOutput", () => {
  test("makes a code-point preview and its true length visible", () => {
    // 1,000 astral code points are 2,000 UTF-16 units: the displayed count must
    // follow code points, the same unit the preview and read's charOffset use.
    const output = GrepTool.toModelOutput([match("😀".repeat(1_000), 1_500)])
    expect(output).toContain("line truncated to 1000 of 1500 chars")
    expect(output).toContain("src/app.ts")
  })

  test("leaves a complete line untouched", () => {
    const output = GrepTool.toModelOutput([match("short")])
    expect(output).toContain("Line 7: short")
    expect(output).not.toContain("line truncated")
  })
})
