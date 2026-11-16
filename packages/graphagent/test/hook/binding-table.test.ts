// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { NODE_TRANSITION_TABLE, WORKFLOW_TRANSITION_TABLE } from "@graphagent/core/lifecycle/dag"
import {
  GOAL_TRANSITION_TABLE,
  JOB_TRANSITION_TABLE,
  PR_WATCH_TRANSITION_TABLE,
  TURN_TRANSITION_TABLE,
  type TransitionTable,
} from "@graphagent/core/lifecycle/transition"
import { phaseOf, valuesOf } from "@graphagent/core/lifecycle/vocabulary"
import { DOMAINS, type Domain } from "@graphagent/schema/lifecycle-status"
import { VALID_HOOK_EVENTS } from "@/hook"
import { HOOK_BINDINGS, bindingOf, type HookTransition } from "@/hook/bindings"

/**
 * Issue #1070, step 1: the trigger binding table. Each hook event names the one
 * canonical transition it derives from, and the table covers every event the
 * engine accepts. The dispatcher that consumes the table is a later step.
 */

// Domains whose transition rules are registered with the lifecycle service
// (`src/lifecycle/service.ts`). A binding into one of them must be reachable.
const TABLES: Partial<Record<Domain, TransitionTable>> = {
  turn: TURN_TRANSITION_TABLE,
  job: JOB_TRANSITION_TABLE,
  goal: GOAL_TRANSITION_TABLE,
  pr_watch: PR_WATCH_TRANSITION_TABLE,
  workflow: WORKFLOW_TRANSITION_TABLE,
  node: NODE_TRANSITION_TABLE,
}

const entries = Object.entries(HOOK_BINDINGS)
const transitions = (kind: HookTransition["kind"]) =>
  entries.flatMap(([event, binding]) =>
    binding.transition.kind === kind ? [[event, binding.transition] as const] : [],
  )

// The events no canonical transition names yet, because the #1069 vocabulary has
// no domain for the point where the owner fires them. This is a ratchet: an event
// leaves the list when its binding becomes a `lifecycle` one; nothing is added.
const UNBOUND = [
  "CwdChanged",
  "DirectoryAdded",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "FileChanged",
  "InstructionsLoaded",
  "MessageDisplay",
  "Notification",
  "PermissionRequest",
  "PostCompact",
  "PostModelSwitch",
  "PostToolBatch",
  "PreCompact",
  "PreModelSwitch",
  "SessionEnd",
  "SessionStart",
  "Setup",
  "SubagentStart",
  "SubagentStop",
  "TaskCompleted",
  "TaskCreated",
  "UserPromptExpansion",
  "UserPromptSubmit",
  "WorktreeCreate",
  "WorktreeRemove",
].toSorted()

describe("hook trigger binding table", () => {
  test("binds exactly the hook events the engine accepts", () => {
    expect(Object.keys(HOOK_BINDINGS).toSorted()).toEqual([...VALID_HOOK_EVENTS].toSorted())
  })

  test("gives each event one transition of a known kind", () => {
    for (const [event, binding] of entries) {
      expect(Object.keys(binding), event).toEqual(["transition"])
      expect(["lifecycle", "unbound"], event).toContain(binding.transition.kind)
    }
    // The lookup helper reads the same table.
    expect(bindingOf("Stop")).toBe(HOOK_BINDINGS.Stop)
  })

  test("a lifecycle binding names a value of the shared vocabulary", () => {
    const bound = transitions("lifecycle")
    expect(bound.length).toBeGreaterThan(0)
    for (const [event, transition] of bound) {
      if (transition.kind !== "lifecycle") throw new Error(`${event} is not a lifecycle binding`)
      expect(DOMAINS as readonly string[], event).toContain(transition.domain)
      expect(valuesOf(transition.domain), `${event}: ${transition.domain} has no value ${transition.to}`).toContain(
        transition.to,
      )
      // `turn` + `ended` is the one value without a phase of its own: the turn
      // outcome decides it.
      const unphased = transition.domain === "turn" && transition.to === "ended"
      expect(phaseOf(transition.domain, transition.to) !== undefined || unphased, event).toBe(true)
      expect(transition.when.trim().length, event).toBeGreaterThan(0)
    }
  })

  test("a lifecycle binding is reachable through its domain's transition table", () => {
    for (const [event, transition] of transitions("lifecycle")) {
      if (transition.kind !== "lifecycle") throw new Error(`${event} is not a lifecycle binding`)
      const table = TABLES[transition.domain]
      // `tool` has no registered table: its states live on the durable tool part.
      if (!table) continue
      const reachable = [null, ...valuesOf(transition.domain)].some((from) => table.next(from).includes(transition.to))
      expect(reachable, `${event}: ${transition.domain} cannot reach ${transition.to}`).toBe(true)
    }
  })

  test("the unbound events are a ratchet that may only shrink", () => {
    const unbound = transitions("unbound")
    for (const [event, transition] of unbound) {
      if (transition.kind !== "unbound") throw new Error(`${event} is not an unbound binding`)
      expect(transition.reason.trim().length, event).toBeGreaterThan(0)
    }
    expect(unbound.map(([event]) => event).toSorted()).toEqual(UNBOUND)
    // Bound plus unbound is the whole table.
    expect(transitions("lifecycle").length + unbound.length).toBe(VALID_HOOK_EVENTS.size)
  })

  test("the tool and turn events bind to the vocabulary values the owners use", () => {
    expect(HOOK_BINDINGS.PreToolUse.transition).toMatchObject({ kind: "lifecycle", domain: "tool", to: "running" })
    expect(HOOK_BINDINGS.PostToolUse.transition).toMatchObject({ kind: "lifecycle", domain: "tool", to: "completed" })
    expect(HOOK_BINDINGS.PostToolUseFailure.transition).toMatchObject({
      kind: "lifecycle",
      domain: "tool",
      to: "error",
    })
    expect(HOOK_BINDINGS.Stop.transition).toMatchObject({ kind: "lifecycle", domain: "turn", to: "ended" })
    expect(HOOK_BINDINGS.StopFailure.transition).toMatchObject({ kind: "lifecycle", domain: "turn", to: "ended" })
  })
})
