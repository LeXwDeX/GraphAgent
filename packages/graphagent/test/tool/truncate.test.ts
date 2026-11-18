// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { MAX_LINE_FETCH, formatSize, headPreview, notice, tailPreview } from "../../src/tool/truncate"

describe("tool.truncate previews", () => {
  it("reports the complete byte length of a partial first line", () => {
    const first = "a".repeat(60_000)
    const second = "b".repeat(200_000)
    const preview = headPreview(`${first}\n${second}`, 20, 50 * 1024)

    expect(preview.cut).toBe(true)
    expect(preview.details).toMatchObject({
      direction: "head",
      partialLine: true,
      startLine: 1,
      endLine: 1,
      lineBytes: 60_000,
      outputBytes: 50 * 1024,
    })
    expect(preview.text.length).toBe(50 * 1024)
  })

  it("reports the complete byte length of a partial last line", () => {
    const first = "a".repeat(60_000)
    const second = "b".repeat(200_000)
    const preview = tailPreview(`${first}\n${second}`, 20, 50 * 1024)

    expect(preview.cut).toBe(true)
    expect(preview.details).toMatchObject({
      direction: "tail",
      partialLine: true,
      startLine: 2,
      endLine: 2,
      lineBytes: 200_000,
      outputBytes: 50 * 1024,
      totalBytes: 260_001,
    })
    expect(preview.text.length).toBe(50 * 1024)

    const text = notice("/tmp/full.txt", preview.details!)
    expect(text).toContain(`showing the last ${formatSize(50 * 1024)} of line 2`)
    expect(text).toContain(`line is ${formatSize(200_000)}`)
    expect(text).toContain('offset=2 limit=1')
  })

  it("names the exact read that continues a partial line", () => {
    const preview = headPreview("a".repeat(60_000), 20, 50 * 1024)
    const text = notice("/tmp/full.txt", preview.details!)
    expect(text).toContain(`offset=1 limit=1 charOffset=51201 maxLineLength=${MAX_LINE_FETCH}`)
    expect(text).toContain(`line is ${formatSize(60_000)}`)
    // The one line is the whole output: nothing follows it.
    expect(text).not.toContain("more lines follow it")
  })

  it("continues a cut first line past what the preview shows and counts the lines after it", () => {
    const preview = headPreview("a".repeat(60_000) + "\nb\nc\nd", 20, 50 * 1024)
    const text = notice("/tmp/full.txt", preview.details!)
    const lines = text.split("\n")

    expect(preview.details).toMatchObject({ partialLine: true, shownChars: 51_200 })
    expect(lines[0]).toBe(
      `[truncated: showing the first ${formatSize(50 * 1024)} of line 1 ` +
        `(line is ${formatSize(60_000)}; ${formatSize(60_006)} total output). Full output: /tmp/full.txt]`,
    )
    expect(lines[1]).toBe(
      `Continue this line: read filePath="/tmp/full.txt" offset=1 limit=1 charOffset=51201 maxLineLength=${MAX_LINE_FETCH}`,
    )
    expect(lines[2]).toBe('3 more lines follow it; read them with: read filePath="/tmp/full.txt" offset=2')
    expect(lines).toHaveLength(3)
  })

  it("counts the shown characters in code points, which is how read counts charOffset", () => {
    const preview = headPreview("😀".repeat(30_000), 20, 50 * 1024)

    // 51200 bytes hold 12800 four-byte characters.
    expect(preview.details).toMatchObject({ partialLine: true, shownChars: 12_800 })
    expect(Array.from(preview.text)).toHaveLength(12_800)
    expect(notice("/tmp/full.txt", preview.details!)).toContain("charOffset=12801")
  })

  it("records no shown characters when the preview is whole lines", () => {
    const head = headPreview(Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n"), 10, 50 * 1024)
    const tail = tailPreview(Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n"), 10, 50 * 1024)

    expect(head.details).toMatchObject({ partialLine: false, shownChars: 0 })
    expect(tail.details).toMatchObject({ partialLine: false, shownChars: 0 })
  })

  it("keeps the continuation of a cut last line as it was", () => {
    const preview = tailPreview(`first\n${"b".repeat(60_000)}`, 20, 50 * 1024)
    const text = notice("/tmp/full.txt", preview.details!)

    expect(preview.details).toMatchObject({ partialLine: true, shownChars: 51_200 })
    expect(text.split("\n")[1]).toBe(
      `Continue: read filePath="/tmp/full.txt" offset=2 limit=1 maxLineLength=${MAX_LINE_FETCH}; ` +
        "use the shell tool for characters beyond that.",
    )
    expect(text).not.toContain("charOffset")
  })
})
