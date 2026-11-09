// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { create } from "../src/identifier"

const WRAP_BOUNDARY = 1786706395136
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

describe("identifier 48-bit wrap", () => {
  test("ascending ids stay lexicographically ascending across the wrap boundary", () => {
    const preWrap = create(false, WRAP_BOUNDARY - 1)
    const postWrap = create(false, WRAP_BOUNDARY + 1)
    expect(preWrap < postWrap).toBe(true)
  })

  test("descending ids stay lexicographically descending across the wrap boundary", () => {
    const preWrap = create(true, WRAP_BOUNDARY - 1)
    const postWrap = create(true, WRAP_BOUNDARY + 1)
    expect(postWrap < preWrap).toBe(true)
  })

  test("same-millisecond ids are strictly ascending and unique", () => {
    const ids = Array.from({ length: 10 }, (_, index) => create(false, WRAP_BOUNDARY + 1000 + index))
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i - 1] < ids[i]).toBe(true)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("same-millisecond descending ids are strictly descending and unique", () => {
    const ids = Array.from({ length: 10 }, (_, index) => create(true, WRAP_BOUNDARY + 2000 + index))
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i - 1] > ids[i]).toBe(true)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("id format is 12 hex chars plus 14 base62 chars", () => {
    const id = create(false, WRAP_BOUNDARY + 1)
    expect(id).toHaveLength(26)
    expect(id.slice(0, 12)).toMatch(/^[0-9a-f]{12}$/)
    for (const char of id.slice(12)) {
      expect(chars).toContain(char)
    }
  })

  test("ids stay ascending when the clock regresses (latch absorbs regression)", () => {
    const first = create(false, WRAP_BOUNDARY + 3000)
    const regressed = create(false, WRAP_BOUNDARY + 3000 - 50)
    const later = create(false, WRAP_BOUNDARY + 3000 + 50)
    expect(first < regressed).toBe(true)
    expect(regressed < later).toBe(true)
  })

  test("new-scheme ids sort below historical pre-wrap ids (comparisons must be time-based)", () => {
    const now = create(false, Date.now())
    const historical = create(false, WRAP_BOUNDARY - 1)
    expect(now < historical).toBe(true)
  })
})
