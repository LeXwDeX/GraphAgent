// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { Permission } from "@/permission"
import { testEffect } from "../lib/effect"

// The debug CLI helpers are runtime code; keep this DAG test independent of them.
function debugToolVisibility(
  native: PermissionV1.Ruleset,
  configured: PermissionV1.Ruleset,
  tools: string[],
): Record<string, boolean> {
  const disabled = Permission.disabledByPolicy(tools, native, configured)
  return Object.fromEntries(tools.map((tool) => [tool, !disabled.has(tool)]))
}

function debugPermissionError(
  native: PermissionV1.Ruleset,
  configured: PermissionV1.Ruleset,
  request: { permission: string; patterns: readonly string[] },
) {
  const denied = request.patterns.some(
    (pattern) =>
      Permission.evaluate(request.permission, pattern, native).action === "deny" ||
      Permission.evaluate(request.permission, pattern, configured).action === "deny",
  )
  return denied ? new PermissionV1.DeniedError({ ruleset: configured }) : undefined
}

describe("debug agent permission policy", () => {
  test("native deny hides a tool even when the configured rules allow it", () => {
    const native = Permission.fromConfig({ "*": "deny" })
    const configured = Permission.fromConfig({ "*": "allow", edit: "allow" })

    expect(debugToolVisibility(native, configured, ["edit", "read"])).toEqual({
      edit: false,
      read: false,
    })
    expect(debugPermissionError(native, configured, { permission: "edit", patterns: ["README.md"] })).toBeInstanceOf(
      PermissionV1.DeniedError,
    )
  })

  test("configured deny hides a tool that the native rules allow", () => {
    const native = Permission.fromConfig({ "*": "allow" })
    const configured = Permission.fromConfig({ "*": "deny", read: "allow" })

    expect(debugToolVisibility(native, configured, ["edit", "read"])).toEqual({
      edit: false,
      read: true,
    })
    expect(debugPermissionError(native, configured, { permission: "edit", patterns: ["README.md"] })).toBeInstanceOf(
      PermissionV1.DeniedError,
    )
  })

  test("allows a tool only when both layers allow it", () => {
    const native = Permission.fromConfig({ "*": "allow" })
    const configured = Permission.fromConfig({ "*": "allow" })

    expect(debugToolVisibility(native, configured, ["edit", "read"])).toEqual({
      edit: true,
      read: true,
    })
    expect(debugPermissionError(native, configured, { permission: "edit", patterns: ["README.md"] })).toBeUndefined()
  })
})

const it = testEffect(Agent.defaultLayer)

describe("debug agent explore profile", () => {
  it.instance("native explore deny wins over a user allow for visibility and execution", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const explore = yield* agents.get("explore")
      expect(explore).toBeDefined()
      const policy = yield* agents.permissionPolicy("explore")
      const configured = Permission.merge(explore!.permission, Permission.fromConfig({ edit: "allow" }))

      expect(debugToolVisibility(policy.native, configured, ["edit"])).toEqual({ edit: false })
      expect(
        debugPermissionError(policy.native, configured, { permission: "edit", patterns: ["README.md"] }),
      ).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  )
})
