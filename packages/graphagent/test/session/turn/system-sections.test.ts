// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { DagMode } from "@/dag/mode"
import { RuntimeContext } from "@/session/runtime-context"
import { SYSTEM_SECTIONS } from "@/session/step-metrics"
import { SystemSections } from "@/session/turn/system-sections"

const full = {
  env: ["environment", "references"],
  languageDocs: ["language"],
  instructions: ["instruction one", "instruction two"],
  mcpInstructions: "mcp instructions",
  skills: "skills",
  goal: ["goal note"],
  hooksDocs: ["hooks"],
  dag: true,
}

describe("SystemSections.assemble", () => {
  test("puts every section in prompt order and labels each text with its section", () => {
    const sections = SystemSections.assemble(full)

    expect(sections.system).toEqual([
      "environment",
      "references",
      "language",
      "instruction one",
      "instruction two",
      "mcp instructions",
      "skills",
      "goal note",
      "hooks",
      DagMode.SYSTEM,
      RuntimeContext.SYSTEM_NOTE,
    ])
    expect(sections.labels).toEqual([
      "environment",
      "environment",
      "language",
      "instructions",
      "instructions",
      "mcp_instructions",
      "skills",
      "goal",
      "hooks",
      "dag",
      "runtime_note",
    ])
  })

  test("leaves out the sections that have no text", () => {
    const sections = SystemSections.assemble({
      ...full,
      instructions: [],
      mcpInstructions: undefined,
      skills: undefined,
      hooksDocs: [],
      dag: false,
    })

    expect(sections.system).toEqual(["environment", "references", "language", "goal note", RuntimeContext.SYSTEM_NOTE])
    expect(sections.labels).toEqual(["environment", "environment", "language", "goal", "runtime_note"])
  })

  test("an empty goal input leaves the goal section out", () => {
    const sections = SystemSections.assemble({ ...full, goal: [] })

    expect(sections.labels).not.toContain("goal")
    expect(sections.system).toHaveLength(sections.labels.length)
  })

  test("labels and texts always have the same length and only use registered names", () => {
    for (const input of [full, { ...full, skills: undefined, dag: false }, { ...full, env: [], goal: [] }]) {
      const sections = SystemSections.assemble(input)
      expect(sections.labels).toHaveLength(sections.system.length)
      for (const label of sections.labels) expect(SYSTEM_SECTIONS).toContain(label)
    }
  })
})

describe("SystemSections.append", () => {
  test("pushes the texts and one label for each of them", () => {
    const sections = SystemSections.assemble(full)
    const before = sections.system.length

    SystemSections.append(sections, "structured_output", "structured")
    SystemSections.append(sections, "one_shot_event", "first event", "second event")

    expect(sections.system.slice(before)).toEqual(["structured", "first event", "second event"])
    expect(sections.labels.slice(before)).toEqual(["structured_output", "one_shot_event", "one_shot_event"])
    expect(sections.labels).toHaveLength(sections.system.length)
  })

  test("appending nothing changes nothing", () => {
    const sections = SystemSections.assemble(full)
    const system = [...sections.system]
    const labels = [...sections.labels]

    SystemSections.append(sections, "one_shot_event")

    expect(sections.system).toEqual(system)
    expect(sections.labels).toEqual(labels)
  })

  test("grows the same text array the request carries", () => {
    const sections = SystemSections.assemble(full)
    const system = sections.system

    SystemSections.append(sections, "one_shot_event", "event")

    expect(system).toBe(sections.system)
    expect(system.at(-1)).toBe("event")
  })
})
