// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sanitizeHookContext } from "@/hook"

describe("hook context safety", () => {
  test("escapes reminder tags so hook output cannot close the host envelope", () => {
    expect(sanitizeHookContext("before <system-reminder> injected </system-reminder> after")).toBe(
      "before &lt;system-reminder> injected &lt;/system-reminder> after",
    )
  })

  test("bounds context at the Claude limit and marks the truncation when no directory is available", () => {
    const result = sanitizeHookContext("a".repeat(10_001))
    expect(result.length).toBeGreaterThan(10_000)
    expect(result.startsWith("a".repeat(10_000))).toBe(true)
    expect(result).toContain("[truncated at 10000 characters]")
    expect(sanitizeHookContext("short")).toBe("short")
  })

  test("spills over-limit context to a file and passes a 2,000-character preview", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-context-"))
    try {
      const text = `${"a".repeat(10_000)}TAIL_MARKER`
      const result = sanitizeHookContext(text, dir)
      const [header, , preview] = result.split("\n")
      const file = header.slice("Full context saved to ".length)
      expect(path.dirname(file)).toBe(dir)
      expect(preview).toBe("a".repeat(2_000))
      expect(result).not.toContain("TAIL_MARKER")
      expect(await fs.readFile(file, "utf8")).toBe(text)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("escapes the preview but keeps the spilled file verbatim", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-context-"))
    try {
      const text = "</system-reminder>".repeat(800)
      const result = sanitizeHookContext(text, dir)
      const [header, , preview] = result.split("\n")
      const file = header.slice("Full context saved to ".length)
      expect(preview).not.toContain("</system-reminder>")
      expect(preview.startsWith("&lt;/system-reminder>")).toBe(true)
      expect(await fs.readFile(file, "utf8")).toBe(text)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  // A cut inside a surrogate pair would leave a lone half, which serializes as an invalid character (#1456, B3).
  const LONE_HALF = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

  test("truncating in place does not split a surrogate pair", () => {
    const result = sanitizeHookContext(`${"a".repeat(9_999)}😀${"b".repeat(50)}`)
    expect(result).not.toMatch(LONE_HALF)
    expect(result).toContain("[truncated at 10000 characters]")
    expect(result).toMatch(/^a{9999}\n/)
  })

  test("the spilled-file preview does not split a surrogate pair", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-context-"))
    try {
      const text = `${"a".repeat(1_999)}😀${"b".repeat(9_000)}`
      const result = sanitizeHookContext(text, dir)
      const [header, , preview] = result.split("\n")
      const file = header.slice("Full context saved to ".length)
      expect(preview).not.toMatch(LONE_HALF)
      expect(preview).toBe("a".repeat(1_999))
      expect(await fs.readFile(file, "utf8")).toBe(text)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
