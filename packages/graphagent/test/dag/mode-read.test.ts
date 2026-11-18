// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the reader's service slices are minimal fakes; only the members `read` calls are real.
// #1027 D6b: the session-level DAG mode status reports the review quality of the
// session's workflows, combined, from the same per-workflow computation a
// summary carries.
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { SummaryNodeRow, WorkflowRow } from "@graphagent/core/dag/store"
import type { ConfigV1 } from "@graphagent/core/v1/config/config"
import { DEFAULT_USER_MAX_TOTAL_NODES } from "@/dag/dag"
import { DagModeReader } from "@/dag/mode-read"
import { AgentScheduler } from "@/session/agent-scheduler"
import { DEFAULT_LIMITS, makeState } from "@/session/agent-scheduler-state"
import { TestConfig } from "../fixture/config"
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

// #1290: the limits the endpoint reports come from the scheduler's own DAG layer
// and the user's node cap, never from a default of the read's own, and every
// limit carries the configured value next to the one in force.
describe("session DAG mode limits (#1290)", () => {
  /**
   * The read over the live scheduler wiring: the scheduler resolves its limits
   * from the same configuration the read is handed, as the process pool does.
   */
  const limitsFor = (input: { readonly dag?: ConfigV1.Info["dag"]; readonly engine?: ConfigV1.Info["engine"] } = {}) =>
    Effect.gen(function* () {
      const config = TestConfig.make({
        dagGlobal: () => Effect.succeed(input.dag ?? {}),
        getGlobal: () => Effect.succeed(input.engine ? { engine: input.engine } : {}),
      })
      const scheduler = AgentScheduler.make(makeState(), () => AgentScheduler.limitsFrom(config))
      const snapshot = yield* DagModeReader.read({ ...deps([], []), config, scheduler }, {
        id: "ses_parent",
        dagMode: "on",
      } as never)
      return { snapshot, capacity: yield* scheduler.capacity() }
    })

  it.effect("an unset dag.concurrency reports the scheduler's DAG layer, with no configured value", () =>
    Effect.gen(function* () {
      const { snapshot, capacity } = yield* limitsFor()
      const limits = snapshot.status.limits
      expect(limits.concurrency).toBe(capacity.children.dagCap)
      expect(limits.concurrency).toBe(DEFAULT_LIMITS.dagConcurrency)
      expect(limits.configuredConcurrency).toBeNull()
      // The receipt's cap is the same read.
      expect(snapshot.cap).toBe(limits.concurrency)
    }),
  )

  it.effect(
    "a configured dag.concurrency inside the child pool is both the value in force and the configured one",
    () =>
      Effect.gen(function* () {
        const { snapshot, capacity } = yield* limitsFor({ dag: { concurrency: 3 } })
        expect(snapshot.status.limits.concurrency).toBe(3)
        expect(snapshot.status.limits.concurrency).toBe(capacity.children.dagCap)
        expect(snapshot.status.limits.configuredConcurrency).toBe(3)
      }),
  )

  it.effect("a dag.concurrency above the child pool reports both the configured value and the cut one", () =>
    Effect.gen(function* () {
      const { snapshot, capacity } = yield* limitsFor({ dag: { concurrency: 30 } })
      const pool = DEFAULT_LIMITS.childGlobal - DEFAULT_LIMITS.taskReserve
      expect(snapshot.status.limits.configuredConcurrency).toBe(30)
      expect(snapshot.status.limits.concurrency).toBe(pool)
      expect(snapshot.status.limits.concurrency).toBe(capacity.children.dagCap)
      expect(snapshot.cap).toBe(pool)
    }),
  )

  it.effect("a small child pool cuts even the unset default, and the read follows the scheduler", () =>
    Effect.gen(function* () {
      const { snapshot, capacity } = yield* limitsFor({ engine: { concurrency: { childGlobal: 5, taskReserve: 2 } } })
      expect(capacity.children.dagCap).toBe(3)
      expect(snapshot.status.limits.concurrency).toBe(capacity.children.dagCap)
      expect(snapshot.status.limits.configuredConcurrency).toBeNull()
    }),
  )

  it.effect("an unset dag.max_total_nodes reports the user's default node cap, with no configured value", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* limitsFor()
      expect(snapshot.status.limits.maxTotalNodes).toBe(100)
      expect(snapshot.status.limits.maxTotalNodes).toBe(DEFAULT_USER_MAX_TOTAL_NODES)
      expect(snapshot.status.limits.configuredMaxTotalNodes).toBeNull()
    }),
  )

  it.effect("a configured dag.max_total_nodes is both the cap in force and the configured one", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* limitsFor({ dag: { max_total_nodes: 40 } })
      expect(snapshot.status.limits.maxTotalNodes).toBe(40)
      expect(snapshot.status.limits.configuredMaxTotalNodes).toBe(40)
    }),
  )
})
