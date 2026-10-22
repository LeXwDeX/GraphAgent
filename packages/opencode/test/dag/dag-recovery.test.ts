// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mock dag
// layers and row fixtures use `as unknown as DagStore.Interface` shims that
// implement only the interface slice each scenario exercises.
import { describe, expect, it, afterAll } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { reconcileWorkflow, makeLastAssistantTextReader } from "@/dag/runtime/recovery"
import { Dag } from "@/dag/dag"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowRuntime, toSchedulingNodes } from "@opencode-ai/core/dag/core/scheduling"
import { TerminalViolationError } from "@opencode-ai/core/dag/core/types"
import { makeNodeRow } from "./fixtures"
import { commitOutputFileRef } from "@/dag/runtime/output-ref"

const tmpRoots: string[] = []

afterAll(async () => {
  for (const dir of tmpRoots) await fs.rm(dir, { recursive: true, force: true })
})

type TrackedEvent = {
  type: string
  nodeID: string
  output?: unknown
  reason?: string
  trigger?: string
}

function makeDagLayer(
  nodes: DagStore.NodeRow[],
  trackedEvents: TrackedEvent[],
  actions?: string[],
  capturedWrites?: { sid: string; payload: unknown }[],
  opts?: { capturedFail?: boolean },
) {
  return Layer.mock(Dag.Service, {
    store: {
      getNodes: () => Effect.succeed(nodes),
      getNode: (id: string) => Effect.succeed(nodes.find((n) => n.id === id)),
      setCapturedOutput: (sid: string, payload: unknown) =>
        opts?.capturedFail
          ? Effect.fail(new Error("captured output persistence boom"))
          : Effect.sync(() => capturedWrites?.push({ sid, payload })),
    } as unknown as DagStore.Interface,
    nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string, output: unknown) =>
      Effect.sync(() => trackedEvents.push({
        type: "nodeCompleted",
        nodeID,
        ...(output === undefined ? {} : { output }),
      })),
    ),
    nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string, trigger: string) =>
      Effect.sync(() => {
        actions?.push(`failed:${trigger}`)
        trackedEvents.push({ type: "nodeFailed", nodeID, reason, trigger })
      }),
    ),
    nodeStarted: Effect.fn("stub.nodeStarted")((dagID: string, nodeID: string) =>
      Effect.sync(() => trackedEvents.push({ type: "nodeStarted", nodeID })),
    ),
  })
}

describe("reconcileWorkflow", () => {
  it("publishes NodeCompleted for running node with completed child session", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("completed" as const)

    await Effect.runPromise(
      reconcileWorkflow(
        "wf-1",
        checkStatus,
        undefined,
        { nodes: [{ id: "n1" }] },
        () => Effect.succeed("recovered output"),
      ).pipe(Effect.provide(dagLayer)),
    )

    expect(events).toContainEqual({ type: "nodeCompleted", nodeID: "n1", output: "recovered output" })
    expect(events).not.toContainEqual({ type: "nodeFailed", nodeID: "n1" })
  })

  it("publishes NodeFailed for running node with failed child session", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("failed" as const)

    await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toContainEqual(expect.objectContaining({ type: "nodeFailed", nodeID: "n1" }))
  })

  it("publishes NodeFailed for running node with no child session", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: null })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)

    await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toContainEqual(expect.objectContaining({ type: "nodeFailed", nodeID: "n1" }))
  })

  it("cancels and fails an active child with no deadline after execution ownership is lost", async () => {
    const events: TrackedEvent[] = []
    const cancelled: string[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)
    const cancelSession = (sessionID: string) => Effect.sync(() => cancelled.push(sessionID))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, cancelSession).pipe(Effect.provide(dagLayer)),
    )

    expect(cancelled).toEqual(["ses_1"])
    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "n1",
      reason: "execution ownership lost on recovery",
      trigger: "exec_failed",
    })
    expect(result).toEqual({ reconciled: 1, ownershipLost: 1 })
  })

  it("leaves pending node with no child session for spawnReady", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "pending", childSessionId: null })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)

    const result = await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toEqual([])
    expect(result.reconciled).toBe(0)
  })

  it("skips pending node with child session (restart-orphan, left for spawnReady)", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "pending", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)

    const result = await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    // Pending nodes with a childSessionId are restart-orphans (NodeRestarted
    // set them pending but replacement was never spawned). Recovery should NOT
    // re-attach to the old session — leave them pending for spawnReady.
    expect(events).not.toContainEqual({ type: "nodeStarted", nodeID: "n1" })
    expect(result.reconciled).toBe(0)
    expect(result.ownershipLost).toBe(0)
  })

  it("skips non-running, non-pending nodes", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [
      makeNodeRow({ id: "n1", status: "completed", childSessionId: "ses_1" }),
      makeNodeRow({ id: "n2", status: "skipped", childSessionId: null }),
    ]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("completed" as const)

    const result = await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toEqual([])
    expect(result.reconciled).toBe(0)
  })

  it("re-admits a queued node without any ownership judgement (P0-2)", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "queued", childSessionId: null })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)

    const result = await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    // A queued node never created its child session — no invented failure,
    // no recovery-pause trigger; it simply re-enters scheduling.
    expect(events).toEqual([])
    expect(result).toEqual({ reconciled: 0, ownershipLost: 0 })
  })

  it("cancels the stale session of a queued restart-orphan without judging it", async () => {
    const events: { type: string; nodeID: string }[] = []
    const cancelled: string[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "queued", childSessionId: "ses_stale" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)
    const cancelSession = (sessionID: string) => Effect.sync(() => cancelled.push(sessionID))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, cancelSession).pipe(Effect.provide(dagLayer)),
    )

    expect(cancelled).toEqual(["ses_stale"])
    expect(events).toEqual([])
    expect(result).toEqual({ reconciled: 0, ownershipLost: 0 })
  })

  // #349/REC-1: a persistent stale-child cancel failure no longer aborts
  // the whole reconcile — that made the workflow unadoptable in this process
  // (its running nodes would never be scheduled until a restart). The
  // failure is logged and the reconcile continues; this test pinned the old
  // abort behavior.
  it("survives a stale restart-orphan cancel failure and continues the reconcile", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "queued", childSessionId: "ses_stale" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)
    const cancelSession = () => Effect.fail(new Error("cancel unavailable"))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, cancelSession).pipe(Effect.provide(dagLayer)),
    )

    expect(events).toEqual([])
    expect(result).toEqual({ reconciled: 0, ownershipLost: 0 })
  })

  it("cancels and fails a zero-message child classified as unknown exactly once", async () => {
    const events: TrackedEvent[] = []
    const cancelled: string[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("unknown" as const)
    const cancelSession = (sessionID: string) => Effect.sync(() => cancelled.push(sessionID))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, cancelSession).pipe(Effect.provide(dagLayer)),
    )

    expect(cancelled).toEqual(["ses_1"])
    expect(events.filter((event) => event.type === "nodeFailed")).toEqual([
      {
        type: "nodeFailed",
        nodeID: "n1",
        reason: "execution ownership lost on recovery",
        trigger: "exec_failed",
      },
    ])
    expect(result).toEqual({ reconciled: 1, ownershipLost: 1 })
  })

  it("cancels before failing a running node whose deadline expired during crash", async () => {
    const events: TrackedEvent[] = []
    const actions: string[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", deadlineMs: Date.now() - 10000 })]
    const dagLayer = makeDagLayer(nodes, events, actions)
    const checkStatus = () => Effect.succeed("active" as const)
    const cancelSession = () => Effect.sync(() => actions.push("cancelled"))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, cancelSession).pipe(Effect.provide(dagLayer)),
    )

    expect(actions).toEqual(["cancelled", "failed:timeout"])
    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "n1",
      reason: "deadline exceeded on recovery",
      trigger: "timeout",
    })
    expect(result).toEqual({ reconciled: 1, ownershipLost: 1 })
  })

  it("cancels and fails an active child with a future deadline after execution ownership is lost", async () => {
    const events: TrackedEvent[] = []
    const cancelled: string[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", deadlineMs: Date.now() + 60000 })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)
    const cancelSession = (sessionID: string) => Effect.sync(() => cancelled.push(sessionID))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, cancelSession).pipe(Effect.provide(dagLayer)),
    )

    expect(cancelled).toEqual(["ses_1"])
    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "n1",
      reason: "execution ownership lost on recovery",
      trigger: "exec_failed",
    })
    expect(result).toEqual({ reconciled: 1, ownershipLost: 1 })
  })

  it("terminalizes the node even when cancelling the lost child session fails", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", deadlineMs: null })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("unknown" as const)
    const cancelSession = () => Effect.fail(new Error("cancel unavailable"))

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, cancelSession).pipe(Effect.provide(dagLayer)),
    )

    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "n1",
      reason: "execution ownership lost on recovery",
      trigger: "exec_failed",
    })
    expect(result).toEqual({ reconciled: 1, ownershipLost: 1 })
  })

  it("preserves captured structured output from an already completed child session", async () => {
    const events: TrackedEvent[] = []
    const output = { summary: "done" }
    const nodes = [
      makeNodeRow({
        id: "n1",
        status: "running",
        childSessionId: "ses_1",
        capturedOutput: output,
      }),
    ]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("completed" as const)
    const workflowConfig = {
      nodes: [{ id: "n1", output_schema: { type: "object" } }],
    }

    await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, undefined, workflowConfig).pipe(Effect.provide(dagLayer)),
    )

    expect(events).toContainEqual({ type: "nodeCompleted", nodeID: "n1", output })
    expect(events.find((event) => event.type === "nodeFailed")).toBeUndefined()
  })

  it("fails a recovered ACCEPT that leaves a lane's required action unrefuted", async () => {
    const events: TrackedEvent[] = []
    const nodes = [
      makeNodeRow({
        id: "lane",
        status: "completed",
        output: { verdict: "REJECT", required_actions: ["Handle the empty input"] },
      }),
      makeNodeRow({
        id: "decision",
        status: "running",
        childSessionId: "ses_1",
        dependsOn: ["lane"],
        capturedOutput: { verdict: "ACCEPT", required_actions: [] },
      }),
    ]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("completed" as const)
    const workflowConfig = { nodes: [{ id: "lane" }, { id: "decision", output_schema: { type: "object" } }] }

    await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, undefined, workflowConfig).pipe(Effect.provide(dagLayer)),
    )

    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "decision",
      reason:
        "Verdict consistency contract failed (recovered): ACCEPT leaves required actions unrefuted: lane[0]; refute each as { node, index, reason } or submit REJECT",
      trigger: "verdict_fail",
    })
  })

  it("fails an already completed child whose required structured output was never captured", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("completed" as const)
    const workflowConfig = {
      nodes: [{ id: "n1", output_schema: { type: "object" } }],
    }

    await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, undefined, workflowConfig).pipe(Effect.provide(dagLayer)),
    )

    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "n1",
      reason: "output_schema declared but submit_result was never successfully called (recovered)",
      trigger: "verdict_fail",
    })
  })

  it("continues recovery when a concurrent settlement already terminalized the node", async () => {
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = Layer.mock(Dag.Service, {
      store: {
        getNodes: () => Effect.succeed(nodes),
      } as unknown as DagStore.Interface,
      nodeCompleted: () => Effect.fail(new TerminalViolationError("n1", "failed", "completed")),
    })
    const checkStatus = () => Effect.succeed("completed" as const)

    const exit = await Effect.runPromiseExit(
      reconcileWorkflow(
        "wf-1",
        checkStatus,
        undefined,
        { nodes: [{ id: "n1" }] },
        () => Effect.succeed("recovered output"),
      ).pipe(Effect.provide(dagLayer)),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("does not hide non-transition settlement failures", async () => {
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = Layer.mock(Dag.Service, {
      store: {
        getNodes: () => Effect.succeed(nodes),
      } as unknown as DagStore.Interface,
      nodeCompleted: () => Effect.fail(new Error("database unavailable")),
    })
    const checkStatus = () => Effect.succeed("completed" as const)

    const exit = await Effect.runPromiseExit(
      reconcileWorkflow(
        "wf-1",
        checkStatus,
        undefined,
        { nodes: [{ id: "n1" }] },
        () => Effect.succeed("recovered output"),
      ).pipe(Effect.provide(dagLayer)),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("rehydration via toSchedulingNodes", () => {
  it("maps every durable node status into the scheduling state machine", () => {
    const nodes = [
      makeNodeRow({ id: "pending", status: "pending" }),
      makeNodeRow({ id: "queued", status: "queued" }),
      makeNodeRow({ id: "running", status: "running" }),
      makeNodeRow({ id: "paused", status: "paused" }),
      makeNodeRow({ id: "completed", status: "completed" }),
      makeNodeRow({ id: "failed", status: "failed" }),
      makeNodeRow({ id: "aborted", status: "aborted" }),
      makeNodeRow({ id: "skipped", status: "skipped" }),
    ]

    expect(toSchedulingNodes(nodes).map((node) => [node.id, node.status])).toEqual([
      ["pending", "pending"],
      ["queued", "pending"],
      ["running", "running"],
      ["paused", "pending"],
      ["completed", "satisfied"],
      ["failed", "unsatisfied"],
      // Aborted and skipped stay distinguishable from satisfied so pure-skip
      // descendants cascade-skip after rehydration instead of running on a
      // non-existent output.
      ["aborted", "skipped"],
      ["skipped", "skipped"],
    ])
  })

  it("rehydrates aborted nodes as no-output terminals and cascades skip-only descendants", () => {
    const nodes = [
      makeNodeRow({ id: "aborted", status: "aborted" }),
      makeNodeRow({ id: "dependent", status: "pending", dependsOn: ["aborted"] }),
      makeNodeRow({ id: "downstream", status: "pending", dependsOn: ["dependent"] }),
    ]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)

    expect(rt.getReadyNodes()).toEqual([])
    expect(rt.getCascadeSkipNodes()).toEqual(["dependent"])
    rt.markSkipped("dependent")
    expect(rt.getCascadeSkipNodes()).toEqual(["downstream"])
  })

  it("running nodes are seeded as running in WorkflowRuntime", () => {
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    expect(rt.getReadyNodes()).toEqual([])
    expect(rt.isComplete()).toBe(false)
  })

  it("completed nodes after reconciliation are seeded as satisfied", () => {
    const nodes = [
      makeNodeRow({ id: "n1", status: "completed" }),
      makeNodeRow({ id: "n2", status: "pending", dependsOn: ["n1"] }),
    ]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    expect(rt.getReadyNodes()).toEqual(["n2"])
  })

  it("failed nodes after reconciliation are seeded as unsatisfied with cascade", () => {
    const nodes = [
      makeNodeRow({ id: "n1", status: "failed", required: true }),
      makeNodeRow({ id: "n2", status: "pending", dependsOn: ["n1"] }),
    ]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    expect(rt.getReadyNodes()).toEqual([])
    expect(rt.isComplete()).toBe(true)
    expect(rt.hasRequiredFailure()).toBe(true)
  })

  it("failed optional nodes after reconciliation unblock dependents", () => {
    const nodes = [
      makeNodeRow({ id: "n1", status: "failed", required: false }),
      makeNodeRow({ id: "n2", status: "pending", dependsOn: ["n1"], required: true }),
    ]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    expect(rt.getReadyNodes()).toEqual(["n2"])
    expect(rt.hasRequiredFailure()).toBe(false)
  })

  it("paused workflow rehydrates with setPaused(true)", () => {
    const nodes = [makeNodeRow({ id: "n1", status: "pending" })]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    rt.setPaused(true)
    expect(rt.isPaused()).toBe(true)
    expect(rt.getReadyNodes()).toEqual([])
  })

  // #345: the live path (spawn.ts) settles a schemaless node with the child's
  // last assistant text; recovery must mirror it — a crash between the child's
  // final reply and the NodeCompleted publish must not erase a string verdict
  // (a bare {"verdict":"replan"} checkpoint reply would otherwise vanish).
  it("settles a completed schemaless node with the child's last assistant text", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "cp", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed<"active" | "completed" | "failed" | "unknown">("completed")
    const verdict = '{"verdict":"replan","reason":"wrong file"}'

    await Effect.runPromise(
      reconcileWorkflow(
        "wf-1",
        checkStatus,
        undefined,
        { nodes: [{ id: "cp" }] },
        () => Effect.succeed(verdict),
      ).pipe(Effect.provide(dagLayer)),
    )

    expect(events).toContainEqual({ type: "nodeCompleted", nodeID: "cp", output: verdict })
    expect(events).not.toContainEqual({ type: "nodeFailed", nodeID: "cp" })
  })

  it("fails a completed schemaless node whose text part is missing", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed<"active" | "completed" | "failed" | "unknown">("completed")

    await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, undefined, { nodes: [{ id: "n1" }] }, () => Effect.succeed(undefined)).pipe(
        Effect.provide(dagLayer),
      ),
    )

    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "n1",
      reason: "provider returned empty output",
      trigger: "verdict_fail",
    })
    expect(events).not.toContainEqual(expect.objectContaining({ type: "nodeCompleted", nodeID: "n1" }))
  })

  // #345 degenerate branch: an unparseable workflow row (explicit null) must
  // fail loudly — undefined-completing a schema-carrying node would bypass
  // settleCapturedOutput's review contract.
  it("fails a completed node whose workflow config is unparseable (null), not undefined-complete", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed<"active" | "completed" | "failed" | "unknown">("completed")

    const result = await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, undefined, null, () => Effect.succeed("text")).pipe(
        Effect.provide(dagLayer),
      ),
    )

    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "n1",
      reason: expect.stringContaining("unparseable"),
      trigger: "exec_failed",
    })
    expect(events).not.toContainEqual({ type: "nodeCompleted", nodeID: "n1" })
    expect(result.ownershipLost).toBe(1)
  })

  it("fails safely when a completed schemaless node has no text reader", async () => {
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed<"active" | "completed" | "failed" | "unknown">("completed")

    await Effect.runPromise(
      reconcileWorkflow("wf-1", checkStatus, undefined, { nodes: [{ id: "n1" }] }).pipe(Effect.provide(dagLayer)),
    )

    expect(events).toContainEqual({
      type: "nodeFailed",
      nodeID: "n1",
      reason: "provider returned empty output",
      trigger: "verdict_fail",
    })
    expect(events).not.toContainEqual(expect.objectContaining({ type: "nodeCompleted", nodeID: "n1" }))
  })
})

// issue #388: the live path captures {content_ref, size, sha256, summary}
// when a schemaless node's final reply IS one existing absolute file path
// (spawn.ts → output-ref.ts). Recovery must produce the same durable receipt
// for the same reply instead of diverging by crash timing. Behavioral
// lockstep with the live path is asserted side-by-side in
// dag-wake-integration.test.ts "captures a file_ref receipt when a
// schemaless reply is one absolute path (issue #388)" — keep both green or
// neither ships.
describe("reconcileWorkflow output file refs (issue #388)", () => {
  for (const checkpoint of [false, true]) {
    it(`does not restore a file without source read authorization (checkpoint=${checkpoint})`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-recover-denied-"))
      tmpRoots.push(dir)
      const source = path.join(dir, "secret.md")
      await fs.writeFile(source, `denied checkpoint ${dir}`)
      const ref = checkpoint ? await Effect.runPromise(commitOutputFileRef(source, {
        workflow_id: "wf-1", node_id: "n1", child_session_id: "ses_1", replan_attempt: 0,
      })) : undefined
      if (ref) tmpRoots.push(path.dirname(ref.path))
      const events: TrackedEvent[] = []
      const captured: { sid: string; payload: unknown }[] = []
      const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", capturedOutput: ref })]
      const checked: string[] = []
      await Effect.runPromise(reconcileWorkflow(
        "wf-1", () => Effect.succeed("completed" as const), undefined, { nodes: [{ id: "n1" }] },
        () => Effect.succeed(source), dir, (_sid, value) => Effect.suspend(() => {
          checked.push(value)
          return Effect.fail(new Error("source read denied"))
        }),
      ).pipe(Effect.provide(makeDagLayer(nodes, events, undefined, captured))))
      expect(checked).toEqual([FSUtil.normalizePath(source)])
      expect(captured).toEqual([])
      expect(events.some((event) => event.type === "nodeCompleted")).toBe(false)
      expect(events).toContainEqual(expect.objectContaining({ type: "nodeFailed", trigger: "exec_failed" }))
    })
  }

  for (const damaged of [false, true]) {
    it(`recovers a committed receipt after source deletion (damaged=${damaged})`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-recover-managed-"))
      tmpRoots.push(dir)
      const source = path.join(dir, "report.md")
      await fs.writeFile(source, `recovery checkpoint ${dir}`)
      const ref = await Effect.runPromise(commitOutputFileRef(source, {
        workflow_id: "wf-1", node_id: "n1", child_session_id: "ses_1", replan_attempt: 0,
      }))
      expect(ref).toBeDefined()
      tmpRoots.push(path.dirname(ref!.path))
      await fs.unlink(source)
      if (damaged) {
        await fs.chmod(ref!.path, 0o600)
        await fs.unlink(ref!.path)
      }
      const events: TrackedEvent[] = []
      const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", capturedOutput: ref })]
      await Effect.runPromise(reconcileWorkflow(
        "wf-1", () => Effect.succeed("completed" as const), undefined, { nodes: [{ id: "n1" }] },
        () => Effect.succeed(source),
      ).pipe(Effect.provide(makeDagLayer(nodes, events))))
      if (damaged) {
        expect(events.some((event) => event.type === "nodeCompleted")).toBe(false)
        expect(events).toContainEqual(expect.objectContaining({ type: "nodeFailed", trigger: "exec_failed" }))
      } else {
        expect(events).toContainEqual({ type: "nodeCompleted", nodeID: "n1", output: ref!.path })
      }
    })
  }

  it("captures the same file_ref receipt as the live path for an absolute-path reply", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-recovery-ref-"))
    tmpRoots.push(dir)
    const reportPath = path.join(dir, "report.md")
    const content = "recovered report body"
    await Bun.write(reportPath, content)

    const events: TrackedEvent[] = []
    const captured: { sid: string; payload: unknown }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events, undefined, captured)
    const checkStatus = () => Effect.succeed<"active" | "completed" | "failed" | "unknown">("completed")

    await Effect.runPromise(
      reconcileWorkflow(
        "wf-1",
        checkStatus,
        undefined,
        { nodes: [{ id: "n1" }] },
        () => Effect.succeed(reportPath),
        dir,
      ).pipe(Effect.provide(dagLayer)),
    )

    expect(events).toContainEqual({ type: "nodeCompleted", nodeID: "n1", output: expect.stringContaining("workflow-artifacts") })
    expect(captured).toEqual([{
      sid: "ses_1",
      payload: expect.objectContaining({
        kind: "file_ref",
        storage: "managed-v1",
        source_path: FSUtil.normalizePath(reportPath),
        content_ref: expect.stringContaining("workflow-artifacts"),
        path: expect.stringContaining("workflow-artifacts"),
        size: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
        summary: content,
      }),
    }])
  })

  it("keeps the inline settlement and captures nothing when the reply is not an existing path", async () => {
    const events: TrackedEvent[] = []
    const captured: { sid: string; payload: unknown }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events, undefined, captured)
    const checkStatus = () => Effect.succeed<"active" | "completed" | "failed" | "unknown">("completed")

    await Effect.runPromise(
      reconcileWorkflow(
        "wf-1",
        checkStatus,
        undefined,
        { nodes: [{ id: "n1" }] },
        () => Effect.succeed(`Report written to ${path.join(os.tmpdir(), "dag-recovery-ghost.md")}`),
        process.cwd(),
      ).pipe(Effect.provide(dagLayer)),
    )

    expect(captured).toEqual([])
    const completed = events.find((event) => event.type === "nodeCompleted")
    expect(completed?.output).toMatch(/^Report written to /)
  })

  // Managed artifact receipts must persist before recovery records success.
  it("fails recovery when managed receipt persistence fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-recovery-refboom-"))
    tmpRoots.push(dir)
    const reportPath = path.join(dir, "report.md")
    await Bun.write(reportPath, "doomed receipt")
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events, undefined, undefined, { capturedFail: true })
    const checkStatus = () => Effect.succeed<"active" | "completed" | "failed" | "unknown">("completed")

    await Effect.runPromise(
      reconcileWorkflow(
        "wf-1",
        checkStatus,
        undefined,
        { nodes: [{ id: "n1" }] },
        () => Effect.succeed(reportPath),
        dir,
      ).pipe(Effect.provide(dagLayer)),
    )

    expect(events.some((event) => event.type === "nodeCompleted")).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: "nodeFailed", nodeID: "n1", trigger: "exec_failed" }))
  })
})

// #345: the schemaless completion mirror — recovery reads the child's last
// assistant text exactly as spawn settles it. Direct reader contract.
describe("makeLastAssistantTextReader (#345)", () => {
  function assistantText(text: string): SessionV1.WithParts {
    return {
      info: {
        id: "m1",
        role: "assistant",
        sessionID: "ses_1",
        time: { created: 0 },
        agent: "build",
        model: { providerID: "p", modelID: "m" },
      },
      parts: [{ type: "text", text }],
    } as never
  }

  it("returns the last assistant text part from the child transcript", async () => {
    const reader = makeLastAssistantTextReader({
      messages: () => Effect.succeed([assistantText("attempt one"), assistantText("final verdict: GO")]),
    } as never)
    expect(await Effect.runPromise(reader("ses_1"))).toBe("final verdict: GO")
  })

  it("treats a missing child session as no text instead of failing recovery", async () => {
    const reader = makeLastAssistantTextReader({
      messages: () => Effect.fail({ _tag: "NotFoundError", message: "session gone" } as never),
    } as never)
    expect(await Effect.runPromise(reader("ses_ghost"))).toBeUndefined()
  })
})
