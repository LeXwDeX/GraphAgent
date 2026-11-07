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
    expect(text).toContain(`offset=1 limit=1 maxLineLength=${MAX_LINE_FETCH}`)
    expect(text).toContain(`line is ${formatSize(60_000)}`)
  })
})
