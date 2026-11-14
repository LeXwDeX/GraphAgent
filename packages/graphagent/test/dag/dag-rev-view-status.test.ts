// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Train A probe A-p1 (status-action seam) — workflows/dag-engine-optimization.md,
 * v1.0.15 ledger.
 *
 * The workflow tool's `status` action is one of the view seams the ledger
 * filters to the current revision (evidence §8: workflow.ts status action).
 * The store mock offers BOTH reads: the legacy all-rows read and the
 * current-revision read. Before the feature, status consumes the all-rows
 * read and surfaces superseded replaced segments; after, it consumes the
 * current-revision read only.
 *
 * RED on the unmodified engine: the superseded rows leak into the status
 * output.
 */
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { DagStore } from "@graphagent/core/dag/store"
import { ProjectV2 } from "@graphagent/core/project"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { Event } from "@graphagent/schema/event"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { DagControl } from "@/dag/control"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Skill } from "@/skill"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WorkflowTool } from "@/tool/workflow"
import { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"

const projectID = ProjectV2.ID.make("project_test")

const currentRow = {
  id: "current_a",
  workflowId: "dag_rev_status",
  name: "Current node",
  workerType: "build",
  status: "completed",
  required: true,
  dependsOn: [],
  modelId: null,
  modelProviderId: null,
  childSessionId: null,
  output: "kept",
  capturedOutput: null,
  errorReason: null,
  errorClass: null,
  deadlineMs: null,
  wakeEligible: false,
  wakeReported: false,
  replanAttempts: 0,
  timeoutExtensions: 0,
  escalationPending: false,
  superseded: false,
  seq: 1,
  startedAt: 1,
  completedAt: 2,
  timeCreated: 1,
  timeUpdated: 2,
}
const supersededFail = {
  ...currentRow,
  id: "superseded_c",
  name: "Replaced failure",
  status: "failed",
  errorReason: "simulated exec failure",
  errorClass: "exec_failed",
  output: null,
  startedAt: null,
  completedAt: 3,
  seq: 2,
}
const supersededCancelled = {
  ...currentRow,
  id: "superseded_d",
  name: "Replaced cancelled",
  status: "failed",
  errorReason: "cancelled via replan",
  output: null,
  startedAt: null,
  completedAt: 3,
  seq: 3,
}
const allRows = [currentRow, supersededFail, supersededCancelled]
const currentRows = [currentRow]

// The extra getCurrentNodes property is cast away pre-feature: the probe must
// compile against the baseline interface while offering the post-feature seam.
const storeImpl = {
  getWorkflow: (id: string) =>
    Effect.succeed(
      id === "dag_rev_status"
        ? {
            id,
            projectId: projectID,
            sessionId: "ses_rev_parent",
            directory: process.cwd(),
            targetFingerprint: { kind: "none" } as const,
            title: "Rev status",
            status: "running",
            pauseReason: null,
            config: "{}",
            seq: 3,
            wakeReported: false,
            graphRev: 2,
            startedAt: 1,
            completedAt: null,
            timeCreated: 1,
            timeUpdated: 2,
          }
        : undefined,
    ),
  getNodes: () => Effect.succeed(allRows),
  getCurrentNodes: () => Effect.succeed(currentRows),
  getWorkflowFailureReason: () => Effect.succeed(undefined),
  getLatestRetarget: () => Effect.succeed(undefined),
  getNode: (workflowID: string, nodeID: string) =>
    Effect.succeed(allRows.find((node) => node.workflowId === workflowID && node.id === nodeID)),
}

const dag = Dag.layer.pipe(
  Layer.provide(Layer.mock(DagStore.Service, storeImpl)),
  Layer.provide(Layer.mock(EventV2Bridge.Service, {
    publish: (definition, data) =>
      Effect.succeed({ id: Event.ID.create(), type: definition.type, data }),
  })),
)
const control = DagControl.layer.pipe(Layer.provide(dag))

const runtime = testEffect(
  Layer.mergeAll(
    Layer.mock(Agent.Service, {
      get: () =>
        Effect.succeed({
          name: "build",
          mode: "all",
          permission: [],
          options: {},
          description: "",
          prompt: "",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
          tools: {},
          hooks: {},
        }),
      list: () => Effect.succeed([]),
    }),
    Layer.mock(Skill.Service, { all: () => Effect.succeed([]) }),
    Layer.mock(Truncate.Service, {
      output: (content) => Effect.succeed({ content, truncated: false }),
    }),
    Layer.mock(Question.Service, { ask: () => Effect.succeed([]) }),
    Layer.mock(Provider.Service, {
      list: () => Effect.succeed({}),
      getModel: (providerID, modelID) => Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID })),
    }),
    dag,
    control,
    Layer.mock(Session.Service, {
      get: (id: Parameters<Session.Interface["get"]>[0]) =>
        Effect.succeed({
          id,
          slug: "rev-status",
          projectID,
          directory: process.cwd(),
          parentID: undefined,
          title: "Rev status",
          version: "test",
          time: { created: 0, updated: 0 },
          model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
        } satisfies Session.Info),
    }),
  ),
)

function toolContext() {
  return {
    sessionID: SessionID.make("ses_rev_parent"),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  } satisfies Tool.Context
}

describe("workflow tool status — current-revision filtering (Train A, A-p1 status seam)", () => {
  runtime.effect("status exposes only the current revision; replaced segments stay hidden", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        { params: { action: "inspect", operation: "status", workflow_id: Dag.ID.make("dag_rev_status") } },
        toolContext(),
      )
      expect(result.output).toContain("current_a")
      expect(result.output).not.toContain("superseded_c")
      expect(result.output).not.toContain("superseded_d")
      const ids = [...result.output.matchAll(/"id": "(\w+)"/g)].map((match) => match[1])
      expect(ids).toContain("dag_rev_status")
      expect(ids.filter((id) => id.startsWith("current_") || id.startsWith("superseded_"))).toEqual(["current_a"])
    }),
  )
})
