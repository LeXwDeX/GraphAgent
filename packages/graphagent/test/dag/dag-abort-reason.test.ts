// Issue #955 — runtime-initiated child interruption must name its reason and actor.
//
// The DAG runtime cannot infer why a child stopped after the fact: a deadline
// cap, parent control, replan, scope shutdown and recovery all look like a
// bare MessageAbortedError in durable history. These tests pin the explicit
// reason threaded into the interruption and the reason recovery reports.
import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { DagStore } from "@graphagent/core/dag/store"
import { Project } from "@graphagent/core/project"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { Dag } from "@/dag/dag"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { SessionPrompt } from "@/session/prompt"
import { SessionAbortReason } from "@/session/abort-reason"
import { MessageID, SessionID } from "@/session/schema"
import {
  childAbort,
  childFailureReason,
  type ChildAbortActor,
  type ChildAbortReason,
} from "../../src/dag/runtime/child-failure-reason"
import { makeDeadlineWatcher } from "../../src/dag/runtime/spawn"
import { reconcileWorkflow } from "../../src/dag/runtime/recovery"
import { makeNodeRow } from "./fixtures"

const paths: ReadonlyArray<readonly [ChildAbortReason, ChildAbortActor]> = [
  ["deadline-cap", "deadline-watcher"],
  ["deadline-supervision-lost", "deadline-watcher"],
  ["control-cancel", "parent-control"],
  ["workflow-complete", "dag-loop"],
  ["workflow-failed", "dag-loop"],
  ["replan", "dag-replan"],
  ["attempt-replaced", "dag-loop"],
  ["failure-cleanup", "dag-loop"],
  ["runtime-interrupt", "runtime-scope"],
  ["shutdown", "runtime-scope"],
  ["parent-session-deleted", "parent-session"],
  ["location-moved", "dag-location"],
  ["recovery", "recovery"],
  ["admission-rejected", "dag-loop"],
  ["admission-error", "dag-loop"],
]

const ABORTED = (message: string): SessionV1.Assistant["error"] => ({
  name: "MessageAbortedError",
  data: { message },
})

describe("DAG child abort reason", () => {
  for (const [reason, actor] of paths) {
    it(`names ${reason} by ${actor}`, () => {
      const abort = childAbort(reason, actor)
      const message = SessionAbortReason.format(abort)
      expect(SessionAbortReason.parse(message)).toEqual({ reason, actor })
      const failure = childFailureReason("child session failed (recovered)", ABORTED(message))
      expect(failure).toContain(`reason: ${reason}`)
      expect(failure).toContain(`actor: ${actor}`)
      expect(failure).not.toContain("interrupt source unknown")
    })
  }

  it("keeps the legacy unknown wording for aborts outside the runtime", () => {
    const failure = childFailureReason("child session failed (recovered)", ABORTED("Aborted"))
    expect(failure).toContain("interrupt source unknown")
    expect(failure).not.toContain("reason:")
  })

  it("never copies arbitrary abort message payloads", () => {
    const failure = childFailureReason("child session failed (recovered)", ABORTED("provider secret payload"))
    expect(failure).not.toContain("provider secret payload")
  })

  it("names provider aborts without copying the provider payload", () => {
    const message = SessionAbortReason.provider("upstream aborted the request")
    const failure = childFailureReason("child session failed (recovered)", ABORTED(message))
    expect(failure).toContain("reason: provider-aborted")
    expect(failure).toContain("actor: provider")
    expect(failure).not.toContain("upstream aborted the request")
    expect(failure).not.toContain("interrupt source unknown")
  })

  it("only upgrades legacy abort records and never relabels runtime or provider records", () => {
    const runtime = SessionAbortReason.format(childAbort("replan", "dag-replan"))
    expect(SessionAbortReason.replaceableByCancellation(undefined)).toBe(true)
    expect(SessionAbortReason.replaceableByCancellation("Aborted")).toBe(true)
    expect(SessionAbortReason.replaceableByCancellation(runtime)).toBe(false)
    expect(SessionAbortReason.replaceableByCancellation(SessionAbortReason.provider("Aborted"))).toBe(false)
    expect(SessionAbortReason.provider(runtime)).toBe(runtime)
  })

  it("does not relabel a provider abort during a cancellation race", () => {
    const provider = SessionAbortReason.provider("The operation was aborted.")
    expect(SessionAbortReason.origin(provider)).toBe("provider")
    expect(SessionAbortReason.replaceableByCancellation(provider)).toBe(false)
    expect(childFailureReason("child session failed (recovered)", ABORTED(provider))).toContain(
      "reason: provider-aborted",
    )
  })
})

describe("DAG deadline watcher abort reason", () => {
  it("records the cap verdict and cancels the child with the deadline reason", async () => {
    const node = makeNodeRow({
      id: "n1",
      status: "running",
      childSessionId: "ses_child",
      deadlineMs: 1,
      timeoutExtensions: 0,
      startedAt: 0,
    })
    const failed: Array<{ reason: string; trigger: string }> = []
    const cancelled: Array<{ sessionID: string; reason?: SessionAbortReason.Info }> = []
    const store = Layer.mock(DagStore.Service, {
      getNode: () => Effect.succeed(node),
    })
    const dagLayer = Layer.unwrap(
      Effect.map(DagStore.Service, (store) =>
        Layer.mock(Dag.Service, {
          store,
          nodeFailed: (_dagID: string, _nodeID: string, reason: string, trigger: string) =>
            Effect.sync(() => {
              failed.push({ reason, trigger })
            }),
        }),
      ),
    ).pipe(Layer.provide(store))
    const promptLayer = Layer.mock(SessionPrompt.Service, {
      cancel: (sessionID: SessionID, options?: { readonly reason?: SessionAbortReason.Info }) =>
        Effect.sync(() => {
          cancelled.push({ sessionID, reason: options?.reason })
        }),
    })
    const instance: InstanceContext = {
      directory: "/tmp",
      worktree: "/tmp",
      root: "/tmp",
      project: {
        id: Project.ID.make("project-1"),
        worktree: "/tmp",
        time: { created: 0, updated: 0 },
        sandboxes: [],
      },
    }

    await Effect.runPromise(
      makeDeadlineWatcher({
        dagID: "dag_abort",
        nodeID: "n1",
        attempt: { replanAttempts: 0, childSessionID: "ses_child" },
        timeoutMs: 1_000,
        maxTimeoutExtensions: 0,
      }).pipe(
        Effect.timeout("2 seconds"),
        Effect.provide(dagLayer),
        Effect.provide(promptLayer),
        Effect.provideService(InstanceRef, instance),
      ),
    )

    expect(failed).toHaveLength(1)
    expect(failed[0].trigger).toBe("timeout")
    expect(failed[0].reason).toContain("timeout extensions exhausted (0/0)")
    expect(failed[0].reason).toContain("timed out at the cap")
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]).toEqual({
      sessionID: "ses_child",
      reason: { reason: "deadline-cap", actor: "deadline-watcher" },
    })
  })
})

describe("recovered DAG child abort reason", () => {
  it("shows the durable runtime reason instead of unknown", async () => {
    const message = SessionAbortReason.format(childAbort("replan", "dag-replan"))
    const node = makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })
    const failed: Array<{ reason: string; trigger: string }> = []
    const store = Layer.mock(DagStore.Service, {
      getNodes: () => Effect.succeed([node]),
      getNode: () => Effect.succeed(node),
    })
    const dagLayer = Layer.unwrap(
      Effect.map(DagStore.Service, (store) =>
        Layer.mock(Dag.Service, {
          store,
          nodeFailed: (_dagID: string, _nodeID: string, reason: string, trigger: string) =>
            Effect.sync(() => {
              failed.push({ reason, trigger })
            }),
        }),
      ),
    ).pipe(Layer.provide(store))
    const reader = () =>
      Effect.succeed({
        info: {
          id: MessageID.ascending(),
          role: "assistant" as const,
          parentID: MessageID.ascending(),
          sessionID: SessionID.make("ses_1"),
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: Date.now() },
          error: ABORTED(message),
        },
        parts: [],
      })

    await Effect.runPromise(
      reconcileWorkflow(
        "dag_abort",
        () => Effect.succeed("failed" as const),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        reader,
      ).pipe(Effect.provide(dagLayer)),
    )

    expect(failed).toHaveLength(1)
    expect(failed[0].trigger).toBe("exec_failed")
    expect(failed[0].reason).toContain("reason: replan")
    expect(failed[0].reason).toContain("actor: dag-replan")
    expect(failed[0].reason).not.toContain("interrupt source unknown")
  })
})

describe("SessionAbortReason pending handoff", () => {
  it("consumes a reason once and leaves newer cancellations alone", () => {
    const first = childAbort("shutdown", "runtime-scope")
    const second = childAbort("recovery", "recovery")
    SessionAbortReason.set("ses_test", first)
    expect(SessionAbortReason.take("ses_test")).toEqual(first)
    expect(SessionAbortReason.take("ses_test")).toBeUndefined()
    SessionAbortReason.set("ses_test", second)
    SessionAbortReason.clear("ses_test", first)
    expect(SessionAbortReason.take("ses_test")).toEqual(second)
  })
})
