// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import { Effect, Scope } from "effect"
import { makeChildRuns, type ChildRuns } from "@/session/child/run"
import type { Tool } from "@/tool/tool"

/**
 * Child runs over the test database (Issue #1026). The runtime builds them in
 * `SessionPrompt.layer`; tests that drive the task tool directly build the same
 * factory here. `cancelSession` stands in for `SessionPrompt.cancel`.
 */
export const testChildRuns = (cancelSession?: ChildRuns.Deps["cancelSession"]) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope
    return yield* makeChildRuns({ db, scope, cancelSession: cancelSession ?? (() => Effect.void) })
  })

/**
 * Initializes a task tool the way the engine hands it to a model: every
 * `execute` call carries a `children` capability narrowed to the calling
 * session, unless the test supplies its own. The built `children` instance is
 * returned on the definition so a test can read the rows and registry state.
 */
export const initTaskTool = <D extends { execute: (args: never, ctx: Tool.Context) => unknown }>(
  tool: { init: () => Effect.Effect<D> },
  cancelSession?: ChildRuns.Deps["cancelSession"],
) =>
  Effect.gen(function* () {
    const def = yield* tool.init()
    const children = yield* testChildRuns(cancelSession)
    const execute = ((args: never, ctx: Tool.Context) =>
      def.execute(args, { ...ctx, children: ctx.children ?? children.forParent(ctx.sessionID) })) as D["execute"]
    return Object.assign({}, def, { execute, children })
  })
