// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- partial agent, session and processor fixtures use `as never`.
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { ProjectV2 } from "@graphagent/core/project"
import { Injection } from "@graphagent/core/system-context/injection"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import path from "node:path"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionTools } from "@/session/tools"
import { SettingsHook, type TriggerResult } from "@/hook"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { DirectTool } from "@/tool/pipeline"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { builtinEntry, directShellEntry } from "../fixture/tool-registry"
import { testEffect } from "../lib/effect"

/**
 * #1454 PR2: a truncated result of webfetch, websearch, bash or read ends with one `runtime` block that holds a
 * ready-to-run `task` call, but only when the session can make that call. The stubs answer with the metadata the
 * real tools write; the wrapper, the hooks and the permission rules around them are the real pipeline's.
 */

afterEach(async () => {
  await disposeAllInstances()
})

const SAVED = "/data/tool-output/tool_0001"
const BIG_FILE = "/repo/build.log"

type Reply = { output: string; metadata: Record<string, unknown> }

/** What the stubs answer, and what the registry and the agent service hold: set by `arrange` before each case. */
const state: { reply: Reply; omitted: ReadonlySet<string>; known: ReadonlySet<string> } = {
  reply: { output: "", metadata: {} },
  omitted: new Set(),
  known: new Set(),
}
const arrange = (next: { reply: Reply; omitted?: Iterable<string>; known?: Iterable<string> }) =>
  Effect.sync(() => {
    state.reply = next.reply
    state.omitted = new Set(next.omitted ?? [])
    state.known = new Set(next.known ?? ["explore", "researcher"])
  })

const stub = (id: string) => ({
  id,
  description: `Fixture ${id}`,
  parameters: Schema.Struct({}),
  execute: () => Effect.succeed({ title: id, output: state.reply.output, metadata: state.reply.metadata }),
})
const definitions = ["bash", "webfetch", "websearch", "read", "grep", "task"].map(stub)
// The `!cmd` run of the shell: the registry resolves it to this one entry and nothing else.
const directBash: DirectTool = {
  id: "bash",
  description: "Fixture explicit shell command",
  parameters: Schema.Struct({}),
  execute: () => Effect.succeed({ title: "bash", output: state.reply.output, metadata: state.reply.metadata }),
}

/** The hook text of each event, and the order the pipeline put it in. */
const hookReplies: Record<string, string> = { PreToolUse: "PRE_NOTE", PostToolUse: "POST_NOTE" }
const withHooks = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: (payload) =>
      Effect.succeed<TriggerResult>({
        additionalContexts: hookReplies[payload.event] === undefined ? [] : [hookReplies[payload.event]],
        systemMessages: [],
      }),
    list: () => Effect.succeed([]),
  }),
)

const services = Layer.mergeAll(
  Layer.mock(Permission.Service, {
    ask: () => Effect.void,
    hookPolicy: () => Effect.succeed({ rules: [], directories: [] }),
  }),
  Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
  Layer.mock(Truncate.Service, { output: (text: string) => Effect.succeed({ content: text, truncated: false }) }),
  Layer.mock(ToolRegistry.Service, {
    tools: () => Effect.succeed(definitions),
    resolve: (input) =>
      Effect.sync(() =>
        input.directTool
          ? [directShellEntry(directBash)]
          : definitions.filter((item) => !state.omitted.has(item.id)).map((item) => builtinEntry(item)),
      ),
  }),
)
const agents = Layer.mock(Agent.Service, {
  get: (name) => Effect.succeed(state.known.has(name) ? ({ name } as never) : undefined),
})
const it = testEffect(Layer.mergeAll(services, agents))
const withoutAgentService = testEffect(services)
const hooked = testEffect(Layer.mergeAll(services, agents, withHooks))

const ALLOW_ALL: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]
const deny = (agent: string): PermissionV1.Ruleset => [
  ...ALLOW_ALL,
  { permission: "task", pattern: agent, action: "deny" },
]

type Tools = Record<
  string,
  { execute: (args: unknown, options: unknown) => Promise<{ output: string; metadata: any }> }
>

/** The tools of one root session as the model's runtime would run them, wrapped by the real pipeline. */
const resolveTools = (options: { rules?: PermissionV1.Ruleset; direct?: boolean } = {}) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const sessionID = SessionID.descending()
    return (yield* SessionTools.resolve({
      agent: { name: "build", permission: options.rules ?? ALLOW_ALL, options: {} } as never,
      model: ProviderTest.model(),
      session: { id: sessionID, directory: instance.directory, permission: [] } as never,
      processor: {
        message: { id: MessageID.ascending(), sessionID },
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      } as never,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
      ...(options.direct ? { directTool: directBash } : {}),
    } as never)) as unknown as Tools
  })

const call = (tools: Tools, name: string, args: unknown = {}) =>
  Effect.tryPromise(() =>
    tools[name].execute(args, {
      toolCallId: `call-${name}`,
      messages: [],
      abortSignal: new AbortController().signal,
    }),
  )

const block = (agent: string, path: string) =>
  Injection.wrap(
    "runtime",
    `Delegate: task subagent_type="${agent}" description="Read the file" prompt="Read ${path} and answer: <your question>."`,
  )

const saved = { truncated: true, outputPath: SAVED }
const bigRead = { truncated: true, display: { type: "file", path: BIG_FILE, totalLines: 2500 } }
const reply = (metadata: Record<string, unknown>): Reply => ({ output: "PREVIEW", metadata })

describe("the delegation line on a truncated result (#1454)", () => {
  it.instance("webfetch, websearch, bash and read each end with the block of their agent", () =>
    Effect.gen(function* () {
      const cases = [
        { tool: "webfetch", args: { url: "https://example.com" }, metadata: saved, agent: "researcher", path: SAVED },
        { tool: "websearch", args: { query: "q" }, metadata: saved, agent: "researcher", path: SAVED },
        { tool: "bash", args: { command: "make" }, metadata: saved, agent: "explore", path: SAVED },
        { tool: "read", args: { filePath: BIG_FILE }, metadata: bigRead, agent: "explore", path: BIG_FILE },
      ]
      for (const item of cases) {
        yield* arrange({ reply: reply(item.metadata) })
        const result = yield* call(yield* resolveTools(), item.tool, item.args)
        expect(result.output).toBe(`PREVIEW\n\n${block(item.agent, item.path)}`)
        // The line only reads what the tool wrote: the result's own metadata is as the tool left it.
        expect(result.metadata).toEqual(item.metadata)
      }
    }),
  )

  it.instance("a tool the line does not cover keeps its result, truncated or not", () =>
    Effect.gen(function* () {
      yield* arrange({ reply: reply({ ...saved, display: bigRead.display }) })
      expect((yield* call(yield* resolveTools(), "grep", { pattern: "x" })).output).toBe("PREVIEW")
    }),
  )

  it.instance("a result that was not truncated, or that has no saved copy, keeps its text", () =>
    Effect.gen(function* () {
      for (const metadata of [{ truncated: false, outputPath: SAVED }, { truncated: true }, {}]) {
        yield* arrange({ reply: reply(metadata) })
        expect((yield* call(yield* resolveTools(), "bash", { command: "make" })).output).toBe("PREVIEW")
      }
    }),
  )

  it.instance("a read of a directory, of a short file or with its own window keeps its text", () =>
    Effect.gen(function* () {
      const directory = { truncated: true, display: { type: "directory", path: "/repo", totalEntries: 9000 } }
      const short = { truncated: true, display: { type: "file", path: BIG_FILE, totalLines: 2000 } }
      const cases = [
        { metadata: directory, args: { filePath: "/repo" } },
        { metadata: short, args: { filePath: BIG_FILE } },
        { metadata: bigRead, args: { filePath: BIG_FILE, offset: 1 } },
        { metadata: bigRead, args: { filePath: BIG_FILE, limit: 100 } },
        { metadata: bigRead, args: { filePath: BIG_FILE, page: -1 } },
        { metadata: bigRead, args: { filePath: BIG_FILE, charOffset: 5 } },
      ]
      for (const item of cases) {
        yield* arrange({ reply: reply(item.metadata) })
        expect((yield* call(yield* resolveTools(), "read", item.args)).output).toBe("PREVIEW")
      }
    }),
  )

  it.instance("a session without the task tool (a child session) keeps its text", () =>
    Effect.gen(function* () {
      yield* arrange({ reply: reply(saved), omitted: ["task"] })
      const tools = yield* resolveTools()
      expect(Object.keys(tools)).not.toContain("task")
      expect((yield* call(tools, "bash", { command: "make" })).output).toBe("PREVIEW")
      expect((yield* call(tools, "webfetch", { url: "https://example.com" })).output).toBe("PREVIEW")
    }),
  )

  it.instance("an explicit `!cmd` run keeps its text: its tool set holds no task", () =>
    Effect.gen(function* () {
      yield* arrange({ reply: reply(saved) })
      const tools = yield* resolveTools({ direct: true })
      expect(Object.keys(tools)).toEqual(["bash"])
      expect((yield* call(tools, "bash", { command: "make" })).output).toBe("PREVIEW")
    }),
  )

  it.instance("a task call to the agent being denied withholds that agent's line and no other", () =>
    Effect.gen(function* () {
      yield* arrange({ reply: reply(saved) })
      const noExplore = yield* resolveTools({ rules: deny("explore") })
      expect((yield* call(noExplore, "bash", { command: "make" })).output).toBe("PREVIEW")
      expect((yield* call(noExplore, "webfetch", { url: "https://example.com" })).output).toBe(
        `PREVIEW\n\n${block("researcher", SAVED)}`,
      )

      const noResearcher = yield* resolveTools({ rules: deny("researcher") })
      expect((yield* call(noResearcher, "webfetch", { url: "https://example.com" })).output).toBe("PREVIEW")
      expect((yield* call(noResearcher, "websearch", { query: "q" })).output).toBe("PREVIEW")
      expect((yield* call(noResearcher, "bash", { command: "make" })).output).toBe(
        `PREVIEW\n\n${block("explore", SAVED)}`,
      )
    }),
  )

  it.instance("a task call the rules would ask about still gets its line: only a denial withholds it", () =>
    Effect.gen(function* () {
      yield* arrange({ reply: reply(saved) })
      const tools = yield* resolveTools({
        rules: [...ALLOW_ALL, { permission: "task", pattern: "explore", action: "ask" }],
      })
      expect((yield* call(tools, "bash", { command: "make" })).output).toBe(`PREVIEW\n\n${block("explore", SAVED)}`)
    }),
  )

  it.instance("denying the task tool itself withholds every line", () =>
    Effect.gen(function* () {
      yield* arrange({ reply: reply(saved) })
      const tools = yield* resolveTools({ rules: [...ALLOW_ALL, { permission: "task", pattern: "*", action: "deny" }] })
      expect((yield* call(tools, "bash", { command: "make" })).output).toBe("PREVIEW")
      expect((yield* call(tools, "websearch", { query: "q" })).output).toBe("PREVIEW")
    }),
  )

  it.instance("an agent the service does not know withholds its line", () =>
    Effect.gen(function* () {
      yield* arrange({ reply: reply(saved), known: ["researcher"] })
      const tools = yield* resolveTools()
      expect((yield* call(tools, "bash", { command: "make" })).output).toBe("PREVIEW")
      expect((yield* call(tools, "webfetch", { url: "https://example.com" })).output).toBe(
        `PREVIEW\n\n${block("researcher", SAVED)}`,
      )
    }),
  )

  withoutAgentService.instance("a pipeline with no agent service adds no line", () =>
    Effect.gen(function* () {
      yield* arrange({ reply: reply(saved) })
      expect((yield* call(yield* resolveTools(), "bash", { command: "make" })).output).toBe("PREVIEW")
    }),
  )

  hooked.instance("the line comes after the hook text of both events", () =>
    Effect.gen(function* () {
      yield* arrange({ reply: reply(saved) })
      const result = yield* call(yield* resolveTools(), "bash", { command: "make" })
      expect(result.output).toBe(
        [
          Injection.wrap("hook", "PRE_NOTE"),
          "PREVIEW",
          Injection.wrap("hook", "POST_NOTE"),
          block("explore", SAVED),
        ].join("\n\n"),
      )
    }),
  )
})

// The line is withheld from a session that holds no `task` entry, so the real registry has to leave the tool out of a
// child session: a task child and a DAG node hand their findings to the parent instead of starting subagents.
describe("the real registry and the task tool (#1454)", () => {
  const real = testEffect(
    LayerNode.buildLayer(LayerNode.group([ToolRegistry.node, Agent.node]), {
      replacements: [
        LayerNode.replace(
          Config.node,
          TestConfig.layer({
            directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".agents")])),
          }),
        ),
        LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer()),
      ],
    }),
  )
  const session = (id: SessionID, directory: string, parentID?: SessionID) =>
    ({
      id,
      ...(parentID ? { parentID } : {}),
      slug: id,
      role: parentID ? "task_child" : "root",
      projectID: ProjectV2.ID.global,
      directory,
      title: id,
      version: "1.0.0",
      time: { created: 1, updated: 1 },
    }) as Session.Info

  real.instance("a root session is given the task tool and a child session is not", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const build = yield* (yield* Agent.Service).get("build")
      if (!build) throw new Error("build agent not found")
      const directory = yield* InstanceState.directory
      const parentID = SessionID.make(`ses_delegation_root_${crypto.randomUUID()}`)
      const childID = SessionID.make(`ses_delegation_child_${crypto.randomUUID()}`)
      const idsOf = (value: Session.Info) =>
        registry
          .resolve({ model: ProviderTest.model(), agent: build, session: value })
          .pipe(Effect.map((entries) => entries.map((entry) => entry.id)))

      expect(yield* idsOf(session(parentID, directory))).toContain("task")
      expect(yield* idsOf(session(childID, directory, parentID))).not.toContain("task")
    }),
  )
})
