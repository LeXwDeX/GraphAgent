// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ShellNormalize } from "@/tool/shell/normalize"

const ESC = String.fromCharCode(27)
const CR = String.fromCharCode(13)

describe("ShellNormalize.normalize", () => {
  test("returns the same string when nothing changes", () => {
    const text = "plain\nlines\n"
    const result = ShellNormalize.normalize(text)
    expect(result.text).toBe(text)
    expect(result.folded).toBe(0)
    expect(result.ansi).toBe(false)
  })

  test("keeps CRLF line endings as they are", () => {
    const text = `a${CR}\nb${CR}\n`
    const result = ShellNormalize.normalize(text)
    expect(result.text).toBe(text)
    expect(result.folded).toBe(0)
  })

  test("keeps only the last frame of a line redrawn with a carriage return", () => {
    const result = ShellNormalize.normalize(`10%${CR}20%${CR}30%\ndone\n`)
    expect(result.text).toBe("30%\ndone\n")
    expect(result.folded).toBe(2)
    expect(result.ansi).toBe(false)
  })

  test("counts the dropped frames of every line", () => {
    const result = ShellNormalize.normalize(`a${CR}b\nc${CR}d${CR}e\nf`)
    expect(result.text).toBe("b\ne\nf")
    expect(result.folded).toBe(3)
  })

  test("keeps the CRLF ending of a line that was also redrawn", () => {
    const result = ShellNormalize.normalize(`1${CR}2${CR}\nnext\n`)
    expect(result.text).toBe(`2${CR}\nnext\n`)
    expect(result.folded).toBe(1)
  })

  test("keeps the last frame of a line that has no end yet", () => {
    expect(ShellNormalize.normalize(`a${CR}b`).text).toBe("b")
  })

  test("removes ANSI escape sequences", () => {
    const result = ShellNormalize.normalize(`${ESC}[31mred${ESC}[0m plain\n${ESC}[2K${ESC}[1Gnext\n`)
    expect(result.text).toBe("red plain\nnext\n")
    expect(result.ansi).toBe(true)
    expect(result.folded).toBe(0)
  })

  test("removes escapes before it folds frames", () => {
    const result = ShellNormalize.normalize(`${ESC}[32m50%${ESC}[0m${CR}${ESC}[32m100%${ESC}[0m\n`)
    expect(result.text).toBe("100%\n")
    expect(result.folded).toBe(1)
    expect(result.ansi).toBe(true)
  })

  test("never changes the number of lines", () => {
    const text = `a${CR}b\n${ESC}[1mc${ESC}[0m\n\nd${CR}${CR}e${CR}\n`
    expect(ShellNormalize.normalize(text).text.split("\n")).toHaveLength(text.split("\n").length)
  })
})

describe("ShellNormalize.note", () => {
  test("says what was done and that the saved output keeps the original", () => {
    expect(ShellNormalize.note({ folded: 3, ansi: true }, true)).toBe(
      "output normalized: 3 carriage-return frames folded; ANSI escape sequences removed. The saved full output keeps the original text.",
    )
  })

  test("writes only what happened, one frame in the singular", () => {
    expect(ShellNormalize.note({ folded: 1, ansi: false }, true)).toBe(
      "output normalized: 1 carriage-return frame folded. The saved full output keeps the original text.",
    )
    expect(ShellNormalize.note({ folded: 0, ansi: true }, true)).toBe(
      "output normalized: ANSI escape sequences removed. The saved full output keeps the original text.",
    )
  })

  test("says when the original was not saved", () => {
    expect(ShellNormalize.note({ folded: 2, ansi: true }, false)).toBe(
      "output normalized: 2 carriage-return frames folded; ANSI escape sequences removed. The original text was not saved.",
    )
  })
})
