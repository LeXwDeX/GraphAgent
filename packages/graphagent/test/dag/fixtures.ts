import type { DagStore } from "@opencode-ai/core/dag/store"

export function makeWorkflowRow(overrides: Partial<DagStore.WorkflowRow> = {}): DagStore.WorkflowRow {
  return {
    id: "wf-1",
    projectId: "proj-1",
    sessionId: "ses_parent",
    // #948: spawned workflows must have a usable execution location. Unit
    // fixtures represent normal created workflows, so default to the existing
    // test process directory; NULL-legacy cases pass directory: null
    // explicitly.
    directory: process.cwd(),
    executionDirectory: null,
    title: "Test Workflow",
    status: "running",
    config: "{}",
    seq: 1,
    wakeReported: false,
    graphRev: 1,
    startedAt: null,
    completedAt: null,
    timeCreated: 1,
    timeUpdated: 1,
    ...overrides,
  }
}

export function makeNodeRow(overrides: Partial<DagStore.NodeRow> = {}): DagStore.NodeRow {
  return {
    id: "node-1",
    workflowId: "wf-1",
    name: "Test Node",
    workerType: "build",
    status: "pending",
    required: true,
    dependsOn: [],
    modelId: null,
    modelProviderId: null,
    childSessionId: null,
    directory: null,
    baseHead: null,
    output: undefined,
    capturedOutput: undefined,
    errorReason: null,
    errorClass: null,
    deadlineMs: null,
    wakeEligible: false,
    wakeReported: false,
    replanAttempts: 0,
    timeoutExtensions: 0,
    escalationPending: false,
    superseded: false,
    seq: 0,
    startedAt: null,
    completedAt: null,
    timeCreated: 1,
    timeUpdated: 1,
    ...overrides,
  }
}
