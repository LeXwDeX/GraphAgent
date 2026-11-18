// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { DeniedError, RejectedError } from "../src/v1/permission"

const rule = (index: number) => ({ permission: `perm${index}`, pattern: `pattern${index}`, action: "deny" })

describe("permission errors tell the model what to do next", () => {
  test("a rejected call says not to retry it", () => {
    const message = new RejectedError().message
    expect(message).toBe(
      "The user rejected permission to use this specific tool call. Do not retry this call; choose another approach or ask the user.",
    )
    expect(message).toContain("rejected permission")
  })

  test("a denied call lists a few rules and says not to retry it", () => {
    const message = new DeniedError({ ruleset: [rule(1), rule(2)] }).message
    expect(message).toBe(
      "The user has specified a rule which prevents you from using this specific tool call. Relevant rules: perm1 pattern1 deny; perm2 pattern2 deny. Do not retry this call; choose another approach.",
    )
    expect(message).toContain("specified a rule")
  })

  test("a denied call lists only the first 5 of 6 rules and counts the rest", () => {
    const message = new DeniedError({ ruleset: Array.from({ length: 6 }, (_, index) => rule(index + 1)) }).message
    expect(message).toContain(
      "Relevant rules: perm1 pattern1 deny; perm2 pattern2 deny; perm3 pattern3 deny; perm4 pattern4 deny; perm5 pattern5 deny; +1 more. ",
    )
    expect(message).not.toContain("perm6")
    expect(message).toContain("Do not retry this call")
  })

  test("a denied call cuts a long rule to 120 characters", () => {
    const message = new DeniedError({ ruleset: [{ permission: "bash", pattern: "x".repeat(300), action: "deny" }] })
      .message
    expect(message).toContain(`Relevant rules: bash ${"x".repeat(115)}. `)
    expect(message).not.toContain("x".repeat(116))
  })

  test("a denied call skips entries that are not readable rules and leaves the clause out when none is left", () => {
    const mixed = new DeniedError({ ruleset: [null, "deny all", { permission: "bash" }, rule(1), { permission: 1 }] })
    expect(mixed.message).toContain("Relevant rules: perm1 pattern1 deny. ")
    expect(mixed.message).not.toContain("+")

    for (const ruleset of [[], undefined, "deny all", [{ permission: "bash" }]]) {
      expect(new DeniedError({ ruleset }).message).toBe(
        "The user has specified a rule which prevents you from using this specific tool call. Do not retry this call; choose another approach.",
      )
    }
  })

  test("a role-derived reason is kept as it is", () => {
    const reason = "dag_safety:SF-5: denied by test"
    expect(new DeniedError({ ruleset: [rule(1)], reason }).message).toBe(reason)
  })
})
