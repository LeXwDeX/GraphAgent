// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- The denied path
// returns before any Dag/authoring/tool-context use; the stubs keep the unit
// focused on the M5 pre-gate rather than re-building the full workflow tool.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Project } from "@graphagent/core/project"
import { BudgetExhaustedError } from "@/dag/budget"
import { runWorkflow } from "@/tool/workflow/run"

describe("workflow start budget pre-gate", () => {
  test("rejects a start while the session budget is exhausted, before authoring", async () => {
    let authoringCalls = 0
    const context = {
      dag: {} as Parameters<typeof runWorkflow>[0]["dag"],
      control: {} as Parameters<typeof runWorkflow>[0]["control"],
      budget: {
        check: () =>
          Effect.fail(
            new BudgetExhaustedError({ sessionID: "ses_budget_start", used: 1200, budget: 1000 }),
          ),
      },
      authoring: {
        prepare: () => {
          authoringCalls++
          return Effect.die(new Error("authoring must not run past a budget veto"))
        },
      } as unknown as Parameters<typeof runWorkflow>[0]["authoring"],
      sessionID: "ses_budget_start",
      session: { directory: process.cwd(), projectID: Project.ID.global, model: undefined },
      ctx: {} as Parameters<typeof runWorkflow>[0]["ctx"],
    }
    const result = await Effect.runPromise(
      runWorkflow(context, { operation: "start", spec_path: "unused.yaml" } as Parameters<typeof runWorkflow>[1]),
    )
    expect(authoringCalls).toBe(0)
    expect(result.title).toBe("Workflow not started: DAG token budget exhausted")
    expect(result.metadata?.blocked).toBe(true)
    const output = JSON.parse(result.output) as { workflow_created: boolean; error_code: string }
    expect(output.workflow_created).toBe(false)
    expect(output.error_code).toBe("budget_exhausted")
  })
})