// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { DagMode } from "@/dag/mode"
import { RuntimeContext } from "../runtime-context"
import type { SystemSection } from "../step-metrics"

/**
 * The system texts of one turn request with the section each one belongs to (Issue #1458). `labels[i]` is the
 * section of `system[i]`; the step log uses it to name the section that moved when the system prompt changes.
 */
export type Sections = {
  readonly system: string[]
  readonly labels: SystemSection[]
}

export interface AssembleInput {
  readonly env: readonly string[]
  readonly languageDocs: readonly string[]
  /** One text per instruction file. */
  readonly instructions: readonly string[]
  readonly mcpInstructions: string | undefined
  readonly skills: string | undefined
  /** The goal note; a child session passes none. */
  readonly goal: readonly string[]
  readonly hooksDocs: readonly string[]
  /** The DAG mechanism text is part of the prompt only while the turn advertises the workflow tool. */
  readonly dag: boolean
}

/** Add `texts` to a request's system prompt under one section name, with one label for each text. */
export function append(sections: Sections, label: SystemSection, ...texts: readonly string[]): void {
  for (const text of texts) {
    sections.system.push(text)
    sections.labels.push(label)
  }
}

/**
 * The system prompt of a turn request in prompt order. Sections without text are left out. The request's one-shot
 * additions (structured output, one-shot events) follow later through `append`.
 */
export function assemble(input: AssembleInput): Sections {
  const sections: Sections = { system: [], labels: [] }
  append(sections, "environment", ...input.env)
  append(sections, "language", ...input.languageDocs)
  append(sections, "instructions", ...input.instructions)
  if (input.mcpInstructions) append(sections, "mcp_instructions", input.mcpInstructions)
  if (input.skills) append(sections, "skills", input.skills)
  append(sections, "goal", ...input.goal)
  append(sections, "hooks", ...input.hooksDocs)
  if (input.dag) append(sections, "dag", DagMode.SYSTEM)
  append(sections, "runtime_note", RuntimeContext.SYSTEM_NOTE)
  return sections
}

export * as SystemSections from "./system-sections"
