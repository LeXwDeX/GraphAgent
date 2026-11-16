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
import { HOOK_BINDINGS, bindingOf, sourceName, type HookBinding } from "@/hook/bindings"
import { eventTypes, sources, unknownNames } from "../lib/hook-sources"

/**
 * Issue #1070: the trigger binding table. Each hook event names the one source
 * it derives from (a lifecycle value or an owner event), whether the owner
 * consumes the hook result, and the files that fire it. The tests pin the table
 * against the event union, the lifecycle vocabulary, the event definitions and
 * the source tree, so none of them can drift from the code unnoticed.
 */

// Domains whose transition rules are registered with the lifecycle service
// (`src/lifecycle/service.ts`). A source into one of them must be reachable.
const TABLES: Partial<Record<Domain, TransitionTable>> = {
  turn: TURN_TRANSITION_TABLE,
  job: JOB_TRANSITION_TABLE,
  goal: GOAL_TRANSITION_TABLE,
  pr_watch: PR_WATCH_TRANSITION_TABLE,
  workflow: WORKFLOW_TRANSITION_TABLE,
  node: NODE_TRANSITION_TABLE,
}

const entries: [string, HookBinding][] = Object.entries(HOOK_BINDINGS)
const ofKind = (kind: HookBinding["source"]["kind"]) => entries.filter(([, binding]) => binding.source.kind === kind)

// The events nothing announces: no owner event or vocabulary value covers the
// occurrence the hook fires on (the reasons are in the table). This is a ratchet:
// an event leaves the list when its source becomes a lifecycle value or an owner
// event; nothing is added.
const UNBOUND = ["ConfigChange", "DirectoryAdded", "FileChanged", "InstructionsLoaded", "Notification", "Setup"]

// Payload declarations, and the lines that name an event without firing it:
// the payload union itself, a type that narrows to a payload, and the stop policy.
const DECLARATION = "graphagent/src/hook/types.ts"
const NOT_A_PAYLOAD = /Extract<HookPayload|stopPolicy:/

function firedBy(event: string): string[] {
  const literal = `event: "${event}"`
  return [...sources]
    .filter(
      ([file, text]) =>
        file !== DECLARATION && text.split("\n").some((line) => line.includes(literal) && !NOT_A_PAYLOAD.test(line)),
    )
    .map(([file]) => file)
    .toSorted()
}

describe("hook trigger binding table", () => {
  test("binds exactly the hook events the engine accepts", () => {
    expect(Object.keys(HOOK_BINDINGS).toSorted()).toEqual([...VALID_HOOK_EVENTS].toSorted())
  })

  test("gives each event one source and the fields the contract needs", () => {
    for (const [event, binding] of entries) {
      expect(Object.keys(binding).toSorted(), event).toEqual(["gating", "once", "sites", "source", "when"])
      expect(["lifecycle", "ownerEvent", "unbound"], event).toContain(binding.source.kind)
      expect(typeof binding.gating, event).toBe("boolean")
      expect(binding.sites.length, event).toBeGreaterThan(0)
      expect(binding.when.trim().length, event).toBeGreaterThan(0)
      expect(binding.once.trim().length, event).toBeGreaterThan(0)
    }
    // The lookup helper reads the same table.
    expect(bindingOf("Stop")).toBe(HOOK_BINDINGS.Stop)
    expect(sourceName(HOOK_BINDINGS.PreToolUse)).toBe("tool.running")
    expect(sourceName(HOOK_BINDINGS.SessionEnd)).toBe("session.deleted")
    expect(sourceName(HOOK_BINDINGS.Setup)).toBe("unbound")
  })

  test("a lifecycle source names a value of the shared vocabulary", () => {
    const bound = ofKind("lifecycle")
    expect(bound.length).toBeGreaterThan(0)
    for (const [event, binding] of bound) {
      if (binding.source.kind !== "lifecycle") throw new Error(`${event} is not a lifecycle source`)
      const { domain, to } = binding.source
      expect(DOMAINS as readonly string[], event).toContain(domain)
      expect(valuesOf(domain), `${event}: ${domain} has no value ${to}`).toContain(to)
      // `turn` + `ended` is the one value without a phase of its own: the turn
      // outcome decides it.
      const unphased = domain === "turn" && to === "ended"
      expect(phaseOf(domain, to) !== undefined || unphased, event).toBe(true)
    }
  })

  test("a lifecycle source is reachable through its domain's transition table", () => {
    for (const [event, binding] of ofKind("lifecycle")) {
      if (binding.source.kind !== "lifecycle") throw new Error(`${event} is not a lifecycle source`)
      const { domain, to } = binding.source
      const table = TABLES[domain]
      // `tool` has no registered table: its states live on the durable tool part.
      if (!table) continue
      const reachable = [null, ...valuesOf(domain)].some((from) => table.next(from).includes(to))
      expect(reachable, `${event}: ${domain} cannot reach ${to}`).toBe(true)
    }
  })

  test("an owner event source names a defined event", () => {
    const owned = ofKind("ownerEvent")
    expect(owned.length).toBeGreaterThan(0)
    for (const [event, binding] of owned) {
      if (binding.source.kind !== "ownerEvent") throw new Error(`${event} is not an owner event source`)
      expect(eventTypes.has(binding.source.event), `${event}: ${binding.source.event} is not a defined event`).toBe(
        true,
      )
    }
  })

  test("the unbound events are a ratchet that may only shrink", () => {
    const unbound = ofKind("unbound")
    for (const [event, binding] of unbound) {
      if (binding.source.kind !== "unbound") throw new Error(`${event} is not an unbound source`)
      expect(binding.source.reason.trim().length, event).toBeGreaterThan(0)
    }
    expect(unbound.map(([event]) => event).toSorted()).toEqual(UNBOUND.toSorted())
    // Every event has exactly one kind of source.
    expect(ofKind("lifecycle").length + ofKind("ownerEvent").length + unbound.length).toBe(VALID_HOOK_EVENTS.size)
  })

  test("the sites are exactly the files that build each event's payload", () => {
    for (const [event, binding] of entries) {
      const sites = binding.sites.toSorted()
      expect(sites, `${event}: sites must be listed once`).toEqual([...new Set(sites)])
      for (const site of sites) expect(sources.has(site), `${event}: ${site} is not a source file`).toBe(true)
      expect(firedBy(event), `${event}: trigger sites drifted from the table`).toEqual(sites)
    }
  })

  test("the symbols and events the table text names still exist", () => {
    for (const [event, binding] of entries) {
      const text = [binding.when, binding.once, binding.source.kind === "unbound" ? binding.source.reason : ""]
      expect(unknownNames(text.join("\n")), event).toEqual([])
    }
  })

  test("the sources the tool and turn events use are the vocabulary values the owners use", () => {
    expect(HOOK_BINDINGS.PreToolUse.source).toEqual({ kind: "lifecycle", domain: "tool", to: "running" })
    expect(HOOK_BINDINGS.PostToolUse.source).toEqual({ kind: "lifecycle", domain: "tool", to: "completed" })
    expect(HOOK_BINDINGS.PostToolUseFailure.source).toEqual({ kind: "lifecycle", domain: "tool", to: "error" })
    for (const event of ["Stop", "StopFailure", "SubagentStop"] as const)
      expect(HOOK_BINDINGS[event].source, event).toEqual({ kind: "lifecycle", domain: "turn", to: "ended" })
  })

  test("an event that only observes is not gating", () => {
    const observing = entries.filter(([, binding]) => !binding.gating).map(([event]) => event)
    expect(observing.toSorted()).toEqual([
      "DirectoryAdded",
      "InstructionsLoaded",
      "Notification",
      "PostCompact",
      "SessionEnd",
      "Setup",
      "StopFailure",
    ])
  })
})
