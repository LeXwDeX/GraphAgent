// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- partial agent, session and processor fixtures use `as never` shims.
import { describe, expect } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Effect, Fiber, Layer, Schema } from "effect"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { LegacyEvent } from "@graphagent/schema/legacy-event"
import { Dag } from "@/dag/dag"
import { DagCoverage } from "@/dag/coverage"
import { nodeSafetyWakeLine, workflowSafetyWakeLine } from "@/dag/runtime/delivery"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SettingsHook, type HookCommand } from "@/hook"
import { SessionHooks } from "@/hook/session-hooks"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { SafetyGuard } from "@/permission/safety-guard"
import { ChildRegistry } from "@/session/child/registry"
import type { ChildOwner, ChildPermissionPolicy } from "@/session/child/types"
import { MessageID, SessionID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { renderStatus } from "@/tool/workflow/render"
import { Truncate } from "@/tool/truncate"
import { isRecord } from "@/util/record"
import { TestConfig } from "../fixture/config"
import { guardHooks, readGuardLog } from "../fixture/fake-command-guard"
import { TestInstance } from "../fixture/fixture"
import { isolatedGlobalConfig, writeHookLayers } from "../fixture/hook-layers"
import { builtinEntry, mcpEntries, mcpResourceEntries } from "../fixture/tool-registry"
import { ProviderTest } from "../fake/provider"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { transactLayer } from "../dag/fixture/transact"

/**
 * #1324 P4, end to end through the tool pipeline with the real hook engine. A
 * fake command guard (a test script that speaks the Claude Code PreToolUse
 * protocol) sits in the user-level hooks file and is the only thing in front of
 * the tools. The cases follow acceptance D of the Issue:
 *
 * - a guard deny keeps a DAG node's command from running, the node goes on, and
 *   one `HOOK` safety denial lands on the node row, which `inspect`, coverage
 *   and the wake text read; nothing else is published, so nothing wakes anyone;
 * - a task child of a DAG-on root is refused the same way and records nothing:
 *   it has no node row;
 * - a guard that answers `ask` is refused by SF-6 under the `allow` and
 *   `readonly` tiers and reaches the user under the `ask` tier;
 * - a guard that cannot run lets the call through with a warning, unless its
 *   entry says `onFailure: "block"` (the behaviour the guide relies on).
 */

const directory = "/repo/project"
const rootSessionID = SessionID.make("ses_guard_root")

type Tier = "allow" | "ask" | "readonly"

/** The `dag.permission` tier the fake global configuration reports. */
const config: { tier: Tier | undefined } = { tier: undefined }

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = DagStore.layer.pipe(Layer.provide(database))
const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store), Layer.provide(transactLayer(database)))
const configLayer = TestConfig.layer({
  dagGlobal: () => Effect.sync(() => (config.tier ? { permission: config.tier } : {})),
})
const hookLayer = SettingsHook.layer.pipe(
  Layer.provide(bridge),
  Layer.provide(database),
  Layer.provideMerge(SessionHooks.defaultLayer),
)

// What actually ran, per call.
const executed: string[] = []
const bashDefinition = {
  id: "bash",
  description: "Fixture shell that asks for its own command",
  parameters: Schema.Struct({ command: Schema.String }),
  execute: (args: { command: string }, ctx: Tool.Context) =>
    ctx
      .ask({
        permission: "bash",
        patterns: [args.command],
        always: [`${args.command.split(" ")[0]} *`],
        metadata: { command: args.command },
      })
      .pipe(
        Effect.andThen(
          Effect.sync(() => {
            executed.push(args.command)
            return { title: "ran", output: `RAN ${args.command}`, metadata: {} }
          }),
        ),
      ),
}
const fetchDefinition = {
  id: "webfetch",
  description: "Fixture fetch that asks for its own URL",
  parameters: Schema.Struct({ url: Schema.String }),
  execute: (args: { url: string }, ctx: Tool.Context) =>
    ctx.ask({ permission: "webfetch", patterns: [args.url], always: ["*"], metadata: { url: args.url } }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          executed.push(args.url)
          return { title: "fetched", output: `FETCHED ${args.url}`, metadata: {} }
        }),
      ),
    ),
}
// A file tool by id (`write` shares the `edit` permission key with edit and apply_patch). It never runs here:
// the guard refuses it first, and the guard reads the `command` field of whatever tool it sits in front of.
const writeDefinition = {
  id: "write",
  description: "Fixture file tool",
  parameters: Schema.Struct({ command: Schema.String }),
  execute: () => Effect.succeed({ title: "written", output: "WRITE_COMPLETE", metadata: {} }),
}
// A call that asks nothing: proof that the node goes on after a refusal.
const noteDefinition = {
  id: "note",
  description: "Fixture tool that asks nothing",
  parameters: Schema.Struct({ text: Schema.String }),
  execute: () => Effect.succeed({ title: "noted", output: "NOTED", metadata: {} }),
}
const definitions = [bashDefinition, fetchDefinition, writeDefinition, noteDefinition]

// One MCP server tool. `resolve` wraps server tools in place, so every session gets a fresh instance.
const makeMcp = () =>
  McpCatalog.bindTool(
    tool({
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => {
        executed.push("mcp")
        return { content: [{ type: "text" as const, text: "MCP_RAN" }] }
      },
    }),
    { server: "srv", tool: "lookup", source: "unknown" },
  )
let mcpTools: Record<string, ReturnType<typeof makeMcp>> = {}

const it = testEffect(
  Layer.mergeAll(
    Permission.layer.pipe(
      Layer.provide(database),
      Layer.provide(bridge),
      Layer.provide(SafetyGuard.layer),
      Layer.provide(hookLayer),
      Layer.provide(configLayer),
    ),
    hookLayer,
    configLayer,
    database,
    events,
    bridge,
    projector,
    store,
    dag,
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.sync(() => mcpTools) }),
    Layer.mock(Truncate.Service, { output: (text: string) => Effect.succeed({ content: text, truncated: false }) }),
    Layer.mock(ToolRegistry.Service, {
      tools: () => Effect.succeed(definitions),
      resolve: () =>
        Effect.sync(() => [
          ...definitions.map((definition) => builtinEntry(definition)),
          ...mcpEntries(mcpTools),
          ...mcpResourceEntries(["read"]),
        ]),
    }),
  ),
)

// An MCP server tool answers with its `content`; the other tools with an `output`.
type ToolResult = { output: string; metadata?: Record<string, unknown>; content?: { type: string; text?: string }[] }
type Tools = Record<
  string,
  {
    execute: (
      args: Record<string, unknown>,
      options: { toolCallId: string; messages: unknown[]; abortSignal: AbortSignal },
    ) => Promise<ToolResult>
  }
>

/** One call; a result for the model, or the thrown error when the call fails. */
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

/** Root session row; the DAG workflows hang off it and a task child reads its `dag_mode`. */
const seedRoot = (mode: "on" | "off") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("prj_guard"), worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: rootSessionID,
        project_id: Project.ID.make("prj_guard"),
        slug: "guard",
        directory: AbsolutePath.make(directory),
        title: "guard root",
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

/** The type of every DAG event the run publishes. */
const watchDagEvents = Effect.gen(function* () {
  const bridgeService = yield* EventV2Bridge.Service
  const types: string[] = []
  const stop = yield* bridgeService.listen((event) => {
    if (event.type.startsWith("dag.")) types.push(event.type)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => stop)
  return types
})

/**
 * The guard written to the user-level hooks file, and the tools of `sessionID`
 * resolved through the real pipeline. The file is written before the engine
 * first reads its chain.
 */
const behindGuard = (
  sessionID: SessionID,
  options: { readonly root?: boolean; readonly entry?: HookCommand; readonly matcher?: string } = {},
) =>
  Effect.gen(function* () {
    const { dir } = yield* isolatedGlobalConfig
    const instance = yield* TestInstance
    const log = `${instance.directory}/guard.log`
    yield* writeHookLayers(instance.directory, dir, { global: guardHooks(log, options.entry, options.matcher) })
    mcpTools = { srv_lookup: makeMcp() }
    const tools = (yield* SessionTools.resolve({
      agent: { name: "general", permission: [], options: {} } as never,
      model: ProviderTest.model(),
      session: {
        id: sessionID,
        ...(options.root ? {} : { parentID: rootSessionID }),
        directory: instance.directory,
        permission: [],
      } as never,
      processor: {
        message: { id: MessageID.ascending(), sessionID },
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      } as never,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })) as unknown as Tools
    executed.length = 0
    return { log, tools }
  })

/** A DAG node: a started workflow row, its run registered as `auto`, and the guard in front of its tools. */
const guardedNode = (options: { readonly entry?: HookCommand; readonly matcher?: string } = {}) =>
  Effect.gen(function* () {
    yield* seedRoot("off")
    const sessionID = SessionID.make("ses_guard_node")
    const dagService = yield* Dag.Service
    const dagID = yield* dagService.create({
      projectID: "prj_guard",
      sessionID: rootSessionID,
      title: "guard",
      config: {
        name: "guard",
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
    yield* dagService.nodeQueued(dagID, "a")
    yield* dagService.nodeStarted(dagID, "a", sessionID, Date.now() + 60_000, true)
    yield* register(sessionID, { kind: "dag_node", workflowID: dagID, nodeID: "a", attempt: 0 }, { ask: "auto" })
    return { sessionID, dagID, ...(yield* behindGuard(sessionID, options)) }
  })

/** A session with no node row: a task child (under a root with DAG mode on or off), or the root session itself. */
const guardedElsewhere = (kind: "task-on" | "task-off" | "root") =>
  Effect.gen(function* () {
    yield* seedRoot(kind === "task-on" ? "on" : "off")
    const sessionID = SessionID.make(`ses_guard_${kind}`)
    if (kind !== "root")
      yield* register(sessionID, { kind: "task", toolCallID: "call_guard" }, { ask: "root-dag-mode" })
    return { sessionID, ...(yield* behindGuard(sessionID, { root: kind === "root" })) }
  })

/** Every case starts from the default tier, and a failing case cannot leak its tier into the next one. */
const withTier = <A, E, R>(tier: Tier | undefined, body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      config.tier = tier
    }),
    () => body,
    () =>
      Effect.sync(() => {
        config.tier = undefined
      }),
  )

/** The mode the guard is told in each tier: the tier's own, or the one the session would have had anyway. */
const guardMode = (tier: Tier | undefined) =>
  tier === undefined || tier === "allow" ? "dontAsk" : tier === "readonly" ? "plan" : "default"

const GAP = "env X=1 git reset --hard HEAD~1"
const REASON = `fake guard deny: ${GAP}`

describe("a guard's deny in front of a DAG node", () => {
  for (const tier of [undefined, "ask", "readonly"] as const) {
    it.instance(
      `tier ${tier ?? "allow (default)"}: the command does not run, the node goes on, one HOOK denial is recorded`,
      () =>
        withTier(
          tier,
          Effect.gen(function* () {
            const { dagID, log, tools } = yield* guardedNode()
            const denied = yield* watch(DagEvent.NodeSafetyDenied.type)
            const asked = yield* watch(Permission.Event.Asked.type)
            const permission = yield* Permission.Service

            // The spelling the safety list does not read (a known gap): only the guard stops it.
            const refused = yield* callTool(tools, "bash", { command: GAP })
            expect(refused.output.startsWith(`[Tool denied by hook] ${REASON}`)).toBe(true)
            expect(refused.metadata).toMatchObject({ hookDenied: true })
            expect(refused.metadata?.hookStopped).toBeUndefined()
            expect(executed).toEqual([])
            // The deny comes before the call's own permission request: nobody is asked.
            expect(yield* permission.list()).toEqual([])

            // The node is not wedged: its next call runs.
            expect((yield* callTool(tools, "note", { text: "next" })).output).toContain("NOTED")
            yield* Effect.yieldNow
            expect(asked).toEqual([])

            // One durable denial, labelled as the hook's, for the call's permission key.
            expect(denied).toHaveLength(1)
            expect(denied[0]).toMatchObject({
              dagID,
              nodeID: "a",
              attempt: 0,
              ruleID: "HOOK",
              permission: "bash",
              summary: REASON,
            })
            const row = yield* (yield* DagStore.Service).getNode(dagID, "a")
            expect(row?.status).toBe("running")
            expect(row?.safetyDenials?.total).toBe(1)
            expect(row?.safetyDenials?.items[0]).toMatchObject({ ruleID: "HOOK", permission: "bash", summary: REASON })

            // The guard was told what the session runs under, with the Claude-formatted tool name.
            expect(yield* Effect.promise(() => readGuardLog(log))).toEqual([
              { event: "PreToolUse", permission_mode: guardMode(tier), tool_name: "Bash", subject: GAP },
            ])
          }),
        ),
      { git: true },
    )
  }

  it.instance(
    "the denial reaches inspect.status, coverage and the wake counts, and creates no event of its own",
    () =>
      Effect.gen(function* () {
        const { dagID, log, tools } = yield* guardedNode()
        const dagEvents = yield* watchDagEvents

        yield* callTool(tools, "bash", { command: GAP })
        // The next calls: one the guard lets through (and its PostToolUse), one it never sees.
        const ran = yield* callTool(tools, "bash", { command: "echo hi" })
        expect(ran.output).toContain("RAN echo hi")
        yield* callTool(tools, "note", { text: "next" })
        yield* Effect.yieldNow

        // The only DAG event of the whole run is the denial: no lifecycle change, no wake of its own.
        expect(dagEvents).toEqual([DagEvent.NodeSafetyDenied.type])
        const dagStore = yield* DagStore.Service
        const row = yield* dagStore.getNode(dagID, "a")
        expect(row?.status).toBe("running")
        expect(row?.wakeReported).toBe(false)

        const workflow = yield* dagStore.getWorkflow(dagID)
        const nodes = yield* dagStore.getCurrentNodes(dagID)
        if (!workflow) throw new Error("workflow missing")
        const coverage = DagCoverage.workflowCoverage({
          config: Dag.parseWorkflowConfig(workflow.config),
          nodes,
          workflow: { status: workflow.status, pauseReason: workflow.pauseReason },
        })
        expect(coverage).toContainEqual({ node_id: "a", reason: "safety denied: HOOK" })

        const rendered = renderStatus({ workflow, nodes, allNodes: nodes, coverage })
        const parsed: unknown = JSON.parse(rendered.output)
        if (!isRecord(parsed) || !Array.isArray(parsed.nodes)) throw new Error("unexpected status shape")
        const shown = parsed.nodes.find((item): item is Record<string, unknown> => isRecord(item) && item.id === "a")
        expect(isRecord(shown?.safety_denials) ? shown.safety_denials.total : undefined).toBe(1)
        expect(parsed.coverage).toContainEqual({ node_id: "a", reason: "safety denied: HOOK" })

        // The wake text counts what the node rows hold.
        const total = nodes.reduce((sum, node) => sum + (node.safetyDenials?.total ?? 0), 0)
        expect(nodeSafetyWakeLine(row?.safetyDenials?.total ?? 0)).toContain("1 tool call in this node was denied")
        expect(workflowSafetyWakeLine(total)).toContain("Safety policy denied 1 tool call in this workflow")

        // The allowed call is the one PostToolUse reports, and it is told the mode as well.
        const calls = yield* Effect.promise(() => readGuardLog(log))
        expect(calls.map((call) => [call.event, call.permission_mode, call.subject])).toEqual([
          ["PreToolUse", "dontAsk", GAP],
          ["PreToolUse", "dontAsk", "echo hi"],
          ["PostToolUse", "dontAsk", "echo hi"],
        ])
      }),
    { git: true },
  )

  it.instance(
    "the hook is asked before the safety list: a command both would refuse is the hook's denial",
    () =>
      Effect.gen(function* () {
        const { dagID, tools } = yield* guardedNode()
        for (const command of ["git reset --hard", GAP]) yield* callTool(tools, "bash", { command })
        yield* Effect.yieldNow
        const row = yield* (yield* DagStore.Service).getNode(dagID, "a")
        expect(row?.safetyDenials?.total).toBe(2)
        expect(row?.safetyDenials?.items.map((item) => item.ruleID)).toEqual(["HOOK", "HOOK"])
      }),
    { git: true },
  )
})

describe("every tool path records the hook's denial", () => {
  it.instance(
    "an MCP server tool: the call does not run, and the denial names the tool's own permission key",
    () =>
      Effect.gen(function* () {
        const { dagID, tools } = yield* guardedNode({ matcher: "*" })
        const denied = yield* watch(DagEvent.NodeSafetyDenied.type)

        const refused = yield* callTool(tools, "srv_lookup", { command: GAP })
        expect(refused.content?.[0]?.text).toContain(`[Tool denied by hook] ${REASON}`)
        expect(executed).toEqual([])
        yield* Effect.yieldNow

        expect(denied).toHaveLength(1)
        expect(denied[0]).toMatchObject({
          dagID,
          nodeID: "a",
          ruleID: "HOOK",
          permission: "srv_lookup",
          summary: REASON,
        })
      }),
    { git: true },
  )

  it.instance(
    "a file tool: the denial is recorded under the edit key the file tools share",
    () =>
      Effect.gen(function* () {
        const { dagID, tools } = yield* guardedNode({ matcher: "*" })
        const denied = yield* watch(DagEvent.NodeSafetyDenied.type)

        const refused = yield* callTool(tools, "write", { command: GAP })
        expect(refused.output.startsWith(`[Tool denied by hook] ${REASON}`)).toBe(true)
        yield* Effect.yieldNow

        expect(denied).toHaveLength(1)
        expect(denied[0]).toMatchObject({ dagID, nodeID: "a", ruleID: "HOOK", permission: "edit" })
      }),
    { git: true },
  )

  it.instance(
    "an MCP resource tool: the denial is recorded under the read key the tool asks for",
    () =>
      Effect.gen(function* () {
        const { dagID, tools } = yield* guardedNode({ matcher: "*" })
        const denied = yield* watch(DagEvent.NodeSafetyDenied.type)

        const refused = yield* callTool(tools, "read_mcp_resource", { server: "srv", uri: `file:///x/${GAP}` })
        expect(refused.output.startsWith("[Tool denied by hook] fake guard deny:")).toBe(true)
        yield* Effect.yieldNow

        expect(denied).toHaveLength(1)
        expect(denied[0]).toMatchObject({ dagID, nodeID: "a", ruleID: "HOOK", permission: "read" })
      }),
    { git: true },
  )

  it.instance(
    "a long reason is cut to the 200 characters the event allows",
    () =>
      Effect.gen(function* () {
        const { dagID, tools } = yield* guardedNode()
        const denied = yield* watch(DagEvent.NodeSafetyDenied.type)
        const command = `git reset --hard ${"x".repeat(400)}`

        const refused = yield* callTool(tools, "bash", { command })
        // The model still reads the whole reason; only the durable summary is bounded.
        expect(refused.output).toContain(`fake guard deny: ${command}`)
        yield* Effect.yieldNow

        expect(denied).toHaveLength(1)
        const summary = isRecord(denied[0]) ? String(denied[0].summary) : ""
        expect(summary).toHaveLength(200)
        expect(summary.startsWith("fake guard deny: git reset --hard xxx")).toBe(true)
        expect(summary.endsWith("...")).toBe(true)
        const row = yield* (yield* DagStore.Service).getNode(dagID, "a")
        expect(row?.safetyDenials?.items[0]?.summary).toBe(summary)
      }),
    { git: true },
  )
})

describe("the same guard in front of sessions that have no node row", () => {
  for (const [kind, mode] of [
    ["task-on", "dontAsk"],
    ["task-off", "default"],
    ["root", "default"],
  ] as const) {
    it.instance(
      `${kind}: the call is refused and nothing is recorded (the guard is told ${mode})`,
      () =>
        Effect.gen(function* () {
          const { log, tools } = yield* guardedElsewhere(kind)
          const denied = yield* watch(DagEvent.NodeSafetyDenied.type)
          const dagEvents = yield* watchDagEvents

          const refused = yield* callTool(tools, "bash", { command: GAP })
          expect(refused.output.startsWith(`[Tool denied by hook] ${REASON}`)).toBe(true)
          expect(executed).toEqual([])
          expect((yield* callTool(tools, "note", { text: "next" })).output).toContain("NOTED")
          yield* Effect.yieldNow

          expect(denied).toEqual([])
          expect(dagEvents).toEqual([])
          const calls = yield* Effect.promise(() => readGuardLog(log))
          expect(calls.map((call) => call.permission_mode)).toEqual([mode])
        }),
      { git: true },
    )
  }
})

describe("a guard that answers ask", () => {
  const url = "https://example.test/needs-confirmation"

  // `webfetch` stands in for any tool the read-only surface leaves alone: it keeps these cases about the
  // forced ask, however that surface settles shell commands.
  for (const tier of [undefined, "readonly"] as const) {
    it.instance(
      `tier ${tier ?? "allow (default)"}: SF-6 refuses it for the node, nobody is asked, the denial is recorded`,
      () =>
        withTier(
          tier,
          Effect.gen(function* () {
            const { dagID, tools } = yield* guardedNode()
            const denied = yield* watch(DagEvent.NodeSafetyDenied.type)
            const asked = yield* watch(Permission.Event.Asked.type)
            const permission = yield* Permission.Service

            const refused = yield* callTool(tools, "webfetch", { url })
            expect(refused.output.startsWith("[Tool denied by hook]")).toBe(true)
            expect(refused.metadata).toMatchObject({ hookDenied: true })
            expect(executed).toEqual([])
            expect(yield* permission.list()).toEqual([])
            expect((yield* callTool(tools, "note", { text: "next" })).output).toContain("NOTED")
            yield* Effect.yieldNow
            expect(asked).toEqual([])

            expect(denied).toHaveLength(1)
            expect(denied[0]).toMatchObject({ dagID, nodeID: "a", ruleID: "SF-6", permission: "webfetch" })
          }),
        ),
      { git: true },
    )
  }

  it.instance(
    "tier ask: it reaches the user, who can refuse it (nothing is recorded) or let it run",
    () =>
      withTier(
        "ask",
        Effect.gen(function* () {
          const { sessionID, tools } = yield* guardedNode()
          const denied = yield* watch(DagEvent.NodeSafetyDenied.type)
          const asked = yield* watch(Permission.Event.Asked.type)
          const permission = yield* Permission.Service

          const pending = Effect.gen(function* () {
            const fiber = yield* callTool(tools, "webfetch", { url }).pipe(Effect.forkScoped)
            const request = yield* pollWithTimeout(
              permission.list().pipe(Effect.map((list) => list.find((item) => item.sessionID === sessionID))),
              () => `no pending request for ${sessionID}`,
            )
            return { fiber, request }
          })

          const refusing = yield* pending
          expect(refusing.request.permission).toBe("webfetch")
          yield* permission.reply({ requestID: refusing.request.id, reply: "reject" })
          const refused = yield* Fiber.join(refusing.fiber)
          expect(refused.output.startsWith("[Tool denied by hook]")).toBe(true)
          expect(executed).toEqual([])

          const approving = yield* pending
          yield* permission.reply({ requestID: approving.request.id, reply: "once" })
          const ran = yield* Fiber.join(approving.fiber)
          expect(ran.output).toContain(`FETCHED ${url}`)
          expect(executed).toEqual([url])

          expect(asked).toHaveLength(2)
          // The user's own refusal is not a safety denial.
          expect(denied).toEqual([])
        }),
      ),
    { git: true },
  )
})

describe("a guard that cannot run (the behaviour the guide relies on)", () => {
  const missing = (extra: Partial<HookCommand> = {}): HookCommand => ({
    type: "command",
    command: "/nonexistent/fake-command-guard",
    args: ["--check"],
    ...extra,
  })
  const hung = (extra: Partial<HookCommand> = {}): HookCommand => ({
    type: "command",
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    timeout: 0.3,
    ...extra,
  })

  for (const [label, entry, warning] of [
    ["the executable does not exist", missing, "hook error"],
    ["the guard times out", hung, "timed out"],
  ] as const) {
    it.instance(
      `${label}: the call runs and the user is warned`,
      () =>
        Effect.gen(function* () {
          const { tools } = yield* guardedNode({ entry: entry() })
          const denied = yield* watch(DagEvent.NodeSafetyDenied.type)
          const warnings = yield* watch(LegacyEvent.HookMessage.type)

          const ran = yield* callTool(tools, "bash", { command: "git status" })
          expect(ran.output).toContain("RAN git status")
          expect(executed).toEqual(["git status"])
          yield* Effect.yieldNow

          expect(warnings.map((item) => (isRecord(item) ? String(item.message) : "")).join("\n")).toContain(warning)
          expect(denied).toEqual([])
        }),
      { git: true },
    )

    it.instance(
      `${label}, onFailure "block": the call is refused, and the denial is the hook's`,
      () =>
        Effect.gen(function* () {
          const { dagID, tools } = yield* guardedNode({ entry: entry({ onFailure: "block" }) })
          const denied = yield* watch(DagEvent.NodeSafetyDenied.type)

          const refused = yield* callTool(tools, "bash", { command: "git status" })
          expect(refused.output.startsWith("[Tool denied by hook]")).toBe(true)
          expect(refused.output).toContain('blocking because onFailure is "block"')
          expect(executed).toEqual([])
          yield* Effect.yieldNow

          // A guard that fails closed refuses the call like any other hook deny.
          expect(denied).toHaveLength(1)
          expect(denied[0]).toMatchObject({ dagID, nodeID: "a", ruleID: "HOOK", permission: "bash" })
        }),
      { git: true },
    )
  }

  it.instance(
    "a guard that works leaves an unrelated command alone and sees both ends of it",
    () =>
      Effect.gen(function* () {
        const { log, tools } = yield* guardedNode()
        expect((yield* callTool(tools, "bash", { command: "git status" })).output).toContain("RAN git status")
        const calls = yield* Effect.promise(() => readGuardLog(log))
        expect(calls.map((call) => call.event)).toEqual(["PreToolUse", "PostToolUse"])
      }),
    { git: true },
  )
})
