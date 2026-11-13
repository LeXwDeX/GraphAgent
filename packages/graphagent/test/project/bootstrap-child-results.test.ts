// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { ChildBindingTable, ChildRunTable } from "@graphagent/core/session/child.sql"
import { SessionProjector } from "@graphagent/core/session/projector"
import { SessionTurnTable } from "@graphagent/core/session/turn.sql"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { SettingsHook } from "@/hook"
import { HookFileWatch } from "@/hook/file-watch"
import { HookLifecycle } from "@/hook/lifecycle"
import { HookRewakeLive } from "@/hook/rewake-live"
import { SessionHooks } from "@/hook/session-hooks"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { SessionInbox } from "@/session/inbox"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

/**
 * Issue #1026 PR3a: instance bootstrap wires the result ledger. A detached run
 * whose process is gone is recovered as interrupted (PR1); the source that
 * bootstrap registers right after must then tell the parent about it, without
 * waiting for the 30s tick and without starting a turn nobody asked for.
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

const appLayer = LayerNode.buildLayer(
  LayerNode.group([
    InstanceStore.node,
    Project.node,
    SessionPrompt.node,
    SessionInbox.node,
    SettingsHook.node,
    HookRewakeLive.node,
    HookLifecycle.node,
    SessionHooks.node,
    HookFileWatch.node,
    Session.node,
    SessionProjector.node,
    SessionSummary.node,
    Database.node,
    SessionRunState.node,
    SessionStatus.node,
    LayerNode.make(TestLLMServer.layer, []),
  ]),
  { replacements: [LayerNode.replace(MCP.node, mcp), LayerNode.replace(LSP.node, lsp)] },
)
const appIt = testEffect(Layer.mergeAll(appLayer, CrossSpawnSpawner.defaultLayer))

// A provider for the delivery to stamp the message with: a parent that never ran has no saved model, and this
// directory would otherwise offer none (the notice is written without asking any model).
const providerCfg = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

describe("instance bootstrap child results", () => {
  appIt.live("tells the parent of a run its process lost, once, without a turn, when the instance loads", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: providerCfg(llm.url) })
      const instances = yield* InstanceStore.Service
      const ids: { parent?: SessionID; child?: SessionID } = {}
      yield* instances.provide(
        { directory },
        Effect.gen(function* () {
          const session = yield* Session.Service
          const database = yield* Database.Service
          const parent = yield* session.create({ title: "bootstrap child results" })
          const child = yield* session.create({ title: "lost background task", parentID: parent.id })
          ids.parent = parent.id
          ids.child = child.id
          for (const id of [parent.id, child.id])
            yield* pollWithTimeout(
              session.get(id).pipe(
                Effect.as(true as const),
                Effect.catch(() => Effect.succeed(undefined)),
              ),
              "session projection did not become visible",
            )
          // A detached task run its process died with: still `running` in the row, owned by an earlier life of this pid.
          yield* database.db
            .insert(ChildBindingTable)
            .values({ child_session_id: child.id, parent_session_id: parent.id, owner_kind: "task" })
            .run()
            .pipe(Effect.orDie)
          yield* database.db
            .insert(ChildRunTable)
            .values({
              id: "crun_bootstrap_lost",
              child_session_id: child.id,
              parent_session_id: parent.id,
              owner_kind: "task",
              attempt: 1,
              state: "running",
              detached: true,
              runner_id: `${process.pid}:an-earlier-life`,
            })
            .run()
            .pipe(Effect.orDie)
        }),
      )

      yield* instances.reload({ directory })

      yield* instances.provide(
        { directory },
        Effect.gen(function* () {
          const session = yield* Session.Service
          const database = yield* Database.Service
          const inbox = yield* SessionInbox.Service
          const { parent, child } = ids
          if (!parent || !child) throw new Error("the fixture sessions were not created")
          const notices = yield* pollWithTimeout(
            session.messages({ sessionID: parent }).pipe(
              Effect.orDie,
              Effect.map((messages) => {
                const found = messages.flatMap((message) =>
                  message.parts.flatMap((part) =>
                    part.type === "text" && part.text.includes(`<task id="${child}"`) ? [part.text] : [],
                  ),
                )
                return found.length > 0 ? found : undefined
              }),
            ),
            "bootstrap did not tell the parent about the lost run",
            "5 seconds",
          )
          expect(notices).toHaveLength(1)
          expect(notices[0]).toContain('state="error"')
          expect(notices[0]).toContain("interrupted")
          const row = yield* database.db
            .select()
            .from(ChildRunTable)
            .where(eq(ChildRunTable.id, "crun_bootstrap_lost"))
            .get()
            .pipe(Effect.orDie)
          expect(row).toMatchObject({ state: "ended", outcome: { type: "interrupted", reason: "process-restart" } })
          expect(row?.reported_at).not.toBeNull()
          // Only written: no turn started and no model was asked.
          expect(
            yield* database.db
              .select()
              .from(SessionTurnTable)
              .where(eq(SessionTurnTable.session_id, parent))
              .all()
              .pipe(Effect.orDie),
          ).toEqual([])
          expect(yield* llm.calls).toBe(0)
          // A drain after the delivery finds nothing owed: the parent is told once.
          yield* inbox.drain(parent)
          const again = yield* session.messages({ sessionID: parent }).pipe(Effect.orDie)
          expect(
            again.flatMap((message) =>
              message.parts.filter((part) => part.type === "text" && part.text.includes(`<task id="${child}"`)),
            ),
          ).toHaveLength(1)
        }),
      )
    }),
  )
})
