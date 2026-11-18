// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { costLabel, formatCost, unpriced } from "../../src/util/cost"

describe("formatCost", () => {
  test.each([
    // Nothing to show: zero, negative drift, and values that are not numbers.
    [0, "$0.00"],
    [-0, "$0.00"],
    [-1e-17, "$0.00"],
    [-3, "$0.00"],
    [Number.NaN, "$0.00"],
    [Number.POSITIVE_INFINITY, "$0.00"],
    [Number.NEGATIVE_INFINITY, "$0.00"],
    // A real cost below a hundredth of a cent never reads as zero.
    [1e-9, "<$0.0001"],
    [0.00001, "<$0.0001"],
    [0.00009999, "<$0.0001"],
    // Low-priced models: four decimals up to one cent.
    [0.0001, "$0.0001"],
    [0.0027, "$0.0027"],
    [0.0099, "$0.0099"],
    // From one cent on: cents, with grouping.
    [0.01, "$0.01"],
    [1.234, "$1.23"],
    [12, "$12.00"],
    [1234.5, "$1,234.50"],
  ])("formats %p as %p", (cost, text) => {
    expect(formatCost(cost)).toBe(text)
  })
})

describe("unpriced", () => {
  test("a session that recorded tokens at zero cost has no price", () => {
    expect(unpriced(0, 1)).toBe(true)
    expect(unpriced(0, 120_000)).toBe(true)
  })

  test("a priced session, or one without tokens, is not unpriced", () => {
    expect(unpriced(0.0027, 1)).toBe(false)
    expect(unpriced(0, 0)).toBe(false)
    expect(unpriced(1.5, 0)).toBe(false)
  })
})

describe("costLabel", () => {
  const unknown = "unknown"

  test("a known cost is only the formatted cost", () => {
    expect(costLabel(0, false, unknown)).toBe("$0.00")
    expect(costLabel(0.0027, false, unknown)).toBe("$0.0027")
    expect(costLabel(3.456, false, unknown)).toBe("$3.46")
  })

  test("an unknown part with nothing priced is only the word", () => {
    expect(costLabel(0, true, unknown)).toBe("unknown")
    expect(costLabel(0, true, "未知")).toBe("未知")
  })

  test("an unknown part next to a priced one is the cost plus the word", () => {
    expect(costLabel(0.0027, true, unknown)).toBe("$0.0027 + unknown")
    expect(costLabel(12, true, "未知")).toBe("$12.00 + 未知")
  })

  test("a negative or non-finite sum is not a price: with an unknown part it reads as the word", () => {
    expect(costLabel(-1e-17, true, unknown)).toBe("unknown")
    expect(costLabel(Number.NaN, true, unknown)).toBe("unknown")
  })
})
