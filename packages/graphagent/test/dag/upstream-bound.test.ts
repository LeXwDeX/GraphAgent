// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { UpstreamBound } from "@/dag/runtime/upstream-bound"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(Truncate.defaultLayer)

const FILE = "/spill/tool_recorded"

/** A `save` that keeps what it was given and names one fixed file, so the pointer is predictable. */
function recorder() {
  const written: string[] = []
  const write = (text: string) =>
    Effect.sync((): Truncate.Saved => {
      written.push(text)
      return { path: FILE }
    })
  return { written, write }
}

function textOf(value: unknown): string {
  if (typeof value !== "string") throw new Error(`expected a string, got ${typeof value}`)
  return value
}

/** What a downstream node reads before the pointer: the text up to the blank line that precedes the notice. */
function headOf(value: unknown): string {
  return textOf(value).split("\n\n[truncated:")[0]
}

const bytes = (text: string) => Buffer.byteLength(text, "utf-8")
// Under the `u` flag a surrogate pair is one code point, so this matches only a half left on its own.
const LONE_SURROGATE = /[\ud800-\udfff]/u

describe("UpstreamBound.bound", () => {
  it.live("states the inline limit and the head it keeps", () =>
    Effect.sync(() => {
      expect(UpstreamBound.UPSTREAM_INLINE_LIMIT_BYTES).toBe(16_384)
      expect(UpstreamBound.UPSTREAM_HEAD_BYTES).toBe(4_096)
    }),
  )

  it.live("leaves a string of exactly the limit alone and writes nothing", () =>
    Effect.gen(function* () {
      const { written, write } = recorder()
      const mapping = { at: "a".repeat(16_384) }
      const bounded = yield* UpstreamBound.bound(mapping, write)
      expect(bounded).toBe(mapping)
      expect(written).toEqual([])
    }),
  )

  it.live("replaces a string one byte over the limit with its first 4096 bytes and a pointer to the full text", () =>
    Effect.gen(function* () {
      const { written, write } = recorder()
      const full = "a".repeat(16_385)
      const mapping = { over: full }
      const bounded = yield* UpstreamBound.bound(mapping, write)
      const value = textOf(bounded.over)
      expect(headOf(value)).toBe("a".repeat(4_096))
      expect(value).toContain(`Full output: ${FILE}`)
      // The full text went to disk once, whole; the mapping the caller holds is not rewritten.
      expect(written).toEqual([full])
      expect(mapping.over).toBe(full)
    }),
  )

  it.live("builds the bounded value from the head preview and the standard truncation notice", () =>
    Effect.gen(function* () {
      const { write } = recorder()
      const full = "a".repeat(16_385)
      const preview = Truncate.headPreview(full, Truncate.MAX_LINES, UpstreamBound.UPSTREAM_HEAD_BYTES)
      if (!preview.details) throw new Error("the preview was not cut")
      const bounded = yield* UpstreamBound.bound({ over: full }, write)
      expect(bounded.over).toBe(`${preview.text}\n\n${Truncate.notice(FILE, preview.details)}`)
    }),
  )

  it.live("counts UTF-8 bytes, not characters, against the limit", () =>
    Effect.gen(function* () {
      const { written, write } = recorder()
      // 3 bytes each: 5461 of them are 16383 bytes, and one more byte makes exactly the limit.
      const atLimit = { under: "中".repeat(5_461), exact: "中".repeat(5_461) + "a" }
      expect(yield* UpstreamBound.bound(atLimit, write)).toBe(atLimit)
      expect(written).toEqual([])

      // 5462 characters, 16386 bytes.
      const over = "中".repeat(5_462)
      expect(over.length).toBeLessThan(16_384)
      expect(bytes(over)).toBeGreaterThan(16_384)
      const bounded = yield* UpstreamBound.bound({ over }, write)
      expect(written).toEqual([over])
      expect(headOf(bounded.over)).toBe("中".repeat(1_365))
    }),
  )

  it.live("cuts a multi-byte head at a character boundary and never leaves half a surrogate pair", () =>
    Effect.gen(function* () {
      const { write } = recorder()
      // 4 bytes and two UTF-16 units each: 8200 units, yet 16400 bytes.
      const emoji = "😀".repeat(4_100)
      expect(emoji.length).toBeLessThan(16_384)
      const bounded = yield* UpstreamBound.bound({ emoji, han: "中".repeat(6_000) }, write)
      const head = headOf(bounded.emoji)
      expect(head).toBe("😀".repeat(1_024))
      expect(bytes(head)).toBe(4_096)
      expect(LONE_SURROGATE.test(textOf(bounded.emoji))).toBe(false)
      // 4096 is not a multiple of 3: the cut backs off to 1365 whole characters.
      const han = headOf(bounded.han)
      expect(han).toBe("中".repeat(1_365))
      expect(bytes(han)).toBeLessThanOrEqual(4_096)
    }),
  )

  it.live("keeps whole lines of a long multi-line string and says how many follow", () =>
    Effect.gen(function* () {
      const { written, write } = recorder()
      const lines = Array.from({ length: 10_000 }, (_, index) => `line ${index}`)
      const full = lines.join("\n")
      const bounded = yield* UpstreamBound.bound({ log: full }, write)
      const value = textOf(bounded.log)
      const head = headOf(value).split("\n")
      expect(head.length).toBeGreaterThan(1)
      expect(head).toEqual(lines.slice(0, head.length))
      expect(bytes(head.join("\n"))).toBeLessThanOrEqual(4_096)
      expect(value).toContain(`showing lines 1-${head.length} of 10000`)
      expect(value).toContain(`Full output: ${FILE}`)
      expect(written).toEqual([full])
    }),
  )

  it.live("bounds each oversized value once, in order, and leaves the others as they are", () =>
    Effect.gen(function* () {
      const { written, write } = recorder()
      const first = "f".repeat(20_000)
      const second = "s".repeat(30_000)
      const bounded = yield* UpstreamBound.bound({ first, small: "short", second, count: 3 }, write)
      expect(Object.keys(bounded)).toEqual(["first", "small", "second", "count"])
      expect(headOf(bounded.first)).toBe("f".repeat(4_096))
      expect(headOf(bounded.second)).toBe("s".repeat(4_096))
      expect(bounded.small).toBe("short")
      expect(bounded.count).toBe(3)
      expect(written).toEqual([first, second])
    }),
  )

  it.live("leaves object values, file refs and other non-strings whole however large they are", () =>
    Effect.gen(function* () {
      const { written, write } = recorder()
      const object = { note: "x".repeat(40_000) }
      const fileRef = { content_ref: "sha256:abc", path: "/work/out.md", summary: "y".repeat(40_000), size: 40_000 }
      const list = ["z".repeat(40_000)]
      const mapping = { object, fileRef, list, none: null, flag: true, count: 7 }
      expect(yield* UpstreamBound.bound(mapping, write)).toBe(mapping)

      const bounded = yield* UpstreamBound.bound({ ...mapping, text: "t".repeat(20_000) }, write)
      expect(bounded.object).toBe(object)
      expect(bounded.fileRef).toBe(fileRef)
      expect(bounded.list).toBe(list)
      expect(bounded.none).toBeNull()
      expect(bounded.flag).toBe(true)
      expect(bounded.count).toBe(7)
      expect(written).toEqual(["t".repeat(20_000)])
    }),
  )

  it.live("hands a string over whole when its full text cannot be saved", () =>
    Effect.gen(function* () {
      const attempted: string[] = []
      const failing = (text: string) =>
        Effect.sync((): Truncate.Saved => {
          attempted.push(text)
          return { failed: "ENOSPC: no space left on device" }
        })
      const full = "a".repeat(20_000)
      const bounded = yield* UpstreamBound.bound({ over: full, small: "short" }, failing)
      // No pointer to a file that does not exist: the downstream node reads the whole text instead.
      expect(bounded).toEqual({ over: full, small: "short" })
      expect(attempted).toEqual([full])
    }),
  )

  it.live("returns the mapping as it is when there is nowhere to write", () =>
    Effect.gen(function* () {
      const mapping = { over: "a".repeat(20_000) }
      expect(yield* UpstreamBound.bound(mapping)).toBe(mapping)
      expect(yield* UpstreamBound.bound(mapping, undefined)).toBe(mapping)
    }),
  )

  it.live("points at a file that holds the complete text when the real truncation service writes it", () =>
    Effect.gen(function* () {
      const truncate = yield* Truncate.Service
      const full = Array.from({ length: 3_000 }, (_, index) => `row ${index}: ${"x".repeat(20)}`).join("\n")
      const bounded = yield* UpstreamBound.bound({ report: full }, truncate.save)
      const value = textOf(bounded.report)
      const file = /Full output: (.+?)\]/.exec(value)?.[1]
      if (!file) throw new Error("the bounded value has no pointer")
      expect(path.dirname(file)).toBe(Truncate.DIR)
      expect(yield* Effect.promise(() => fs.readFile(file, "utf-8"))).toBe(full)
    }),
  )
})
