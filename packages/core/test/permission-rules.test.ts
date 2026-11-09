// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "@graphagent/core/permission"

describe("Permission rules", () => {
  test("last matching rule wins", () => {
    const merged = PermissionV2.merge(
      [{ action: "read", resource: "*", effect: "allow" }],
      [{ action: "read", resource: "*.env", effect: "deny" }],
      [{ action: "read", resource: "*.env.example", effect: "allow" }],
    )

    expect(PermissionV2.evaluate("read", "src/index.ts", merged)).toEqual({
      action: "read",
      resource: "*",
      effect: "allow",
    })
    expect(PermissionV2.evaluate("read", "prod.env", merged)).toEqual({
      action: "read",
      resource: "*.env",
      effect: "deny",
    })
    expect(PermissionV2.evaluate("read", "prod.env.example", merged)).toEqual({
      action: "read",
      resource: "*.env.example",
      effect: "allow",
    })
  })

  test("matches action and resource wildcards independently", () => {
    const rules = PermissionV2.merge([
      { action: "edit*", resource: "src/**", effect: "allow" },
      { action: "bash", resource: "*", effect: "deny" },
    ])

    expect(PermissionV2.evaluate("edit", "src/main.ts", rules).effect).toBe("allow")
    expect(PermissionV2.evaluate("bash", "rm -rf /", rules).effect).toBe("deny")
    expect(PermissionV2.evaluate("bash", "src/main.ts", rules).effect).toBe("deny")
  })

  test("falls back to ask when no rule matches", () => {
    expect(PermissionV2.evaluate("webfetch", "https://example.com", [])).toEqual({
      action: "webfetch",
      resource: "*",
      effect: "ask",
    })
  })
})
