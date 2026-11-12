// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { parentSessionIDOf, sessionIDOf } from "@/background/session-metadata"

describe("background session metadata keys", () => {
  it("reads the current keys", () => {
    expect(sessionIDOf({ sessionID: "ses_new" })).toBe("ses_new")
    expect(parentSessionIDOf({ parentSessionID: "ses_parent" })).toBe("ses_parent")
  })

  it("falls back to the pre-rename keys for durable rows and parts", () => {
    expect(sessionIDOf({ sessionId: "ses_old" })).toBe("ses_old")
    expect(parentSessionIDOf({ parentSessionId: "ses_old_parent" })).toBe("ses_old_parent")
  })

  it("prefers the current key when both are present", () => {
    expect(sessionIDOf({ sessionID: "ses_new", sessionId: "ses_old" })).toBe("ses_new")
    expect(parentSessionIDOf({ parentSessionID: "ses_new_parent", parentSessionId: "ses_old_parent" })).toBe(
      "ses_new_parent",
    )
  })

  it("ignores non-string values and missing metadata", () => {
    expect(sessionIDOf(undefined)).toBeUndefined()
    expect(sessionIDOf({ sessionID: 42, sessionId: "ses_old" })).toBe("ses_old")
    expect(parentSessionIDOf({ parentSessionID: null })).toBeUndefined()
  })
})
