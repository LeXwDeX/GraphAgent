// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test"
import { settleCapturedOutput, validateAgainstSchema } from "../../src/dag/runtime/capture"

describe("null structured submission", () => {
  test("a schema-accepted null completes when the durable submission bit is set", () => {
    expect(validateAgainstSchema(null, { type: "null" })).toEqual({ ok: true })
    expect(settleCapturedOutput(null, undefined, "", true)).toEqual({ kind: "complete", output: null })
    expect(settleCapturedOutput(null, undefined, " (recovered)", true)).toEqual({ kind: "complete", output: null })
  })

  test("an empty nullable slot still fails and null cannot bypass a review contract", () => {
    expect(settleCapturedOutput(null, undefined, "", false).kind).toBe("fail")
    expect(settleCapturedOutput(undefined, undefined).kind).toBe("fail")
    expect(settleCapturedOutput(null, "1234567890123456", "", true).kind).toBe("fail")
  })
})
