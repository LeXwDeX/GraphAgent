// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { logLines } from "effect/testing/TestConsole"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Dag } from "@/dag/dag"
import { DagControl } from "@/dag/control"
import { DagValidation } from "@/dag/validation"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { DagStore } from "@graphagent/core/dag/store"
import { DagEvent } from "@graphagent/schema/dag-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Parameters, WorkflowTool } from "@/tool/workflow"
import { workflowArtifactsRoot, workflowDraftsArea } from "@/dag/runtime/output-ref"
import { schemaFailures } from "@/tool/schema-error"
import { testEffect } from "../lib/effect"
import { fingerprintBrief, type State } from "@/dag/admission"
import { ModelV2 } from "@graphagent/core/model"
import { ProjectV2 } from "@graphagent/core/project"
import { ProviderV2 } from "@graphagent/core/provider"
import { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"
import { makeNodeRow } from "./fixtures"
import { tmpdirScoped } from "../fixture/fixture"
import { Permission } from "@/permission"

const projectID = ProjectV2.ID.make("project_test")
let workflowSpecDirectory = ""

beforeAll(async () => {
  workflowSpecDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-spec-"))
  // Drafts now live in the project-scoped XDG area, which is stable across
  // processes; start each run from an empty area like the old temp directory.
  await fs.rm(workflowDraftsArea(projectID), { recursive: true, force: true })
})

afterAll(async () => {
  await fs.rm(workflowSpecDirectory, { recursive: true, force: true })
  await fs.rm(workflowDraftsArea(projectID), { recursive: true, force: true })
})

const admissionBrief = {
  goal: "Qualify and execute a deep workflow",
  scope: {
    in: ["workflow start", "review lifecycle"],
    out: ["new admission UI"],
  },
  constraints: ["standard workflows stay compatible"],
  assumptions: ["the parent session can ask questions"],
  acceptance_criteria: ["deep start requires READY or WAIVED"],
  evidence_required: ["unit tests", "integration tests"],
  risks: ["waiver misuse"],
  review_plan: ["verify", "review the implementation diff"],
  open_questions: [],
  blocking_questions: [],
}

function admissionFor(verdict: "READY" | "NOT_READY" | "WAIVED", state: State = verdict) {
  const brief =
    verdict === "READY"
      ? admissionBrief
      : {
          ...admissionBrief,
          blocking_questions: ["Confirm the production rollout target"],
        }
  return {
    protocol_version: 1,
    brief_revision: 1,
    qa_mode: "STANDARD" as const,
    verdict,
    state,
    fingerprint: fingerprintBrief(brief),
    brief,
    ...(verdict === "WAIVED"
      ? {
          waiver_reason: "Preview release only",
          acknowledged_risks: ["Production rollout is unresolved"],
        }
      : {}),
  }
}

function admissionInputFor(verdict: "READY" | "NOT_READY" | "WAIVED") {
  const record = admissionFor(verdict)
  return {
    brief_revision: record.brief_revision,
    qa_mode: record.qa_mode,
    verdict: record.verdict,
    brief: record.brief,
    ...(record.waiver_reason ? { waiver_reason: record.waiver_reason } : {}),
    ...(record.acknowledged_risks ? { acknowledged_risks: record.acknowledged_risks } : {}),
  }
}

const published: Array<{ type: string; data: unknown }> = []
const resultOutput = `${"a".repeat(1_500)}RESULT_SENTINEL${"b".repeat(200)}`
const targetFingerprint = {
  kind: "git" as const,
  head: "0123456789abcdef",
  diff: "diff-hash",
  untracked: "clean",
  value: "target-value",
}
const resultNodes = [
  makeNodeRow({
    id: "node_result",
    workflowId: "dag_result",
    name: "Long result",
    status: "completed",
    output: resultOutput,
    targetFingerprint,
    staleTarget: true,
  }),
  makeNodeRow({
    id: "node_other",
    workflowId: "dag_result",
    name: "Other result",
    status: "completed",
    output: "other",
  }),
]
const mockNodes = (id: string) =>
  id === "dag_finishable"
    ? [
        makeNodeRow({
          id: "node_done",
          workflowId: id,
          name: "Done node",
          status: "completed",
          required: true,
          output: "done",
        }),
      ]
    : id === "dag_status"
      ? [
          {
            id: "node_running",
            workflowId: "dag_status",
            name: "Running node",
            workerType: "build",
            status: "running",
            required: true,
            dependsOn: [],
            modelId: null,
            modelProviderId: null,
            childSessionId: "ses_child",
            directory: "/repo/.worktrees/status",
            baseHead: "0123456789abcdef",
            targetFingerprint,
            worktreeDirectory: "/repo/.worktrees/status-node-running",
            worktreeBranch: "opencode/dag-status-node-running",
            worktreeCommit: "fedcba9876543210",
            worktreeState: "removed",
            worktreeConflictsWith: ["node_failed"],
            // #946: a replaced attempt stays visible after its pointer is
            // overwritten by the current attempt.
            worktreeHistory: [
              {
                directory: "/repo/.worktrees/status-node-retired",
                branch: "opencode/dag-status-node-retired",
                touchedPaths: ["src/retired.ts"],
                state: "kept" as const,
                conflictsWith: [],
              },
            ],
            touchedPaths: ["src/shared.ts"],
            output: null,
            capturedOutput: null,
            errorReason: null,
            errorClass: null,
            deadlineMs: null,
            wakeEligible: true,
            wakeReported: false,
            replanAttempts: 0,
            seq: 1,
            timeoutExtensions: 0,
            escalationPending: false,
            superseded: false,
            startedAt: 1,
            completedAt: null,
            timeCreated: 1,
            timeUpdated: 2,
          },
          {
            id: "node_failed",
            workflowId: "dag_status",
            name: "Failed node",
            workerType: "build",
            status: "failed",
            required: false,
            dependsOn: ["node_running"],
            modelId: null,
            modelProviderId: null,
            childSessionId: "ses_failed_child",
            worktreeDirectory: "/repo/.worktrees/status-node-failed",
            worktreeBranch: "opencode/dag-status-node-failed",
            worktreeCommit: "0123456789abcdef",
            worktreePatchPath: "/repo/.agents/workflow-reports/dag_status/node_failed.patch",
            worktreePatchSha256: "a".repeat(64),
            worktreeState: "kept",
            worktreeConflictsWith: ["node_running"],
            touchedPaths: ["src/shared.ts"],
            output: null,
            capturedOutput: null,
            errorReason: "node exceeded timeout of 600000ms",
            errorClass: "timeout",
            deadlineMs: null,
            wakeEligible: false,
            wakeReported: false,
            replanAttempts: 0,
            seq: 2,
            timeoutExtensions: 0,
            escalationPending: false,
            superseded: false,
            startedAt: 1,
            completedAt: 2,
            timeCreated: 1,
            timeUpdated: 2,
          },
        ]
      : id === "dag_step"
        ? [
            {
              id: "node_ready",
              workflowId: "dag_step",
              name: "Ready node",
              workerType: "build",
              status: "pending",
              required: true,
              dependsOn: [],
              modelId: null,
              modelProviderId: null,
              childSessionId: null,
              output: null,
              capturedOutput: null,
              errorReason: null,
              errorClass: null,
              deadlineMs: null,
              wakeEligible: false,
              wakeReported: false,
              replanAttempts: 0,
              seq: 1,
              timeoutExtensions: 0,
              escalationPending: false,
              superseded: false,
              startedAt: null,
              completedAt: null,
              timeCreated: 1,
              timeUpdated: 1,
            },
          ]
        : id === "dag_paused"
          ? [makeNodeRow({ id: "retry", workflowId: id, name: "Retry", status: "failed", required: true })]
          : id === "dag_retarget"
            ? [
                makeNodeRow({
                  id: "review",
                  workflowId: id,
                  name: "Review",
                  workerType: "review",
                  status: "running",
                  required: true,
                  childSessionId: "ses_review",
                }),
              ]
            : id === "dag_display"
              ? [
                  makeNodeRow({
                    id: "node_cancelled",
                    workflowId: id,
                    name: "Cancelled node",
                    status: "failed",
                    required: false,
                    errorReason: "cancelled via replan",
                    errorClass: "cancelled",
                    superseded: true,
                  }),
                  makeNodeRow({
                    id: "node_escalated",
                    workflowId: id,
                    name: "Escalated node",
                    status: "running",
                    required: true,
                    escalationPending: true,
                    timeoutExtensions: 1,
                  }),
                ]
              : []

const mockWorkflowConfig = (id: string) =>
  JSON.stringify({
    name: id,
    nodes: mockNodes(id).map((node) => ({
      id: node.id,
      name: node.name,
      worker_type: node.workerType,
      depends_on: node.dependsOn,
      required: node.required,
      prompt_template: { inline: node.name },
    })),
  })

const store = Layer.mock(DagStore.Service, {
  getWorkflowFailureReason: (id: string) =>
    Effect.succeed(id === "dag_workspace_failed" ? "workspace_missing: /gone/worktree" : undefined),
  getLatestRetarget: (id: string) =>
    Effect.succeed(
      id === "dag_status"
        ? {
            seq: 9,
            retarget: {
              fromFingerprint: targetFingerprint,
              toFingerprint: targetFingerprint,
              reason: "tree moved",
              nodes: [DagEvent.NodeID.make("node_running")],
            },
          }
        : undefined,
    ),
  getWorkflow: (id: string) =>
    Effect.succeed(
      id === "dag_workspace_failed"
        ? {
            id,
            projectId: projectID,
            sessionId: "ses_workflow_parent",
            title: "Missing workspace",
            directory: "/gone/worktree",
            targetFingerprint: { kind: "none" } as const,
            status: "failed",
            pauseReason: null,
            config: mockWorkflowConfig(id),
            seq: 1,
            wakeReported: false,
            graphRev: 1,
            startedAt: 1,
            completedAt: 2,
            timeCreated: 1,
            timeUpdated: 2,
          }
        : id === "dag_status"
          ? {
              id,
              projectId: projectID,
              sessionId: "ses_workflow_parent",
              title: "Status workflow",
              directory: process.cwd(),
              status: "running",
              config: mockWorkflowConfig(id),
              targetFingerprint,
              pauseReason: null,
              seq: 1,
              wakeReported: false,
              graphRev: 1,
              startedAt: 1,
              completedAt: null,
              timeCreated: 1,
              timeUpdated: 2,
            }
          : id === "dag_result"
            ? {
                id,
                projectId: projectID,
                sessionId: "ses_workflow_parent",
                title: "Result workflow",
                directory: process.cwd(),
                targetFingerprint: { kind: "none" } as const,
                status: "completed",
                pauseReason: null,
                config: mockWorkflowConfig(id),
                seq: 1,
                wakeReported: true,
                graphRev: 1,
                startedAt: 1,
                completedAt: 2,
                timeCreated: 1,
                timeUpdated: 2,
              }
            : id === "dag_paused" ||
                id === "dag_step" ||
                id === "dag_completed" ||
                id === "dag_finishable" ||
                id === "dag_pause_failure" ||
                id === "dag_runtime_failure" ||
                id === "dag_runtime_extend_failure"
              ? {
                  id,
                  projectId: projectID,
                  sessionId: "ses_workflow_parent",
                  title: "Control workflow",
                  directory: process.cwd(),
                  targetFingerprint: { kind: "none" } as const,
                  status: id === "dag_paused" ? "paused" : id === "dag_completed" ? "completed" : "running",
                  pauseReason: null,
                  config: mockWorkflowConfig(id),
                  seq: 1,
                  wakeReported: false,
                  graphRev: 1,
                  startedAt: 1,
                  completedAt: null,
                  timeCreated: 1,
                  timeUpdated: 2,
                }
              : id === "dag_retarget"
                ? {
                    id,
                    projectId: projectID,
                    sessionId: "ses_workflow_parent",
                    title: "Retarget workflow",
                    directory: "/repo",
                    targetFingerprint: { kind: "none" } as const,
                    status: "running",
                    pauseReason: null,
                    config: mockWorkflowConfig(id),
                    graphRev: 1,
                    seq: 1,
                    wakeReported: false,
                    startedAt: 1,
                    completedAt: null,
                    timeCreated: 1,
                    timeUpdated: 2,
                  }
                : id === "dag_deep_status"
                  ? {
                      id,
                      projectId: projectID,
                      sessionId: "ses_workflow_parent",
                      title: "Deep status workflow",
                      directory: process.cwd(),
                      targetFingerprint: { kind: "none" } as const,
                      status: "running",
                      pauseReason: null,
                      config: JSON.stringify({
                        name: "deep-status",
                        mode: "deep",
                        admission: {
                          ...admissionFor("WAIVED"),
                          state: "CONSUMED",
                        },
                        nodes: [],
                      }),
                      seq: 1,
                      wakeReported: false,
                      graphRev: 1,
                      startedAt: 1,
                      completedAt: null,
                      timeCreated: 1,
                      timeUpdated: 2,
                    }
                  : id === "dag_defaults"
                    ? {
                        id,
                        projectId: projectID,
                        sessionId: "ses_workflow_parent",
                        title: "Configured defaults",
                        directory: process.cwd(),
                        targetFingerprint: { kind: "none" } as const,
                        status: "running",
                        pauseReason: null,
                        config: JSON.stringify({
                          name: "configured-defaults",
                          node_defaults: {
                            required: true,
                            report_to_parent: true,
                            worker_config: { timeout_ms: 1234 },
                            model: {
                              providerID: "local-proxy-compatible",
                              modelID: "local-proxy-compatible/glm-5.2",
                            },
                          },
                          max_concurrency: 5,
                          max_node_replan_attempts: 5,
                          max_total_nodes: 100,
                          nodes: [],
                        }),
                        seq: 1,
                        wakeReported: false,
                        graphRev: 1,
                        startedAt: 1,
                        completedAt: null,
                        timeCreated: 1,
                        timeUpdated: 2,
                      }
                    : id === "dag_display"
                      ? {
                          id,
                          projectId: projectID,
                          sessionId: "ses_workflow_parent",
                          title: "Display state workflow",
                          directory: process.cwd(),
                          targetFingerprint: { kind: "none" } as const,
                          status: "paused",
                          pauseReason: "budget_exhausted",
                          config: mockWorkflowConfig(id),
                          seq: 1,
                          wakeReported: false,
                          graphRev: 1,
                          startedAt: 1,
                          completedAt: null,
                          timeCreated: 1,
                          timeUpdated: 2,
                        }
                      : undefined,
    ),
  getNodes: (id: string) =>
    Effect.succeed(
      id === "dag_status"
        ? [
            ...mockNodes(id),
            makeNodeRow({
              id: "node_orphan",
              workflowId: id,
              name: "Orphaned writer",
              status: "failed",
              required: false,
              superseded: true,
              worktreeDirectory: "/repo/.worktrees/status-node-orphan",
              worktreeBranch: "opencode/dag-status-node-orphan",
              worktreeState: "active",
              touchedPaths: ["src/orphan.ts"],
            }),
          ]
        : mockNodes(id),
    ),
  // Rev-view: status reads the current graph revision; the mock offers the
  // same rows (none superseded) so legacy expectations stay intact.
  getCurrentNodes: (id: string) => Effect.succeed(mockNodes(id)),
  getNode: (workflowID: string, nodeID: string) =>
    Effect.succeed(
      resultNodes.find((node) => node.workflowId === workflowID && node.id === nodeID) ??
        mockNodes(workflowID).find((node) => node.id === nodeID) ??
        (workflowID === "dag_status" && nodeID === "node_orphan"
          ? makeNodeRow({
              id: "node_orphan",
              workflowId: workflowID,
              name: "Orphaned writer",
              status: "failed",
              required: false,
              superseded: true,
              worktreeDirectory: "/repo/.worktrees/status-node-orphan",
              worktreeBranch: "opencode/dag-status-node-orphan",
              worktreeState: "active",
              touchedPaths: ["src/orphan.ts"],
            })
          : undefined),
    ),
})
const events = Layer.mock(EventV2Bridge.Service, {
  publishMany: (entries) =>
    Effect.sync(() => {
      if (
        entries.some(
          (entry) =>
            entry.definition.type === DagEvent.WorkflowReplanned.type &&
            typeof entry.data === "object" &&
            entry.data !== null &&
            "dagID" in entry.data &&
            (entry.data.dagID === "dag_runtime_failure" || entry.data.dagID === "dag_runtime_extend_failure"),
        )
      )
        throw new Error("simulated runtime batch write failure")
      for (const entry of entries) published.push({ type: entry.definition.type, data: entry.data })
      return []
    }),
  publish: (definition, data) =>
    Effect.sync(() => {
      if (
        definition.type === DagEvent.WorkflowPaused.type &&
        typeof data === "object" &&
        data !== null &&
        "dagID" in data &&
        data.dagID === "dag_pause_failure"
      )
        throw new Error("simulated durable pause write failure")
      published.push({ type: definition.type, data })
      return { id: "event_test", type: definition.type, data } as never
    }),
})
// Observability for the "tool never bypasses DagControl" test: wrap the real
// Dag instance and the real control service without changing behavior.
const dagCalls: string[] = []
const controlOps: string[] = []
// Test-local overrides for the DagControl service. Reset by each test that sets
// them so the shared runtime layer observes real behavior everywhere else.
let controlApplyOverride: DagControl.Interface["apply"] | undefined
let controlParkOverride: DagControl.Interface["parkRejected"] | undefined

function recordingDagMethod<K extends keyof Dag.Interface>(name: K, method: Dag.Interface[K]): Dag.Interface[K] {
  const inner = method as unknown as (...args: unknown[]) => unknown
  return ((...args: unknown[]) => {
    dagCalls.push(name)
    return inner(...args)
  }) as unknown as Dag.Interface[K]
}

const dagBase = Dag.layer.pipe(Layer.provide(store), Layer.provide(events))
const dag = Layer.effect(
  Dag.Service,
  Effect.gen(function* () {
    const real = yield* Dag.Service
    return Dag.Service.of({
      ...real,
      pause: recordingDagMethod("pause", real.pause),
      resume: recordingDagMethod("resume", real.resume),
      step: recordingDagMethod("step", real.step),
      cancel: recordingDagMethod("cancel", real.cancel),
      complete: recordingDagMethod("complete", real.complete),
      replan: recordingDagMethod("replan", real.replan),
      extend: recordingDagMethod("extend", real.extend),
      recover: recordingDagMethod("recover", real.recover),
      retarget: recordingDagMethod("retarget", real.retarget),
      extendTimeout: recordingDagMethod("extendTimeout", real.extendTimeout),
      nodeCancelled: recordingDagMethod("nodeCancelled", real.nodeCancelled),
    })
  }),
).pipe(Layer.provide(dagBase))
const control = Layer.effect(
  DagControl.Service,
  Effect.gen(function* () {
    const real = yield* DagControl.Service
    return DagControl.Service.of({
      apply: (dagID, request, caller) =>
        Effect.flatMap(
          Effect.sync(() => {
            controlOps.push(request.op)
          }),
          () =>
            controlApplyOverride ? controlApplyOverride(dagID, request, caller) : real.apply(dagID, request, caller),
        ),
      parkRejected: (dagID, caller) =>
        controlParkOverride ? controlParkOverride(dagID, caller) : real.parkRejected(dagID, caller),
    })
  }),
).pipe(Layer.provide(DagControl.layer.pipe(Layer.provide(dag))))
const testModel = ProviderTest.model({
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("test-model"),
})
const localModel = ProviderTest.model({
  providerID: ProviderV2.ID.make("local-proxy-compatible"),
  id: ModelV2.ID.make("local-proxy-compatible/glm-5.2"),
})
const providerRows = {
  [testModel.providerID]: ProviderTest.info({}, testModel),
  [localModel.providerID]: ProviderTest.info({}, localModel),
}
let environmentProviderListCalls = 0
let environmentProviderGetModelCalls = 0
const providerCatalog = Layer.mock(Provider.Service, {
  list: () =>
    Effect.sync(() => {
      environmentProviderListCalls++
      return providerRows
    }),
  getModel: (providerID, modelID) =>
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        environmentProviderGetModelCalls++
      })
      if (providerID === testModel.providerID && modelID === testModel.id) return testModel
      if (providerID === localModel.providerID && modelID === localModel.id) return localModel
      return yield* new Provider.ModelNotFoundError({ providerID, modelID })
    }),
})
let environmentAgentListCalls = 0
let environmentSkillListCalls = 0
const runtime = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    Layer.mock(Agent.Service, {
      get: () =>
        Effect.succeed({
          name: "build",
          mode: "all",
          permission: [],
          options: {},
          description: "",
          prompt: "",
          tools: {},
          hooks: {},
        }),
      list: () =>
        Effect.sync(() => {
          environmentAgentListCalls++
          return builtinAgentCatalog
        }),
    }),
    Layer.mock(Skill.Service, {
      all: () =>
        Effect.sync(() => {
          environmentSkillListCalls++
          return []
        }),
    }),
    Layer.mock(Truncate.Service, {
      output: (content) => Effect.succeed({ content, truncated: false }),
    }),
    Layer.mock(Question.Service, {
      ask: () => Effect.succeed([["Configure first"]]),
    }),
    providerCatalog,
    dag,
    control,
    Layer.mock(Session.Service, {
      get: (id: Parameters<Session.Interface["get"]>[0]) =>
        Effect.succeed({
          id,
          slug: "workflow-test",
          projectID,
          directory: workflowSpecDirectory,
          parentID: id === SessionID.make("ses_workflow_child") ? SessionID.make("ses_workflow_parent") : undefined,
          title: "Workflow test",
          version: "test",
          time: { created: 0, updated: 0 },
          model: {
            providerID: ProviderV2.ID.make("test"),
            id: ModelV2.ID.make("test-model"),
          },
        } satisfies Session.Info),
    }),
  ),
)

let missingModelDirectory = ""
const questionsAsked: Question.Info[] = []
const missingModelRuntime = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    Layer.mock(Agent.Service, {
      get: () =>
        Effect.succeed({
          name: "build",
          mode: "all",
          permission: [],
          options: {},
        }),
      list: () => Effect.succeed(builtinAgentCatalog),
    }),
    Layer.mock(Skill.Service, {
      all: () => Effect.succeed([]),
    }),
    Layer.mock(Truncate.Service, {
      output: (content) => Effect.succeed({ content, truncated: false }),
    }),
    Layer.mock(Question.Service, {
      ask: (input) =>
        Effect.sync(() => {
          questionsAsked.push(...input.questions)
          return [["Configure first"]]
        }),
    }),
    providerCatalog,
    dag,
    control,
    Layer.mock(Session.Service, {
      get: (id: Parameters<Session.Interface["get"]>[0]) =>
        Effect.succeed({
          id,
          slug: "workflow-test",
          projectID,
          directory: missingModelDirectory,
          title: "Workflow test",
          version: "test",
          time: { created: 0, updated: 0 },
        } satisfies Session.Info),
    }),
  ),
)

// The builtin agent catalog the environment validation checks worker types
// against — mirrors the real build/plan/general/explore builtins.
const builtinAgentCatalog = ["build", "plan", "general", "explore"].map((name) => ({
  name,
  mode: "all" as const,
  permission: [],
  options: {},
})) as Agent.Info[]

function writeWorkflowSpec(name: string, value: unknown) {
  const filepath = path.join(workflowSpecDirectory, `${name}.yaml`)
  return Effect.promise(() => Bun.write(filepath, JSON.stringify(value, null, 2))).pipe(Effect.as(filepath))
}

function toolContext() {
  return {
    sessionID: SessionID.make("ses_workflow_parent"),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  } satisfies Tool.Context
}

/** Drafts are written under the project-scoped XDG area, so each temporary
 * directory gets its own synthetic project ID to keep tests isolated and
 * leave the shared area clean between cases. */
function draftProjectID(directory: string) {
  return ProjectV2.ID.make(`project_${path.basename(directory)}`)
}

function workflowToolAt(directory: string) {
  return WorkflowTool.pipe(
    Effect.provide(
      Layer.mock(Session.Service, {
        get: (id) =>
          Effect.succeed({
            id,
            slug: "draft-test",
            projectID: draftProjectID(directory),
            directory,
            title: "Draft permissions",
            version: "test",
            time: { created: 0, updated: 0 },
          } satisfies Session.Info),
      }),
    ),
    Effect.flatMap((info) => info.init()),
  )
}

function missingModelProject() {
  return tmpdirScoped({
    init: (directory) =>
      Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".agents"), { recursive: true })
        await Bun.write(path.join(directory, ".agents", "settings.json"), '{ "dag": { "model": {} } }\n')
        await Bun.write(
          path.join(directory, "missing-model.yaml"),
          JSON.stringify({
            config: {
              name: "missing-model",
              nodes: [
                {
                  id: "worker",
                  name: "Worker",
                  worker_type: "build",
                  depends_on: [],
                  prompt_template: { inline: "work" },
                },
              ],
            },
          }),
        )
      }),
  })
}

function missingCatalogModelProject() {
  return tmpdirScoped({
    init: (directory) =>
      Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".agents"), { recursive: true })
        await Bun.write(
          path.join(directory, ".agents", "settings.json"),
          '{ "dag": { "model": { "advanced": "ghost/ghost" } } }\n',
        )
        await Bun.write(
          path.join(directory, "missing-catalog-model.yaml"),
          JSON.stringify({
            config: {
              name: "missing-catalog-model",
              nodes: [
                {
                  id: "worker",
                  name: "Worker",
                  worker_type: "build",
                  depends_on: [],
                  prompt_template: { inline: "work" },
                },
              ],
            },
          }),
        )
      }),
  })
}

describe("workflow tool schema (negative tests)", () => {
  it("action field accepts the four action groups and their operations", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() =>
      decode({ params: { action: "run", operation: "start", spec_path: ".agents/workflows/test.yaml" } }),
    ).not.toThrow()
    expect(() =>
      decode({
        params: {
          action: "run",
          operation: "extend",
          workflow_id: "dag_wf_1",
          spec_path: ".agents/workflows/extend.yaml",
        },
      }),
    ).not.toThrow()
    expect(() => decode({ params: { action: "control", workflow_id: "dag_wf_1", operation: "pause" } })).not.toThrow()
    expect(() => decode({ params: { action: "inspect", operation: "status", workflow_id: "dag_wf_1" } })).not.toThrow()
    expect(() =>
      decode({
        params: { action: "inspect", operation: "result", workflow_id: "dag_wf_1", node_id: "node-1", limit: 600 },
      }),
    ).not.toThrow()
    // list browses the saved-spec library and needs no workflow_id.
    expect(() => decode({ params: { action: "spec", operation: "list" } })).not.toThrow()
    expect(() =>
      decode({ params: { action: "spec", operation: "read", spec_path: "project-change-route" } }),
    ).not.toThrow()
    // The removed guide action no longer decodes.
    expect(() => decode({ params: { action: "guide", topic: "blocks" } })).toThrow()
  })

  it("rejects inline structured specs and JSON-stringified specs", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    const spec = {
      config: {
        name: "inline-schema",
        nodes: [],
      },
    }

    expect(() => decode({ params: { action: "run", operation: "start", spec } })).toThrow()
    expect(() => decode({ params: { action: "run", operation: "start", spec: JSON.stringify(spec) } })).toThrow()
  })

  it("action field rejects unknown actions", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ params: { action: "delete" } })).toThrow()
  })

  it("workflow IDs use the durable DAG identity schema", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ params: { action: "inspect", operation: "status", workflow_id: "workflow-1" } })).toThrow()
    expect(decode({ params: { action: "inspect", operation: "status", workflow_id: "dag_workflow_1" } })).toMatchObject(
      {
        params: { workflow_id: "dag_workflow_1" },
      },
    )
  })

  it("no node_complete action exists", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ params: { action: "node_complete" } })).toThrow()
  })

  it("no unsupported read-only actions exist (history/logs)", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ params: { action: "history" } })).toThrow()
    expect(() => decode({ params: { action: "logs" } })).toThrow()
  })

  it("control operation accepts pause/resume/cancel/step/complete", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    for (const op of ["pause", "resume", "cancel", "step", "complete"]) {
      expect(() => decode({ params: { action: "control", workflow_id: "dag_wf_1", operation: op } })).not.toThrow()
    }
  })

  it("control replan requires a YAML graph source", () => {
    const decode = Schema.decodeUnknownSync(Parameters, { onExcessProperty: "error" })
    expect(() =>
      decode({
        params: { action: "control", workflow_id: "dag_wf_1", operation: "replan", spec_path: "fragment.yaml" },
      }),
    ).not.toThrow()
    expect(() =>
      decode({
        params: {
          action: "control",
          workflow_id: "dag_wf_1",
          operation: "replan",
          spec: { fragment: { name: "fragment", nodes: [] } },
        },
      }),
    ).toThrow()
    expect(() => decode({ params: { action: "control", workflow_id: "dag_wf_1", operation: "replan" } })).toThrow()
  })

  it("control operation rejects unknown operations", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ params: { action: "control", workflow_id: "dag_wf_1", operation: "delete" } })).toThrow()
    expect(() => decode({ params: { action: "control", workflow_id: "dag_wf_1", operation: "start" } })).toThrow()
  })

  it("control extend_timeout requires node_id and a positive timeout_ms (P0-A)", () => {
    const decode = Schema.decodeUnknownSync(Parameters, { onExcessProperty: "error" })
    expect(() =>
      decode({
        params: {
          action: "control",
          workflow_id: "dag_wf_1",
          operation: "extend_timeout",
          node_id: "n1",
          timeout_ms: 60_000,
        },
      }),
    ).not.toThrow()
    expect(() =>
      decode({
        params: { action: "control", workflow_id: "dag_wf_1", operation: "extend_timeout", timeout_ms: 60_000 },
      }),
    ).toThrow()
    expect(() =>
      decode({ params: { action: "control", workflow_id: "dag_wf_1", operation: "extend_timeout", node_id: "n1" } }),
    ).toThrow()
    expect(() =>
      decode({
        params: {
          action: "control",
          workflow_id: "dag_wf_1",
          operation: "extend_timeout",
          node_id: "n1",
          timeout_ms: 0,
        },
      }),
    ).toThrow()
    // Bounds: sub-second extensions (which would instantly re-escalate) and
    // >24h grants are rejected at the schema boundary.
    expect(() =>
      decode({
        params: {
          action: "control",
          workflow_id: "dag_wf_1",
          operation: "extend_timeout",
          node_id: "n1",
          timeout_ms: 999,
        },
      }),
    ).toThrow()
    expect(() =>
      decode({
        params: {
          action: "control",
          workflow_id: "dag_wf_1",
          operation: "extend_timeout",
          node_id: "n1",
          timeout_ms: 86_400_001,
        },
      }),
    ).toThrow()
  })

  it("keeps workflow graph and admission fields inside the YAML file", () => {
    const decode = Schema.decodeUnknownSync(Parameters, { onExcessProperty: "error" })
    expect(() =>
      decode({
        params: {
          action: "run",
          operation: "start",
          spec_path: ".agents/workflows/deep.yaml",
          mode: "deep",
          admission: admissionFor("READY", "CONSUMED"),
          config: {
            name: "deep-schema",
            nodes: [],
          },
        },
      }),
    ).toThrow()
    expect(decode({ params: { action: "run", operation: "start", spec_path: ".agents/workflows/deep.yaml" } })).toEqual(
      {
        params: { action: "run", operation: "start", spec_path: ".agents/workflows/deep.yaml" },
      },
    )
  })

  it("draft accepts a structured graph and rejects unknown fields", () => {
    const decode = Schema.decodeUnknownSync(Parameters, { onExcessProperty: "error" })
    const draft = {
      action: "spec",
      operation: "draft",
      title: "Structured draft",
      config: {
        name: "structured-draft",
        objective: "Validate the draft rendering path.",
        blocks: [
          { id: "map", kind: "explore", instruction: "Map the seams.", worker_config: { timeout_ms: 4321 } },
          { id: "review", kind: "review", depends_on: ["map"] },
        ],
      },
    }
    expect(decode({ params: draft })).toMatchObject({ params: { action: "spec", operation: "draft" } })
    // The high-frequency drift shapes die at the schema boundary.
    expect(() =>
      decode({
        params: {
          action: "spec",
          operation: "draft",
          config: { ...draft.config, blocks: [{ id: "x", kind: "coding", worker: "general" }] },
        },
      }),
    ).toThrow()
    expect(() =>
      decode({
        params: {
          action: "spec",
          operation: "draft",
          config: { ...draft.config, blocks: [{ id: "x", kind: "coding", worker_timeout: 5000 }] },
        },
      }),
    ).toThrow()
    expect(() =>
      decode({
        params: {
          action: "spec",
          operation: "draft",
          config: { ...draft.config, blocks: [{ id: "x", kind: "coding", worker_config: { foo: 1 } }] },
        },
      }),
    ).toThrow()
    expect(() => decode({ params: { action: "spec", operation: "draft", objective: "top level" } })).toThrow()
    expect(() => decode({ params: { action: "spec", operation: "draft" } })).toThrow()
  })

  it("draft passes mixed blocks+nodes through the schema; the authoring layer rejects them", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    // WorkflowGraphSchema is a permissive union at the parameter boundary —
    // the compiled authoring check owns the blocks-xor-nodes rule, exercised
    // in the execution tests below.
    expect(() =>
      decode({
        params: {
          action: "spec",
          operation: "draft",
          config: {
            name: "mixed",
            objective: "Both sources at once.",
            blocks: [{ id: "a", kind: "coding" }],
            nodes: [],
          },
        },
      }),
    ).not.toThrow()
  })
})

describe("workflow tool execution", () => {
  runtime.effect("rejects workflow orchestration from a child session even if invoked directly", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const exit = yield* workflow
        .execute(
          { params: { action: "spec", operation: "list" } },
          { ...toolContext(), sessionID: SessionID.make("ses_workflow_child") },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("main conversation")
      expect(published).toHaveLength(0)
    }),
  )

  runtime.effect("description keeps tool selection and self-contained routing; action fields live in the schema", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()

      // The resident description no longer carries the per-action field
      // manual — the discriminated parameter schema owns those fields
      // (change repair-workflow-authoring-validation, §7.1).
      expect(workflow.description).not.toContain('guide(topic="blocks")')
      expect(workflow.description).not.toContain("**start** creates")
      expect(workflow.description).not.toContain("**result** reads")
      expect(workflow.description).toContain("parameter schema")
      expect(workflow.description).toContain("not a task-category rule")
      expect(workflow.description).toContain("Explicit user instructions take precedence")
      expect(workflow.description).not.toMatch(/even one project\s+file/)
      expect(workflow.description).not.toContain("$ARGUMENTS")
    }),
  )

  runtime.effect("routing stays self-contained when skills are denied and guide is removed", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      // The guide action is gone and the dag-* skills are on-demand (a skill
      // permission may deny them): the always-on description alone must carry
      // the minimum route.
      expect(workflow.description).toContain("`spec`")
      expect(workflow.description).toContain("`run`")
      expect(workflow.description).toContain("`inspect`")
      expect(workflow.description).toContain("`control`")
      expect(workflow.description).toContain("spec_path")
      expect(workflow.description).toContain("checkpoints are gates")
      expect(workflow.description).toContain("parks the workflow paused")
      expect(workflow.description).toContain("one live DAG")
      expect(workflow.description).toContain("`agent` tool")
      expect(workflow.description).not.toMatch(/load .*skill/i)
    }),
  )

  runtime.effect("draft renders a structured graph into a validated spec file", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        {
          params: {
            action: "spec",
            operation: "draft",
            title: "Draft round trip",
            config: {
              name: "draft-round-trip",
              objective: "Validate the draft rendering path.",
              blocks: [
                { id: "map", kind: "explore", instruction: "Map the seams.\nSecond line with: colons and quotes." },
                { id: "coding", kind: "coding", depends_on: ["map"] },
                { id: "verify", kind: "verify", depends_on: ["coding"] },
                { id: "review", kind: "review", depends_on: ["verify"] },
              ],
            },
          },
        },
        toolContext(),
      )

      const draftPath = path.join(workflowDraftsArea(projectID), "draft-round-trip.yaml")
      expect(result.output).toContain(draftPath)
      expect(result.output).toContain("nodes: ")

      // The rendered file round-trips through the same authoring path start
      // uses, and read returns the authored document with draft content.
      const read = yield* workflow.execute(
        { params: { action: "spec", operation: "read", spec_path: draftPath } },
        toolContext(),
      )
      const parsed = JSON.parse(read.output)
      expect(parsed.validation.valid).toBe(true)
      expect(parsed.spec.config.name).toBe("draft-round-trip")
      expect(parsed.spec.config.blocks).toHaveLength(4)
      expect(parsed.spec.title).toBe("Draft round trip")
    }),
  )

  runtime.effect("start surfaces legacy model warnings while preserving the authored pin", () =>
    Effect.gen(function* () {
      published.length = 0
      const workflow = yield* (yield* WorkflowTool).init()
      const specPath = yield* writeWorkflowSpec("legacy-pin-warning", {
        config: {
          name: "legacy-pin-warning",
          nodes: [
            {
              id: "worker",
              name: "Worker",
              worker_type: "general",
              depends_on: [],
              prompt_template: { inline: "Do the work" },
              model: { providerID: "test", modelID: "test-model" },
            },
          ],
        },
      })
      const result = yield* workflow.execute(
        { params: { action: "run", operation: "start", spec_path: specPath } },
        toolContext(),
      )
      expect(result.title).toContain("Workflow started")
      expect(result.output).toContain("Warning [model.legacy_pin] config.nodes[worker].model")
      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toMatchObject({
        model: { providerID: "test", modelID: "test-model" },
      })
      published.length = 0
    }),
  )

  runtime.effect("draft reports validation errors without creating a workflow", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const decode = Schema.decodeUnknownSync(Parameters)
      // Unknown dependency: valid at the parameter schema, rejected by the
      // authoring validation the draft runs before returning.
      const result = yield* workflow.execute(
        decode({
          params: {
            action: "spec",
            operation: "draft",
            config: {
              name: "draft-bad-edge",
              objective: "Broken dependency.",
              blocks: [{ id: "a", kind: "coding", depends_on: ["ghost"] }],
            },
          },
        }),
        toolContext(),
      )

      expect(result.title).toContain("validation errors")
      expect(result.output).toContain(path.join(workflowDraftsArea(projectID), "draft-bad-edge.yaml"))
      expect(result.output).toContain("ghost")
      expect(published).toHaveLength(0)
    }),
  )

  runtime.live("draft checks edit denial or approval before creating any directory", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const workflow = yield* workflowToolAt(directory)
      for (const action of ["deny", "ask"] as const) {
        const requests: string[] = []
        const result = yield* workflow
          .execute(
            {
              params: {
                action: "spec",
                operation: "draft",
                config: { name: "protected", nodes: [] },
              },
            },
            {
              ...toolContext(),
              ask: (request) =>
                Effect.gen(function* () {
                  requests.push(request.permission)
                  if (request.permission !== "edit") return
                  expect(request.patterns).toEqual([
                    path.relative(
                      directory,
                      path.join(workflowDraftsArea(draftProjectID(directory)), "protected.yaml"),
                    ),
                  ])
                  const rule = Permission.evaluate("edit", request.patterns[0], [
                    { permission: "edit", pattern: "*", action },
                  ])
                  yield* Effect.die(new Error(rule.action === "deny" ? "edit denied" : "edit approval required"))
                }),
            },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(requests).toEqual(["workflow", "edit"])
        expect(yield* Effect.promise(() => fs.readdir(directory))).not.toContain(".agents")
      }
    }),
  )

  runtime.live("draft exclusive creation preserves an existing file and reports write failures", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const workflow = yield* workflowToolAt(directory)
      const params = { action: "spec", operation: "draft", config: { name: "exclusive", nodes: [] } } as const
      const draftArea = workflowDraftsArea(draftProjectID(directory))
      yield* workflow.execute({ params }, toolContext())
      const file = path.join(draftArea, "exclusive.yaml")
      const before = yield* Effect.promise(() => Bun.file(file).text())
      const duplicate = yield* workflow.execute({ params: { ...params, title: "replacement" } }, toolContext())
      expect(duplicate.output).toContain("already exists")
      expect(duplicate.hookFailure).toContain("not overwritten")
      expect(duplicate.metadata.blocked).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(before)
      expect(yield* Effect.promise(() => fs.readdir(draftArea))).toEqual(["exclusive.yaml"])

      const blockedDirectory = yield* tmpdirScoped()
      const blockedArea = workflowDraftsArea(draftProjectID(blockedDirectory))
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(blockedArea), { recursive: true })
        await fs.writeFile(blockedArea, "not a directory")
      })
      const blocked = yield* workflowToolAt(blockedDirectory)
      // An expected filesystem error is returned as tool failure feedback,
      // rather than escaping as an Effect defect or claiming a written draft.
      const failed = yield* blocked.execute({ params }, toolContext())
      expect(failed.title).toContain("not written")
      expect(failed.hookFailure).toContain("Failed to write workflow draft")
      expect(failed.metadata.blocked).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(blockedArea).text())).toBe("not a directory")

      yield* Effect.promise(() => fs.rm(draftArea, { recursive: true, force: true }))
      yield* Effect.promise(() =>
        fs.rm(workflowArtifactsRoot(draftProjectID(blockedDirectory)), { recursive: true, force: true }),
      )
    }),
  )

  runtime.live("a draft write failing midway leaves no partial target and can be retried", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const workflow = yield* workflowToolAt(directory)
      const draftDirectory = workflowDraftsArea(draftProjectID(directory))
      const originalWrite = fs.writeFile
      const write = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spyOn(fs, "writeFile").mockImplementation(async (file, content, options) => {
            if (typeof file === "string" && file.startsWith(draftDirectory + path.sep)) {
              await originalWrite(file, "config:\n  name: partial", options)
              throw Object.assign(new Error("disk full while writing"), { code: "ENOSPC" })
            }
            return originalWrite(file, content, options)
          }),
        ),
        (mock) => Effect.sync(() => mock.mockRestore()),
      )
      const params = { action: "spec", operation: "draft", config: { name: "recoverable", nodes: [] } } as const
      const failed = yield* workflow.execute({ params }, toolContext())
      expect(failed.hookFailure).toContain("disk full while writing")
      expect(failed.title).toContain("not written")
      expect(yield* Effect.promise(() => fs.readdir(draftDirectory))).toEqual([])
      write.mockRestore()
      const retried = yield* workflow.execute({ params }, toolContext())
      expect(retried.hookFailure).toBeUndefined()
      expect(yield* Effect.promise(() => fs.readdir(draftDirectory))).toEqual(["recoverable.yaml"])
      const saved = yield* Effect.promise(() => Bun.file(path.join(draftDirectory, "recoverable.yaml")).text())
      expect(saved).toContain("name: recoverable")
      expect(saved).not.toContain("name: partial")
      yield* Effect.promise(() =>
        fs.rm(workflowArtifactsRoot(draftProjectID(directory)), { recursive: true, force: true }),
      )
    }),
  )

  runtime.live("cancelling after staging creation but before acquisition returns still cleans the directory", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const workflow = yield* workflowToolAt(directory)
      const draftDirectory = workflowDraftsArea(draftProjectID(directory))
      const created = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const originalMkdtemp = fs.mkdtemp
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          spyOn(fs, "mkdtemp").mockImplementation(
            new Proxy(originalMkdtemp, {
              async apply(target, receiver, args) {
                const staging = await Reflect.apply(target, receiver, args)
                if (String(args[0]).startsWith(draftDirectory + path.sep)) {
                  created.resolve()
                  await release.promise
                }
                return staging
              },
            }),
          ),
        ),
        (mock) => Effect.sync(() => mock.mockRestore()),
      )
      const fiber = yield* workflow
        .execute(
          {
            params: {
              action: "spec",
              operation: "draft",
              config: { name: "cancelled-acquisition", nodes: [] },
            },
          },
          toolContext(),
        )
        .pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        yield* Effect.promise(() => created.promise)
        // Request interruption synchronously so acquisition is definitely
        // still suspended in the mocked mkdtemp promise when cancellation hits.
        yield* Effect.sync(() => fiber.interruptUnsafe())
        release.resolve()
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(yield* Effect.promise(() => fs.readdir(draftDirectory))).toEqual([])
        yield* Effect.promise(() =>
          fs.rm(workflowArtifactsRoot(draftProjectID(directory)), { recursive: true, force: true }),
        )
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))
    }),
  )

  runtime.live("draft writes remain interruptible and clean their partial staging file", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const workflow = yield* workflowToolAt(directory)
      const draftDirectory = workflowDraftsArea(draftProjectID(directory))
      const writing = Promise.withResolvers<void>()
      const originalWrite = fs.writeFile
      let aborted = false
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          spyOn(fs, "writeFile").mockImplementation(async (file, content, options) => {
            if (typeof file !== "string" || !file.startsWith(draftDirectory + path.sep))
              return originalWrite(file, content, options)
            await originalWrite(file, "partial", options)
            const signal = typeof options === "object" && options !== null ? options.signal : undefined
            if (!signal) throw new Error("draft write must be abortable")
            await new Promise<void>((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true
                  resolve()
                },
                { once: true },
              )
              writing.resolve()
            })
            signal.throwIfAborted()
          }),
        ),
        (mock) => Effect.sync(() => mock.mockRestore()),
      )
      const fiber = yield* workflow
        .execute(
          {
            params: {
              action: "spec",
              operation: "draft",
              config: { name: "cancelled-write", nodes: [] },
            },
          },
          toolContext(),
        )
        .pipe(Effect.forkChild)
      yield* Effect.promise(() => writing.promise)
      yield* Fiber.interrupt(fiber)
      expect(aborted).toBe(true)
      expect(yield* Effect.promise(() => fs.readdir(draftDirectory))).toEqual([])
      yield* Effect.promise(() =>
        fs.rm(workflowArtifactsRoot(draftProjectID(directory)), { recursive: true, force: true }),
      )
    }),
  )

  runtime.effect("draft refuses unsafe workflow names and stays outside the saved library", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const decode = Schema.decodeUnknownSync(Parameters)

      const exit = yield* workflow
        .execute(
          decode({
            params: {
              action: "spec",
              operation: "draft",
              config: { name: "../escape", objective: "x", blocks: [{ id: "a", kind: "coding" }] },
            },
          }),
          toolContext(),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)

      const list = yield* workflow.execute({ params: { action: "spec", operation: "list" } }, toolContext())
      expect(list.output).not.toContain("draft-round-trip")
      expect(list.output).not.toContain("workflow-drafts")
    }),
  )

  runtime.effect("status returns the durable workflow and node state", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        {
          params: {
            action: "inspect",
            operation: "status",
            workflow_id: Dag.ID.make("dag_status"),
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(result.output).toContain('"status": "running"')
      expect(result.output).toContain('"id": "node_running"')
      expect(result.output).toContain('"child_session_id": "ses_child"')
      expect(result.output).toContain('"directory": "/repo/.worktrees/status"')
      expect(result.output).toContain('"head": "0123456789ab"')
      expect(result.output).toContain('"target_fingerprint"')
      expect(result.output).toContain('"value": "target-value"')
      expect(result.output).toContain('"last_activity_at": "1970-01-01T00:00:00.002Z"')
      expect(result.output).toContain('"mode": "standard"')
      expect(result.output).toContain('"latest_retarget"')
      expect(result.output).toContain('"seq": 9')
      expect(result.output).toContain('"reason": "tree moved"')
      expect(result.output).toContain('"id": "node_failed"')
      expect(result.output).toContain('"error_class": "timeout"')
      // #946: worktree evidence and conflict views are part of the status.
      expect(result.output).toContain('"worktrees"')
      expect(result.output).toContain('"state": "kept"')
      expect(result.output).toContain('"branch": "opencode/dag-status-node-failed"')
      // A cancelled/restarted superseded row still owns an active worktree.
      expect(result.output).toContain('"directory": "/repo/.worktrees/status-node-orphan"')
      expect(result.output).toContain('"state": "active"')
      // #946: a worktree replaced by a later attempt stays listed as retired.
      expect(result.output).toContain('"directory": "/repo/.worktrees/status-node-retired"')
      expect(result.output).toContain('"retired": true')
      expect(result.output).toContain('"conflicts"')
      expect(result.output).toContain('"src/shared.ts"')
    }),
  )

  runtime.effect("status exposes pause_reason and structured display_state per node", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        {
          params: { action: "inspect", operation: "status", workflow_id: Dag.ID.make("dag_display") },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(result.output).toContain('"pause_reason": "budget_exhausted"')
      // D11: cancellation keeps the raw failed status but displays as cancelled.
      const cancelled = JSON.parse(result.output).nodes.find((node: { id: string }) => node.id === "node_cancelled")
      expect(cancelled.status).toBe("failed")
      expect(cancelled.error_class).toBe("cancelled")
      expect(cancelled.display_state).toBe("cancelled")
      const escalated = JSON.parse(result.output).nodes.find((node: { id: string }) => node.id === "node_escalated")
      expect(escalated.status).toBe("running")
      expect(escalated.display_state).toBe("escalated")
    }),
  )

  runtime.effect("status exposes the durable failure reason", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        {
          params: {
            action: "inspect",
            operation: "status",
            workflow_id: Dag.ID.make("dag_workspace_failed"),
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )
      expect(result.output).toContain('"status": "failed"')
      expect(result.output).toContain('"failure_reason": "workspace_missing: /gone/worktree"')
    }),
  )

  runtime.effect("reads a complete durable node result through target-bound pages", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const decode = Schema.decodeUnknownSync(Parameters)
      const first = JSON.parse(
        (yield* workflow.execute(
          decode({
            params: {
              action: "inspect",
              operation: "result",
              workflow_id: "dag_result",
              node_id: "node_result",
              limit: 600,
            },
          }),
          toolContext(),
        )).output,
      )
      const second = JSON.parse(
        (yield* workflow.execute(
          decode({
            params: {
              action: "inspect",
              operation: "result",
              workflow_id: "dag_result",
              node_id: "node_result",
              cursor: first.next_cursor,
              limit: 600,
            },
          }),
          toolContext(),
        )).output,
      )
      const third = JSON.parse(
        (yield* workflow.execute(
          decode({
            params: {
              action: "inspect",
              operation: "result",
              workflow_id: "dag_result",
              node_id: "node_result",
              cursor: second.next_cursor,
              limit: 600,
            },
          }),
          toolContext(),
        )).output,
      )

      expect(first).toEqual(
        expect.objectContaining({
          workflow_id: "dag_result",
          node_id: "node_result",
          status: "completed",
          target_fingerprint: targetFingerprint,
          stale_target: true,
          truncated: true,
        }),
      )
      expect(`${first.content}${second.content}${third.content}`).toBe(resultOutput)
      expect(third.content).toContain("RESULT_SENTINEL")
      expect(third).toEqual(expect.objectContaining({ truncated: false, next_cursor: null }))

      const mismatched = yield* workflow
        .execute(
          decode({
            params: {
              action: "inspect",
              operation: "result",
              workflow_id: "dag_result",
              node_id: "node_other",
              cursor: first.next_cursor,
            },
          }),
          toolContext(),
        )
        .pipe(Effect.exit)
      const malformed = yield* workflow
        .execute(
          decode({
            params: {
              action: "inspect",
              operation: "result",
              workflow_id: "dag_result",
              node_id: "node_result",
              cursor: "not-a-result-cursor",
            },
          }),
          toolContext(),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(mismatched)).toBe(true)
      expect(Exit.isFailure(malformed)).toBe(true)
    }),
  )

  runtime.effect("requests workflow permission before a control action mutates state", () =>
    Effect.gen(function* () {
      published.length = 0
      const requests: Array<{ permission: string; patterns: readonly string[]; metadata: unknown }> = []
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const exit = yield* workflow
        .execute(
          { params: { action: "control", workflow_id: Dag.ID.make("dag_status"), operation: "pause" } },
          {
            ...toolContext(),
            ask: (request) => {
              requests.push(request)
              return Effect.die(new Error("permission denied"))
            },
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("permission denied")
      expect(requests).toEqual([
        expect.objectContaining({
          permission: "workflow",
          patterns: ["control", "control:pause"],
          metadata: expect.objectContaining({
            action: "control",
            workflow_id: "dag_status",
            operation: "pause",
          }),
        }),
      ])
      expect(published.some((event) => event.type === DagEvent.WorkflowPaused.type)).toBe(false)
    }),
  )

  runtime.effect("control operation rules preserve legacy denies and approval requirements", () =>
    Effect.gen(function* () {
      const workflow = yield* (yield* WorkflowTool).init()
      for (const legacy of ["allow", "deny", "ask"] as const) {
        for (const operation of ["pause", "cancel"] as const) {
          published.length = 0
          const checked: string[] = []
          const result = yield* workflow
            .execute(
              {
                params: {
                  action: "control",
                  workflow_id: Dag.ID.make("dag_status"),
                  operation,
                },
              },
              {
                ...toolContext(),
                ask: (request) =>
                  Effect.gen(function* () {
                    for (const pattern of request.patterns) {
                      const rule = Permission.evaluate(request.permission, pattern, [
                        { permission: "workflow", pattern: "control", action: legacy },
                        { permission: "workflow", pattern: "control:pause", action: "allow" },
                        { permission: "workflow", pattern: "control:cancel", action: "deny" },
                      ])
                      checked.push(`${pattern}:${rule.action}`)
                      if (rule.action !== "allow") yield* Effect.die(new Error(`permission ${rule.action}`))
                    }
                  }),
              },
            )
            .pipe(Effect.exit)
          const allowed = legacy === "allow" && operation === "pause"
          expect(Exit.isSuccess(result)).toBe(allowed)
          expect(checked[0]).toBe(`control:${legacy}`)
          if (legacy === "allow")
            expect(checked[1]).toBe(`control:${operation}:${operation === "pause" ? "allow" : "deny"}`)
          expect(published.some((event) => event.type === DagEvent.WorkflowPaused.type)).toBe(allowed)
          expect(published.some((event) => event.type === DagEvent.WorkflowCancelled.type)).toBe(false)
        }
      }
    }),
  )

  runtime.effect("checks both group and operation permissions for spec, run, and inspect", () =>
    Effect.gen(function* () {
      const workflow = yield* (yield* WorkflowTool).init()
      const cases = [
        { params: { action: "spec", operation: "list" }, group: "spec", legacy: "list" },
        {
          params: { action: "inspect", operation: "status", workflow_id: Dag.ID.make("dag_status") },
          group: "inspect",
          legacy: "status",
        },
        {
          params: { action: "run", operation: "start", spec_path: "saved-project" },
          group: "run",
          legacy: "start",
        },
      ] as const
      for (const item of cases) {
        const asked: Array<{ patterns: readonly string[] }> = []
        yield* workflow
          .execute(
            { params: item.params },
            {
              ...toolContext(),
              ask: (request) =>
                Effect.sync(() => {
                  asked.push(request)
                }),
            },
          )
          .pipe(Effect.exit)
        expect(asked, item.group).toHaveLength(1)
        // The legacy bare action pattern keeps pre-convergence deny rules
        // effective (see the legacy-deny regression below).
        expect(asked[0]?.patterns, item.group).toEqual([
          item.group,
          `${item.group}:${item.params.operation}`,
          item.legacy,
        ])
      }
    }),
  )

  runtime.effect("legacy action deny rules still reject the converged run action", () =>
    Effect.gen(function* () {
      const workflow = yield* (yield* WorkflowTool).init()
      const rules = Permission.fromConfig({ workflow: { "*": "allow", start: "deny" } })
      const checked: string[] = []
      const exit = yield* workflow
        .execute(
          { params: { action: "run", operation: "start", spec_path: "saved-project" } },
          {
            ...toolContext(),
            ask: (request) =>
              Effect.gen(function* () {
                for (const pattern of request.patterns) {
                  const rule = Permission.evaluate(request.permission, pattern, rules)
                  checked.push(`${pattern}:${rule.action}`)
                  if (rule.action === "deny") return yield* Effect.die(new Error("permission denied"))
                }
              }),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      // The old bare action name is asked alongside the new group patterns,
      // so a configured `workflow: { start: "deny" }` cannot silently allow
      // run:start through the `*` allow.
      expect(checked).toEqual(["run:allow", "run:start:allow", "start:deny"])
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("permission denied")
    }),
  )

  // A spec path is a file read: read/validate echo the parsed document (even
  // for non-workflow YAML) and start/extend/replan consume it, so read deny
  // rules must apply before the file is opened — not only external_directory.
  runtime.effect("asks read permission for a spec path before reading it", () =>
    Effect.gen(function* () {
      const specPath = yield* writeWorkflowSpec("read-permission-secret", { secret: "do-not-echo" })
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      for (const action of [
        { action: "spec", operation: "read" },
        { action: "spec", operation: "validate" },
        { action: "run", operation: "start" },
      ] as const) {
        const label = `${action.action}:${action.operation}`
        const requests: Array<{ permission: string; patterns: readonly string[] }> = []
        const exit = yield* workflow
          .execute(
            { params: { ...action, spec_path: specPath } },
            {
              ...toolContext(),
              ask: (request) => {
                requests.push(request)
                return request.permission === "read" ? Effect.die(new Error("read denied")) : Effect.void
              },
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit), label).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause), label).toContain("read denied")
          expect(Cause.pretty(exit.cause), label).not.toContain("do-not-echo")
        }
        expect(
          requests.filter((request) => request.permission === "read"),
          label,
        ).toEqual([expect.objectContaining({ permission: "read", patterns: ["read-permission-secret.yaml"] })])
      }
    }),
  )

  runtime.effect("rejects reads and mutations from a session that does not own the workflow", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const foreignContext = {
        ...toolContext(),
        sessionID: SessionID.make("ses_foreign"),
      } satisfies Tool.Context

      const statusExit = yield* Effect.exit(
        workflow.execute(
          { params: { action: "inspect", operation: "status", workflow_id: Dag.ID.make("dag_status") } },
          foreignContext,
        ),
      )
      const resultExit = yield* Effect.exit(
        workflow.execute(
          Schema.decodeUnknownSync(Parameters)({
            params: {
              action: "inspect",
              operation: "result",
              workflow_id: "dag_result",
              node_id: "node_result",
            },
          }),
          foreignContext,
        ),
      )
      const extendExit = yield* Effect.exit(
        workflow.execute(
          {
            params: {
              action: "run",
              operation: "extend",
              workflow_id: Dag.ID.make("dag_defaults"),
              spec_path: "foreign.yaml",
            },
          },
          foreignContext,
        ),
      )
      const controlExit = yield* Effect.exit(
        workflow.execute(
          { params: { action: "control", workflow_id: Dag.ID.make("dag_status"), operation: "pause" } },
          foreignContext,
        ),
      )

      expect({
        statusSucceeded: Exit.isSuccess(statusExit),
        statusLeakedChildSession: Exit.isSuccess(statusExit) && statusExit.value.output.includes("ses_child"),
        resultSucceeded: Exit.isSuccess(resultExit),
        resultLeakedSentinel: Exit.isSuccess(resultExit) && resultExit.value.output.includes("RESULT_SENTINEL"),
        extendSucceeded: Exit.isSuccess(extendExit),
        controlSucceeded: Exit.isSuccess(controlExit),
        publishedPause: published.some((event) => event.type === DagEvent.WorkflowPaused.type),
      }).toEqual({
        statusSucceeded: false,
        statusLeakedChildSession: false,
        resultSucceeded: false,
        resultLeakedSentinel: false,
        extendSucceeded: false,
        controlSucceeded: false,
        publishedPause: false,
      })
    }),
  )

  runtime.effect("dispatches every public control operation to its durable workflow event", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const controls = [
        { workflowID: Dag.ID.make("dag_status"), operation: "pause" },
        { workflowID: Dag.ID.make("dag_paused"), operation: "resume" },
        { workflowID: Dag.ID.make("dag_status"), operation: "cancel" },
        { workflowID: Dag.ID.make("dag_finishable"), operation: "complete" },
        { workflowID: Dag.ID.make("dag_step"), operation: "step" },
      ] as const
      const routed = yield* Effect.forEach(controls, (control) =>
        Effect.gen(function* () {
          published.length = 0
          yield* workflow.execute(
            {
              params: {
                action: "control",
                workflow_id: control.workflowID,
                operation: control.operation,
              },
            },
            toolContext(),
          )
          return published.find((event) => event.type.startsWith("dag.workflow."))?.type ?? "missing"
        }),
      )

      published.length = 0
      yield* workflow.execute(
        {
          params: {
            action: "control",
            operation: "cancel_node",
            workflow_id: Dag.ID.make("dag_status"),
            node_id: Dag.NodeID.make("node_running"),
          },
        },
        toolContext(),
      )
      routed.push(published.find((event) => event.type === DagEvent.NodeCancelled.type)?.type ?? "missing")

      expect(routed).toEqual([
        DagEvent.WorkflowPaused.type,
        DagEvent.WorkflowResumed.type,
        DagEvent.WorkflowCancelled.type,
        DagEvent.WorkflowCompleted.type,
        DagEvent.WorkflowStepped.type,
        DagEvent.NodeCancelled.type,
      ])
    }),
  )

  runtime.effect("routes every control op and the top-level extend through DagControl without bypassing it", () =>
    Effect.gen(function* () {
      published.length = 0
      dagCalls.length = 0
      controlOps.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const replanSpec = yield* writeWorkflowSpec("control-replan-recording", {
        fragment: {
          name: "control-replan-recording",
          nodes: [
            {
              id: "replanned-recording",
              name: "Replanned recording",
              worker_type: "general",
              depends_on: [],
              prompt_template: { inline: "work" },
            },
          ],
        },
      })
      const extendSpec = yield* writeWorkflowSpec("control-extend-recording", {
        nodes: [
          {
            id: "extended-recording",
            name: "Extended recording",
            worker_type: "general",
            depends_on: [],
            prompt_template: { inline: "work" },
          },
        ],
      })

      yield* workflow.execute(
        { params: { action: "control", workflow_id: Dag.ID.make("dag_status"), operation: "pause" } },
        toolContext(),
      )
      yield* workflow.execute(
        { params: { action: "control", workflow_id: Dag.ID.make("dag_paused"), operation: "resume" } },
        toolContext(),
      )
      yield* workflow.execute(
        { params: { action: "control", workflow_id: Dag.ID.make("dag_status"), operation: "cancel" } },
        toolContext(),
      )
      yield* workflow.execute(
        { params: { action: "control", workflow_id: Dag.ID.make("dag_finishable"), operation: "complete" } },
        toolContext(),
      )
      yield* workflow.execute(
        { params: { action: "control", workflow_id: Dag.ID.make("dag_step"), operation: "step" } },
        toolContext(),
      )
      yield* workflow.execute(
        {
          params: {
            action: "control",
            workflow_id: Dag.ID.make("dag_status"),
            operation: "cancel_node",
            node_id: Dag.NodeID.make("node_running"),
            reason: "recording",
          },
        },
        toolContext(),
      )
      yield* workflow.execute(
        {
          params: {
            action: "control",
            workflow_id: Dag.ID.make("dag_paused"),
            operation: "recover",
            node_ids: [DagEvent.NodeID.make("retry")],
            expected_graph_rev: 1,
          },
        },
        toolContext(),
      )
      yield* workflow.execute(
        {
          params: {
            action: "control",
            workflow_id: Dag.ID.make("dag_retarget"),
            operation: "retarget",
            fingerprint: "none",
            reason: "recording",
          },
        },
        toolContext(),
      )
      yield* workflow.execute(
        {
          params: {
            action: "control",
            workflow_id: Dag.ID.make("dag_defaults"),
            operation: "extend_timeout",
            node_id: Dag.NodeID.make("node_missing"),
            timeout_ms: 60_000,
          },
        },
        toolContext(),
      )
      yield* workflow.execute(
        {
          params: {
            action: "control",
            workflow_id: Dag.ID.make("dag_status"),
            operation: "replan",
            spec_path: replanSpec,
          },
        },
        toolContext(),
      )
      yield* workflow.execute(
        {
          params: { action: "run", operation: "extend", workflow_id: Dag.ID.make("dag_status"), spec_path: extendSpec },
        },
        toolContext(),
      )

      expect(controlOps).toEqual([
        "pause",
        "resume",
        "cancel",
        "complete",
        "step",
        "cancel_node",
        "recover",
        "retarget",
        "extend_timeout",
        "replan",
        "extend",
      ])
      // Each mutation reaches Dag exactly once, through DagControl. A direct
      // dag.* call from the tool would double that method's count.
      expect([...dagCalls].sort()).toEqual([
        "cancel",
        "complete",
        "extend",
        "extendTimeout",
        "nodeCancelled",
        "pause",
        "recover",
        "replan",
        "resume",
        "retarget",
        "step",
      ])
    }),
  )

  runtime.effect("parks a rejected replan whose workflow row cannot be read and reports missing state", () =>
    Effect.gen(function* () {
      published.length = 0
      const workflow = yield* (yield* WorkflowTool).init()
      const spec_path = yield* writeWorkflowSpec("replan-missing-workflow", {
        fragment: {
          name: "replan-missing-workflow",
          nodes: [
            {
              id: "replan-missing",
              name: "Replan missing",
              worker_type: "general",
              depends_on: [],
              prompt_template: { inline: "work" },
            },
          ],
        },
      })
      controlApplyOverride = (() =>
        Effect.fail(new DagControl.ControlNotFound())) as unknown as DagControl.Interface["apply"]
      controlParkOverride = (() =>
        Effect.succeed({
          result: { failed: "simulated first read failure", actualStatus: "missing" },
          status: "missing",
        })) as unknown as DagControl.Interface["parkRejected"]
      const result = yield* workflow
        .execute(
          Schema.decodeUnknownSync(Parameters)({
            params: {
              action: "control",
              workflow_id: "dag_status",
              operation: "replan",
              spec_path,
            },
          }),
          toolContext(),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const message = String(Cause.squash(result.cause))
        // The rejected mutation still reports the best-known durable state and
        // the shared recovery instruction, even though the workflow vanished.
        expect(message).toContain("Workflow not found: dag_status")
        expect(message).toContain("Workflow state: missing")
        expect(message).toContain("Diagnose the reported cause")
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          controlApplyOverride = undefined
          controlParkOverride = undefined
        }),
      ),
    ),
  )

  runtime.effect("routes local recovery through the owned workflow and returns revision and attempt lineage", () =>
    Effect.gen(function* () {
      published.length = 0
      const workflow = yield* (yield* WorkflowTool).init()
      const result = yield* workflow.execute(
        {
          params: {
            action: "control",
            workflow_id: Dag.ID.make("dag_paused"),
            operation: "recover",
            node_ids: [DagEvent.NodeID.make("retry")],
            expected_graph_rev: 1,
          },
        },
        toolContext(),
      )
      expect(result.title).toContain("Workflow recovered: 1 new attempts")
      expect(result.output).toContain('"graph_rev": 2')
      expect(result.output).toContain('"previous": "retry"')
      expect(published.map((event) => event.type)).toEqual([
        DagEvent.WorkflowReplanned.type,
        DagEvent.NodeRegistered.type,
        DagEvent.WorkflowConfigUpdated.type,
      ])
    }),
  )

  runtime.effect("retargets a live workflow and audits the durable event", () =>
    Effect.gen(function* () {
      published.length = 0
      const workflow = yield* (yield* WorkflowTool).init()
      const result = yield* workflow.execute(
        {
          params: {
            action: "control",
            workflow_id: Dag.ID.make("dag_retarget"),
            operation: "retarget",
            fingerprint: "none",
            reason: "tree moved",
          },
        },
        toolContext(),
      )

      expect(result.title).toBe("Workflow retargeted: 1 node(s) restarted")
      expect(JSON.parse(result.output)).toMatchObject({
        workflow_id: "dag_retarget",
        action: "retarget",
        graph_rev: 2,
        nodes: ["review"],
        reason: "tree moved",
        to_fingerprint: { kind: "none" },
      })
      expect(published.map((event) => event.type)).toEqual([
        DagEvent.NodeRestarted.type,
        DagEvent.WorkflowReplanned.type,
      ])
      expect(published[1].data).toMatchObject({
        restarted: 1,
        retarget: { reason: "tree moved", nodes: ["review"], toFingerprint: { kind: "none" } },
      })
    }),
  )

  runtime.effect("requests control:retarget permission before changing the target", () =>
    Effect.gen(function* () {
      const requests: Array<{ permission: string; patterns: readonly string[] }> = []
      const workflow = yield* (yield* WorkflowTool).init()
      const exit = yield* workflow
        .execute(
          {
            params: {
              action: "control",
              workflow_id: Dag.ID.make("dag_retarget"),
              operation: "retarget",
              fingerprint: "none",
            },
          },
          {
            ...toolContext(),
            ask: (request) => {
              requests.push(request)
              return Effect.die(new Error("permission denied"))
            },
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(requests).toEqual([
        expect.objectContaining({
          permission: "workflow",
          patterns: ["control", "control:retarget"],
        }),
      ])
    }),
  )

  runtime.effect("starts from a YAML workflow file", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const spec_path = yield* writeWorkflowSpec("file-start", {
        config: {
          name: "file-start",
          nodes: [],
        },
      })
      const result = yield* workflow.execute(
        Schema.decodeUnknownSync(Parameters)({
          params: {
            action: "run",
            operation: "start",
            spec_path,
          },
        }),
        toolContext(),
      )

      expect(result.title).toBe("Workflow started: file-start")
      expect(result.metadata.workflowId).toBeDefined()
      expect(published.some((event) => event.type === DagEvent.WorkflowCreated.type)).toBe(true)
    }),
  )

  runtime.effect("starts from composable blocks and persists only compiled nodes", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const spec_path = yield* writeWorkflowSpec("block-start", {
        config: {
          name: "block-start",
          objective: "Implement and review session recovery",
          blocks: [
            { id: "build", kind: "coding" },
            { id: "verify", kind: "verify", depends_on: ["build"] },
            { id: "review", kind: "review", depends_on: ["verify"] },
          ],
        },
      })
      const result = yield* workflow.execute(
        Schema.decodeUnknownSync(Parameters)({
          params: {
            action: "run",
            operation: "start",
            spec_path,
          },
        }),
        toolContext(),
      )

      expect(result.title).toBe("Workflow started: block-start")
      expect(result.output).toContain("5 nodes registered")
      const created = published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data as {
        config?: string
      }
      const config = JSON.parse(created.config ?? "{}")
      expect(config).not.toHaveProperty("blocks")
      expect(config).not.toHaveProperty("objective")
      expect(config.nodes.map((node: { id: string }) => node.id)).toEqual([
        "build",
        "verify",
        "review--standards",
        "review--intent",
        "review",
      ])
    }),
  )

  runtime.effect("extends from a YAML workflow file", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const spec_path = yield* writeWorkflowSpec("file-extend", {
        nodes: [
          {
            id: "file-added",
            name: "File added",
            worker_type: "general",
            depends_on: [],
            prompt_template: { inline: "work" },
          },
        ],
      })
      const result = yield* workflow.execute(
        Schema.decodeUnknownSync(Parameters)({
          params: {
            action: "run",
            operation: "extend",
            workflow_id: "dag_defaults",
            spec_path,
          },
        }),
        toolContext(),
      )

      expect(result.title).toBe("Workflow extended: 1 nodes added")
      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toEqual(
        expect.objectContaining({ nodeID: "file-added" }),
      )
    }),
  )

  runtime.effect("extends with blocks that depend on an existing durable node", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const spec_path = yield* writeWorkflowSpec("block-extend", {
        objective: "Repair from the current diagnostic evidence",
        blocks: [{ id: "repair", kind: "coding", depends_on: ["node_running"] }],
      })
      const result = yield* workflow.execute(
        Schema.decodeUnknownSync(Parameters)({
          params: {
            action: "run",
            operation: "extend",
            workflow_id: "dag_status",
            spec_path,
          },
        }),
        toolContext(),
      )

      expect(result.title).toBe("Workflow extended: 1 nodes added")
      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toEqual(
        expect.objectContaining({ nodeID: "repair", dependsOn: ["node_running"] }),
      )
    }),
  )

  runtime.effect("replans from a YAML workflow file", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const spec_path = yield* writeWorkflowSpec("file-replan", {
        fragment: {
          name: "file-replan",
          nodes: [
            {
              id: "file-replanned",
              name: "File replanned",
              worker_type: "general",
              depends_on: [],
              prompt_template: { inline: "work" },
            },
          ],
        },
      })
      const result = yield* workflow.execute(
        Schema.decodeUnknownSync(Parameters)({
          params: {
            action: "control",
            workflow_id: "dag_defaults",
            operation: "replan",
            spec_path,
          },
        }),
        toolContext(),
      )

      expect(result.title).toContain("Workflow replanned: +1")
      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toEqual(
        expect.objectContaining({ nodeID: "file-replanned" }),
      )
    }),
  )

  runtime.effect("parks a recoverable runtime replan rejection and reports the durable state", () =>
    Effect.gen(function* () {
      published.length = 0
      const workflow = yield* (yield* WorkflowTool).init()
      const spec_path = yield* writeWorkflowSpec("runtime-replan-failure", {
        fragment: {
          name: "runtime-replan-failure",
          nodes: [
            {
              id: "repair",
              name: "Repair",
              worker_type: "general",
              depends_on: [],
              prompt_template: { inline: "repair" },
            },
          ],
        },
      })
      const result = yield* workflow
        .execute(
          Schema.decodeUnknownSync(Parameters)({
            params: {
              action: "control",
              workflow_id: "dag_runtime_failure",
              operation: "replan",
              spec_path,
            },
          }),
          toolContext(),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(String(Cause.squash(result.cause))).toContain("simulated runtime batch write failure")
        expect(String(Cause.squash(result.cause))).toContain("Workflow state: paused (durably parked)")
      }
      expect(published.some((event) => event.type === DagEvent.WorkflowPaused.type)).toBe(true)
    }),
  )

  runtime.effect("parks a recoverable runtime extend rejection and reports the durable state", () =>
    Effect.gen(function* () {
      published.length = 0
      const workflow = yield* (yield* WorkflowTool).init()
      const spec_path = yield* writeWorkflowSpec("runtime-extend-failure", {
        nodes: [
          {
            id: "additional",
            name: "Additional",
            worker_type: "general",
            depends_on: [],
            prompt_template: { inline: "additional" },
          },
        ],
      })
      const result = yield* workflow
        .execute(
          Schema.decodeUnknownSync(Parameters)({
            params: {
              action: "run",
              operation: "extend",
              workflow_id: "dag_runtime_extend_failure",
              spec_path,
            },
          }),
          toolContext(),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(String(Cause.squash(result.cause))).toContain("simulated runtime batch write failure")
        expect(String(Cause.squash(result.cause))).toContain("Workflow state: paused (durably parked)")
      }
      expect(published.some((event) => event.type === DagEvent.WorkflowPaused.type)).toBe(true)
    }),
  )

  runtime.effect("replan without a fragment envelope is rejected with a precise, structured signal (P0-B/P1-F)", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      // A top-level nodes graph with no `fragment` envelope — the exact mistake
      // that previously surfaced as the misleading blocks/nodes union error.
      const spec_path = yield* writeWorkflowSpec("bad-envelope", {
        name: "bad-envelope",
        nodes: [{ id: "x", name: "X", worker_type: "general", depends_on: [], prompt_template: { inline: "work" } }],
      })
      const exit = yield* workflow
        .execute(
          Schema.decodeUnknownSync(Parameters)({
            params: {
              action: "control",
              workflow_id: "dag_defaults",
              operation: "replan",
              spec_path,
            },
          }),
          toolContext(),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const pretty = Cause.pretty(exit.cause)
        // P0-B: precise envelope diagnosis + targeted hint, never the union text.
        expect(pretty).toContain('missing required top-level key "fragment"')
        expect(pretty).toContain('Move "nodes" under "fragment".')
        expect(pretty).not.toContain("blocks graphs need name+objective+blocks")
        // P1-F: stable machine-readable retry signal for deterministic correction.
        expect(pretty).toContain("replan.envelope_missing")
        expect(pretty).toContain('"error_code":"replan_envelope_missing"')
        expect(pretty).toContain('"required_root_key":"fragment"')
      }
      // P0-C / audit #5: a rejected replan parks the workflow paused and
      // recoverable — it never fails or cancels the graph, and mutates no nodes.
      expect(published.some((event) => event.type === DagEvent.WorkflowPaused.type)).toBe(true)
      expect(published.some((event) => event.type === DagEvent.WorkflowFailed.type)).toBe(false)
      expect(published.some((event) => event.type === DagEvent.WorkflowCancelled.type)).toBe(false)
      expect(published.some((event) => event.type === DagEvent.NodeRegistered.type)).toBe(false)
    }),
  )

  runtime.effect("rejected replan reports a failed durable pause instead of claiming the workflow is parked", () =>
    Effect.gen(function* () {
      published.length = 0
      const workflow = yield* (yield* WorkflowTool).init()
      const specPath = yield* writeWorkflowSpec("pause-failure-replan", { nodes: [] })
      const exit = yield* workflow
        .execute(
          {
            params: {
              action: "control",
              operation: "replan",
              workflow_id: Dag.ID.make("dag_pause_failure"),
              spec_path: specPath,
            },
          },
          toolContext(),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("Workflow state: running")
        expect(message).toContain("Automatic pause failed")
        expect(message).toContain("simulated durable pause write failure")
        expect(message).not.toContain("Workflow state: paused (durably parked)")
      }
      expect(published.some((event) => event.type === DagEvent.WorkflowPaused.type)).toBe(false)
    }),
  )

  runtime.effect("invalid extend on a completed workflow reports its unchanged terminal state", () =>
    Effect.gen(function* () {
      published.length = 0
      const workflow = yield* (yield* WorkflowTool).init()
      const specPath = yield* writeWorkflowSpec("terminal-invalid-extend", { nodes: [{ id: "missing-fields" }] })
      const exit = yield* workflow
        .execute(
          {
            params: {
              action: "run",
              operation: "extend",
              workflow_id: Dag.ID.make("dag_completed"),
              spec_path: specPath,
            },
          },
          toolContext(),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("Workflow state: completed (unchanged)")
        expect(message).toContain("retry extend")
        expect(message).not.toContain("Automatic pause failed")
        expect(message).not.toContain("InvalidTransitionError")
        expect(message).not.toContain("Workflow state: paused (durably parked)")
      }
      expect(published.some((event) => event.type === DagEvent.WorkflowPaused.type)).toBe(false)
    }),
  )

  runtime.effect("accepts a flat { action } call without the params wrapper", () =>
    Effect.gen(function* () {
      const workflow = yield* (yield* WorkflowTool).init()
      const result = yield* workflow.execute({ action: "spec", operation: "list" } as never, toolContext())
      expect(result.title.length).toBeGreaterThan(0)
    }),
  )

  runtime.effect("extend_timeout routes to the durable command and renders its verdict (P0-A)", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      // The mocked store exposes no running node for dag_defaults, so the command
      // refuses with not_running — proving the control op routes to
      // dag.extendTimeout and renders the verdict with no durable side effect.
      // (The extended / no_escalation / escalation_undelivered / cap_exhausted verdicts are covered
      // against the real store in dag-deadline-extended.test.ts.)
      const result = yield* workflow.execute(
        Schema.decodeUnknownSync(Parameters)({
          params: {
            action: "control",
            workflow_id: "dag_defaults",
            operation: "extend_timeout",
            node_id: "node_missing",
            timeout_ms: 60_000,
          },
        }),
        toolContext(),
      )
      expect(result.title).toContain("Node not running")
      expect(result.output).toContain('action="extend_timeout"')
      expect(result.output).toContain('status="not_running"')
      expect(result.metadata.nodeId).toBe(DagEvent.NodeID.make("node_missing"))
      expect(published).toHaveLength(0)
    }),
  )

  runtime.effect("cancel_node forwards the reason and warns when a required node is cancelled", () =>
    Effect.gen(function* () {
      published.length = 0
      const workflow = yield* (yield* WorkflowTool).init()
      const result = yield* workflow.execute(
        {
          params: {
            action: "control",
            operation: "cancel_node",
            workflow_id: Dag.ID.make("dag_status"),
            node_id: Dag.NodeID.make("node_running"),
            reason: "route changed",
          },
        },
        toolContext(),
      )
      expect(result.title).toBe("Workflow node cancelled: node_running")
      // node_running is required, so the output explains the follow-on failure.
      expect(result.output).toContain("required")
      expect(result.output).toContain("workflow fails")
      const cancelled = published.find((event) => event.type === DagEvent.NodeCancelled.type)
      expect(cancelled?.data).toMatchObject({ source: "control", reason: "route changed" })

      // A terminal node cannot be cancelled again.
      const exit = yield* workflow
        .execute(
          {
            params: {
              action: "control",
              operation: "cancel_node",
              workflow_id: Dag.ID.make("dag_status"),
              node_id: Dag.NodeID.make("node_failed"),
            },
          },
          toolContext(),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Cannot transition from terminal state")
      }
    }),
  )

  runtime.effect("replanning a gate-paused workflow resumes it so corrective nodes can run", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const spec_path = yield* writeWorkflowSpec("paused-replan", {
        fragment: {
          name: "paused-replan",
          nodes: [
            {
              id: "corrective",
              name: "Corrective",
              worker_type: "general",
              depends_on: [],
              prompt_template: { inline: "work" },
            },
          ],
        },
      })
      const result = yield* workflow.execute(
        Schema.decodeUnknownSync(Parameters)({
          params: {
            action: "control",
            workflow_id: "dag_paused",
            operation: "replan",
            spec_path,
          },
        }),
        toolContext(),
      )

      expect(result.title).toContain("Workflow replanned: +1")
      expect(result.output).toContain("has been resumed")
      expect(published.some((event) => event.type === DagEvent.WorkflowResumed.type)).toBe(true)
    }),
  )

  runtime.effect("extending a paused workflow resumes it so added nodes can run (#381)", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const spec_path = yield* writeWorkflowSpec("paused-extend", {
        nodes: [
          {
            id: "added-while-paused",
            name: "Added while paused",
            worker_type: "general",
            depends_on: [],
            prompt_template: { inline: "work" },
          },
        ],
      })
      const result = yield* workflow.execute(
        Schema.decodeUnknownSync(Parameters)({
          params: {
            action: "run",
            operation: "extend",
            workflow_id: "dag_paused",
            spec_path,
          },
        }),
        toolContext(),
      )

      expect(result.title).toContain("Workflow extended: 1 nodes added")
      expect(result.output).toContain("has been resumed")
      expect(published.some((event) => event.type === DagEvent.WorkflowResumed.type)).toBe(true)
    }),
  )

  runtime.effect("rejects inline or missing spec sources before side effects", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const cases = [
        {
          params: {
            action: "run",
            operation: "start",
            spec: { config: { name: "ambiguous", nodes: [] } },
            spec_path: "saved-workflow",
          },
        },
        {
          params: { action: "run", operation: "start" },
        },
      ]

      for (const item of cases) {
        published.length = 0
        // Source exclusivity is owned by the parameter schema: the real tool
        // path strict-decodes before execute, so neither shape can reach the
        // DAG service or publish an event.
        const exit = yield* Effect.sync(() =>
          Schema.decodeUnknownSync(Parameters, { onExcessProperty: "error" })(item.params),
        ).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(published).toHaveLength(0)
      }

      // Recovery guidance tells the model to move graph content into a spec
      // file — never an inline spec field.
      const guidance = workflow.formatValidationError?.(new Error("no branch matched")) ?? ""
      expect(guidance).toContain("run {start|extend}")
      expect(guidance).toContain("spec {list|read|draft|validate}")
      expect(guidance).toContain("Put graph content in a spec file")
    }),
  )

  runtime.effect("maps legacy action names to the converged call shapes", () =>
    Effect.gen(function* () {
      const workflow = yield* (yield* WorkflowTool).init()
      const cases = [
        { action: "start", expected: 'action:"run",operation:"start"' },
        { action: "extend", expected: 'action:"run",operation:"extend"' },
        { action: "status", expected: 'action:"inspect",operation:"status"' },
        { action: "result", expected: 'action:"inspect",operation:"result"' },
        { action: "list", expected: 'action:"spec",operation:"list"' },
        { action: "read", expected: 'action:"spec",operation:"read"' },
        { action: "draft", expected: 'action:"spec",operation:"draft"' },
        { action: "validate", expected: 'action:"spec",operation:"validate"' },
        { action: "guide", expected: "guide action was removed" },
        { action: "extend_timeout", expected: 'operation:"extend_timeout"' },
      ]
      for (const item of cases) {
        const input = { params: { action: item.action, workflow_id: "dag_wf_1" } }
        const text = workflow.formatValidationError?.(new Error("no branch matched"), input) ?? ""
        expect(text, item.action).toContain(`workflow no longer has a ${item.action} action`)
        expect(text, item.action).toContain(item.expected)
        expect(text.length, item.action).toBeLessThan(600)
      }
    }),
  )

  runtime.effect("bounds schema errors and points workflow messaging actions at agent", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const decode = Schema.decodeUnknownResult(Parameters, { onExcessProperty: "error" })
      const marker = "DAG_952_NODE_MARKER_"
      const long = marker.repeat(200)
      const cases = [
        {
          input: {
            params: {
              action: "spec",
              operation: "draft",
              config: {
                name: "large-draft",
                objective: "prove bounded schema output",
                blocks: [{ id: "b", kind: "explore", worker: long }],
              },
            },
          },
          expected: "workflow call rejected",
        },
        {
          input: {
            params: { action: "extend_timeout", workflow_id: "wf", node_id: "a", timeout_ms: 900_000 },
          },
          expected: 'operation:"extend_timeout"',
          expectedDetail: '["params"]["action"] "extend_timeout"',
        },
        {
          input: { params: { action: "receive" } },
          expected: "use agent",
          expectedDetail: '["params"]["action"] "receive"',
        },
        {
          input: { params: { action: "SECRET_MARKER\nprivate" } },
          expected: "workflow call rejected",
          expectedDetail: '["params"]["action"]',
        },
      ]
      for (const item of cases) {
        const result = decode(item.input)
        expect(result._tag).toBe("Failure")
        if (result._tag !== "Failure") continue
        const text = workflow.formatValidationError?.(result.failure, item.input) ?? ""
        expect(text).toContain(item.expected)
        if (item.expectedDetail) expect(text).toContain(item.expectedDetail)
        expect(text).not.toContain(marker)
        expect(text).not.toContain("SECRET_MARKER")
        expect(text).not.toContain("\n")
        expect(text.length).toBeLessThan(600)
      }
    }),
  )

  runtime.effect("redacts dynamic record keys in real draft errors and logs", () =>
    Effect.gen(function* () {
      const workflow = yield* (yield* WorkflowTool).init()
      const ctx: Tool.Context = {
        sessionID: SessionID.make("ses_synthetic"),
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const params = {
        action: "spec",
        operation: "draft",
        config: {
          name: "test",
          nodes: [
            {
              id: "a",
              name: "a",
              worker_type: "general",
              depends_on: [],
              prompt_template: { inline: "test" },
              input_mapping: { SYNTHETIC_KEY_952: 7 },
            },
          ],
        },
      }
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- malformed value tests the real tool decoder
      const exit = yield* Effect.exit(workflow.execute({ params } as any, ctx))
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : ""
      expect(error).not.toContain("SYNTHETIC_KEY_952")
      expect(error).toContain("input_mapping")
      expect(error).toContain('["input_mapping"]["<key>"]')
      expect(error).toContain("[0]")
      expect(error.length).toBeLessThan(650)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- flat malformed call must also traverse repair logging
      const flat = yield* Effect.exit(workflow.execute(params as any, ctx))
      expect(Exit.isFailure(flat)).toBe(true)
      const flatError = Exit.isFailure(flat) ? String(Cause.squash(flat.cause)) : ""
      expect(flatError).not.toContain("SYNTHETIC_KEY_952")
      const logs = JSON.stringify(yield* logLines)
      expect(logs).toContain("tool arguments repaired")
      expect(logs).not.toContain("SYNTHETIC_KEY_952")
      const valid = {
        ...params,
        config: { ...params.config, nodes: [{ ...params.config.nodes[0], input_mapping: { source: "value" } }] },
      }
      const decoded = Schema.decodeUnknownResult(Parameters)({ params: valid })
      expect(decoded._tag).toBe("Success")
      if (
        decoded._tag === "Success" &&
        decoded.success.params.action === "spec" &&
        decoded.success.params.operation === "draft" &&
        "nodes" in decoded.success.params.config
      )
        expect(decoded.success.params.config.nodes?.[0].input_mapping).toEqual({ source: "value" })
    }),
  )

  it("redacts dynamic keys for arbitrary schemas without hardcoded field names", () => {
    const schema = Schema.Struct({ arbitrary: Schema.Array(Schema.Record(Schema.String, Schema.String)) })
    const decoded = Schema.decodeUnknownResult(schema)({ arbitrary: [{ arbitrary: 7, SECRET_OTHER: 9 }] })
    expect(decoded._tag).toBe("Failure")
    if (decoded._tag !== "Failure") return
    const failures = schemaFailures(decoded.failure, 10)
    expect(failures.some((failure) => failure.path === '["arbitrary"][0]["<key>"]')).toBe(true)
    expect(JSON.stringify(failures)).not.toContain("SECRET_OTHER")
  })

  runtime.effect("status and recovery reads retain consumed deep admission audit fields", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        {
          params: {
            action: "inspect",
            operation: "status",
            workflow_id: Dag.ID.make("dag_deep_status"),
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      const output = JSON.parse(result.output)
      expect(output).toEqual(
        expect.objectContaining({
          mode: "deep",
          admission: {
            verdict: "WAIVED",
            state: "CONSUMED",
            qa_mode: "STANDARD",
            brief_revision: 1,
            fingerprint: admissionFor("WAIVED").fingerprint,
            waiver_reason: "Preview release only",
            acknowledged_risks: ["Production rollout is unresolved"],
          },
        }),
      )
      expect(output.admission).not.toHaveProperty("qa_transcript")
    }),
  )

  runtime.effect("deep start repairs one YAML file and owns admission audit fields", () =>
    Effect.gen(function* () {
      published.length = 0
      const specPath = path.join(workflowSpecDirectory, "deep.yaml")
      yield* Effect.promise(() =>
        Bun.write(
          specPath,
          `title: Deep ready
mode: deep
admission:
  brief_revision: 1
  qa_mode: STANDARD
  verdict: READY
config:
  name: deep-ready
  nodes: []
`,
        ),
      )

      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const context = {
        sessionID: SessionID.make("ses_workflow_parent"),
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } satisfies Tool.Context
      const invalid = yield* workflow
        .execute(
          {
            params: {
              action: "run",
              operation: "start",
              spec_path: "deep.yaml",
            },
          },
          context,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(invalid)).toBe(true)
      if (Exit.isFailure(invalid)) {
        expect(Cause.pretty(invalid.cause)).toContain('["admission"]["brief"]')
      }
      expect(published).toHaveLength(0)

      yield* Effect.promise(() =>
        Bun.write(
          specPath,
          `title: Deep ready
mode: deep
admission:
  protocol_version: 999
  brief_revision: 1
  qa_mode: STANDARD
  verdict: READY
  state: CONSUMED
  fingerprint: ${"0".repeat(64)}
  brief:
    goal: Qualify and execute a deep workflow
    scope:
      in: [workflow start, review lifecycle]
      out: [new admission UI]
    constraints: [standard workflows stay compatible]
    assumptions: [the parent session can ask questions]
    acceptance_criteria: [deep start requires READY or WAIVED]
    evidence_required: [unit tests, integration tests]
    risks: [waiver misuse]
    review_plan: [verify, review the implementation diff]
    open_questions: []
    blocking_questions: []
config:
  name: deep-ready
  nodes: []
`,
        ),
      )

      const result = yield* workflow.execute(
        {
          params: {
            action: "run",
            operation: "start",
            spec_path: "deep.yaml",
          },
        },
        context,
      )

      expect(result.output).toContain('mode="deep"')
      const created = published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data as {
        config?: string
      }
      expect(JSON.parse(created.config ?? "{}")).toEqual(
        expect.objectContaining({
          mode: "deep",
          admission: expect.objectContaining({
            protocol_version: 1,
            verdict: "READY",
            state: "CONSUMED",
            fingerprint: fingerprintBrief(admissionBrief),
          }),
        }),
      )
    }),
  )

  runtime.effect("invalid YAML reports its source file without workflow side effects", () =>
    Effect.gen(function* () {
      published.length = 0
      const specPath = path.join(workflowSpecDirectory, "invalid.yaml")
      yield* Effect.promise(() => Bun.write(specPath, "config:\n  nodes: [\n"))
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const exit = yield* workflow
        .execute(
          {
            params: {
              action: "run",
              operation: "start",
              spec_path: specPath,
            },
          },
          {
            sessionID: SessionID.make("ses_workflow_parent"),
            messageID: MessageID.ascending(),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          } satisfies Tool.Context,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("[schema.invalid] $: file is not parseable YAML")
      }
      expect(published).toHaveLength(0)
    }),
  )

  runtime.effect("start derives the project ID from the parent session", () =>
    Effect.gen(function* () {
      published.length = 0
      const parentID = SessionID.make("ses_workflow_parent")
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const specPath = yield* writeWorkflowSpec("project-id-regression", {
        config: {
          name: "project-id-regression",
          nodes: [],
        },
      })

      const result = yield* workflow.execute(
        {
          params: {
            action: "run",
            operation: "start",
            spec_path: specPath,
          },
        },
        {
          sessionID: parentID,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      const workflowID = result.metadata.workflowId
      expect(workflowID).toBeDefined()
      expect(result.output).toContain("Do not poll")
      expect(published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data).toEqual(
        expect.objectContaining({ projectID, sessionID: parentID }),
      )
      const created = published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data as {
        config?: string
      }
      expect(JSON.parse(created.config ?? "{}").mode).toBe("standard")
    }),
  )

  missingModelRuntime.effect("start returns a recoverable blocker without asking the user or creating a workflow", () =>
    Effect.gen(function* () {
      published.length = 0
      questionsAsked.length = 0
      missingModelDirectory = yield* missingModelProject()

      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        {
          params: {
            action: "run",
            operation: "start",
            spec_path: "missing-model.yaml",
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(result.title).toBe("Workflow not started: model required")
      expect(result.metadata.workflowId).toBeUndefined()
      expect(questionsAsked).toHaveLength(0)
      expect(result.metadata.blocked).toBe(true)
      const report = JSON.parse(result.output)
      expect(report.workflow_created).toBe(false)
      expect(report.recovery.max_attempts).toBe(2)
      expect(report.errors[0].code).toBe("model.unavailable")
      expect(published).toHaveLength(0)
    }),
  )

  missingModelRuntime.effect("validate(environment) reports the same missing model before start", () =>
    Effect.gen(function* () {
      missingModelDirectory = yield* missingModelProject()

      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        {
          params: {
            action: "spec",
            operation: "validate",
            spec_path: "missing-model.yaml",
            profile: "environment",
          },
        },
        toolContext(),
      )

      const report = JSON.parse(result.output)
      expect(report.valid).toBe(false)
      expect(report.profile).toBe("environment")
      const diagnostic = report.errors.find((d: { code: string }) => d.code === "model.unavailable")
      expect(diagnostic?.path).toBe("nodes[worker]")
      expect(result.title).toContain("failed")
      expect(result.metadata.blocked).toBe(true)
      expect(result.metadata.diagnosticSummary).toContain("model.unavailable")
      expect(report.recovery.max_attempts).toBe(2)
    }),
  )

  missingModelRuntime.effect("validate(environment) rejects a configured model absent from the provider catalog", () =>
    Effect.gen(function* () {
      missingModelDirectory = yield* missingCatalogModelProject()
      published.length = 0

      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        {
          params: {
            action: "spec",
            operation: "validate",
            spec_path: "missing-catalog-model.yaml",
            profile: "environment",
          },
        },
        toolContext(),
      )

      const report = JSON.parse(result.output)
      expect(report.valid).toBe(false)
      expect(report.errors).toContainEqual(
        expect.objectContaining({ code: "model.unavailable", path: "nodes[worker]" }),
      )
      const started = yield* workflow.execute(
        { params: { action: "run", operation: "start", spec_path: "missing-catalog-model.yaml" } },
        toolContext(),
      )
      expect(started.title).toBe("Workflow not started: model required")
      expect(started.metadata.workflowId).toBeUndefined()
      expect(published).toHaveLength(0)
    }),
  )

  missingModelRuntime.effect("extend and replan reject unresolved models before durable events", () =>
    Effect.gen(function* () {
      missingModelDirectory = yield* missingModelProject()
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const node = {
        id: "unresolved",
        name: "Unresolved",
        worker_type: "build",
        depends_on: [],
        prompt_template: { inline: "work" },
      }
      const extendPath = path.join(missingModelDirectory, "unresolved-extend.yaml")
      const replanPath = path.join(missingModelDirectory, "unresolved-replan.yaml")
      yield* Effect.promise(() => Bun.write(extendPath, JSON.stringify({ nodes: [node] })))
      yield* Effect.promise(() =>
        Bun.write(replanPath, JSON.stringify({ fragment: { name: "unresolved-replan", nodes: [node] } })),
      )

      const extendExit = yield* workflow
        .execute(
          {
            params: {
              action: "run",
              operation: "extend",
              workflow_id: Dag.ID.make("dag_paused"),
              spec_path: extendPath,
            },
          },
          toolContext(),
        )
        .pipe(Effect.exit)
      const replanExit = yield* workflow
        .execute(
          {
            params: {
              action: "control",
              operation: "replan",
              workflow_id: Dag.ID.make("dag_paused"),
              spec_path: replanPath,
            },
          },
          toolContext(),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(extendExit)).toBe(true)
      expect(Exit.isFailure(replanExit)).toBe(true)
      if (Exit.isFailure(extendExit)) expect(Cause.pretty(extendExit.cause)).toContain("model.unavailable")
      if (Exit.isFailure(replanExit)) expect(Cause.pretty(replanExit.cause)).toContain("model.unavailable")
      expect(published).toHaveLength(0)
    }),
  )

  missingModelRuntime.effect("extend and replan honor persisted or explicit node models", () =>
    Effect.gen(function* () {
      missingModelDirectory = yield* missingModelProject()
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const node = {
        id: "modeled",
        name: "Modeled",
        worker_type: "build",
        depends_on: [],
        prompt_template: { inline: "work" },
      }
      const extendPath = path.join(missingModelDirectory, "modeled-extend.yaml")
      yield* Effect.promise(() => Bun.write(extendPath, JSON.stringify({ nodes: [node] })))

      const extended = yield* workflow.execute(
        {
          params: {
            action: "run",
            operation: "extend",
            workflow_id: Dag.ID.make("dag_defaults"),
            spec_path: extendPath,
          },
        },
        toolContext(),
      )
      const replanned = yield* workflow.execute(
        {
          params: {
            action: "control",
            operation: "replan",
            workflow_id: Dag.ID.make("dag_paused"),
            spec_path: yield* Effect.promise(() =>
              Bun.write(
                path.join(missingModelDirectory, "modeled-replan.yaml"),
                JSON.stringify({
                  fragment: {
                    name: "modeled-replan",
                    nodes: [
                      {
                        ...node,
                        model: {
                          providerID: "local-proxy-compatible",
                          modelID: "local-proxy-compatible/glm-5.2",
                        },
                      },
                    ],
                  },
                }),
              ).then(() => path.join(missingModelDirectory, "modeled-replan.yaml")),
            ),
          },
        },
        toolContext(),
      )

      expect(extended.title).toContain("Workflow extended")
      expect(replanned.title).toContain("Workflow replanned")
    }),
  )

  runtime.effect("deep start consumes and retains an informed WAIVED admission", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const specPath = yield* writeWorkflowSpec("deep-waived", {
        mode: "deep",
        admission: admissionInputFor("WAIVED"),
        config: {
          name: "deep-waived",
          nodes: [],
        },
      })
      yield* workflow.execute(
        {
          params: {
            action: "run",
            operation: "start",
            spec_path: specPath,
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      const created = published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data as {
        config?: string
      }
      expect(JSON.parse(created.config ?? "{}").admission).toEqual(
        expect.objectContaining({
          verdict: "WAIVED",
          state: "CONSUMED",
          waiver_reason: "Preview release only",
          acknowledged_risks: ["Production rollout is unresolved"],
        }),
      )
    }),
  )

  runtime.effect("start strips persisted admission audit fields read from disk and regenerates them", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      // Legacy saved specs may embed the persisted record shape. The audit
      // fields are boundary-owned: stripped at the file-read boundary and
      // regenerated by createAdmissionRecord.
      const specPath = yield* writeWorkflowSpec("deep-legacy-admission", {
        mode: "deep",
        admission: {
          ...admissionInputFor("WAIVED"),
          protocol_version: 9,
          state: "CONSUMED",
          fingerprint: "stale-fingerprint",
        },
        config: {
          name: "deep-legacy-admission",
          nodes: [],
        },
      })
      yield* workflow.execute(
        {
          params: {
            action: "run",
            operation: "start",
            spec_path: specPath,
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      const created = published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data
      if (!created || typeof created !== "object" || !("config" in created) || typeof created.config !== "string") {
        throw new Error("workflow.created event did not include serialized config")
      }
      const admission = JSON.parse(created.config).admission
      expect(admission).toEqual(expect.objectContaining({ protocol_version: 1, verdict: "WAIVED", state: "CONSUMED" }))
      expect(admission.fingerprint).not.toBe("stale-fingerprint")
      expect(admission.fingerprint).toBe(fingerprintBrief(admission.brief))
    }),
  )

  runtime.effect("deep start blocks missing or non-ready admission without side effects", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const cases = [
        {
          name: "missing",
          value: {
            mode: "deep",
            config: {
              name: "deep-missing",
              nodes: [],
            },
          },
        },
        {
          name: "not-ready",
          value: {
            mode: "deep",
            admission: admissionInputFor("NOT_READY"),
            config: {
              name: "deep-not-ready",
              nodes: [],
            },
          },
        },
        {
          name: "waived-without-audit",
          value: {
            mode: "deep",
            admission: {
              ...admissionInputFor("WAIVED"),
              waiver_reason: undefined,
              acknowledged_risks: undefined,
            },
            config: {
              name: "deep-waived-without-audit",
              nodes: [],
            },
          },
        },
      ]

      for (const item of cases) {
        published.length = 0
        const specPath = yield* writeWorkflowSpec(`blocked-${item.name}`, item.value)
        const exit = yield* workflow
          .execute(
            {
              params: {
                action: "run",
                operation: "start",
                spec_path: specPath,
              },
            },
            {
              sessionID: SessionID.make("ses_workflow_parent"),
              messageID: MessageID.ascending(),
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            } satisfies Tool.Context,
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(published).toHaveLength(0)
      }
    }),
  )

  runtime.effect("start passes the decoded required default to Dag.create", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const specPath = yield* writeWorkflowSpec("required-default", {
        config: {
          name: "required-default",
          nodes: [
            {
              id: "optional-node",
              name: "Optional node",
              worker_type: "build",
              depends_on: [],
              prompt_template: { inline: "work" },
            },
          ],
        },
      })

      yield* workflow.execute(
        {
          params: {
            action: "run",
            operation: "start",
            spec_path: specPath,
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toEqual(
        expect.objectContaining({ required: false }),
      )
    }),
  )

  runtime.effect("start resolves omitted values from workflow config defaults", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const specPath = yield* writeWorkflowSpec("configured-defaults", {
        config: {
          name: "configured-defaults",
          node_defaults: {
            required: true,
            report_to_parent: true,
            worker_config: { timeout_ms: 1234 },
          },
          nodes: [
            {
              id: "inherits",
              name: "Inherits defaults",
              worker_type: "general",
              depends_on: [],
              prompt_template: { inline: "work" },
            },
            {
              id: "overrides",
              name: "Overrides defaults",
              worker_type: "general",
              depends_on: [],
              required: false,
              report_to_parent: false,
              worker_config: { timeout_ms: 4321 },
              prompt_template: { inline: "work" },
            },
          ],
        },
      })

      yield* workflow.execute(
        {
          params: {
            action: "run",
            operation: "start",
            spec_path: specPath,
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      const created = published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data as {
        config?: string
      }
      const config = JSON.parse(created.config ?? "{}")
      expect(config).toEqual(
        expect.objectContaining({
          max_concurrency: 5,
          max_node_replan_attempts: 5,
          max_total_nodes: 100,
        }),
      )
      expect(config.nodes[0]).toEqual(
        expect.objectContaining({
          required: true,
          report_to_parent: true,
          worker_config: { timeout_ms: 1234 },
        }),
      )
      expect(config.nodes[1]).toEqual(
        expect.objectContaining({
          required: false,
          report_to_parent: false,
          worker_config: { timeout_ms: 4321 },
        }),
      )
    }),
  )

  // issue #425: block-level worker_config rides through compilation onto the
  // expanded nodes and beats node_defaults; omitted blocks still inherit.
  runtime.effect("start resolves block worker_config over node_defaults", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const specPath = yield* writeWorkflowSpec("block-worker-config", {
        config: {
          name: "block-worker-config",
          objective: "Bound each block individually.",
          node_defaults: {
            worker_config: { timeout_ms: 1234 },
          },
          blocks: [
            { id: "override", kind: "coding", worker_config: { timeout_ms: 4321 } },
            { id: "inherit", kind: "verify", depends_on: ["override"] },
            { id: "diag", kind: "debug", depends_on: ["inherit"], worker_config: { timeout_ms: 4321 } },
          ],
        },
      })

      yield* workflow.execute(
        {
          params: {
            action: "run",
            operation: "start",
            spec_path: specPath,
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      const created = published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data
      const configJSON =
        typeof created === "object" && created !== null && "config" in created && typeof created.config === "string"
          ? created.config
          : "{}"
      const nodes: Array<{ id: string; worker_config?: { timeout_ms?: number } }> = JSON.parse(configJSON).nodes ?? []
      expect(Object.fromEntries(nodes.map((node) => [node.id, node.worker_config?.timeout_ms]))).toEqual({
        override: 4321,
        inherit: 1234,
        "diag--evidence": 4321,
        diag: 4321,
      })
    }),
  )

  runtime.effect("extend resolves new nodes from the persisted workflow defaults", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const specPath = yield* writeWorkflowSpec("extend-defaults", {
        nodes: [
          {
            id: "added",
            name: "Added node",
            worker_type: "general",
            depends_on: [],
            prompt_template: { inline: "work" },
          },
        ],
      })

      yield* workflow.execute(
        {
          params: {
            action: "run",
            operation: "extend",
            workflow_id: Dag.ID.make("dag_defaults"),
            spec_path: specPath,
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toEqual(
        expect.objectContaining({
          nodeID: "added",
          required: true,
          model: {
            providerID: "local-proxy-compatible",
            modelID: "glm-5.2",
          },
        }),
      )
      const updated = published.find((event) => event.type === DagEvent.WorkflowConfigUpdated.type)?.data as {
        config?: string
      }
      expect(JSON.parse(updated.config ?? "{}").nodes[0]).toEqual(
        expect.objectContaining({
          report_to_parent: true,
          worker_config: { timeout_ms: 1234 },
        }),
      )
    }),
  )

  runtime.effect("replan resolves new nodes from the persisted workflow defaults", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const specPath = yield* writeWorkflowSpec("replan-defaults", {
        fragment: {
          name: "replan-fragment",
          nodes: [
            {
              id: "replanned",
              name: "Replanned node",
              worker_type: "general",
              depends_on: [],
              prompt_template: { inline: "work" },
            },
          ],
        },
      })

      yield* workflow.execute(
        {
          params: {
            action: "control",
            workflow_id: Dag.ID.make("dag_defaults"),
            operation: "replan",
            spec_path: specPath,
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toEqual(
        expect.objectContaining({
          nodeID: "replanned",
          required: true,
          model: {
            providerID: "local-proxy-compatible",
            modelID: "glm-5.2",
          },
        }),
      )
      const updated = published.find((event) => event.type === DagEvent.WorkflowConfigUpdated.type)?.data as {
        config?: string
      }
      expect(JSON.parse(updated.config ?? "{}").nodes[0]).toEqual(
        expect.objectContaining({
          report_to_parent: true,
          worker_config: { timeout_ms: 1234 },
        }),
      )
    }),
  )

  runtime.effect("start does not accept a model-authored project identity", () =>
    Effect.gen(function* () {
      // Runtime identity fields are derived from the authenticated tool
      // context and the loaded session, never authored by the model: the
      // strict parameter decode rejects a project_id supplied by the caller.
      const decode = Schema.decodeUnknownSync(Parameters, { onExcessProperty: "error" })
      expect(() =>
        decode({
          params: {
            action: "run",
            operation: "start",
            project_id: "project_other",
            spec_path: "project-id-mismatch.yaml",
          },
        }),
      ).toThrow()
    }),
  )

  runtime.effect("start does not accept a model-authored session identity", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownSync(Parameters, { onExcessProperty: "error" })
      expect(() =>
        decode({
          params: {
            action: "run",
            operation: "start",
            session_id: "ses_other_parent",
            spec_path: "foreign-parent.yaml",
          },
        }),
      ).toThrow()
    }),
  )
})

describe("workflow tool saved workflows", () => {
  // The global scope reads Flag.GRAPHAGENT_CONFIG_DIR from the env; point it at a
  // fresh directory so the real user config dir is never touched.
  const withGlobalConfigDir = <A, E, R>(self: (globalDir: string) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-global-"))
        const previous = process.env.GRAPHAGENT_CONFIG_DIR
        process.env.GRAPHAGENT_CONFIG_DIR = globalDir
        return { globalDir, previous }
      }),
      (state) => self(state.globalDir),
      (state) =>
        Effect.promise(async () => {
          if (state.previous === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
          else process.env.GRAPHAGENT_CONFIG_DIR = state.previous
          await fs.rm(state.globalDir, { recursive: true, force: true })
        }),
    )

  const savedSpec = (name: string) => `title: ${name} title\nconfig:\n  name: ${name}\n  nodes: []\n`

  const contextWith = (asked: unknown[]) =>
    ({
      sessionID: SessionID.make("ses_workflow_parent"),
      messageID: MessageID.ascending(),
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: (input: unknown) =>
        Effect.sync(() => {
          asked.push(input)
        }),
    }) satisfies Tool.Context

  runtime.effect("read returns a saved route for parent retargeting without starting it", () =>
    withGlobalConfigDir(() =>
      Effect.gen(function* () {
        published.length = 0
        yield* Effect.promise(() =>
          Bun.write(
            path.join(workflowSpecDirectory, ".agents", "workflows", "saved-readable.yaml"),
            [
              "title: Saved readable route",
              "config:",
              "  name: saved-readable",
              "  objective: Replace this generic objective",
              "  blocks:",
              "    - id: map",
              "      kind: explore",
              "",
            ].join("\n"),
          ),
        )
        const info = yield* WorkflowTool
        const workflow = yield* info.init()
        const asked: unknown[] = []

        const result = yield* workflow.execute(
          { params: { action: "spec", operation: "read", spec_path: "saved-readable" } },
          contextWith(asked),
        )

        expect(result.title).toBe("Workflow spec: saved-readable")
        const payload = JSON.parse(result.output)
        expect(payload.spec).toMatchObject({
          title: "Saved readable route",
          config: {
            objective: "Replace this generic objective",
            blocks: [{ id: "map", kind: "explore" }],
          },
        })
        expect(payload.validation.valid).toBe(true)
        expect(asked).toEqual([
          expect.objectContaining({ permission: "workflow", patterns: ["spec", "spec:read", "read"] }),
        ])
        expect(published).toHaveLength(0)
      }),
    ),
  )

  runtime.effect("start resolves a bare name against the project workflow library", () =>
    withGlobalConfigDir(() =>
      Effect.gen(function* () {
        published.length = 0
        yield* Effect.promise(() =>
          Bun.write(
            path.join(workflowSpecDirectory, ".agents", "workflows", "saved-project.yaml"),
            savedSpec("saved-project"),
          ),
        )
        const info = yield* WorkflowTool
        const workflow = yield* info.init()
        const asked: unknown[] = []

        const result = yield* workflow.execute(
          { params: { action: "run", operation: "start", spec_path: "saved-project" } },
          contextWith(asked),
        )

        expect(result.output).toContain('state="running"')
        expect(result.title).toBe("Workflow started: saved-project")
        expect(asked).toEqual([
          expect.objectContaining({ permission: "workflow", patterns: ["run", "run:start", "start"] }),
        ])
      }),
    ),
  )

  runtime.effect("start resolves a global saved workflow without an external-directory prompt", () =>
    withGlobalConfigDir((globalDir) =>
      Effect.gen(function* () {
        published.length = 0
        yield* Effect.promise(() =>
          Bun.write(path.join(globalDir, "workflows", "saved-global.yaml"), savedSpec("saved-global")),
        )
        const info = yield* WorkflowTool
        const workflow = yield* info.init()
        const asked: unknown[] = []

        const result = yield* workflow.execute(
          { params: { action: "run", operation: "start", spec_path: "saved-global" } },
          contextWith(asked),
        )

        expect(result.title).toBe("Workflow started: saved-global")
        // The library's two scopes are curated config, so a resolved name never
        // asks for external-directory permission.
        expect(asked).toEqual([
          expect.objectContaining({ permission: "workflow", patterns: ["run", "run:start", "start"] }),
        ])
      }),
    ),
  )

  runtime.effect("an unresolved name fails with the directories that were searched", () =>
    withGlobalConfigDir((globalDir) =>
      Effect.gen(function* () {
        published.length = 0
        const info = yield* WorkflowTool
        const workflow = yield* info.init()
        const exit = yield* workflow
          .execute({ params: { action: "run", operation: "start", spec_path: "not-saved" } }, contextWith([]))
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const message = Cause.pretty(exit.cause)
          expect(message).toContain('Saved workflow not found: "not-saved"')
          expect(message).toContain(path.join(workflowSpecDirectory, ".agents", "workflows"))
          expect(message).toContain(path.join(globalDir, "workflows"))
        }
        expect(published).toHaveLength(0)
      }),
    ),
  )

  runtime.effect("list reports both scopes with the project entry shadowing the global one", () =>
    withGlobalConfigDir((globalDir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(path.join(globalDir, "workflows", "shared.yaml"), savedSpec("global-shared")),
            Bun.write(path.join(globalDir, "workflows", "global-only.yaml"), savedSpec("global-only")),
            Bun.write(
              path.join(globalDir, "workflows", "block-flow.yaml"),
              "title: block flow title\nconfig:\n  name: block-flow\n  objective: Review a bounded change\n  blocks:\n    - id: decision\n      kind: review\n",
            ),
            Bun.write(
              path.join(workflowSpecDirectory, ".agents", "workflows", "shared.yaml"),
              savedSpec("project-shared"),
            ),
          ]),
        )
        const info = yield* WorkflowTool
        const workflow = yield* info.init()

        const result = yield* workflow.execute({ params: { action: "spec", operation: "list" } }, contextWith([]))

        expect(result.output).toContain("shared [project] — project-shared title")
        expect(result.output).toContain("global-only [global] — global-only title")
        expect(result.output).toContain("block-flow [global] — block flow title (1 blocks)")
        expect(result.output).toContain("objective: Review a bounded change")
        expect(result.output).not.toContain("global-shared")
      }),
    ),
  )

  runtime.effect("list explains where to save a spec when the library is empty", () =>
    withGlobalConfigDir((globalDir) =>
      Effect.gen(function* () {
        // A previous case may have seeded the project scope — start clean.
        yield* Effect.promise(() =>
          fs.rm(path.join(workflowSpecDirectory, ".agents", "workflows"), { recursive: true, force: true }),
        )
        const info = yield* WorkflowTool
        const workflow = yield* info.init()

        const result = yield* workflow.execute({ params: { action: "spec", operation: "list" } }, contextWith([]))

        expect(result.title).toBe("No saved workflows")
        expect(result.output).toContain(path.join(workflowSpecDirectory, ".agents", "workflows"))
        expect(result.output).toContain(path.join(globalDir, "workflows"))
      }),
    ),
  )

  runtime.effect("validate(portable) does not load agent or skill catalogs", () =>
    Effect.gen(function* () {
      environmentAgentListCalls = 0
      environmentSkillListCalls = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const spec_path = yield* writeWorkflowSpec("portable-file", {
        config: { name: "portable-file", nodes: [] },
      })

      const result = yield* workflow.execute(
        {
          params: {
            action: "spec",
            operation: "validate",
            profile: "portable",
            spec_path,
          },
        },
        toolContext(),
      )

      expect(JSON.parse(result.output).valid).toBe(true)
      expect(environmentAgentListCalls).toBe(0)
      expect(environmentSkillListCalls).toBe(0)
    }),
  )

  runtime.effect("validate(environment) snapshots required catalogs once and never reads Skills", () =>
    Effect.gen(function* () {
      environmentAgentListCalls = 0
      environmentSkillListCalls = 0
      environmentProviderListCalls = 0
      environmentProviderGetModelCalls = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const spec_path = yield* writeWorkflowSpec("catalog-snapshot", {
        config: {
          name: "catalog-snapshot",
          nodes: [
            {
              id: "first",
              name: "First",
              worker_type: "build",
              depends_on: [],
              prompt_template: { inline: "First" },
            },
            {
              id: "second",
              name: "Second",
              worker_type: "build",
              depends_on: ["first"],
              prompt_template: { inline: "Second" },
            },
          ],
        },
      })

      const result = yield* workflow.execute(
        {
          params: {
            action: "spec",
            operation: "validate",
            profile: "environment",
            spec_path,
          },
        },
        toolContext(),
      )

      expect(JSON.parse(result.output).valid).toBe(true)
      expect(environmentAgentListCalls).toBe(1)
      expect(environmentSkillListCalls).toBe(0)
      expect(environmentProviderListCalls).toBe(1)
      expect(environmentProviderGetModelCalls).toBe(0)
    }),
  )

  runtime.effect("validate and start resolve the same source content across all four sources", () =>
    withGlobalConfigDir((globalDir) =>
      Effect.gen(function* () {
        published.length = 0
        // project scope shadows global for the same name; builtin fills the
        // gap a file scope does not own; an explicit path stays session-local.
        const routeSpec = (name: string) =>
          `title: ${name} title\nconfig:\n  name: ${name}\n  objective: Route objective\n  blocks:\n    - id: plan\n      kind: plan\n`
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(path.join(globalDir, "workflows", "shared-route.yaml"), routeSpec("global-route")),
            Bun.write(path.join(globalDir, "workflows", "builtin-shadowed.yaml"), routeSpec("file-route")),
            Bun.write(
              path.join(workflowSpecDirectory, ".agents", "workflows", "shared-route.yaml"),
              routeSpec("project-route"),
            ),
            Bun.write(path.join(workflowSpecDirectory, "path-route.yaml"), routeSpec("path-route")),
          ]),
        )
        const previousBuiltin = (globalThis as Record<string, unknown>).GRAPHAGENT_DAG_TEMPLATES
        ;(globalThis as Record<string, unknown>).GRAPHAGENT_DAG_TEMPLATES = {
          "builtin-only-route": routeSpec("builtin-route"),
          "builtin-shadowed": routeSpec("stale-builtin-route"),
        }
        try {
          const info = yield* WorkflowTool
          const workflow = yield* info.init()

          // project beats global
          const projectRead = yield* workflow.execute(
            { params: { action: "spec", operation: "read", spec_path: "shared-route" } },
            contextWith([]),
          )
          expect(JSON.parse(projectRead.output).spec.title).toContain("project-route")

          // global fills names the project scope does not own
          const globalRead = yield* workflow.execute(
            { params: { action: "spec", operation: "read", spec_path: "builtin-shadowed" } },
            contextWith([]),
          )
          expect(JSON.parse(globalRead.output).spec.title).toContain("file-route")

          // builtin fills names no file scope owns
          const builtinValidate = yield* workflow.execute(
            { params: { action: "spec", operation: "validate", spec_path: "builtin-only-route" } },
            contextWith([]),
          )
          const builtinResult = JSON.parse(builtinValidate.output)
          expect(builtinResult.source).toBe("builtin://builtin-only-route")
          expect(builtinResult.profile).toBe("portable")
          expect(builtinResult.valid).toBe(true)

          // explicit path source validates under the environment profile by default
          const pathValidate = yield* workflow.execute(
            {
              params: {
                action: "spec",
                operation: "validate",
                spec_path: "path-route.yaml",
              },
            },
            contextWith([]),
          )
          const pathResult = JSON.parse(pathValidate.output)
          expect(pathResult.source).toBe(path.join(workflowSpecDirectory, "path-route.yaml"))
          expect(pathResult.profile).toBe("environment")
          expect(pathResult.valid).toBe(true)

          // validate and start see the same resolved content: validate passes,
          // start succeeds from the same name, and mutating the file changes
          // both views consistently.
          const beforeStart = yield* workflow.execute(
            { params: { action: "spec", operation: "validate", spec_path: "shared-route" } },
            contextWith([]),
          )
          expect(JSON.parse(beforeStart.output).valid).toBe(true)
          const started = yield* workflow.execute(
            { params: { action: "run", operation: "start", spec_path: "shared-route" } },
            contextWith([]),
          )
          expect(started.title).toBe("Workflow started: project-route")
          expect(published.some((event) => event.type === DagEvent.WorkflowCreated.type)).toBe(true)
        } finally {
          if (previousBuiltin === undefined) delete (globalThis as Record<string, unknown>).GRAPHAGENT_DAG_TEMPLATES
          else (globalThis as Record<string, unknown>).GRAPHAGENT_DAG_TEMPLATES = previousBuiltin
        }
      }),
    ),
  )

  runtime.effect("builtin:// spec_path from list output round-trips by name", () =>
    withGlobalConfigDir((globalDir) =>
      Effect.gen(function* () {
        const routeSpec = (name: string) =>
          `title: ${name} title\nconfig:\n  name: ${name}\n  objective: Route objective\n  blocks:\n    - id: plan\n      kind: plan\n`
        yield* Effect.promise(() =>
          Bun.write(path.join(globalDir, "workflows", "marker-route.yaml"), routeSpec("global-route")),
        )
        const previousBuiltin = (globalThis as Record<string, unknown>).GRAPHAGENT_DAG_TEMPLATES
        ;(globalThis as Record<string, unknown>).GRAPHAGENT_DAG_TEMPLATES = {
          "marker-builtin": routeSpec("marker-builtin-route"),
        }
        try {
          const info = yield* WorkflowTool
          const workflow = yield* info.init()

          // the synthetic builtin:// marker resolves by name through the library
          const builtinRead = yield* workflow.execute(
            { params: { action: "spec", operation: "read", spec_path: "builtin://marker-builtin" } },
            contextWith([]),
          )
          expect(JSON.parse(builtinRead.output).spec.title).toContain("marker-builtin-route")

          // the marker resolves through the same shadowing chain as a bare name
          const shadowed = yield* workflow.execute(
            { params: { action: "spec", operation: "validate", spec_path: "builtin://marker-route" } },
            contextWith([]),
          )
          expect(JSON.parse(shadowed.output).source).toBe(path.join(globalDir, "workflows", "marker-route.yaml"))

          // unknown builtin names fail as a library lookup, not a path extension error
          const missingExit = yield* Effect.exit(
            workflow.execute(
              { params: { action: "spec", operation: "read", spec_path: "builtin://missing-route" } },
              contextWith([]),
            ),
          )
          expect(Exit.isFailure(missingExit)).toBe(true)
          if (Exit.isFailure(missingExit)) {
            expect(Cause.pretty(missingExit.cause)).toContain('Saved workflow not found: "missing-route"')
          }
        } finally {
          if (previousBuiltin === undefined) delete (globalThis as Record<string, unknown>).GRAPHAGENT_DAG_TEMPLATES
          else (globalThis as Record<string, unknown>).GRAPHAGENT_DAG_TEMPLATES = previousBuiltin
        }
      }),
    ),
  )

  runtime.effect("list marks invalid templates without hiding them", () =>
    withGlobalConfigDir((globalDir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(
              path.join(globalDir, "workflows", "broken-route.yaml"),
              "config:\n  name: broken-route\n  objective: Ship\n  blocks:\n    - id: proto\n      kind: prototype\n    - id: review\n      kind: review\n      depends_on: [proto]\n",
            ),
            Bun.write(path.join(globalDir, "workflows", "fine-route.yaml"), savedSpec("fine-route")),
          ]),
        )
        const info = yield* WorkflowTool
        const workflow = yield* info.init()

        const result = yield* workflow.execute({ params: { action: "spec", operation: "list" } }, contextWith([]))

        expect(result.output).toContain("broken-route [global] [invalid — not startable]")
        expect(result.output).toContain("block.compile_failed")
        expect(result.output).toContain("fine-route [global]")
        expect(result.output).not.toContain("fine-route [global] [invalid")
      }),
    ),
  )

  runtime.effect("read keeps the editable raw spec for an invalid graph and reports diagnostics", () =>
    withGlobalConfigDir((globalDir) =>
      Effect.gen(function* () {
        published.length = 0
        yield* Effect.promise(() =>
          Bun.write(
            path.join(globalDir, "workflows", "uncompilable-route.yaml"),
            "config:\n  name: uncompilable-route\n  objective: Ship\n  blocks:\n    - id: proto\n      kind: prototype\n    - id: review\n      kind: review\n      depends_on: [proto]\n",
          ),
        )
        const info = yield* WorkflowTool
        const workflow = yield* info.init()

        const result = yield* workflow.execute(
          { params: { action: "spec", operation: "read", spec_path: "uncompilable-route" } },
          contextWith([]),
        )

        const payload = JSON.parse(result.output)
        // The editable source survives untouched so the parent can repair it.
        expect(payload.spec.config.blocks.map((block: { id: string }) => block.id)).toEqual(["proto", "review"])
        expect(payload.validation.valid).toBe(false)
        expect(payload.validation.errors.some((d: { code: string }) => d.code === "block.compile_failed")).toBe(true)
        // Read never claims the route can be started.
        expect(result.title).toBe("Workflow spec: uncompilable-route")
        expect(published).toHaveLength(0)
      }),
    ),
  )

  runtime.effect("list keeps a syntax-broken template visible with a stable diagnostic", () =>
    withGlobalConfigDir((globalDir) =>
      Effect.gen(function* () {
        published.length = 0
        yield* Effect.promise(() =>
          Bun.write(path.join(globalDir, "workflows", "broken-syntax.yaml"), "key: [unclosed"),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(globalDir, "workflows", "fine-route.yaml"),
            "config:\n  name: fine-route\n  objective: Ship\n  blocks:\n    - id: plan\n      kind: plan\n",
          ),
        )
        const info = yield* WorkflowTool
        const workflow = yield* info.init()

        const result = yield* workflow.execute({ params: { action: "spec", operation: "list" } }, contextWith([]))

        expect(result.output).toContain("broken-syntax [global] [invalid — not startable]")
        expect(result.output).toContain("[schema.invalid]")
        expect(result.output).toContain("fine-route [global]")
      }),
    ),
  )

  runtime.effect("validate returns structured diagnostics for syntax-broken YAML", () =>
    withGlobalConfigDir((globalDir) =>
      Effect.gen(function* () {
        published.length = 0
        const filepath = path.join(globalDir, "workflows", "broken-validate.yaml")
        yield* Effect.promise(() => Bun.write(filepath, "config: [unclosed"))
        const info = yield* WorkflowTool
        const workflow = yield* info.init()

        const result = yield* workflow.execute(
          { params: { action: "spec", operation: "validate", spec_path: "broken-validate", profile: "portable" } },
          contextWith([]),
        )

        const report = JSON.parse(result.output)
        expect(report).toMatchObject({
          source: filepath,
          profile: "portable",
          valid: false,
          errors: [
            {
              code: DagValidation.DIAGNOSTIC_CODES.schemaInvalid,
              path: "$",
              message: "file is not parseable YAML",
            },
          ],
          warnings: [],
          nodes: [],
        })
        expect(result.metadata.workflowId).toBeUndefined()
        expect(published).toHaveLength(0)
      }),
    ),
  )
})
