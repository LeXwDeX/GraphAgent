// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CommandPlugin } from "@graphagent/core/plugin/command"
import { DELEGATION_CRITERIA } from "@graphagent/core/plugin/delegation-criteria"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const PLACEHOLDER = "{{delegation_criteria}}"
const occurrences = (text: string, part: string) => text.split(part).length - 1

// #1454: the three tiers (direct, `task`, `workflow`) are defined once, here. The workflow routing text takes them
// through the placeholder; the `task` description and the `dag-auto` skill are checked in packages/graphagent.
describe("DELEGATION_CRITERIA", () => {
  it.effect("is four static lines naming the three tiers, with no DAG mode rule", () =>
    Effect.sync(() => {
      const lines = DELEGATION_CRITERIA.split("\n")
      expect(lines).toHaveLength(4)
      expect(lines[0]).toBe("Choose the lightest tier that fits.")
      expect(lines[1]).toContain("about five tool calls or fewer")
      expect(lines[2]).toContain("`task` subagent")
      expect(lines[3]).toContain("`workflow` DAG")
      // No blank first or last line: the placeholder line sits between two blank lines in each carrier.
      expect(DELEGATION_CRITERIA).toBe(DELEGATION_CRITERIA.trim())
      // The default routing belongs to the `dag_mode` block (#1031); the constant stays static text.
      expect(DELEGATION_CRITERIA).not.toContain("DAG mode")
      expect(DELEGATION_CRITERIA).not.toContain("dag_mode")
      expect(DELEGATION_CRITERIA).not.toContain(PLACEHOLDER)
      expect(Buffer.byteLength(DELEGATION_CRITERIA)).toBeLessThan(400)
    }),
  )

  it.effect("appears once in the workflow routing text, under the execution mode heading", () =>
    Effect.sync(() => {
      const routing = CommandPlugin.WorkflowContent
      expect(occurrences(routing, DELEGATION_CRITERIA)).toBe(1)
      expect(routing).not.toContain(PLACEHOLDER)
      const heading = routing.indexOf("## Execution mode")
      const criteria = routing.indexOf(DELEGATION_CRITERIA)
      const precedence = routing.indexOf("Explicit user instructions take precedence")
      expect(heading).toBeGreaterThan(-1)
      expect(criteria).toBeGreaterThan(heading)
      expect(precedence).toBeGreaterThan(criteria)
    }),
  )

  it.effect("replaces the earlier per-tier wording in the routing text instead of restating it", () =>
    Effect.sync(() => {
      const routing = CommandPlugin.WorkflowContent
      expect(routing).not.toContain("Choose direct execution")
      expect(routing).not.toContain("Direct execution:")
      expect(routing).not.toContain("One `task` child")
      expect(routing).not.toContain("One `workflow` DAG")
      expect(routing).not.toContain("not a task-category rule")
    }),
  )
})
