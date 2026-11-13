// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Effect, Layer, Option, Scope } from "effect"
import { makeChildRuns, type ChildRuns } from "@/session/child/run"
import { ChildRegistry } from "@/session/child/registry"
import type { ChildCancelBy, ChildRunCredential, ChildRunOutcome, ChildRunView } from "@/session/child/types"
import type { PromptInput } from "@/session/prompt-input"
import { SessionPrompt } from "@/session/prompt"
import type { SessionID } from "@/session/schema"
import type { AdmissionOptions } from "@/session/turns"
import type { Tool } from "@/tool/tool"

/**
 * Child runs over the test database (Issue #1026). The runtime builds them in
 * `SessionPrompt.layer`; tests that drive the task tool directly build the same
 * factory here. `cancelSession` stands in for `SessionPrompt.cancel` and
 * `driver` for the prompt side of `SessionPrompt`; without a driver the runs
 * can be registered, settled and cancelled but not driven.
 */
export const testChildRuns = (cancelSession?: ChildRuns.Deps["cancelSession"], driver?: ChildRuns.Driver) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope
    return yield* makeChildRuns({
      db,
      scope,
      cancelSession: cancelSession ?? (() => Effect.void),
      ...(driver ? { driver } : {}),
    })
  })

/** What a task test stands in for the session's prompt side with: a prompt, the prompt template, a turn cancel. */
export interface StubDriver {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly resolvePromptParts: ChildRuns.Driver["resolvePromptParts"]
  readonly prompt: (input: PromptInput, options?: AdmissionOptions) => Effect.Effect<SessionV1.WithParts>
}

/** One prompt a task sent to its child session, as the admission seam saw it. */
export interface Drive {
  readonly input: PromptInput
  readonly options: AdmissionOptions
  /** The credential the prompt carried. */
  readonly credential: ChildRunCredential | undefined
  /** The credential of the child session's active run when the prompt went out: what it has to carry. */
  readonly active: ChildRunCredential | undefined
}

const isStubDriver = (value: unknown): value is StubDriver =>
  typeof value === "object" &&
  value !== null &&
  "prompt" in value &&
  typeof value.prompt === "function" &&
  "cancel" in value &&
  typeof value.cancel === "function" &&
  "resolvePromptParts" in value &&
  typeof value.resolvePromptParts === "function"

/**
 * Initializes a task tool the way the engine hands it to a model: every
 * `execute` call carries a `children` capability narrowed to the calling
 * session, unless the test supplies its own. The task drives its child
 * session through it, so the child runs of a call are built over the
 * `extra.promptOps` stub the call carries (the stand-in for the session's
 * prompt side): its `prompt` receives every prompt the task sends and its
 * `cancel` every turn interruption. `cancelSession` receives the cancellations
 * a run ends with (those that carry a reason).
 *
 * The built `children` instance is returned on the definition so a test can
 * read the rows and registry state, and so are the `drives`: every prompt the
 * task sent, with the credential it carried next to the one it had to carry.
 */
/**
 * A SessionPrompt layer whose child-run seam is a recording stub (Issue #1026,
 * PR4). The DAG spawn and recovery now register runs and drive prompts through
 * `SessionPrompt.children`; a mock that only spells `prompt` would die at the
 * first drive. The stub delegates `prompt` to the implementation the test gave
 * (so its assertions keep working) and records the start/adopt/cancel calls a
 * test wants to see.
 */
export interface StubChildren {
  readonly runs: Array<{
    readonly childSessionID: SessionID
    readonly owner: unknown
    readonly detached: boolean
    readonly via: "start" | "adopt"
  }>
  readonly prompts: Array<{ readonly input: PromptInput; readonly options?: AdmissionOptions }>
  readonly settled: Array<{ readonly id: string; readonly outcome: ChildRunOutcome }>
  readonly cancelled: Array<{ readonly id: string | undefined; readonly by: ChildCancelBy }>
  /** What `latest(childSessionID)` answers; set it to make a path adopt instead of start. */
  latest?: ChildRunView
}

export const stubChildren = (
  impl: Partial<SessionPrompt.Interface> = {},
): { readonly children: ChildRuns.Interface; readonly stub: StubChildren } => {
  const runs: StubChildren["runs"] = []
  const prompts: StubChildren["prompts"] = []
  const settled: StubChildren["settled"] = []
  const cancelled: StubChildren["cancelled"] = []
  const runSessions = new Map<string, SessionID>()
  const stub: StubChildren = { runs, prompts, settled, cancelled }
  let sequence = 0
  // A cancelled run's session cancellation is what the engine-side tests
  // watched for before runs existed; the stub forwards it to the prompt mock.
  const cancelSession = (childSessionID: SessionID, by: ChildCancelBy): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!impl.cancel) return Effect.void
      const reason =
        by.kind === "main_agent_tool"
          ? { reason: "task-cancelled", actor: "main-agent" }
          : { reason: by.reason, actor: by.actor ?? "child-runs" }
      return impl.cancel(childSessionID, { reason })
    })
  const handle = (childSessionID: SessionID) => {
    const id = `crun_stub_${++sequence}`
    runSessions.set(id, childSessionID)
    return {
      id,
      childSessionID,
      attempt: 1,
      markRunning: Effect.succeed(true),
      settle: (outcome: ChildRunOutcome) =>
        Effect.sync(() => {
          settled.push({ id, outcome })
          return true
        }),
      detach: Effect.succeed(true),
      stopDelegated: Effect.succeed(false),
      settled: Effect.never,
      cancelled: Effect.never,
    }
  }
  const register = (spec: { childSessionID: SessionID; owner: unknown; detached: boolean }, via: "start" | "adopt") =>
    Effect.sync(() => {
      runs.push({
        childSessionID: spec.childSessionID,
        owner: spec.owner,
        detached: spec.detached,
        via,
      })
      return handle(spec.childSessionID)
    })
  const scoped = (parentSessionID: SessionID): ChildRuns.Scoped => ({
    parentSessionID,
    prompt: (input, options) =>
      Effect.suspend(() => {
        // Mirrors `ChildRuns.prompt`: every delegation carries
        // `internalDelegation`, whether or not the caller spelled it.
        const admitted = { ...options, internalDelegation: true as const }
        prompts.push({ input, options: admitted })
        return impl.prompt
          ? impl.prompt(input, admitted).pipe(Effect.catch((error) => Effect.die(error)))
          : Effect.die(new Error("stub child prompt"))
      }),
    interrupt: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    start: (spec) => register(spec, "start"),
    adopt: (spec) => register(spec, "adopt"),
    latest: () => Effect.succeed(Option.fromNullishOr(stub.latest)),
    list: () => Effect.succeed([]),
    cancel: (id, by) =>
      Effect.suspend(() => {
        cancelled.push({ id, by })
        const childSessionID = runSessions.get(id)
        return childSessionID
          ? cancelSession(childSessionID, by).pipe(Effect.as("cancelled" as const))
          : Effect.succeed("cancelled" as const)
      }),
  })
  const children: ChildRuns.Interface = {
    start: (spec) => register(spec, "start"),
    adopt: (spec) => register(spec, "adopt"),
    inspect: () => Effect.succeed(Option.none()),
    latest: () => Effect.succeed(Option.fromNullishOr(stub.latest)),
    listByParent: () => Effect.succeed([]),
    prompt: (parentSessionID, input, options) => scoped(parentSessionID).prompt(input, options),
    interrupt: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    cancel: (id, by) =>
      Effect.suspend(() => {
        cancelled.push({ id, by })
        const childSessionID = runSessions.get(id)
        return childSessionID
          ? cancelSession(childSessionID, by).pipe(Effect.as("cancelled" as const))
          : Effect.succeed("cancelled" as const)
      }),
    cancelActive: (childSessionID, by) =>
      Effect.suspend(() => {
        cancelled.push({ id: childSessionID, by })
        return cancelSession(childSessionID, by).pipe(Effect.as("cancelled" as const))
      }),
    detach: () => Effect.succeed(true),
    recover: () => Effect.void,
    forget: () => Effect.void,
    forParent: scoped,
  }
  return { children, stub }
}

/**
 * A `SessionPrompt.Service` mock with a stub `children` seam; everything else
 * comes from `impl`. The index signature keeps the contextual type as wide as
 * `Layer.mock`'s own, so helpers like `withIdleAdmission` keep inferring their
 * prompt/cancel members.
 */
export const mockSessionPrompt = (impl: Partial<SessionPrompt.Interface> & Record<string, unknown> = {}) =>
  Layer.mock(SessionPrompt.Service, {
    ...impl,
    children: Effect.succeed(stubChildren(impl).children),
  } as Partial<SessionPrompt.Interface>)

/** `mockSessionPrompt` plus the recording stub, for tests that assert run registration. */
export const mockSessionPromptWithStub = (impl: Partial<SessionPrompt.Interface> & Record<string, unknown> = {}) => {
  const built = stubChildren(impl)
  return {
    layer: Layer.mock(SessionPrompt.Service, {
      ...impl,
      children: Effect.succeed(built.children),
    } as Partial<SessionPrompt.Interface>),
    stub: built.stub,
  }
}

export const initTaskTool = <D extends { execute: (args: never, ctx: Tool.Context) => unknown }>(
  tool: { init: () => Effect.Effect<D> },
  cancelSession?: ChildRuns.Deps["cancelSession"],
) =>
  Effect.gen(function* () {
    const def = yield* tool.init()
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope
    const children = yield* testChildRuns(cancelSession)
    const drives: Drive[] = []
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- this generic helper types the tool's execute result as unknown
    const run = (args: never, ctx: Tool.Context) => def.execute(args, ctx) as Effect.Effect<unknown>
    const execute = ((args: never, ctx: Tool.Context) => {
      if (ctx.children) return run(args, ctx)
      const stub = isStubDriver(ctx.extra?.promptOps) ? ctx.extra.promptOps : undefined
      return Effect.gen(function* () {
        const driven = yield* makeChildRuns({
          db,
          scope,
          cancelSession: (sessionID, options) =>
            options?.reason
              ? (cancelSession ?? (() => Effect.void))(sessionID, options)
              : (stub?.cancel(sessionID) ?? Effect.void),
          ...(stub
            ? {
                driver: {
                  resolvePromptParts: stub.resolvePromptParts,
                  prompt: (input, options, extras) =>
                    Effect.suspend(() => {
                      drives.push({
                        input,
                        options,
                        credential: extras?.credential,
                        active: ChildRegistry.credentialOf(input.sessionID),
                      })
                      return stub.prompt(input, options)
                    }),
                },
              }
            : {}),
        })
        return yield* run(args, { ...ctx, children: driven.forParent(ctx.sessionID) })
      })
    }) as D["execute"]
    return Object.assign({}, def, { execute, children, drives })
  })
