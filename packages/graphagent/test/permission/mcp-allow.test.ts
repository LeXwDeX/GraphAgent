// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import { namesOneTool, userAllowsMcpTool } from "@/permission/mcp-allow"

/**
 * #1324: what the user can say about one MCP tool. Its request has no concrete
 * pattern (always `*`), so the allow that counts is the one whose permission key
 * names exactly that tool. The ask tier honors it; the readonly tier's MCP rule
 * (Q8) asks the same question.
 */

const tool = "github_create_issue"
const rule = (permission: string, pattern: string, action: PermissionV1.Rule["action"] = "allow") => ({
  permission,
  pattern,
  action,
})
const everyRuleIsTheUsers = () => true

describe("namesOneTool", () => {
  test("a literal key names one tool", () => {
    for (const key of [tool, "srv_tool", "srv_tool-2", "a.b"]) expect(namesOneTool(key)).toBe(true)
  })

  test("`*` and `?` make a key name a family or everything", () => {
    for (const key of ["*", "github_*", "*_issue", "github_create_?ssue", "?"]) expect(namesOneTool(key)).toBe(false)
  })
})

describe("userAllowsMcpTool", () => {
  test("the user's allow for the exact key with the pattern * counts", () => {
    expect(userAllowsMcpTool([rule(tool, "*")], tool, everyRuleIsTheUsers)).toBe(true)
    // Behind the agent default the user's rule decides, as `evaluate` takes the last match.
    expect(userAllowsMcpTool([rule("*", "*"), rule(tool, "*")], tool, everyRuleIsTheUsers)).toBe(true)
  })

  test("a server wildcard, a whole-key allow and another tool's allow do not", () => {
    for (const rules of [
      [rule("github_*", "*")],
      [rule("*", "*")],
      [rule("github_create_?ssue", "*")],
      [rule("github_list_issues", "*")],
    ])
      expect(userAllowsMcpTool(rules, tool, everyRuleIsTheUsers)).toBe(false)
  })

  test("only the rule that decides counts: a later ask, deny or wildcard decides instead", () => {
    expect(userAllowsMcpTool([rule(tool, "*"), rule(tool, "*", "ask")], tool, everyRuleIsTheUsers)).toBe(false)
    expect(userAllowsMcpTool([rule(tool, "*"), rule(tool, "*", "deny")], tool, everyRuleIsTheUsers)).toBe(false)
    expect(userAllowsMcpTool([rule(tool, "*"), rule("github_*", "*")], tool, everyRuleIsTheUsers)).toBe(false)
    // An earlier wildcard under the user's exact rule does not matter.
    expect(userAllowsMcpTool([rule("github_*", "*", "ask"), rule(tool, "*")], tool, everyRuleIsTheUsers)).toBe(true)
  })

  test("a rule with a concrete pattern does not decide a request whose pattern is *", () => {
    expect(userAllowsMcpTool([rule(tool, "src/*")], tool, everyRuleIsTheUsers)).toBe(false)
    expect(userAllowsMcpTool([], tool, everyRuleIsTheUsers)).toBe(false)
  })

  test("the allow has to be the user's: the caller's provenance test gets the deciding rule's index", () => {
    const asked: number[] = []
    const rules = [rule("*", "*"), rule(tool, "*"), rule("other_tool", "*")]
    expect(
      userAllowsMcpTool(rules, tool, (index) => {
        asked.push(index)
        return false
      }),
    ).toBe(false)
    expect(asked).toEqual([1])
    expect(userAllowsMcpTool(rules, tool, (index) => index === 1)).toBe(true)
  })

  test("no provenance question is asked when the deciding rule cannot count anyway", () => {
    const asked: number[] = []
    const never = (index: number) => {
      asked.push(index)
      return true
    }
    expect(userAllowsMcpTool([rule("github_*", "*")], tool, never)).toBe(false)
    expect(userAllowsMcpTool([rule(tool, "*", "ask")], tool, never)).toBe(false)
    expect(asked).toEqual([])
  })
})
