// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mock dag
// layers and row fixtures use `as unknown as DagStore.Interface` shims that
// implement only the interface slice each scenario exercises.
import { describe, expect, it, afterAll } from "bun:test"
import { $ } from "bun"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { FSUtil } from "@graphagent/core/fs-util"
import { reconcileWorkflow, makeLastAssistantTextReader } from "@/dag/runtime/recovery"
import { Dag } from "@/dag/dag"
import { DagMessages } from "@graphagent/core/dag/messages"
import type { DagStore } from "@graphagent/core/dag/store"
import { WorkflowRuntime, toSchedulingNodes } from "@graphagent/core/dag/core/scheduling"
import { TerminalViolationError } from "@graphagent/core/dag/core/types"
import { Worktree } from "@/worktree"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { makeNodeRow } from "./fixtures"
import { testEffect } from "../lib/effect"
import { commitOutputFileRef } from "@/dag/runtime/output-ref"

const tmpRoots: string[] = []
const STANDARD_TEMPLATE_EXCLUDE = "# task-owned standard template\n# preserved fixture comment\n"

async function initGitFixture(dir: string, templateKind: "standard" | "empty" = "standard") {
  const templateDir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-recovery-template-"))
  tmpRoots.push(templateDir)
  if (templateKind === "standard") {
    await fs.mkdir(path.join(templateDir, "info"), { recursive: true })
    await fs.writeFile(path.join(templateDir, "info", "exclude"), STANDARD_TEMPLATE_EXCLUDE)
  }
  await $`git init -q --template=${templateDir} ${dir}`.quiet()
}

afterAll(async () => {
  for (const dir of tmpRoots) await fs.rm(dir, { recursive: true, force: true })
})

type TrackedEvent = {
  type: string
  nodeID: string
  output?: unknown
  reason?: string
  trigger?: string
  worktree?: {
    directory: string
    state: string
    commit?: string
    patchPath?: string
    touchedPaths: readonly string[]
  }
  touchedPaths?: readonly string[]
}

const effectIt = testEffect(Layer.empty)

function makeDagLayer(
  nodes: DagStore.NodeRow[],
  trackedEvents: TrackedEvent[],
  actions?: string[],
  capturedWrites?: { sid: string; payload: unknown }[],
  opts?: { capturedFail?: boolean; workflowFail?: boolean; workflowInterrupt?: boolean },
  workflow?: DagStore.WorkflowRow,
) {
  return Layer.mock(Dag.Service, {
    store: {
      getNodes: () => Effect.succeed(nodes),
      getNode: (id: string) => Effect.succeed(nodes.find((n) => n.id === id)),
      getWorkflow: () =>
        opts?.workflowInterrupt
          ? Effect.interrupt
          : opts?.workflowFail
            ? Effect.fail(new Error("workflow lookup boom"))
            : Effect.succeed(workflow),
      setCapturedOutput: (sid: string, payload: unknown) =>
        opts?.capturedFail
          ? Effect.fail(new Error("captured output persistence boom"))
          : Effect.sync(() => capturedWrites?.push({ sid, payload })),
    } as unknown as DagStore.Interface,
    nodeCompleted: Effect.fn("stub.nodeCompleted")(
      (
        dagID: string,
        nodeID: string,
        output: unknown,
        _attempt?: unknown,
        _capturedOutput?: unknown,
        worktree?: TrackedEvent["worktree"],
        touchedPaths?: readonly string[],
      ) =>
        Effect.sync(() =>
          trackedEvents.push({
            type: "nodeCompleted",
            nodeID,
            ...(output === undefined ? {} : { output }),
            ...(worktree ? { worktree } : {}),
            ...(touchedPaths ? { touchedPaths } : {}),
          }),
        ),
    ),
    nodeFailed: Effect.fn("stub.nodeFailed")(
      (
        dagID: string,
        nodeID: string,
        reason: string,
        trigger: string,
        _attempt?: unknown,
        _errorClass?: unknown,
        worktree?: TrackedEvent["worktree"],
      ) =>
        Effect.sync(() => {
          actions?.push(`failed:${trigger}`)
          trackedEvents.push({ type: "nodeFailed", nodeID, reason, trigger, ...(worktree ? { worktree } : {}) })
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
      reconcileWorkflow("wf-1", checkStatus, undefined, { nodes: [{ id: "n1" }] }, () =>
        Effect.succeed("recovered output"),
      ).pipe(Effect.provide(dagLayer)),
    )

    expect(events).toContainEqual({ type: "nodeCompleted", nodeID: "n1", output: "recovered output" })
    expect(events).not.toContainEqual({ type: "nodeFailed", nodeID: "n1" })
  })

  it("commits, patches and removes an isolated worktree before completing a recovered node", async () => {
    const owner = await fs.mkdtemp(path.join(os.tmpdir(), "dag-recovery-wt-owner-"))
    tmpRoots.push(owner)
    await initGitFixture(owner)
    await $`git -C ${owner} config user.email test@example.com`.quiet()
    await $`git -C ${owner} config user.name Test`.quiet()
    await $`git -C ${owner} commit --allow-empty -q -m root`.quiet()
    const worktree = path.join(os.tmpdir(), `dag-recovery-wt-${Math.random().toString(36).slice(2)}`)
    tmpRoots.push(worktree)
    await $`git -C ${owner} worktree add --detach ${worktree} HEAD`.quiet()
    const baseHead = (await $`git -C ${worktree} rev-parse HEAD`.text()).trim()
    await fs.writeFile(path.join(worktree, "changed.txt"), "changed\n")

    const removals: string[] = []
    const contexts: string[] = []
    const worktreeLayer = Layer.mock(Worktree.Service, {
      remove: (input: { directory: string }) =>
        Effect.gen(function* () {
          const current = yield* InstanceRef
          contexts.push(current?.directory ?? "")
          execFileSync("git", ["-C", owner, "worktree", "remove", "--force", input.directory])
          removals.push(input.directory)
          return true
        }),
    })
    const instanceStoreLayer = Layer.succeed(InstanceStore.Service, {
      provide: (input: { directory: string }, effect: Effect.Effect<unknown>) =>
        Effect.provideService(effect, InstanceRef, { directory: input.directory } as never),
    } as never)

    const events: TrackedEvent[] = []
    const nodes = [
      makeNodeRow({
        id: "n1",
        status: "running",
        childSessionId: "ses_1",
        directory: worktree,
        baseHead,
        worktreeDirectory: worktree,
        worktreeState: "active",
      }),
    ]
    const workflow = { id: "wf-1", projectId: "p", directory: owner } as unknown as DagStore.WorkflowRow
    await Effect.runPromise(
      reconcileWorkflow(
        "wf-1",
        () => Effect.succeed("completed" as const),
        undefined,
        { nodes: [{ id: "n1", workspace: owner }] },
        () => Effect.succeed("done"),
        owner,
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeDagLayer(nodes, events, undefined, undefined, undefined, workflow),
            worktreeLayer,
            instanceStoreLayer,
          ),
        ),
      ),
    )

    expect(events).toEqual([expect.objectContaining({ type: "nodeCompleted", nodeID: "n1" })])
    const completed = events.find((event) => event.type === "nodeCompleted")
    expect(completed?.worktree?.state).toBe("removed")
    expect(completed?.worktree?.commit).toBeDefined()
    expect(completed?.worktree?.patchPath).toBeDefined()
    expect(completed?.touchedPaths).toEqual(["changed.txt"])
    expect(await fs.readFile(completed?.worktree?.patchPath ?? "", "utf8")).toContain("changed.txt")
    expect(removals).toEqual([worktree])
    expect(contexts).toHaveLength(1)
    expect(await fs.realpath(contexts[0])).toBe(await fs.realpath(owner))
    expect(
      await fs.stat(worktree).then(
        () => false,
        () => true,
      ),
    ).toBe(true)
  })

  it("keeps an isolated worktree when recovery fails the node", async () => {
    const owner = await fs.mkdtemp(path.join(os.tmpdir(), "dag-recovery-wt-owner-"))
    tmpRoots.push(owner)
    await initGitFixture(owner)
    await $`git -C ${owner} -c user.email=test@example.com -c user.name=Test commit --allow-empty -q -m root`.quiet()
    const worktree = path.join(os.tmpdir(), `dag-recovery-wt-${Math.random().toString(36).slice(2)}`)
    tmpRoots.push(worktree)
    await $`git -C ${owner} worktree add --detach ${worktree} HEAD`.quiet()
    const events: TrackedEvent[] = []
    const nodes = [
      makeNodeRow({
        id: "n1",
        status: "running",
        childSessionId: "ses_1",
        directory: worktree,
        worktreeDirectory: worktree,
        worktreeState: "active",
      }),
    ]
    await Effect.runPromise(
      reconcileWorkflow("wf-1", () => Effect.succeed("failed" as const)).pipe(
        Effect.provide(makeDagLayer(nodes, events)),
      ),
    )

    const failed = events.find((event) => event.type === "nodeFailed")
    expect(failed?.worktree?.state).toBe("kept")
    expect(failed?.worktree?.directory).toBe(worktree)
    expect((await fs.stat(worktree)).isDirectory()).toBe(true)
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
    const nodes = [
      makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", deadlineMs: Date.now() - 10000 }),
    ]
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
    const nodes = [
      makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", deadlineMs: Date.now() + 60000 }),
    ]
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

  effectIt.effect("fails a recovered ACCEPT that leaves a lane's required action unrefuted", () =>
    Effect.gen(function* () {
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

      yield* reconcileWorkflow("wf-1", checkStatus, undefined, workflowConfig).pipe(Effect.provide(dagLayer))

      expect(events).toContainEqual({
        type: "nodeFailed",
        nodeID: "decision",
        reason:
          "Verdict consistency contract failed (recovered): ACCEPT leaves required actions unrefuted: lane[0]; refute each as { node, index, reason } or submit REJECT",
        trigger: "verdict_fail",
      })
    }),
  )

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
      reason: "output_schema declared but no final structured response was captured (recovered)",
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
      reconcileWorkflow("wf-1", checkStatus, undefined, { nodes: [{ id: "n1" }] }, () =>
        Effect.succeed("recovered output"),
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
      reconcileWorkflow("wf-1", checkStatus, undefined, { nodes: [{ id: "n1" }] }, () =>
        Effect.succeed("recovered output"),
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
      reconcileWorkflow("wf-1", checkStatus, undefined, { nodes: [{ id: "cp" }] }, () => Effect.succeed(verdict)).pipe(
        Effect.provide(dagLayer),
      ),
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
      reconcileWorkflow("wf-1", checkStatus, undefined, { nodes: [{ id: "n1" }] }, () =>
        Effect.succeed(undefined),
      ).pipe(Effect.provide(dagLayer)),
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
      const ref = checkpoint
        ? await Effect.runPromise(
            commitOutputFileRef(source, {
              workflow_id: "wf-1",
              node_id: "n1",
              child_session_id: "ses_1",
              replan_attempt: 0,
            }),
          )
        : undefined
      if (ref) tmpRoots.push(path.dirname(ref.path))
      const events: TrackedEvent[] = []
      const captured: { sid: string; payload: unknown }[] = []
      const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", capturedOutput: ref })]
      const checked: string[] = []
      await Effect.runPromise(
        reconcileWorkflow(
          "wf-1",
          () => Effect.succeed("completed" as const),
          undefined,
          { nodes: [{ id: "n1" }] },
          () => Effect.succeed(source),
          dir,
          () => (_sid, value) =>
            Effect.suspend(() => {
              checked.push(value)
              return Effect.fail(new Error("source read denied"))
            }),
        ).pipe(Effect.provide(makeDagLayer(nodes, events, undefined, captured))),
      )
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
      const ref = await Effect.runPromise(
        commitOutputFileRef(source, {
          workflow_id: "wf-1",
          node_id: "n1",
          child_session_id: "ses_1",
          replan_attempt: 0,
        }),
      )
      expect(ref).toBeDefined()
      tmpRoots.push(path.dirname(ref!.path))
      await fs.unlink(source)
      if (damaged) {
        await fs.chmod(ref!.path, 0o600)
        await fs.unlink(ref!.path)
      }
      const events: TrackedEvent[] = []
      const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", capturedOutput: ref })]
      await Effect.runPromise(
        reconcileWorkflow(
          "wf-1",
          () => Effect.succeed("completed" as const),
          undefined,
          { nodes: [{ id: "n1" }] },
          () => Effect.succeed(source),
        ).pipe(Effect.provide(makeDagLayer(nodes, events))),
      )
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

    expect(events).toContainEqual({
      type: "nodeCompleted",
      nodeID: "n1",
      output: expect.stringContaining("workflow-artifacts"),
    })
    expect(captured).toEqual([
      {
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
      },
    ])
  })

  it("completes a recovered report without touching repository ignore files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-recovery-exclude-"))
    tmpRoots.push(dir)
    await initGitFixture(dir)
    const exclude = path.join(dir, ".git", "info", "exclude")
    const reports = path.join(dir, ".agents", "workflow-reports")
    await fs.mkdir(reports, { recursive: true })
    const reportPath = path.join(reports, "report.md")
    await Bun.write(reportPath, "recovered report body")
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    await Effect.runPromise(
      reconcileWorkflow(
        "wf-1",
        () => Effect.succeed("completed" as const),
        undefined,
        { nodes: [{ id: "n1" }] },
        () => Effect.succeed(reportPath),
        dir,
      ).pipe(Effect.provide(makeDagLayer(nodes, events))),
    )
    expect(events).toContainEqual(expect.objectContaining({ type: "nodeCompleted", nodeID: "n1" }))
    expect(await fs.readFile(exclude, "utf8")).toBe(STANDARD_TEMPLATE_EXCLUDE)
    expect(await Bun.file(path.join(dir, ".gitignore")).exists()).toBe(false)
  })

  it("authorizes artifacts and repairs the report area in the bound execution workspace (#947)", async () => {
    const owner = await fs.mkdtemp(path.join(os.tmpdir(), "dag-recovery-owner-"))
    tmpRoots.push(owner)
    await initGitFixture(owner)
    await $`git -C ${owner} -c user.email=test@example.com -c user.name=Test commit --allow-empty -q -m root`.quiet()
    const linked = path.join(os.tmpdir(), `dag-recovery-linked-${Math.random().toString(36).slice(2)}`)
    tmpRoots.push(linked)
    await $`git -C ${owner} worktree add --detach ${linked} HEAD`.quiet()
    const execution = await fs.realpath(linked)
    const reports = path.join(execution, ".agents", "workflow-reports")
    await fs.mkdir(reports, { recursive: true })
    const reportPath = path.join(reports, "report.md")
    await Bun.write(reportPath, "bound workspace report")
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", directory: execution })]
    const authorized: string[] = []
    await Effect.runPromise(
      reconcileWorkflow(
        "wf-1",
        () => Effect.succeed("completed" as const),
        undefined,
        { nodes: [{ id: "n1", workspace: execution }] },
        () => Effect.succeed(reportPath),
        execution,
        (directory) => {
          authorized.push(directory)
          return () => Effect.void
        },
      ).pipe(Effect.provide(makeDagLayer(nodes, events))),
    )
    expect(authorized).toEqual([execution])
    expect(events).toContainEqual(expect.objectContaining({ type: "nodeCompleted", nodeID: "n1" }))
    expect(await fs.readFile(path.join(owner, ".git", "info", "exclude"), "utf8")).toBe(STANDARD_TEMPLATE_EXCLUDE)
  })

  it("uses the persisted workflow directory when recovery has no explicit directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-recovery-root-"))
    tmpRoots.push(dir)
    await initGitFixture(dir)
    const reports = path.join(dir, ".agents", "workflow-reports")
    await fs.mkdir(reports, { recursive: true })
    const report = path.join(reports, "report.md")
    await Bun.write(report, "recovered report")
    const events: TrackedEvent[] = []
    const captured: { sid: string; payload: unknown }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const workflow = { id: "wf-1", projectId: "p", directory: dir } as unknown as DagStore.WorkflowRow
    const dagLayer = makeDagLayer(nodes, events, undefined, captured, undefined, workflow)
    const messages = Layer.mock(DagMessages.Service, {
      revisions: () => Effect.succeed({ ok: false as const, reason: "unauthorized" as const }),
      guard: (_caller, _input, commit) => Effect.map(commit, (value) => ({ ok: true as const, value })),
    })
    await Effect.runPromise(
      reconcileWorkflow(
        "wf-1",
        () => Effect.succeed("completed" as const),
        undefined,
        { nodes: [{ id: "n1" }] },
        () => Effect.succeed(report),
      ).pipe(Effect.provide(Layer.merge(dagLayer, messages))),
    )
    expect(events).toContainEqual(expect.objectContaining({ type: "nodeCompleted", nodeID: "n1" }))
    expect(await fs.readFile(path.join(dir, ".git", "info", "exclude"), "utf8")).toBe(STANDARD_TEMPLATE_EXCLUDE)
    expect(await Bun.file(path.join(dir, ".gitignore")).exists()).toBe(false)
  })

  it("completes a recovered verified receipt after a crash before the live update", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-recovery-crash-"))
    tmpRoots.push(dir)
    await initGitFixture(dir)
    const reports = path.join(dir, ".agents", "workflow-reports")
    await fs.mkdir(reports, { recursive: true })
    const source = path.join(reports, "report.md")
    await Bun.write(source, "crash window report")
    const ref = await Effect.runPromise(
      commitOutputFileRef(source, {
        workflow_id: "wf-1",
        node_id: "n1",
        child_session_id: "ses_1",
        replan_attempt: 0,
      }),
    )
    expect(ref).toBeDefined()
    tmpRoots.push(path.dirname(ref!.path))
    await fs.unlink(source)
    const events: TrackedEvent[] = []
    const captured: { sid: string; payload: unknown }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", capturedOutput: ref })]
    const workflow = { id: "wf-1", projectId: "p", directory: dir } as unknown as DagStore.WorkflowRow
    const dagLayer = makeDagLayer(nodes, events, undefined, captured, undefined, workflow)
    await Effect.runPromise(
      reconcileWorkflow(
        "wf-1",
        () => Effect.succeed("completed" as const),
        undefined,
        { nodes: [{ id: "n1" }] },
        () => Effect.succeed(source),
      ).pipe(Effect.provide(dagLayer)),
    )
    expect(events).toContainEqual(expect.objectContaining({ type: "nodeCompleted", nodeID: "n1" }))
    expect(await fs.readFile(path.join(dir, ".git", "info", "exclude"), "utf8")).toBe(STANDARD_TEMPLATE_EXCLUDE)
    expect(await Bun.file(path.join(dir, ".gitignore")).exists()).toBe(false)
  })

  it("keeps a verified receipt when the workflow lookup fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-recovery-lookup-fail-"))
    tmpRoots.push(dir)
    await initGitFixture(dir)
    const exclude = path.join(dir, ".git", "info", "exclude")
    const beforeExcludeExists = await Bun.file(exclude).exists()
    const beforeExclude = beforeExcludeExists ? await fs.readFile(exclude) : undefined
    expect(beforeExclude?.toString()).toBe(STANDARD_TEMPLATE_EXCLUDE)
    const reports = path.join(dir, ".agents", "workflow-reports")
    await fs.mkdir(reports, { recursive: true })
    const source = path.join(reports, "report.md")
    await Bun.write(source, "lookup failure report")
    const ref = await Effect.runPromise(
      commitOutputFileRef(source, {
        workflow_id: "wf-1",
        node_id: "n1",
        child_session_id: "ses_1",
        replan_attempt: 0,
      }),
    )
    expect(ref).toBeDefined()
    tmpRoots.push(path.dirname(ref!.path))
    await fs.unlink(source)
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", capturedOutput: ref })]
    await Effect.runPromise(
      reconcileWorkflow(
        "wf-1",
        () => Effect.succeed("completed" as const),
        undefined,
        { nodes: [{ id: "n1" }] },
        () => Effect.succeed(source),
      ).pipe(Effect.provide(makeDagLayer(nodes, events, undefined, undefined, { workflowFail: true }))),
    )
    expect(events).toContainEqual(expect.objectContaining({ type: "nodeCompleted", nodeID: "n1" }))
    expect(events.some((event) => event.type === "nodeFailed")).toBe(false)
    expect(await Bun.file(exclude).exists()).toBe(beforeExcludeExists)
    if (beforeExclude !== undefined) expect(await fs.readFile(exclude)).toEqual(beforeExclude)
  })

  it("propagates interruption from the workflow lookup", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-recovery-lookup-interrupt-"))
    tmpRoots.push(dir)
    await initGitFixture(dir)
    const exclude = path.join(dir, ".git", "info", "exclude")
    const beforeExcludeExists = await Bun.file(exclude).exists()
    const beforeExclude = beforeExcludeExists ? await fs.readFile(exclude) : undefined
    expect(beforeExclude?.toString()).toBe(STANDARD_TEMPLATE_EXCLUDE)
    const reports = path.join(dir, ".agents", "workflow-reports")
    await fs.mkdir(reports, { recursive: true })
    const source = path.join(reports, "report.md")
    await Bun.write(source, "lookup interruption report")
    const ref = await Effect.runPromise(
      commitOutputFileRef(source, {
        workflow_id: "wf-1",
        node_id: "n1",
        child_session_id: "ses_1",
        replan_attempt: 0,
      }),
    )
    expect(ref).toBeDefined()
    tmpRoots.push(path.dirname(ref!.path))
    await fs.unlink(source)
    const events: TrackedEvent[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1", capturedOutput: ref })]
    // The workflow lookup only runs when the message store is present, so the
    // interruption is injected there. `latestSnapshot` is never reached.
    const dagLayer = Layer.merge(
      makeDagLayer(nodes, events, undefined, undefined, { workflowInterrupt: true }),
      Layer.mock(DagMessages.Service, {
        latestSnapshot: () => Effect.succeed({ ok: true, value: undefined }),
      }),
    )
    const exit = await Effect.runPromise(
      Effect.exit(
        reconcileWorkflow(
          "wf-1",
          () => Effect.succeed("completed" as const),
          undefined,
          { nodes: [{ id: "n1" }] },
          () => Effect.succeed(source),
        ).pipe(Effect.provide(dagLayer)),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(events.some((event) => event.type === "nodeCompleted")).toBe(false)
    expect(await Bun.file(exclude).exists()).toBe(beforeExcludeExists)
    if (beforeExclude !== undefined) expect(await fs.readFile(exclude)).toEqual(beforeExclude)
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
