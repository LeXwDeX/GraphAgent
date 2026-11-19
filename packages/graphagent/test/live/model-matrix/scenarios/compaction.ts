// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The compaction scenarios: what a summary of the session keeps. The session is made of user messages the scripted
 * model answers with `noted`, and then the model under test is asked to summarize it (`setup` in `Scenario`). The
 * judge reads the summary for the facts the messages gave: a constraint, the paths and the error that were named,
 * the items still open. What the summary is made of, which model wrote it, does not matter to the scenario.
 *
 * The replay script's summary follows the structure the compaction asks for (`SUMMARY_TEMPLATE` in
 * `core/src/session/compaction-prompt.ts`), so a check of that structure before the summary is stored accepts it.
 */

import { summaryHas } from "../judge"
import type { Reply, Scenario } from "../types"
import { say } from "./kit"

/** What each section of the summary says; a section left out says `(none)`, as the template allows. */
interface Sections {
  readonly goal: string
  readonly constraints?: readonly string[]
  readonly done?: readonly string[]
  readonly inProgress?: readonly string[]
  readonly blocked?: readonly string[]
  readonly decisions?: readonly string[]
  readonly next?: readonly string[]
  readonly context?: readonly string[]
  readonly files?: readonly string[]
}

const bullets = (items: readonly string[] | undefined): string =>
  (items === undefined || items.length === 0 ? ["(none)"] : items).map((item) => `- ${item}`).join("\n")

/** A summary in the structure of `SUMMARY_TEMPLATE`: every section, in order, each with at least one bullet. */
function summaryText(sections: Sections): string {
  return [
    `## Goal\n${bullets([sections.goal])}`,
    `## Constraints & Preferences\n${bullets(sections.constraints)}`,
    `## Progress\n### Done\n${bullets(sections.done)}\n\n### In Progress\n${bullets(sections.inProgress)}\n\n### Blocked\n${bullets(sections.blocked)}`,
    `## Key Decisions\n${bullets(sections.decisions)}`,
    `## Next Steps\n${bullets(sections.next)}`,
    `## Critical Context\n${bullets(sections.context)}`,
    `## Relevant Files\n${bullets(sections.files)}`,
  ].join("\n\n")
}

/** The scripted model answers every setup message `noted`, and then writes the summary when it is asked to. */
const script = (setup: readonly string[], summary: string): readonly Reply[] => [
  ...setup.map(() => say("noted")),
  say(summary),
]

/** A compaction scenario: the messages, the facts the summary has to keep, and the summary the replay tier writes. */
function scenario(input: {
  readonly id: string
  readonly setup: readonly string[]
  readonly facts: readonly string[]
  readonly summary: Sections
}): Scenario {
  return {
    id: input.id,
    files: {},
    prompt: "",
    setup: input.setup,
    scripts: { default: { replies: script(input.setup, summaryText(input.summary)) } },
    judge: (run) => summaryHas(run, input.facts),
  }
}

export const COMPACTION_SCENARIOS: readonly Scenario[] = [
  scenario({
    id: "compaction.constraint",
    setup: [
      'Rule LEGACY-FREEZE: do not modify anything under src/legacy/. Reply "noted".',
      'We are moving billing code into src/billing/. Reply "noted".',
    ],
    facts: ["LEGACY-FREEZE", "src/legacy/", "src/billing/"],
    summary: {
      goal: "Move the billing code into src/billing/ without touching src/legacy/.",
      constraints: ["Rule LEGACY-FREEZE: do not modify anything under src/legacy/."],
      inProgress: ["Moving billing code into src/billing/."],
      next: ["Continue the move into src/billing/ and leave src/legacy/ as it is."],
      context: ["LEGACY-FREEZE covers everything under src/legacy/."],
      files: ["src/billing/: where the billing code is moving to", "src/legacy/: frozen by LEGACY-FREEZE"],
    },
  }),
  scenario({
    id: "compaction.paths",
    setup: [
      'I edited src/billing/invoice.ts and src/billing/tax.ts. Reply "noted".',
      "The test run failed in test/tax.test.ts with: TypeError: Cannot read properties of undefined (reading 'rate'). " +
        'Reply "noted".',
    ],
    facts: [
      "src/billing/invoice.ts",
      "src/billing/tax.ts",
      "test/tax.test.ts",
      "Cannot read properties of undefined (reading 'rate')",
    ],
    summary: {
      goal: "Fix the failing tax test after the edits to the billing code.",
      done: ["Edited src/billing/invoice.ts and src/billing/tax.ts."],
      inProgress: ["Finding why test/tax.test.ts fails."],
      blocked: ["test/tax.test.ts fails."],
      next: ["Find where the tax rate is read from an undefined value and fix it."],
      context: ["test/tax.test.ts fails with TypeError: Cannot read properties of undefined (reading 'rate')."],
      files: ["src/billing/invoice.ts: edited", "src/billing/tax.ts: edited", "test/tax.test.ts: the failing test"],
    },
  }),
  scenario({
    id: "compaction.todo",
    setup: [
      'Open item 1: add retry to the uploader. Reply "noted".',
      'Open item 2: write the migration notes. Reply "noted".',
    ],
    facts: ["add retry to the uploader", "write the migration notes"],
    summary: {
      goal: "Finish the two open items.",
      inProgress: ["Open item 1: add retry to the uploader.", "Open item 2: write the migration notes."],
      next: ["Add retry to the uploader.", "Write the migration notes."],
    },
  }),
]
