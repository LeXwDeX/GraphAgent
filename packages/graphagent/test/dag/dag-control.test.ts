// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Layer, Option, Result } from "effect"
import { DagStore } from "@graphagent/core/dag/store"
import { InvalidTransitionError, StaleNodeAttemptError, TerminalViolationError } from "@graphagent/core/dag/core/types"
import { Dag, type ExtendTimeoutVerdict, type NodeConfig, type RetargetResult } from "@/dag/dag"
import type { RecoveryPlan } from "@/dag/recovery-plan"
import { DagControl, type ControlRejection, type ControlRejectionKind, type ControlRequest } from "@/dag/control"
import { ResumeBlockedError, ResumeGuard } from "@/dag/resume-guard"
import { StructuralValidationError } from "@/dag/validation"
import { makeWorkflowRow } from "./fixtures"

// The service is pure orchestration over `Dag.Interface`. These tests use a
// recording mock Dag (no database, no event bus, no real lock) so each request
// can be observed at the boundary: which method ran, with which arguments, and
// whether the guard/parking/resume protocol fired around it.

type Recorded = { readonly method: string; readonly args: readonly unknown[] }

type ReplanResult = { cancel: string[]; restart: string[]; replace: string[]; add: string[]; ignore: string[] }
type RecoverResult = Omit<RecoveryPlan, "config"> & { graphRev: number }

interface HarnessOptions {
  readonly workflow?: DagStore.WorkflowRow
  readonly readWorkflow?: (index: number) => Effect.Effect<DagStore.WorkflowRow | undefined, Error>
  readonly pause?: (dagID: string) => Effect.Effect<void, Error>
  readonly resume?: (dagID: string) => Effect.Effect<void, Error>
  readonly step?: (
    dagID: string,
  ) => Effect.Effect<{ status: "stepping"; nodeID?: string } | { status: "no_ready_nodes" }, Error>
  readonly cancel?: (dagID: string) => Effect.Effect<void, Error>
  readonly complete?: (dagID: string) => Effect.Effect<void, Error>
  readonly replan?: (dagID: string, fragment: { nodes: NodeConfig[] }) => Effect.Effect<ReplanResult, Error>
  readonly extend?: (dagID: string, nodes: NodeConfig[]) => Effect.Effect<ReplanResult, Error>
  readonly recover?: (
    dagID: string,
    input: { nodeIDs: readonly string[]; expectedGraphRev: number; resumeCancelled?: boolean },
  ) => Effect.Effect<RecoverResult, Error>
  readonly extendTimeout?: (
    dagID: string,
    nodeID: string,
    timeoutMs: number,
  ) => Effect.Effect<ExtendTimeoutVerdict, Error>
  readonly retarget?: (
    dagID: string,
    input: { workspace?: string; fingerprint?: string; nodeIDs?: readonly string[]; reason?: string },
  ) => Effect.Effect<RetargetResult, Error>
}

interface Harness {
  readonly calls: Recorded[]
  readonly guardChecks: DagStore.WorkflowRow[]
  readonly guardState: { policy: ResumeGuard.Policy | undefined }
  readonly layer: Layer.Layer<DagControl.Service>
}

const emptyReplan: ReplanResult = { cancel: [], restart: [], replace: [], add: [], ignore: [] }

const workflowID = "wf-1"
const caller = { sessionID: "ses_parent" }

const makeNode = (id: string): NodeConfig => ({
  id,
  name: id,
  worker_type: "build",
  depends_on: [],
  required: true,
  prompt_template: { inline: id },
})

function makeHarness(options: HarnessOptions = {}): Harness {
  const calls: Recorded[] = []
  const guardChecks: DagStore.WorkflowRow[] = []
  const guardState: { policy: ResumeGuard.Policy | undefined } = { policy: undefined }
  let readIndex = 0
  const record = (method: string, args: readonly unknown[]) => {
    calls.push({ method, args })
  }

  const store = {
    getWorkflow: (dagID: string) => {
      record("store.getWorkflow", [dagID])
      const index = readIndex++
      return options.readWorkflow ? options.readWorkflow(index) : Effect.succeed(options.workflow)
    },
  } as unknown as DagStore.Interface

  const dagLayer = Layer.mock(Dag.Service, {
    store,
    pause: ((...args: unknown[]) => {
      record("pause", args)
      return options.pause?.(args[0] as string) ?? Effect.void
    }) as Dag.Interface["pause"],
    resume: ((...args: unknown[]) => {
      record("resume", args)
      return options.resume?.(args[0] as string) ?? Effect.void
    }) as Dag.Interface["resume"],
    step: ((...args: unknown[]) => {
      record("step", args)
      return options.step?.(args[0] as string) ?? Effect.succeed({ status: "no_ready_nodes" as const })
    }) as Dag.Interface["step"],
    cancel: ((...args: unknown[]) => {
      record("cancel", args)
      return options.cancel?.(args[0] as string) ?? Effect.void
    }) as Dag.Interface["cancel"],
    complete: ((...args: unknown[]) => {
      record("complete", args)
      return options.complete?.(args[0] as string) ?? Effect.void
    }) as Dag.Interface["complete"],
    replan: ((...args: unknown[]) => {
      record("replan", args)
      const [dagID, fragment] = args as [string, { nodes: NodeConfig[] }]
      return options.replan?.(dagID, fragment) ?? Effect.succeed(emptyReplan)
    }) as Dag.Interface["replan"],
    extend: ((...args: unknown[]) => {
      record("extend", args)
      const [dagID, nodes] = args as [string, NodeConfig[]]
      return options.extend?.(dagID, nodes) ?? Effect.succeed(emptyReplan)
    }) as Dag.Interface["extend"],
    recover: ((...args: unknown[]) => {
      record("recover", args)
      const [dagID, input] = args as [
        string,
        { nodeIDs: readonly string[]; expectedGraphRev: number; resumeCancelled?: boolean },
      ]
      return (
        options.recover?.(dagID, input) ??
        Effect.succeed({ replacements: [], superseded: [], reused: [], preserved: [], graphRev: 7 })
      )
    }) as Dag.Interface["recover"],
    extendTimeout: ((...args: unknown[]) => {
      record("extendTimeout", args)
      const [dagID, nodeID, timeoutMs] = args as [string, string, number]
      return (
        options.extendTimeout?.(dagID, nodeID, timeoutMs) ?? Effect.succeed({ status: "extended", deadlineMs: 1234 })
      )
    }) as Dag.Interface["extendTimeout"],
    retarget: ((...args: unknown[]) => {
      record("retarget", args)
      const [dagID, input] = args as [
        string,
        { workspace?: string; fingerprint?: string; nodeIDs?: readonly string[]; reason?: string },
      ]
      return (
        options.retarget?.(dagID, input) ?? Effect.succeed({ nodes: [], toFingerprint: { kind: "none" }, graphRev: 2 })
      )
    }) as Dag.Interface["retarget"],
  })

  const guardLayer = Layer.succeed(
    ResumeGuard.Service,
    ResumeGuard.Service.of({
      check: (workflow) =>
        Effect.suspend(() => {
          guardChecks.push(workflow)
          return guardState.policy ? guardState.policy.check(workflow) : Effect.void
        }),
    }),
  )

  return {
    calls,
    guardChecks,
    guardState,
    layer: Layer.mergeAll(DagControl.layer.pipe(Layer.provide(dagLayer)), guardLayer),
  }
}

function runHarness<A, E>(harness: Harness, body: (control: DagControl.Interface) => Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const control = yield* DagControl.Service
      return yield* body(control)
    }).pipe(Effect.provide(harness.layer)) as Effect.Effect<A>,
  )
}

function rejectionOf<A>(exit: Exit.Exit<A, ControlRejection>): ControlRejection {
  if (Exit.isSuccess(exit)) throw new Error("expected the control request to fail")
  const found = Cause.findErrorOption(exit.cause)
  if (Option.isNone(found)) throw new Error(`expected a typed rejection, got ${Cause.pretty(exit.cause)}`)
  return found.value
}

function defectOf<A>(exit: Exit.Exit<A, unknown>): unknown {
  if (Exit.isSuccess(exit)) throw new Error("expected the control request to die")
  const found = Cause.findDefect(exit.cause)
  if (Result.isFailure(found)) throw new Error(`expected a defect, got ${Cause.pretty(exit.cause)}`)
  return found.success
}

function methods(harness: Harness): string[] {
  return harness.calls.map((call) => call.method)
}

function reset(harness: Harness) {
  harness.calls.length = 0
}

const activeWorkflow = () => makeWorkflowRow({ id: workflowID, sessionId: "ses_parent", status: "running" })
const pausedWorkflow = () => makeWorkflowRow({ id: workflowID, sessionId: "ses_parent", status: "paused" })

describe("DagControl.apply — request mapping", () => {
  it("maps every control request to its Dag method and payload", async () => {
    const harness = makeHarness({ workflow: activeWorkflow() })
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const pauseOutcome = yield* control.apply(workflowID, { op: "pause" }, caller)
        expect(pauseOutcome).toEqual({ op: "pause", workflowID })
        expect(harness.calls).toEqual([
          { method: "store.getWorkflow", args: [workflowID] },
          { method: "pause", args: [workflowID] },
        ])

        reset(harness)
        const resumeOutcome = yield* control.apply(workflowID, { op: "resume" }, caller)
        expect(resumeOutcome).toEqual({ op: "resume", workflowID })
        expect(harness.calls[1]).toEqual({ method: "resume", args: [workflowID] })

        reset(harness)
        const stepOutcome = yield* control.apply(workflowID, { op: "step" }, caller)
        expect(stepOutcome).toEqual({ op: "step", workflowID, result: { status: "no_ready_nodes" } })
        expect(harness.calls[1]).toEqual({ method: "step", args: [workflowID] })

        reset(harness)
        yield* control.apply(workflowID, { op: "cancel" }, caller)
        expect(harness.calls[1]).toEqual({ method: "cancel", args: [workflowID] })

        reset(harness)
        yield* control.apply(workflowID, { op: "complete" }, caller)
        // `complete` must not expose or forward options from this boundary.
        expect(harness.calls[1]).toEqual({ method: "complete", args: [workflowID] })
      }),
    )
  })

  it("maps prepared replan, extend, recover, extend_timeout, and retarget payloads", async () => {
    const harness = makeHarness({ workflow: activeWorkflow() })
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const replanNodes = [makeNode("b")]
        const replanPrepared = { action: "replan", nodes: replanNodes } as const
        const replanOutcome = yield* control.apply(workflowID, { op: "replan", prepared: replanPrepared }, caller)
        expect(replanOutcome.result).toEqual(emptyReplan)
        expect(replanOutcome.resume).toBe("not-paused")
        expect(harness.calls[1]).toEqual({ method: "replan", args: [workflowID, { nodes: replanNodes }] })

        reset(harness)
        const extendNodes = [makeNode("c")]
        const extendPrepared = { action: "extend", nodes: extendNodes } as const
        const extendOutcome = yield* control.apply(workflowID, { op: "extend", prepared: extendPrepared }, caller)
        expect(extendOutcome.result).toEqual(emptyReplan)
        expect(extendOutcome.resume).toBe("not-paused")
        // Extend forwards the node list itself, not a fragment envelope.
        expect(harness.calls[1]?.method).toBe("extend")
        expect(harness.calls[1]?.args).toEqual([workflowID, extendNodes])
        expect(harness.calls[1]?.args[1]).toBe(extendNodes)

        reset(harness)
        const recoverOutcome = yield* control.apply(
          workflowID,
          { op: "recover", nodeIDs: ["a"], expectedGraphRev: 3, resumeCancelled: true },
          caller,
        )
        expect(recoverOutcome.result.graphRev).toBe(7)
        expect(harness.calls[1]).toEqual({
          method: "recover",
          args: [workflowID, { nodeIDs: ["a"], expectedGraphRev: 3, resumeCancelled: true }],
        })

        reset(harness)
        const timeoutOutcome = yield* control.apply(
          workflowID,
          { op: "extend_timeout", nodeID: "a", timeoutMs: 5000 },
          caller,
        )
        expect(timeoutOutcome.nodeID).toBe("a")
        expect(timeoutOutcome.result).toEqual({ status: "extended", deadlineMs: 1234 })
        expect(harness.calls[1]).toEqual({ method: "extendTimeout", args: [workflowID, "a", 5000] })

        reset(harness)
        const retargetOutcome = yield* control.apply(
          workflowID,
          { op: "retarget", workspace: "/work", fingerprint: "fp", nodeIDs: ["a"], reason: "why" },
          caller,
        )
        expect(retargetOutcome.result).toEqual({ nodes: [], toFingerprint: { kind: "none" }, graphRev: 2 })
        expect(harness.calls[1]).toEqual({
          method: "retarget",
          args: [workflowID, { workspace: "/work", fingerprint: "fp", nodeIDs: ["a"], reason: "why" }],
        })
      }),
    )
  })

  it("passes through each op's Dag result payload", async () => {
    const harness = makeHarness({
      workflow: activeWorkflow(),
      step: () => Effect.succeed({ status: "stepping", nodeID: "a" }),
      recover: () =>
        Effect.succeed({
          replacements: [{ previous: "a#1", current: "a#2", logical: "a", attempt: 1 }],
          superseded: ["a#1"],
          reused: [],
          preserved: [],
          graphRev: 9,
        }),
      extendTimeout: () => Effect.succeed({ status: "cap_exhausted" }),
      retarget: () =>
        Effect.succeed({
          nodes: ["a"],
          toDirectory: "/work",
          toFingerprint: { kind: "none" },
          graphRev: 4,
        }),
    })
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const step = yield* control.apply(workflowID, { op: "step" }, caller)
        expect(step.result).toEqual({ status: "stepping", nodeID: "a" })
        const recover = yield* control.apply(workflowID, { op: "recover", nodeIDs: ["a"], expectedGraphRev: 2 }, caller)
        expect(recover.result.graphRev).toBe(9)
        expect(recover.result.replacements).toHaveLength(1)
        const timeout = yield* control.apply(workflowID, { op: "extend_timeout", nodeID: "a", timeoutMs: 1 }, caller)
        expect(timeout.result).toEqual({ status: "cap_exhausted" })
        const retarget = yield* control.apply(workflowID, { op: "retarget", nodeIDs: ["a"] }, caller)
        expect(retarget.result).toEqual({
          nodes: ["a"],
          toDirectory: "/work",
          toFingerprint: { kind: "none" },
          graphRev: 4,
        })
      }),
    )
  })

  it("rejects a prepared graph whose action does not pair with the request op", async () => {
    const harness = makeHarness({ workflow: activeWorkflow() })
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const replanExit = yield* control
          .apply(workflowID, { op: "replan", prepared: { action: "extend", nodes: [makeNode("b")] } as never }, caller)
          .pipe(Effect.exit)
        const replanRejection = rejectionOf(replanExit)
        expect(replanRejection._tag).toBe("Invalid")
        if (replanRejection._tag === "Invalid") {
          expect(replanRejection.message).toContain('Replan rejected: prepared graph action is "extend"')
          expect(replanRejection.status).toBe("running")
          expect(replanRejection.diagnostics).toEqual([])
        }
        expect(methods(harness)).not.toContain("replan")

        reset(harness)
        const extendExit = yield* control
          .apply(workflowID, { op: "extend", prepared: { action: "replan", nodes: [makeNode("b")] } as never }, caller)
          .pipe(Effect.exit)
        const extendRejection = rejectionOf(extendExit)
        expect(extendRejection._tag).toBe("Invalid")
        if (extendRejection._tag === "Invalid") {
          expect(extendRejection.message).toContain('Extend rejected: prepared graph action is "replan"')
        }
        expect(methods(harness)).not.toContain("extend")
        // Prepared-graph pairing is decided before any mutation; no parking.
        expect(methods(harness)).not.toContain("pause")
      }),
    )
  })
})

describe("DagControl.apply — automatic resume after a landed mutation", () => {
  it("returns not-paused when the workflow was never paused", async () => {
    const harness = makeHarness({ workflow: activeWorkflow() })
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const outcome = yield* control.apply(
          workflowID,
          { op: "replan", prepared: { action: "replan", nodes: [makeNode("b")] } },
          caller,
        )
        expect(outcome.resume).toBe("not-paused")
        expect(methods(harness)).not.toContain("resume")
      }),
    )
  })

  it("returns resumed when the mutation leaves the workflow paused and resume succeeds", async () => {
    const harness = makeHarness({ workflow: pausedWorkflow() })
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const outcome = yield* control.apply(
          workflowID,
          { op: "extend", prepared: { action: "extend", nodes: [makeNode("b")] } },
          caller,
        )
        expect(outcome.resume).toBe("resumed")
        expect(methods(harness)).toContain("resume")
      }),
    )
  })

  it("returns resume-failed for a typed resume refusal and does not park", async () => {
    const harness = makeHarness({
      workflow: pausedWorkflow(),
      resume: (dagID) => Effect.fail(new ResumeBlockedError({ workflowID: dagID, pauseReason: "budget" })),
    })
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const outcome = yield* control.apply(
          workflowID,
          { op: "replan", prepared: { action: "replan", nodes: [makeNode("b")] } },
          caller,
        )
        expect(outcome.resume).toBe("resume-failed")
        // A landed mutation must never be parked by its post-block.
        expect(methods(harness)).not.toContain("pause")
      }),
    )
  })

  it("returns resume-failed when resume dies and does not turn the mutation into a defect", async () => {
    const harness = makeHarness({
      workflow: pausedWorkflow(),
      resume: () => Effect.die(new Error("simulated resume defect")),
    })
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const outcome = yield* control.apply(
          workflowID,
          { op: "extend", prepared: { action: "extend", nodes: [makeNode("b")] } },
          caller,
        )
        expect(outcome.resume).toBe("resume-failed")
        expect(methods(harness)).not.toContain("pause")
      }),
    )
  })

  it("returns resume-failed when the post-mutation status read fails", async () => {
    const harness = makeHarness({
      readWorkflow: (index) =>
        index === 0 ? Effect.succeed(pausedWorkflow()) : Effect.fail(new Error("simulated store read failure")),
    })
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const outcome = yield* control.apply(
          workflowID,
          { op: "replan", prepared: { action: "replan", nodes: [makeNode("b")] } },
          caller,
        )
        expect(outcome.resume).toBe("resume-failed")
        expect(methods(harness)).not.toContain("resume")
      }),
    )
  })
})

describe("DagControl.apply — paused ResumeGuard precheck", () => {
  const vetoPolicy: ResumeGuard.Policy = {
    check: (workflow) =>
      Effect.fail(new ResumeBlockedError({ workflowID: workflow.id, pauseReason: workflow.pauseReason ?? undefined })),
  }
  const allowPolicy: ResumeGuard.Policy = { check: () => Effect.void }

  const precheckedRequests: { readonly op: ControlRequest["op"]; readonly request: ControlRequest }[] = [
    { op: "extend", request: { op: "extend", prepared: { action: "extend", nodes: [makeNode("b")] } } },
    { op: "replan", request: { op: "replan", prepared: { action: "replan", nodes: [makeNode("b")] } } },
    { op: "recover", request: { op: "recover", nodeIDs: ["a"], expectedGraphRev: 2 } },
    { op: "extend_timeout", request: { op: "extend_timeout", nodeID: "a", timeoutMs: 1000 } },
  ]

  for (const { op, request } of precheckedRequests) {
    it(`vetoes a paused ${op} before mutating and without parking`, async () => {
      const harness = makeHarness({ workflow: pausedWorkflow() })
      harness.guardState.policy = vetoPolicy
      await runHarness(harness, (control) =>
        Effect.gen(function* () {
          const exit = yield* control.apply(workflowID, request, caller).pipe(Effect.exit)
          const rejection = rejectionOf(exit)
          expect(rejection._tag).toBe("Conflict")
          if (rejection._tag === "Conflict") {
            expect(rejection.kind).toBe("resume-blocked")
            expect(rejection.status).toBe("paused")
          }
          expect(harness.guardChecks).toHaveLength(1)
          // The veto runs before any mutation, so no Dag command was called and
          // nothing was parked.
          expect(methods(harness)).toEqual(["store.getWorkflow"])
        }),
      )
    })

    it(`allows a paused ${op} when the guard permits it`, async () => {
      const harness = makeHarness({ workflow: pausedWorkflow() })
      harness.guardState.policy = allowPolicy
      await runHarness(harness, (control) =>
        Effect.gen(function* () {
          const outcome = yield* control.apply(workflowID, request, caller)
          expect(outcome.op).toBe(op)
          expect(harness.guardChecks).toHaveLength(1)
          expect(methods(harness)).toContain(
            op === "extend_timeout" ? "extendTimeout" : op === "recover" ? "recover" : op,
          )
        }),
      )
    })

    it(`skips the precheck for a running ${op}`, async () => {
      const harness = makeHarness({ workflow: activeWorkflow() })
      harness.guardState.policy = vetoPolicy
      await runHarness(harness, (control) =>
        Effect.gen(function* () {
          yield* control.apply(workflowID, request, caller)
          expect(harness.guardChecks).toHaveLength(0)
        }),
      )
    })
  }

  it("lets Dag own the resume/step guard instead of duplicating it", async () => {
    const harness = makeHarness({
      workflow: pausedWorkflow(),
      // The real Dag calls ResumeGuard inside its lock for resume/step. The mock
      // does the same so a duplicated service precheck would be observable.
      resume: () =>
        Effect.gen(function* () {
          yield* ResumeGuard.check(pausedWorkflow())
        }),
      step: () =>
        Effect.gen(function* () {
          yield* ResumeGuard.check(pausedWorkflow())
          return { status: "no_ready_nodes" as const }
        }),
    })
    harness.guardState.policy = vetoPolicy
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const resumeExit = yield* control.apply(workflowID, { op: "resume" }, caller).pipe(Effect.exit)
        expect(rejectionOf(resumeExit)._tag).toBe("Conflict")
        expect(harness.guardChecks).toHaveLength(1)

        reset(harness)
        const stepExit = yield* control.apply(workflowID, { op: "step" }, caller).pipe(Effect.exit)
        expect(rejectionOf(stepExit)._tag).toBe("Conflict")
        expect(harness.guardChecks).toHaveLength(2)
      }),
    )
  })
})

describe("DagControl.parkRejected", () => {
  it("leaves a terminal workflow unchanged", async () => {
    const harness = makeHarness({
      workflow: makeWorkflowRow({ id: workflowID, sessionId: "ses_parent", status: "completed" }),
    })
    const outcome = await runHarness(harness, (control) => control.parkRejected(workflowID, caller))
    expect(outcome).toEqual({ result: "terminal-unchanged", status: "completed" })
    expect(methods(harness)).not.toContain("pause")
  })

  it("parks a live workflow", async () => {
    const harness = makeHarness({ workflow: activeWorkflow() })
    const outcome = await runHarness(harness, (control) => control.parkRejected(workflowID, caller))
    expect(outcome).toEqual({ result: "parked", status: "paused" })
    expect(methods(harness)).toContain("pause")
  })

  it("reports already-paused when a losing pause race reads back paused", async () => {
    const harness = makeHarness({
      readWorkflow: (index) => Effect.succeed(index === 0 ? activeWorkflow() : pausedWorkflow()),
      pause: () => Effect.fail(new Error("simulated pause race")),
    })
    const outcome = await runHarness(harness, (control) => control.parkRejected(workflowID, caller))
    expect(outcome).toEqual({ result: "already-paused", status: "paused" })
  })

  it("reports the read-back status and pause failure when parking fails", async () => {
    const harness = makeHarness({
      workflow: activeWorkflow(),
      pause: () => Effect.fail(new Error("simulated pause failure")),
    })
    const outcome = await runHarness(harness, (control) => control.parkRejected(workflowID, caller))
    expect(outcome.status).toBe("running")
    expect(outcome.result).toMatchObject({ actualStatus: "running" })
    if (typeof outcome.result === "object") {
      expect(outcome.result.failed).toContain("simulated pause failure")
    } else {
      throw new Error("expected the failed park result")
    }
  })

  it("degrades a failed read-back to unknown", async () => {
    const harness = makeHarness({
      readWorkflow: (index) =>
        index === 0
          ? Effect.succeed(activeWorkflow())
          : Effect.fail(new Error("simulated read failure during parking")),
      pause: () => Effect.fail(new Error("simulated pause failure")),
    })
    const outcome = await runHarness(harness, (control) => control.parkRejected(workflowID, caller))
    expect(outcome.status).toBe("unknown")
    expect(outcome.result).toMatchObject({ actualStatus: "unknown" })
  })

  it("propagates an interrupt from the pause command", async () => {
    const harness = makeHarness({
      workflow: activeWorkflow(),
      pause: () => Effect.interrupt,
    })
    const exit = await runHarness(harness, (control) => control.parkRejected(workflowID, caller).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  })

  it("rejects parking a workflow owned by another session", async () => {
    const harness = makeHarness({
      workflow: makeWorkflowRow({ id: workflowID, sessionId: "ses_other", status: "running" }),
    })
    const exit = await runHarness(harness, (control) => control.parkRejected(workflowID, caller).pipe(Effect.exit))
    expect(rejectionOf(exit)._tag).toBe("NotFound")
    expect(methods(harness)).not.toContain("pause")
  })
})

describe("DagControl applicability — owner check", () => {
  it("rejects a missing workflow without mutating or parking", async () => {
    const harness = makeHarness({ workflow: undefined })
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const exit = yield* control.apply(workflowID, { op: "pause" }, caller).pipe(Effect.exit)
        expect(rejectionOf(exit)._tag).toBe("NotFound")
        expect(methods(harness)).toEqual(["store.getWorkflow"])
        expect(methods(harness)).not.toContain("pause")
      }),
    )
  })

  it("rejects a workflow owned by a different session without mutating or parking", async () => {
    const harness = makeHarness({
      workflow: makeWorkflowRow({ id: workflowID, sessionId: "ses_other", status: "running" }),
    })
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const exit = yield* control.apply(workflowID, { op: "cancel" }, caller).pipe(Effect.exit)
        expect(rejectionOf(exit)._tag).toBe("NotFound")
        expect(methods(harness)).toEqual(["store.getWorkflow"])
      }),
    )
  })
})

describe("DagControl rejection classification", () => {
  type MappingCase = {
    readonly name: string
    readonly error: Error
    readonly tag: "NotFound" | "Conflict" | "Invalid"
    readonly kind?: ControlRejectionKind
    readonly status?: string
    readonly pauseReason?: string
    readonly diagnostics?: number
    readonly defect?: boolean
  }

  const staleAttempt = new StaleNodeAttemptError(
    "node-1",
    { replanAttempts: 0 },
    { replanAttempts: 1, nodeSeq: 2, childSessionID: null, graphRev: 1 },
  )

  const cases: MappingCase[] = [
    {
      name: "InvalidTransitionError for this workflow uses the error's fromStatus",
      error: new InvalidTransitionError(workflowID, "paused", "running"),
      tag: "Conflict",
      kind: "transition",
      status: "paused",
    },
    {
      name: "InvalidTransitionError for a node falls back to the persisted status",
      error: new InvalidTransitionError("node-1", "running", "completed"),
      tag: "Conflict",
      kind: "transition",
      status: "running",
    },
    {
      name: "TerminalViolationError uses the terminal status",
      error: new TerminalViolationError(workflowID, "completed", "running", "done"),
      tag: "Conflict",
      kind: "terminal",
      status: "completed",
    },
    {
      name: "StaleNodeAttemptError is a stale-attempt conflict at the persisted status",
      error: staleAttempt,
      tag: "Conflict",
      kind: "stale-attempt",
      status: "running",
    },
    {
      name: "ReviewGateError is a review-gate conflict",
      error: new Dag.ReviewGateError(workflowID, ["review-1"]),
      tag: "Conflict",
      kind: "review-gate",
      status: "running",
    },
    {
      name: "CompletionGateError is a completion-gate conflict",
      error: new Dag.CompletionGateError(workflowID, ["node-1"]),
      tag: "Conflict",
      kind: "completion-gate",
      status: "running",
    },
    {
      name: "ResumeBlockedError reports paused with the durable pause reason",
      error: new ResumeBlockedError({ workflowID, pauseReason: "budget" }),
      tag: "Conflict",
      kind: "resume-blocked",
      status: "paused",
      pauseReason: "budget",
    },
    {
      name: "StructuralValidationError is invalid with diagnostics",
      error: new StructuralValidationError({
        diagnostics: [{ severity: "error", code: "dag.invalid", path: "nodes", message: "bad node", hint: "fix it" }],
      }),
      tag: "Invalid",
      status: "running",
      diagnostics: 1,
    },
    {
      name: "a missing workflow is NotFound",
      error: new Error("Workflow not found: wf-1"),
      tag: "NotFound",
    },
    {
      name: "an in-flight node is a transition conflict",
      error: new Error("Node still in-flight: cannot step wf-1"),
      tag: "Conflict",
      kind: "transition",
      status: "running",
    },
    {
      name: "a stale recovery revision is a transition conflict",
      error: new Error("Recovery rejected: stale expected_graph_rev 1"),
      tag: "Conflict",
      kind: "transition",
      status: "running",
    },
    {
      name: "a changed-workflow recovery rejection is a transition conflict",
      error: new Error("Recovery rejected: workflow changed during artifact verification"),
      tag: "Conflict",
      kind: "transition",
      status: "running",
    },
    {
      name: "a status-mismatched recovery is a transition conflict",
      error: new Error("Recovery requires a paused or failed workflow"),
      tag: "Conflict",
      kind: "transition",
      status: "running",
    },
    {
      name: "a missing target fingerprint is a transition conflict",
      error: new Error("Retarget rejected: expected target fingerprint"),
      tag: "Conflict",
      kind: "transition",
      status: "running",
    },
    {
      name: "completed target-sensitive nodes are a transition conflict",
      error: new Error("Retarget rejected: completed target-sensitive node(s): a"),
      tag: "Conflict",
      kind: "transition",
      status: "running",
    },
    {
      name: "non-running target-sensitive attempts are a transition conflict",
      error: new Error("Retarget rejected: node(s) are not running target-sensitive attempts: a"),
      tag: "Conflict",
      kind: "transition",
      status: "running",
    },
    {
      name: "a missing node is invalid",
      error: new Error("Node not found: node-1"),
      tag: "Invalid",
      status: "running",
      diagnostics: 0,
    },
    {
      name: "a replan rejection is invalid",
      error: new Error("Replan rejected: cycle detected"),
      tag: "Invalid",
      status: "running",
      diagnostics: 0,
    },
    {
      name: "an unacknowledged cancelled recovery is invalid",
      error: new Error("Recovery of a cancelled workflow requires explicit resume_cancelled: true"),
      tag: "Invalid",
      status: "running",
      diagnostics: 0,
    },
    {
      name: "reusing an artifact is invalid",
      error: new Error("Recovery cannot reuse artifact from node a"),
      tag: "Invalid",
      status: "running",
      diagnostics: 0,
    },
    {
      name: "an empty recovery selection is invalid",
      error: new Error("Recovery requires at least one node_id"),
      tag: "Invalid",
      status: "running",
      diagnostics: 0,
    },
    {
      name: "a recovery attempt ceiling is invalid",
      error: new Error("Recovery attempt ceiling exceeded"),
      tag: "Invalid",
      status: "running",
      diagnostics: 0,
    },
    {
      name: "an invalid retarget input is invalid",
      error: new Error("Retarget rejected: node_ids must not be empty"),
      tag: "Invalid",
      status: "running",
      diagnostics: 0,
    },
    {
      name: "an unrecognized runtime error dies as a defect",
      error: new Error("simulated store failure"),
      tag: "Conflict",
      defect: true,
    },
  ]

  for (const mapping of cases) {
    it(mapping.name, async () => {
      const harness = makeHarness({
        workflow: activeWorkflow(),
        pause: () => Effect.fail(mapping.error),
      })
      const exit = await runHarness(harness, (control) =>
        control.apply(workflowID, { op: "pause" }, caller).pipe(Effect.exit),
      )
      if (mapping.defect) {
        expect(defectOf(exit)).toBe(mapping.error)
        return
      }
      const rejection = rejectionOf(exit)
      expect(rejection._tag).toBe(mapping.tag)
      if (rejection._tag === "NotFound") return
      expect(rejection.status).toBe(mapping.status ?? "running")
      expect(rejection.cause).toBe(mapping.error)
      if (rejection._tag === "Conflict") {
        if (mapping.kind) expect(rejection.kind).toBe(mapping.kind)
        if (mapping.pauseReason) expect(rejection.pauseReason).toBe(mapping.pauseReason)
      }
      if (rejection._tag === "Invalid") {
        expect(rejection.diagnostics).toHaveLength(mapping.diagnostics ?? 0)
      }
    })
  }

  it("attaches the parked result to a rejected replan", async () => {
    const harness = makeHarness({
      workflow: activeWorkflow(),
      replan: () => Effect.fail(new Error("Replan rejected: cycle detected")),
    })
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const exit = yield* control
          .apply(workflowID, { op: "replan", prepared: { action: "replan", nodes: [makeNode("b")] } }, caller)
          .pipe(Effect.exit)
        const rejection = rejectionOf(exit)
        expect(rejection._tag).toBe("Invalid")
        if (rejection._tag !== "Invalid") throw new Error("expected an Invalid rejection")
        expect(rejection.parked).toBe("parked")
        expect(methods(harness)).toContain("pause")
      }),
    )
  })

  it("does not park a non-replan/extend rejection", async () => {
    const harness = makeHarness({
      workflow: activeWorkflow(),
      resume: () => Effect.fail(new Error("Node not found: node-1")),
    })
    await runHarness(harness, (control) =>
      Effect.gen(function* () {
        const exit = yield* control.apply(workflowID, { op: "resume" }, caller).pipe(Effect.exit)
        expect(rejectionOf(exit)._tag).toBe("Invalid")
        expect(methods(harness)).not.toContain("pause")
      }),
    )
  })
})
