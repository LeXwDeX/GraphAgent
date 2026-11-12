// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { KEYMAP_ERROR_PATTERN, watchKeymapErrors, type KeymapErrorGuard } from "./keymap-errors"

let guard: KeymapErrorGuard | undefined
afterEach(() => guard?.restore())

test("the messages from the broken ESC run match", () => {
  expect(KEYMAP_ERROR_PATTERN.test("[event-match-resolver-error] [Keymap] Error in event match resolver:")).toBe(true)
  expect(KEYMAP_ERROR_PATTERN.test("error: Invalid key name: key name cannot be empty")).toBe(true)
  expect(KEYMAP_ERROR_PATTERN.test("bench gate passed: 138 metric(s) compared")).toBe(false)
})

test("console.error with an Error argument is recorded once, by its first line", () => {
  guard = watchKeymapErrors({ quiet: true })

  console.error(
    "[event-match-resolver-error] [Keymap] Error in event match resolver:",
    new Error("Invalid key name: key name cannot be empty"),
  )
  console.error(
    "[event-match-resolver-error] [Keymap] Error in event match resolver:",
    new Error("Invalid key name: key name cannot be empty"),
  )

  expect(guard.hits).toEqual([
    "[event-match-resolver-error] [Keymap] Error in event match resolver: Invalid key name: key name cannot be empty",
  ])
})

test("console.warn and raw stderr writes are watched too", () => {
  guard = watchKeymapErrors({ quiet: true })

  console.warn("[event-match-resolver-error] resolver failed")
  process.stderr.write("error: Invalid key name: key name cannot be empty\n")
  process.stderr.write(new TextEncoder().encode("Invalid key name: bytes\n"))

  expect(guard.hits).toHaveLength(3)
})

test("unrelated output is ignored and still reaches the original writer", () => {
  const seen: unknown[][] = []
  // oxlint-disable-next-line typescript-eslint/unbound-method -- restored below
  const saved = console.error
  console.error = (...args: unknown[]) => void seen.push(args)
  try {
    guard = watchKeymapErrors()
    console.error("ordinary failure", 42)
    guard.restore()
  } finally {
    console.error = saved
  }

  expect(guard.hits).toEqual([])
  expect(seen).toEqual([["ordinary failure", 42]])
})

test("matching output is forwarded unless the guard is quiet", () => {
  const seen: unknown[][] = []
  // oxlint-disable-next-line typescript-eslint/unbound-method -- restored below
  const saved = console.error
  console.error = (...args: unknown[]) => void seen.push(args)
  try {
    guard = watchKeymapErrors()
    console.error("Invalid key name")
    guard.restore()
    guard = watchKeymapErrors({ quiet: true })
    console.error("Invalid key name")
    guard.restore()
  } finally {
    console.error = saved
  }

  expect(seen).toEqual([["Invalid key name"]])
})

// oxlint-disable-next-line typescript-eslint/unbound-method -- identity checks only, never called
const stderrWriter = () => process.stderr.write

test("restore puts back the exact original writers", () => {
  // oxlint-disable-next-line typescript-eslint/unbound-method -- identity check
  const original = { error: console.error, warn: console.warn, write: stderrWriter() }
  guard = watchKeymapErrors({ quiet: true })
  expect(console.error).not.toBe(original.error)
  expect(stderrWriter()).not.toBe(original.write)

  guard.restore()
  guard.restore()

  expect(console.error).toBe(original.error)
  expect(console.warn).toBe(original.warn)
  expect(stderrWriter()).toBe(original.write)
})
