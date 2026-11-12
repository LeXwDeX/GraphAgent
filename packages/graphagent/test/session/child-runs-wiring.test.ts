// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { ChildBindingTable, ChildRunTable } from "@graphagent/core/session/child.sql"
import { SessionProjector } from "@graphagent/core/session/projector"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { SettingsHook } from "@/hook"
import { HookFileWatch } from "@/hook/file-watch"
import { HookLifecycle } from "@/hook/lifecycle"
import { HookRewakeLive } from "@/hook/rewake-live"
import { SessionHooks } from "@/hook/session-hooks"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { ChildRegistry } from "@/session/child/registry"
import { EngineProcess } from "@/session/engine-process"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { pollWithTimeout, testEffect } from "../lib/effect"

/**
 * Issue #1026 PR1 wiring: `SessionPrompt` assembles the child runs and routes
 * the session deletion event to them. The factory itself is covered by
 * child-runs.test.ts; this file proves the assembly in the real layer.
 */

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  SettingsHook.node,
  HookRewakeLive.node,
  HookLifecycle.node,
  SessionHooks.node,
  HookFileWatch.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  SessionRunState.node,
  SessionStatus.node,
])
const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [LayerNode.replace(MCP.node, mcp), LayerNode.replace(LSP.node, lsp)],
  }),
)

describe("SessionPrompt child runs", () => {
  it.instance("deleting the parent session ends its active runs and clears the registry", () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const children = yield* prompt.children
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const parent = yield* sessions.create({ title: "child runs wiring parent" })
      const first = yield* sessions.create({ parentID: parent.id, title: "first child" })
      const second = yield* sessions.create({ parentID: parent.id, title: "second child" })
      const running = yield* children.start({
        parentSessionID: parent.id,
        childSessionID: first.id,
        owner: { kind: "task", toolCallID: "call_1" },
        detached: true,
      })
      yield* running.markRunning
      const queued = yield* children.start({
        parentSessionID: parent.id,
        childSessionID: second.id,
        owner: { kind: "task", toolCallID: "call_2" },
        detached: false,
      })
      expect(ChildRegistry.activeFor(first.id)?.phase).toBe("running")
      expect(ChildRegistry.activeFor(second.id)?.phase).toBe("queued")

      yield* sessions.remove(parent.id)

      // The deletion event reaches the child runs asynchronously.
      yield* pollWithTimeout(
        Effect.sync(() => (EngineProcess.children.byRun.size === 0 ? true : undefined)),
        "deleting the parent session left child runs in the registry",
      )
      expect(ChildRegistry.activeFor(first.id)).toBeUndefined()
      expect(ChildRegistry.activeFor(second.id)).toBeUndefined()
      const ended = { type: "cancelled", by: { kind: "engine", reason: "session-deleted" } } as const
      expect(yield* running.settled).toEqual(ended)
      expect(yield* queued.settled).toEqual(ended)
      // The rows left with their sessions.
      expect(
        yield* db
          .select()
          .from(ChildBindingTable)
          .where(eq(ChildBindingTable.parent_session_id, parent.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
      expect(
        yield* db
          .select()
          .from(ChildRunTable)
          .where(eq(ChildRunTable.parent_session_id, parent.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
    }),
  )

  it.instance("deleting a child session ends only that child's run", () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const children = yield* prompt.children
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "child runs wiring parent" })
      const gone = yield* sessions.create({ parentID: parent.id, title: "deleted child" })
      const stays = yield* sessions.create({ parentID: parent.id, title: "surviving child" })
      for (const child of [gone, stays])
        yield* children.start({
          parentSessionID: parent.id,
          childSessionID: child.id,
          owner: { kind: "task" },
          detached: true,
        })

      yield* sessions.remove(gone.id)

      yield* pollWithTimeout(
        Effect.sync(() => (ChildRegistry.activeFor(gone.id) === undefined ? true : undefined)),
        "deleting a child session left its run in the registry",
      )
      expect(ChildRegistry.activeFor(stays.id)?.phase).toBe("queued")
    }),
  )
})
