// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the reader's service slices are minimal fakes; only the members `read` calls are real.
// #1027 D6b: the session-level DAG mode status reports the review quality of the
// session's workflows, combined, from the same per-workflow computation a
// summary carries.
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { SummaryNodeRow, WorkflowRow } from "@graphagent/core/dag/store"
import { DagModeReader } from "@/dag/mode-read"
import { testEffect } from "../lib/effect"
import { makeWorkflowRow } from "./fixtures"
import { accepted, roundOne, rowsFor, strictConfig, type Outputs } from "./review-fixtures"

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

// The reader works over the service slices it is handed, so no layer is needed.
const it = testEffect(Layer.empty)

const read = (workflows: readonly WorkflowRow[], rows: readonly SummaryNodeRow[]) =>
  DagModeReader.read(deps(workflows, rows), { id: "ses_parent", dagMode: "on" } as never)

describe("session DAG mode quality (#1027 D6b)", () => {
  const config = strictConfig()
  const strict = (id: string) => makeWorkflowRow({ id, config: JSON.stringify(config) })

  it.effect("is null when the session has no workflow with a review", () =>
    Effect.gen(function* () {
      expect((yield* read([], [])).status.quality).toBeNull()
      const standard = { ...config, review_gate: undefined }
      const workflow = makeWorkflowRow({ id: "wf-standard", config: JSON.stringify(standard) })
      expect((yield* read([workflow], nodes("wf-standard", standard, roundOne))).status.quality).toBeNull()
    }),
  )

  it.effect("combines the quality of every strict workflow in the session", () =>
    Effect.gen(function* () {
      const snapshot = yield* read(
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
        // The rejected review has not been quiet for a round; both are quiet only
        // as long as the quietest.
        quietRounds: 0,
        completeness: { covered: 3, total: 4, unlisted: 1 },
      })
    }),
  )
})
