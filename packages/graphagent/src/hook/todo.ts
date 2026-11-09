// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as HookTodo from "./todo"

import { Effect, Layer } from "effect"
import { SessionTodoHooks } from "@graphagent/core/session/todo-hooks"
import { SettingsHook } from "./index"
import { Session } from "@/session/session"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"

export const layer = Layer.effect(
  SessionTodoHooks.Service,
  Effect.gen(function* () {
    const settings = yield* SettingsHook.Service
    const sessions = yield* Session.Service
    const instances = yield* InstanceStore.Service
    return SessionTodoHooks.Service.of({
      check: (change) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make(change.sessionID)
          const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
          const instance = yield* instances.load({ directory: current.directory })
          return yield* Effect.gen(function* () {
            // The engine derives transcript, identity and environment lazily,
            // only when a handler matches this event.
            const result = yield* settings.trigger(
              { event: change.event, source: "task_update", taskID: change.taskID, taskTitle: change.subject },
              { sessionID },
            )
            yield* SettingsHook.landSystemMessages(result, { sessionID })
            return { blocked: result.blocked }
          }).pipe(
            Effect.provideService(InstanceRef, instance),
            Effect.provideService(WorkspaceRef, current.workspaceID),
          )
        }),
    })
  }),
)
