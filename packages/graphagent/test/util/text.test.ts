// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { headChars } from "../../src/util/text"

describe("headChars", () => {
  test("returns the text unchanged when it fits", () => {
    expect(headChars("abc", 3)).toBe("abc")
    expect(headChars("abc", 10)).toBe("abc")
    expect(headChars("", 0)).toBe("")
  })

  test("takes the first max UTF-16 code units", () => {
    expect(headChars("abcdef", 4)).toBe("abcd")
  })

  test("takes one fewer when the cut would split a surrogate pair", () => {
    expect(headChars("a😀b", 2)).toBe("a")
    expect(headChars("a😀b", 3)).toBe("a😀")
    expect(headChars("a😀b", 2).isWellFormed()).toBe(true)
  })

  test("keeps a lone high surrogate that has no pair to split", () => {
    const text = "a\ud83dbc"
    expect(headChars(text, 2)).toBe("a\ud83d")
  })

  test("returns nothing for a non-positive budget", () => {
    expect(headChars("abc", 0)).toBe("")
    expect(headChars("abc", -3)).toBe("")
  })
})
