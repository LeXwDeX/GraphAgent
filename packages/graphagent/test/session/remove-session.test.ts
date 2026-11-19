// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Schema } from "effect"
import { SessionAbortReason } from "@/session/abort-reason"
import { SessionID } from "@/session/schema"
import { makeRemoveSession } from "@/session/remove-session"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { it } from "../lib/effect"

/**
 * Issue #1558: deleting a session stops the prompt runs of its whole tree before any row goes. The orchestration is
 * pinned here against stubs; the layered behavior (a real streaming run, the provider seeing the abort) is covered by
 * the removal cases in `prompt.test.ts` and `httpapi-session-removal.test.ts`.
 */

const id = (name: string) => SessionID.make(`ses_${name}`)

type Role = "root" | "task_child" | "dag_node"

const info = (sessionID: SessionID, role: Role = "root"): Session.Info => {
  const decoded = Schema.decodeUnknownSync(Session.Info)({
    id: sessionID,
    projectID: "proj_test",
    slug: "test",
    role: "root",
    directory: process.cwd(),
    title: "test",
    version: "test",
    agent: "build",
    permission: [],
    time: { created: 1, updated: 1 },
  })
  return {
    id: decoded.id,
    projectID: decoded.projectID,
    slug: decoded.slug,
    role,
    directory: decoded.directory,
    title: decoded.title,
    version: decoded.version,
    agent: "build",
    permission: [],
    time: { created: decoded.time.created, updated: decoded.time.updated },
  }
}

/**
 * `tree` maps a parent to its children; a session that is not a key or a child does not exist. `roles` names the
 * sessions that are not a root. `reasons` collects what each cancel was told.
 */
const harness = (
  tree: Record<string, readonly string[]>,
  cancel: (sessionID: SessionID) => Effect.Effect<void> = () => Effect.void,
  roles: Record<string, Role> = {},
) => {
  const calls: string[] = []
  const reasons: Array<SessionAbortReason.Info | undefined> = []
  const known = new Set([...Object.keys(tree), ...Object.values(tree).flat()])
  const removeSession = makeRemoveSession({
    sessions: {
      get: (sessionID) =>
        known.has(sessionID)
          ? Effect.succeed(info(sessionID))
          : Effect.fail(new NotFoundError({ message: `Session not found: ${sessionID}` })),
      children: (parentID) =>
        Effect.sync(() => {
          calls.push(`children:${parentID}`)
          return (tree[parentID] ?? []).map((child) => info(SessionID.make(child), roles[child]))
        }),
      remove: (sessionID) => Effect.sync(() => void calls.push(`remove:${sessionID}`)),
    },
    cancel: (sessionID, options) =>
      Effect.sync(() => {
        calls.push(`cancel:${sessionID}`)
        reasons.push(options?.reason)
      }).pipe(Effect.andThen(cancel(sessionID))),
  })
  return { calls, reasons, removeSession }
}

describe("SessionPrompt.removeSession orchestration", () => {
  it.effect("cancels a lone session before it removes it", () =>
    Effect.gen(function* () {
      const { calls, removeSession } = harness({ [id("a")]: [] })
      yield* removeSession(id("a"))
      expect(calls).toEqual([`cancel:${id("a")}`, `children:${id("a")}`, `remove:${id("a")}`])
    }),
  )

  it.effect("stops the tree top-down, a level at a time, and removes only after the last level settles", () =>
    Effect.gen(function* () {
      const { calls, removeSession } = harness({
        [id("root")]: [id("left"), id("right")],
        [id("left")]: [id("leaf")],
        [id("right")]: [],
        [id("leaf")]: [],
      })
      yield* removeSession(id("root"))
      const cancels = calls.filter((call) => call.startsWith("cancel:"))
      expect(cancels).toEqual([id("root"), id("left"), id("right"), id("leaf")].map((name) => `cancel:${name}`))
      // A parent settles before its children are listed: a subtask a stopping turn spawned is still seen.
      expect(calls.indexOf(`cancel:${id("root")}`)).toBeLessThan(calls.indexOf(`children:${id("root")}`))
      expect(calls.indexOf(`cancel:${id("leaf")}`)).toBeGreaterThan(calls.indexOf(`children:${id("left")}`))
      expect(calls.at(-1)).toBe(`remove:${id("root")}`)
      expect(calls.filter((call) => call.startsWith("remove:"))).toEqual([`remove:${id("root")}`])
    }),
  )

  it.effect("tells every turn why it stopped", () =>
    Effect.gen(function* () {
      const { reasons, removeSession } = harness({ [id("root")]: [id("child")], [id("child")]: [] })
      yield* removeSession(id("root"))
      expect(reasons).toEqual([
        { reason: "session-deleted", actor: "session-removal" },
        { reason: "session-deleted", actor: "session-removal" },
      ])
    }),
  )

  it.effect("leaves a DAG node session and everything below it to the workflow", () =>
    Effect.gen(function* () {
      const { calls, removeSession } = harness(
        {
          [id("root")]: [id("node"), id("task")],
          [id("node")]: [id("below")],
          [id("task")]: [],
          [id("below")]: [],
        },
        () => Effect.void,
        { [id("node")]: "dag_node", [id("task")]: "task_child", [id("below")]: "task_child" },
      )
      yield* removeSession(id("root"))
      expect(calls.filter((call) => call.startsWith("cancel:"))).toEqual([
        `cancel:${id("root")}`,
        `cancel:${id("task")}`,
      ])
      expect(calls).not.toContain(`children:${id("node")}`)
      expect(calls.at(-1)).toBe(`remove:${id("root")}`)
    }),
  )

  it.effect("fails like Session.remove for a missing session, before any cancel", () =>
    Effect.gen(function* () {
      const { calls, removeSession } = harness({ [id("a")]: [] })
      const exit = yield* removeSession(id("missing")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(NotFoundError.isInstance(Cause.squash(exit.cause))).toBe(true)
      expect(calls).toEqual([])
    }),
  )

  it.effect("removes the tree even when a cancel fails", () =>
    Effect.gen(function* () {
      const { calls, removeSession } = harness({ [id("root")]: [id("child")] }, (sessionID) =>
        sessionID === id("child") ? Effect.die(new Error("cancel blew up")) : Effect.void,
      )
      yield* removeSession(id("root"))
      expect(calls.at(-1)).toBe(`remove:${id("root")}`)
    }),
  )

  it.effect("passes an interrupt on instead of swallowing it as a failed cancel", () =>
    Effect.gen(function* () {
      const { calls, removeSession } = harness({ [id("a")]: [] }, () => Effect.interrupt)
      const exit = yield* removeSession(id("a")).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(calls.some((call) => call.startsWith("remove:"))).toBe(false)
    }),
  )

  it.effect("does not loop on a parent link that points back into the tree", () =>
    Effect.gen(function* () {
      const { calls, removeSession } = harness({ [id("a")]: [id("b")], [id("b")]: [id("a")] })
      yield* removeSession(id("a"))
      expect(calls.filter((call) => call.startsWith("cancel:"))).toEqual([`cancel:${id("a")}`, `cancel:${id("b")}`])
    }),
  )
})
