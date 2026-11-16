// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the reader's service slices are minimal fakes; only the members `read` calls are real.
// #1027 D6b: the session-level DAG mode status reports the review quality of the
// session's workflows, combined, from the same per-workflow computation a
// summary carries.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { SummaryNodeRow, WorkflowRow } from "@graphagent/core/dag/store"
import { DagModeReader } from "@/dag/mode-read"
import { makeWorkflowRow } from "./fixtures"
import { roundOne, rowsFor, strictConfig, type Outputs } from "./review-fixtures"

const nodes = (workflowId: string, config: ReturnType<typeof strictConfig>, outputs: Outputs): SummaryNodeRow[] =>
  rowsFor(config, outputs).map((row) => ({
    id: row.id,
    workflowId,
    status: row.status,
    dependsOn: row.dependsOn,
    errorReason: null,
    errorClass: null,
    safetyDenials: null,
    staleTarget: null,
    superseded: false as const,
    output: row.output,
  }))

function deps(workflows: readonly WorkflowRow[], rows: readonly SummaryNodeRow[]): DagModeReader.Deps {
  return {
    sessions: {},
    agents: {
      defaultInfo: () => Effect.fail(new Error("no default agent")),
      get: () => Effect.die("unused"),
      list: () => Effect.succeed([]),
      permissionPolicy: () => Effect.die("unused"),
    },
    providers: {
      defaultModel: () => Effect.fail(new Error("no default model")),
      getModel: () => Effect.die("unused"),
    },
    config: {
      dagGlobal: () => Effect.succeed({}),
      get: () => Effect.succeed({}),
    },
    dagStore: {
      getWorkflowSummaries: () => Effect.succeed([]),
      listBySession: () => Effect.succeed([...workflows]),
      getSummaryNodes: (input: { readonly workflowIds: readonly string[] }) =>
        Effect.succeed(rows.filter((row) => input.workflowIds.includes(row.workflowId))),
    },
    scheduler: {
      capacity: () => Effect.succeed({ children: { dagRunning: 0, dagCap: 12 } }),
    },
  } as never
}

const read = (workflows: readonly WorkflowRow[], rows: readonly SummaryNodeRow[]) =>
  Effect.runPromise(DagModeReader.read(deps(workflows, rows), { id: "ses_parent", dagMode: "on" } as never))

describe("session DAG mode quality (#1027 D6b)", () => {
  const config = strictConfig()
  const strict = (id: string) => makeWorkflowRow({ id, config: JSON.stringify(config) })

  test("is null when the session has no workflow with a review", async () => {
    expect((await read([], [])).status.quality).toBeNull()
    const standard = { ...config, review_gate: undefined }
    const workflow = makeWorkflowRow({ id: "wf-standard", config: JSON.stringify(standard) })
    expect((await read([workflow], nodes("wf-standard", standard, roundOne))).status.quality).toBeNull()
  })

  test("combines the quality of every strict workflow in the session", async () => {
    const accepted: Outputs = {
      implementation: roundOne.implementation,
      verification: roundOne.verification,
      "decision--standards": { output: { verdict: "ACCEPT", required_actions: [] } },
      "decision--intent": { output: { verdict: "ACCEPT", required_actions: [] } },
      "decision--completeness": {
        output: {
          verdict: "ACCEPT",
          required_actions: [],
          acceptance: [
            { id: "AC1", status: "covered", evidence: "seen" },
            { id: "AC2", status: "covered", evidence: "seen" },
          ],
          unlisted: [],
        },
      },
      "decision--skeptic-1": { output: { verdict: "ACCEPT", required_actions: [] } },
      decision: {
        output: {
          verdict: "ACCEPT",
          implementation_fingerprint: "fp-1",
          required_actions: [],
          dispositions: [],
          resolved: [],
        },
      },
    }
    const snapshot = await read(
      [strict("wf-rejected"), strict("wf-accepted")],
      [...nodes("wf-rejected", config, roundOne), ...nodes("wf-accepted", config, accepted)],
    )
    expect(snapshot.status.quality).toEqual({
      reviewBound: true,
      reviews: 2,
      raised: 5,
      fixed: 0,
      refuted: 1,
      stillOpen: 0,
      skepticRefutations: 1,
      rounds: 2,
      quietRounds: 1,
      completeness: { covered: 3, total: 4, unlisted: 1 },
    })
  })
})
