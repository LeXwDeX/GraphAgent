// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Permission } from "@/permission"
import { HookGuard } from "@/permission/hook-guard"

/**
 * #1324 P4: a hook's denial of a DAG node's call is recorded with the permission
 * key the call would have asked under. The permission service keeps its own
 * tool-to-key table private; this pins the one copy the recording uses to it.
 */

const TOOLS = [
  "edit",
  "write",
  "apply_patch",
  "bash",
  "read",
  "grep",
  "glob",
  "webfetch",
  "websearch",
  "task",
  "todowrite",
  "skill",
  "workflow",
  "lsp",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  // An MCP server tool is its own key.
  "srv_lookup",
]

describe("the permission key of a hook-denied tool", () => {
  for (const tool of TOOLS)
    test(`${tool}: the key is the one the permission service derives for the tool`, () => {
      const key = HookGuard.permissionKey(tool)
      // A deny on exactly this key switches the tool off, a deny on any other does not.
      expect(Permission.disabled([tool], [{ permission: key, pattern: "*", action: "deny" }]).has(tool)).toBe(true)
      expect(
        Permission.disabled([tool], [{ permission: `${key}_other`, pattern: "*", action: "deny" }]).has(tool),
      ).toBe(false)
    })

  test("the file tools share the edit key and the MCP resource tools the read key", () => {
    expect(["edit", "write", "apply_patch"].map(HookGuard.permissionKey)).toEqual(["edit", "edit", "edit"])
    expect(
      ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].map(HookGuard.permissionKey),
    ).toEqual(["read", "read", "read"])
  })
})
