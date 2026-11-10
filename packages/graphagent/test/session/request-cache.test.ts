// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ByteSize, FileSystem, Option } from "effect"
import { RequestCache } from "@/session/request-cache"

describe("RequestCache", () => {
  test("evicts least-recently-used entries and keeps the entry just written", () => {
    const cache = RequestCache.make<string>(10)
    RequestCache.set(cache, "a", "a", 4)
    RequestCache.set(cache, "b", "b", 4)
    // Reading `a` makes `b` the oldest entry.
    expect(RequestCache.get(cache, "a")).toBe("a")
    RequestCache.set(cache, "c", "c", 4)

    expect(RequestCache.has(cache, "b")).toBe(false)
    expect(RequestCache.has(cache, "a")).toBe(true)
    expect(RequestCache.has(cache, "c")).toBe(true)
    expect(RequestCache.size(cache)).toEqual({ entries: 2, bytes: 8 })
  })

  test("never stores an entry larger than the whole budget", () => {
    const cache = RequestCache.make<string>(4)
    RequestCache.set(cache, "large", "x", 5)
    expect(RequestCache.has(cache, "large")).toBe(false)
    expect(RequestCache.size(cache)).toEqual({ entries: 0, bytes: 0 })
  })

  test("a non-positive limit disables eviction", () => {
    const cache = RequestCache.make<string>(0)
    RequestCache.set(cache, "a", "a", 100)
    RequestCache.set(cache, "b", "b", 100)
    expect(RequestCache.size(cache)).toEqual({ entries: 2, bytes: 200 })
  })

  test("overwrites adjust the byte counter and forget/clear reset it", () => {
    const cache = RequestCache.make<string>(100)
    RequestCache.set(cache, "a", "first", 5)
    RequestCache.set(cache, "a", "second", 6)
    expect(RequestCache.size(cache)).toEqual({ entries: 1, bytes: 6 })

    RequestCache.forget(cache, (key) => key === "a")
    expect(RequestCache.size(cache)).toEqual({ entries: 0, bytes: 0 })

    RequestCache.set(cache, "b", "b", 1)
    RequestCache.clear(cache)
    expect(RequestCache.size(cache)).toEqual({ entries: 0, bytes: 0 })
  })

  test("canonicalJson sorts object keys recursively and ignores property order", () => {
    expect(RequestCache.canonicalJson({ b: 1, a: { d: 2, c: [3] } })).toBe('{"a":{"c":[3],"d":2},"b":1}')
    expect(RequestCache.digest({ a: 1, b: [2, 3] })).toBe(RequestCache.digest({ b: [2, 3], a: 1 }))
    expect(RequestCache.digest({ a: 1 })).not.toBe(RequestCache.digest({ a: 2 }))
  })

  test("statSignature tracks inode, size, mtime and mode", () => {
    const info = (ino: bigint, size: number, mtime: number, mode: number) =>
      ({
        ino: Option.some(ino),
        size: ByteSize.bytes(size),
        mtime: Option.some(new Date(mtime)),
        mode,
      }) as unknown as FileSystem.File.Info
    const base = RequestCache.statSignature(info(1n, 2, 3, 0o644))

    expect(RequestCache.statSignature(info(1n, 3, 3, 0o644))).not.toBe(base)
    expect(RequestCache.statSignature(info(2n, 2, 3, 0o644))).not.toBe(base)
    expect(RequestCache.statSignature(info(1n, 2, 4, 0o644))).not.toBe(base)
    expect(RequestCache.statSignature(info(1n, 2, 3, 0o600))).not.toBe(base)
    expect(RequestCache.statSignature(info(1n, 2, 3, 0o644))).toBe(base)
  })
})
