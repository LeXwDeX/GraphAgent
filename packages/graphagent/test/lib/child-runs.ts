// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Effect, Scope } from "effect"
import { makeChildRuns, type ChildRuns } from "@/session/child/run"
import { ChildRegistry } from "@/session/child/registry"
import type { ChildRunCredential } from "@/session/child/types"
import type { PromptInput } from "@/session/prompt-input"
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
