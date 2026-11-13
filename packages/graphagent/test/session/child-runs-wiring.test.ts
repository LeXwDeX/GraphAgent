// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { ChildBindingTable, ChildRunTable } from "@graphagent/core/session/child.sql"
import { SessionProjector } from "@graphagent/core/session/projector"
import { SessionTurnTable } from "@graphagent/core/session/turn.sql"
import { eq } from "drizzle-orm"
import { Effect, Fiber, Layer, Scope } from "effect"
import { SettingsHook } from "@/hook"
import { HookFileWatch } from "@/hook/file-watch"
import { HookLifecycle } from "@/hook/lifecycle"
import { HookRewakeLive } from "@/hook/rewake-live"
import { SessionHooks } from "@/hook/session-hooks"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { SessionCancellation } from "@/session/cancellation"
import { ChildRegistry } from "@/session/child/registry"
import { ChildResults } from "@/session/child/result-source"
import { EngineProcess } from "@/session/engine-process"
import { SessionInbox } from "@/session/inbox"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { provideTmpdirServer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

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
  CrossSpawnSpawner.node,
  SessionRunState.node,
  SessionStatus.node,
  LayerNode.make(TestLLMServer.layer, []),
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
      options: {
        apiKey: "test-key",
        baseURL: url,
      },
    },
  },
  agent: { general: { model: "test/test-model" } },
})

describe("the task tool through the full tool path", () => {
  it.live(
    "registers the child session it creates and ends the run with the task",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const { db } = yield* Database.Service
          const chat = yield* sessions.create({
            title: "child runs end to end",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          // The parent calls the task tool, the child answers, the parent wraps up.
          yield* llm.tool("task", { description: "probe", prompt: "just say ok", subagent_type: "general" })
          yield* llm.text("ok")
          yield* llm.text("all done")

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            parts: [{ type: "text", text: "run the subagent" }],
          })

          const kids = yield* sessions.children(chat.id)
          expect(kids).toHaveLength(1)
          const child = kids[0].id
          const bindings = yield* db
            .select()
            .from(ChildBindingTable)
            .where(eq(ChildBindingTable.child_session_id, child))
            .all()
            .pipe(Effect.orDie)
          expect(bindings).toHaveLength(1)
          expect(bindings[0]).toMatchObject({ parent_session_id: chat.id, owner_kind: "task" })
          // The tool call id is the owner reference: it ties the binding back to the parent's tool part.
          expect(bindings[0]?.owner_ref).toMatch(/\S+/)
          const ended = yield* pollWithTimeout(
            db
              .select()
              .from(ChildRunTable)
              .where(eq(ChildRunTable.child_session_id, child))
              .all()
              .pipe(
                Effect.orDie,
                Effect.map((rows) => rows.find((row) => row.state === "ended")),
              ),
            "the task run never ended",
          )
          expect(ended).toMatchObject({
            parent_session_id: chat.id,
            owner_kind: "task",
            attempt: 1,
            detached: false,
            outcome: { type: "completed" },
            runner_id: EngineProcess.runner.id,
          })
          expect(ended.reported_at).not.toBeNull()
          expect(EngineProcess.children.byRun.size).toBe(0)
        }),
      { git: true, config: providerCfg },
    ),
    30_000,
  )
})

// Issue #1026 PR3a: the result ledger in the real runtime. The source is
// registered the way instance bootstrap does it (`it.live` fixtures run a no-op
// bootstrap), then runs end the way the task tool's watchers end them. The unit
// semantics (what is fresh, what is only written, what is never delivered) are
// pinned deterministically in child-results.test.ts; these tests prove the same
// decisions against the real admission, inbox and turn machinery.
describe("child results in the real runtime", () => {
  const allow = [{ permission: "*", pattern: "*", action: "allow" as const }]

  const wiring = Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const inbox = yield* SessionInbox.Service
    const database = yield* Database.Service
    const scope = yield* Scope.Scope
    const children = yield* prompt.children
    const register = ChildResults.init({ inbox, database, scope })
    const turnsOf = (sessionID: string) =>
      database.db
        .select()
        .from(SessionTurnTable)
        .where(eq(SessionTurnTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
    const rowOf = (runID: string) =>
      database.db.select().from(ChildRunTable).where(eq(ChildRunTable.id, runID)).get().pipe(Effect.orDie)
    const texts = (sessionID: SessionID) =>
      sessions.messages({ sessionID }).pipe(
        Effect.orDie,
        Effect.map((messages) =>
          messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))),
        ),
      )
    /** A detached task run of a fresh parent over a fresh child session, running. */
    const detachedRun = Effect.gen(function* () {
      const parent = yield* sessions.create({ title: "child results parent", permission: allow })
      const child = yield* sessions.create({ parentID: parent.id, title: "background task" })
      const run = yield* children.start({
        parentSessionID: parent.id,
        childSessionID: child.id,
        owner: { kind: "task", toolCallID: "call_1" },
        detached: true,
      })
      yield* run.markRunning
      return { parent, child, run }
    })
    return { prompt, sessions, inbox, register, turnsOf, rowOf, texts, detachedRun }
  })

  const report = { title: "inspect bug", text: "found the cause" }
  const sawResult = (texts: ReadonlyArray<string>) => texts.some((text) => text.includes("found the cause"))

  it.live(
    "a result that ends while the parent is idle starts a turn of its own, stamped as a child result, exactly once",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const { inbox, register, turnsOf, rowOf, texts, sessions, detachedRun } = yield* wiring
          yield* register
          const { parent, run } = yield* detachedRun
          yield* llm.text("noted")

          // The run's ending is the whole trigger: no tick, no idle event, nothing else nudges the inbox.
          yield* run.settle({ type: "completed" }, report)

          yield* pollWithTimeout(
            sessions.messages({ sessionID: parent.id }).pipe(
              Effect.orDie,
              Effect.map((messages) =>
                messages.some(
                  (message) =>
                    message.info.role === "assistant" &&
                    message.parts.some((part) => part.type === "text" && part.text === "noted"),
                )
                  ? true
                  : undefined,
              ),
            ),
            "the finished background task never started a turn of the parent",
            "10 seconds",
          )
          const delivered = (yield* texts(parent.id)).filter((text) => text.includes("found the cause"))
          expect(delivered).toHaveLength(1)
          expect(delivered[0]).toContain('state="completed"')
          const turns = yield* turnsOf(parent.id)
          expect(turns).toHaveLength(1)
          expect(turns[0]).toMatchObject({ origin_ref: run.id, state: "ended" })
          expect(JSON.parse(String(turns[0]?.origin))).toEqual({ kind: "inbox", source: "child.result", key: run.id })
          expect((yield* rowOf(run.id))?.reported_at).not.toBeNull()
          expect(yield* llm.calls).toBe(1)

          // A later nudge, drain or tick finds nothing owed: the parent is not told twice.
          yield* inbox.drain(parent.id)
          yield* inbox.nudge(parent.id)
          expect((yield* texts(parent.id)).filter((text) => text.includes("found the cause"))).toHaveLength(1)
          expect(yield* turnsOf(parent.id)).toHaveLength(1)
        }),
      { git: true, config: providerCfg },
    ),
    30_000,
  )

  it.live(
    "a result that ends while the parent's turn runs joins that turn instead of starting another",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const { register, turnsOf, rowOf, texts, prompt, detachedRun } = yield* wiring
          yield* register
          const { parent, run } = yield* detachedRun
          const gate = Promise.withResolvers<void>()
          // The parent's own turn is held at its first model response.
          yield* llm.hold("first reply", gate.promise)
          yield* llm.text("second reply")
          const turn = yield* prompt
            .prompt({ sessionID: parent.id, agent: "build", parts: [{ type: "text", text: "start work" }] })
            .pipe(Effect.forkChild)
          yield* llm.wait(1)

          yield* run.settle({ type: "completed" }, report)

          // Committed while the turn is still held: the message is in the transcript, no second turn exists.
          yield* pollWithTimeout(
            texts(parent.id).pipe(Effect.map((all) => (sawResult(all) ? true : undefined))),
            "the result did not reach the running parent",
            "10 seconds",
          )
          const running = yield* turnsOf(parent.id)
          expect(running.map((row) => row.state)).toEqual(["running"])
          expect((yield* rowOf(run.id))?.reported_at).not.toBeNull()

          gate.resolve()
          yield* Fiber.join(turn)
          const turns = yield* pollWithTimeout(
            turnsOf(parent.id).pipe(
              Effect.map((rows) => (rows.every((row) => row.state === "ended") ? rows : undefined)),
            ),
            "the parent's turn never ended",
            "10 seconds",
          )
          // One turn, the user's: the result joined it, so the model saw it within that turn.
          expect(turns.map((row) => row.origin_ref)).toEqual(["prompt"])
          expect(turns).toHaveLength(1)
          const inputs = yield* llm.inputs
          expect(inputs.some((body) => JSON.stringify(body).includes("found the cause"))).toBe(true)
        }),
      { git: true, config: providerCfg },
    ),
    30_000,
  )

  it.live(
    "a result an ESC overtook is written to the parent without a turn",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const { prompt, register, turnsOf, rowOf, texts, detachedRun } = yield* wiring
          const { parent, run } = yield* detachedRun
          // Nothing listens yet (the source registers below), so the ending leaves its report and its owed row.
          yield* run.settle({ type: "completed" }, report)
          expect(ChildRegistry.reportOf(run.id)?.epoch).toBe(SessionCancellation.epoch(parent.id))
          expect((yield* rowOf(run.id))?.reported_at).toBeNull()

          // The user cancels the parent before the result is delivered.
          yield* prompt.cancel(parent.id)
          expect(SessionCancellation.epoch(parent.id)).toBeGreaterThan(ChildRegistry.reportOf(run.id)?.epoch ?? 99)
          yield* register

          yield* pollWithTimeout(
            texts(parent.id).pipe(Effect.map((all) => (sawResult(all) ? true : undefined))),
            "the owed result was never written",
            "10 seconds",
          )
          // Only written: no turn started and no model was asked.
          expect(yield* llm.calls).toBe(0)
          expect(yield* turnsOf(parent.id)).toEqual([])
          expect((yield* rowOf(run.id))?.reported_at).not.toBeNull()
        }),
      { git: true, config: providerCfg },
    ),
    30_000,
  )

  it.live(
    "a result left over from before a restart is written to the parent without a turn",
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const { register, turnsOf, rowOf, texts, detachedRun } = yield* wiring
          const { parent, run } = yield* detachedRun
          yield* run.settle({ type: "completed" }, report)
          // The process that ended the run is gone: only its row is left.
          ChildRegistry.dropReport(run.id)

          yield* register

          yield* pollWithTimeout(
            texts(parent.id).pipe(Effect.map((all) => (sawResult(all) ? true : undefined))),
            "the leftover result was never written",
            "10 seconds",
          )
          expect(yield* llm.calls).toBe(0)
          expect(yield* turnsOf(parent.id)).toEqual([])
          expect((yield* rowOf(run.id))?.reported_at).not.toBeNull()
        }),
      { git: true, config: providerCfg },
    ),
    30_000,
  )
})
