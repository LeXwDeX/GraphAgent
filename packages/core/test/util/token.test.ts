// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Token } from "../../src/util/token"

describe("Token.estimateReserve", () => {
  test("English text matches the chars-per-token baseline (ceil)", () => {
    expect(Token.estimateReserve("abcdefgh")).toBe(2)
    expect(Token.estimateReserve("abc")).toBe(1)
    expect(Token.estimateReserve("")).toBe(0)
  })

  test("CJK text counts one token per code point, not length/4", () => {
    const text = "反复分析方案与风险"
    expect(Token.estimateReserve(text)).toBe(text.length)
    expect(Token.estimateReserve(text)).toBeGreaterThan(Token.estimate(text))
  })

  test("mixed text sums CJK tokens with ceil(other / 4)", () => {
    expect(Token.estimateReserve("分析abcdefgh")).toBe(2 + 2)
  })

  test("astral CJK code points count once, not twice", () => {
    const text = "\u{20000}\u{20001}"
    expect(Token.estimateReserve(text)).toBe(2)
  })

  test("estimateReserve dominates estimate for CJK and equals it for ASCII", () => {
    const ascii = "a".repeat(100)
    expect(Token.estimateReserve(ascii)).toBe(Token.estimate(ascii))
    const cjk = "评审".repeat(50)
    expect(Token.estimateReserve(cjk)).toBeGreaterThan(Token.estimate(cjk))
  })
})

describe("Token.estimateComparable", () => {
  // Mirrors a measured pair on the configured DeepSeek relay (English 114 tokens, its Chinese rewrite 106).
  const english =
    'Let me compute: 1200 + 845 = 2045; 2045 + 377 = 2422.\n\nRuling out:\n1. Transcription: entries read directly, all in one line, clear. Good.\n2. Omission: exactly three entries named alpha, beta, gamma — matches "three entries". No others.\n3. Arithmetic: 1200+845+377 = 2422. Check grouping: 1200+377=1577, +845=2422. Consistent.\n\nAudited total = 2422.'
  const chinese =
    "计算：1200 + 845 = 2045；2045 + 377 = 2422。\n\n核对：\n- 转录：条目直接读取，均在同一行，清晰。\n- 遗漏：恰好有三个条目 alpha、beta、gamma，与“three entries”一致，没有其他条目。\n- 算术：1200+845+377 = 2422；按 1200+377=1577，再加 845 得 2422，一致。\n\n审计总额为 2422。"

  test("keeps the measured direction for a Chinese rewrite of English reasoning", () => {
    expect(Token.estimateComparable(chinese)).toBeLessThan(Token.estimateComparable(english))
    // The conservative reserve estimator reverses it, which is why it is not used for comparisons.
    expect(Token.estimateReserve(chinese)).toBeGreaterThan(Token.estimateReserve(english))
  })

  test("weights scripts by calibrated rates", () => {
    expect(Token.estimateComparable("")).toBe(0)
    expect(Token.estimateComparable("abcdef")).toBe(2)
    expect(Token.estimateComparable("分析方案与风险的结论")).toBe(6)
  })
})
