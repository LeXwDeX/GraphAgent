// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { ref } from "@graphagent/core/lifecycle/state"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Session } from "@graphagent/schema/session"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Goal } from "@/goal/goal"
import { GoalLifecycle } from "@/goal/lifecycle"
import { GoalState } from "@/goal/state"
import { Lifecycle, LifecycleReadError } from "@/lifecycle/service"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Option } from "effect"
import { testEffect } from "../lib/effect"

/**
 * #1069 scope 3: the goal-domain resolver. It exposes the durable goal row
 * through `Lifecycle.get` and refuses refs from other directories — goal state
 * has no directory column, so the session row is the ownership authority.
 */

const state = (status: GoalState.Status): GoalState.Info =>
  new GoalState.Info({
    goal_id: "goal-1",
    revision: GoalState.nni(0),
    goal: "test goal",
    status,
    turns_used: GoalState.nni(0),
    max_turns: GoalState.nni(20),
    created_at: 1,
    last_turn_at: 1,
    consecutive_parse_failures: GoalState.nni(0),
    subgoals: [],
  })

const goals = Layer.mock(Goal.Service, {
  load: (sessionID) =>
    Effect.succeed(
      sessionID === "ses_active"
        ? state("active")
        : sessionID === "ses_waiting"
          ? state("waiting")
          : sessionID === "ses_foreign"
            ? state("paused")
            : undefined,
    ),
})

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const base = Layer.mergeAll(database, events, bridge, goals, Lifecycle.layer.pipe(Layer.provide(bridge)))
const it = testEffect(Layer.mergeAll(base, GoalLifecycle.layer.pipe(Layer.provide(base))))

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: the resolver reads only the directory.
const own = { directory: "/own" } as unknown as InstanceContext
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: the resolver reads only the directory.
const other = { directory: "/other" } as unknown as InstanceContext

const insertSession = (id: string, directory: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: Session.ID.make(id),
        project_id: Project.ID.global,
        slug: id,
        directory: AbsolutePath.make(directory),
        title: id,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })

describe("goal lifecycle resolver", () => {
  it.live("reports the durable goal status for the calling directory", () =>
    Effect.gen(function* () {
      yield* insertSession("ses_active", "/own")
      yield* insertSession("ses_waiting", "/own")
      const lifecycle = yield* Lifecycle.Service

      const active = Option.getOrUndefined(
        yield* lifecycle.get(ref("goal", "ses_active")).pipe(Effect.provideService(InstanceRef, own)),
      )
      expect(active?.value).toBe("active")
      expect(active?.phase).toBe("running")
      expect(active?.terminal).toBe(false)
      expect(active?.settled).toBe(false)
      expect(active?.source).toBe("persisted")

      const waiting = Option.getOrUndefined(
        yield* lifecycle.get(ref("goal", "ses_waiting")).pipe(Effect.provideService(InstanceRef, own)),
      )
      expect(waiting?.value).toBe("waiting")
      expect(waiting?.phase).toBe("waiting")
    }),
  )

  it.live("hides a goal whose session belongs to another directory", () =>
    Effect.gen(function* () {
      yield* insertSession("ses_foreign", "/other")
      const lifecycle = yield* Lifecycle.Service

      expect(
        Option.isNone(yield* lifecycle.get(ref("goal", "ses_foreign")).pipe(Effect.provideService(InstanceRef, own))),
      ).toBe(true)
      expect(
        Option.isSome(yield* lifecycle.get(ref("goal", "ses_foreign")).pipe(Effect.provideService(InstanceRef, other))),
      ).toBe(true)
    }),
  )

  it.live("returns none when the session has no goal", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      expect(
        Option.isNone(yield* lifecycle.get(ref("goal", "ses_nogoal")).pipe(Effect.provideService(InstanceRef, own))),
      ).toBe(true)
    }),
  )

  it.live("surfaces a missing instance context as LifecycleReadError", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const error = yield* lifecycle.get(ref("goal", "ses_active")).pipe(Effect.flip)
      expect(error).toBeInstanceOf(LifecycleReadError)
      expect(error.domain).toBe("goal")
      expect(error.id).toBe("ses_active")
    }),
  )
})
