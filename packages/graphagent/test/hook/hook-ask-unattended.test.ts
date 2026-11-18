// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- partial agent, session and processor fixtures use `as never` shims.
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { SessionTools } from "@/session/tools"
import { SettingsHook, type TriggerResult } from "@/hook"
import { Dag } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { SafetyGuard } from "@/permission/safety-guard"
import { ChildRegistry } from "@/session/child/registry"
import type { ChildOwner, ChildPermissionPolicy } from "@/session/child/types"
import { MessageID, SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { builtinEntry } from "../fixture/tool-registry"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { transactLayer } from "../dag/fixture/transact"

/**
 * #1031 M7, end to end through the tool pipeline. An unattended run (a DAG
 * node, or a task child under a DAG-on root) whose PreToolUse hook answers
 * `permissionDecision: "ask"` has nobody to confirm the call. The real
 * Permission service hands that forced ask to the real SafetyGuard, which
 * denies it with SF-6. The pipeline reads the typed denial like a refused
 * confirmation: the tool does not run, nothing is asked or left pending, the
 * model gets a hook-denied tool result, and the run goes on.
 */

const directory = "/repo/project"
const rootSessionID = SessionID.make("ses_hook_ask_root")

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = DagStore.layer.pipe(Layer.provide(database))
const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store), Layer.provide(transactLayer(database)))

// Every hook event of the run, in order. The hook wants a confirmation for the
// `write` tool only.
const fired: string[] = []
const hooks = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: (payload) =>
      Effect.sync(() => {
        fired.push(payload.event)
        const result: TriggerResult = { additionalContexts: [], systemMessages: [] }
        return payload.event === "PreToolUse" && payload.toolName === "write"
          ? { ...result, permissionDecision: "ask" as const, permissionDecisionReason: "confirm the write" }
          : result
      }),
    list: () => Effect.succeed([]),
  }),
)

let executed = 0
const writeDefinition = {
  id: "write",
  description: "Fixture writer behind a hook that asks for confirmation",
  parameters: Schema.Struct({ filePath: Schema.String }),
  execute: () =>
    Effect.sync(() => {
      executed++
      return { title: "written", output: "WRITE_COMPLETE", metadata: {} }
    }),
}
// An ordinary call: its own ask is one the guard settles without a question.
const echoDefinition = {
  id: "echo",
  description: "Fixture shell echo that asks for its own command",
  parameters: Schema.Struct({ command: Schema.String }),
  execute: (args: { command: string }, ctx: Tool.Context) =>
    ctx
      .ask({ permission: "bash", patterns: [args.command], always: [], metadata: { command: args.command } })
      .pipe(Effect.as({ title: "ran", output: `ECHO_COMPLETE ${args.command}`, metadata: {} })),
}

const it = testEffect(
  Layer.mergeAll(
    Permission.layer.pipe(
      Layer.provide(database),
      Layer.provide(bridge),
      Layer.provide(SafetyGuard.layer),
      Layer.provide(hooks),
    ),
    hooks,
    database,
    events,
    bridge,
    projector,
    store,
    dag,
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
    Layer.mock(Truncate.Service, {}),
    Layer.mock(ToolRegistry.Service, {
      tools: () => Effect.succeed([writeDefinition, echoDefinition]),
      resolve: () => Effect.succeed([builtinEntry(writeDefinition), builtinEntry(echoDefinition)]),
    }),
  ),
)

type ToolResult = { title?: string; output: string; metadata?: Record<string, unknown> }
type Tools = Record<
  string,
  {
    execute: (
      args: Record<string, unknown>,
      options: { toolCallId: string; messages: unknown[]; abortSignal: AbortSignal },
    ) => Promise<ToolResult>
  }
>

/** The tools of one child session, wrapped by the real execution pipeline. */
const resolveTools = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    return (yield* SessionTools.resolve({
      agent: { name: "general", permission: [], options: {} } as never,
      model: ProviderTest.model(),
      session: { id: sessionID, parentID: rootSessionID, directory: instance.directory, permission: [] } as never,
      processor: {
        message: { id: MessageID.ascending(), sessionID },
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      } as never,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })) as unknown as Tools
  })

/** The call resolves with a result for the model; a rejection fails the test. */
const callTool = (tools: Tools, name: string, args: Record<string, unknown>) =>
  Effect.tryPromise(() =>
    tools[name].execute(args, { toolCallId: `call-${name}`, messages: [], abortSignal: new AbortController().signal }),
  )

const register = (sessionID: SessionID, owner: ChildOwner, permission: ChildPermissionPolicy) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const entry = ChildRegistry.create({
        id: `crun_${sessionID}`,
        childSessionID: sessionID,
        parentSessionID: rootSessionID,
        ownerKind: owner.kind,
        ownerKey: owner,
        permission,
        detached: false,
        directory: undefined,
        owner: {},
      })
      expect(ChildRegistry.register(entry)).toBe(true)
      return entry
    }),
    (entry) =>
      Effect.sync(() => {
        ChildRegistry.end(entry, { type: "completed" })
        ChildRegistry.release(entry)
      }),
  )

/** Root session row; a task child's policy reads its `dag_mode` at ask time. */
const seedRoot = (mode: "on" | "off") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_hook_ask_unattended"), worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: rootSessionID,
        project_id: Project.ID.make("prj_hook_ask_unattended"),
        slug: "hook-ask",
        directory: AbsolutePath.make(directory),
        title: "hook ask root",
        version: "0",
        dag_mode: mode,
      })
      .onConflictDoUpdate({ target: SessionTable.id, set: { dag_mode: mode } })
      .run()
      .pipe(Effect.orDie)
  })

/** Every event of one type the run publishes. */
const watch = (type: string) =>
  Effect.gen(function* () {
    const bridgeService = yield* EventV2Bridge.Service
    const seen: unknown[] = []
    const stop = yield* bridgeService.listen((event) => {
      if (event.type === type) seen.push(event.data)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => stop)
    return seen
  })

/**
 * The hook asks for the `write` call of an unattended session: it is refused
 * without a question, and the session goes on to an ordinary call.
 */
const expectHookAskDenied = (sessionID: SessionID) =>
  Effect.gen(function* () {
    executed = 0
    fired.length = 0
    const asked = yield* watch(Permission.Event.Asked.type)
    const permission = yield* Permission.Service
    const tools = yield* resolveTools(sessionID)

    const denied = yield* callTool(tools, "write", { filePath: "a.txt" })
    // A refused confirmation is a result the model reads, not a stop: the
    // pipeline's hook-stop marker would end the turn.
    expect(denied.output.startsWith("[Tool denied by hook]")).toBe(true)
    // A complete tool result: a command-driven subtask writes it as it is (#1350).
    expect(denied.title).toBe("write")
    expect(denied.metadata).toMatchObject({ hookDenied: true })
    expect(denied.metadata?.hookStopped).toBeUndefined()
    expect(executed).toBe(0)
    expect(yield* permission.list()).toEqual([])
    yield* Effect.yieldNow
    expect(asked).toEqual([])
    // No PermissionRequest hook was consulted either: nobody answers it.
    expect(fired).not.toContain("PermissionRequest")

    // The run is not wedged: the next call executes, and its own ask is
    // settled by the guard without a pending request.
    const echoed = yield* callTool(tools, "echo", { command: "echo hi" })
    expect(echoed.output).toContain("ECHO_COMPLETE echo hi")
    expect(yield* permission.list()).toEqual([])
    yield* Effect.yieldNow
    expect(asked).toEqual([])
  })

describe("a PreToolUse hook ask in an unattended session", () => {
  it.instance(
    "a DAG node: SF-6 refuses the call, the denial lands on the node row, and the node keeps running",
    () =>
      Effect.gen(function* () {
        yield* seedRoot("off")
        const safetyDenied = yield* watch(DagEvent.NodeSafetyDenied.type)
        const dagService = yield* Dag.Service
        const dagID = yield* dagService.create({
          projectID: "prj_hook_ask_unattended",
          sessionID: rootSessionID,
          title: "hook ask",
          config: {
            name: "hook ask",
            nodes: [
              {
                id: "a",
                name: "a",
                worker_type: "build",
                depends_on: [],
                required: true,
                prompt_template: { inline: "a" },
              },
            ],
          },
        })
        const childSessionID = SessionID.make("ses_hook_ask_node")
        yield* dagService.nodeQueued(dagID, "a")
        yield* dagService.nodeStarted(dagID, "a", childSessionID, Date.now() + 60_000, true)
        yield* register(
          childSessionID,
          { kind: "dag_node", workflowID: dagID, nodeID: "a", attempt: 0 },
          { ask: "auto" },
        )

        yield* expectHookAskDenied(childSessionID)

        // One durable SF-6 denial: for the `write` call, none for the echo.
        expect(safetyDenied).toHaveLength(1)
        expect(safetyDenied[0]).toMatchObject({ dagID, nodeID: "a", ruleID: "SF-6", permission: "write" })
        const row = yield* (yield* DagStore.Service).getNode(dagID, "a")
        expect(row?.status).toBe("running")
        expect(row?.safetyDenials?.total).toBe(1)
        expect(row?.safetyDenials?.items[0]).toMatchObject({ ruleID: "SF-6", permission: "write" })
      }),
    { git: true },
  )

  it.instance(
    "a task child under a DAG-on root: refused the same way, and with no node row nothing is recorded",
    () =>
      Effect.gen(function* () {
        yield* seedRoot("on")
        const safetyDenied = yield* watch(DagEvent.NodeSafetyDenied.type)
        const childSessionID = SessionID.make("ses_hook_ask_task")
        yield* register(childSessionID, { kind: "task", toolCallID: "call_hook_ask" }, { ask: "root-dag-mode" })

        yield* expectHookAskDenied(childSessionID)

        expect(safetyDenied).toEqual([])
      }),
    { git: true },
  )
})
