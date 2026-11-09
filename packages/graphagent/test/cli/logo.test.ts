// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { LOGO_MINI, LOGO_MIN_COLUMNS } from "../../src/cli/logo"
import { UI } from "../../src/cli/ui"

function stderrAs(isTTY: boolean, columns: number | undefined) {
  Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true })
  Object.defineProperty(process.stderr, "columns", { value: columns, configurable: true })
}

afterEach(() => {
  delete (process.stderr as { isTTY?: boolean }).isTTY
  delete (process.stderr as { columns?: number }).columns
})

describe("cli ui logo", () => {
  test("non-TTY output is only the single-line mark", () => {
    stderrAs(false, 120)
    expect(UI.logo()).toBe(LOGO_MINI)
  })

  test("a terminal at least LOGO_MIN_COLUMNS wide prints the wordmark", () => {
    stderrAs(true, LOGO_MIN_COLUMNS)
    const output = UI.logo()
    expect(output.split("\n")).toHaveLength(6)
    expect(output).toContain("█")
    expect(output).not.toContain(LOGO_MINI)
  })

  test("a narrow terminal prints only the single-line mark", () => {
    stderrAs(true, LOGO_MIN_COLUMNS - 1)
    expect(UI.logo()).toBe(LOGO_MINI)
  })

  test("the pad prefix also applies to the single-line mark", () => {
    stderrAs(false, undefined)
    expect(UI.logo("  ")).toBe("  " + LOGO_MINI)
  })
})
