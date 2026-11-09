// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { jsonSchema, tool } from "ai"
import { SessionTools } from "@/session/tools"
import { SessionHooks } from "@/hook/session-hooks"
import { SettingsHook } from "@/hook"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@graphagent/core/database/database"
import { ToolRegistry, type ToolEntry } from "@/tool/registry"
import type { DirectTool } from "@/tool/pipeline"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { hookCommand } from "../fixture/claude-hook"
import { toolPermission, updateSessionPolicy } from "@/permission/session-policy"
import { evaluate } from "@/permission"
import { McpCatalog } from "@/mcp/catalog"
import { hookToolStop } from "@/hook/trigger-result"
import { Agent } from "@/agent/agent"
import { QuestionTool } from "@/tool/question"
import { Question } from "@/question"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { MCP_RESOURCE_DEFINITIONS, MCP_RESOURCE_ORDER } from "@/tool/mcp-resource"
import { builtinEntry, directShellEntry, mcpEntries } from "../fixture/tool-registry"

const hookLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const writeDefinition = {
  id: "write",
  description: "Fixture leaf writer with the real write tool parameter shape",
  parameters: Schema.Struct({ filePath: Schema.String, content: Schema.String }),
  execute: (args: { filePath: string; content: string }) =>
    Effect.promise(async () => {
      if (args.content === "THROW") throw new Error("CROSS_AUDIT_TOOL_FAILURE")
      await fs.writeFile(args.filePath, args.content)
      return {
        title: "written",
        output: "WRITE_COMPLETE",
        metadata: { filepath: args.filePath, exists: false },
      }
    }),
}
let extraDefinitions: any[] = []
let mcpTools: Record<string, any> = {}
let mcpClients: Record<string, unknown> = {}
let resourceLoader: MCP.Interface["resources"] = () => Effect.succeed({})
let askResult: Effect.Effect<void, PermissionV1.RejectedError> = Effect.void
const layers = Layer.mergeAll(
  hookLayer,
  Layer.mock(Permission.Service, {
    ask: () => askResult,
    hookPolicy: () => Effect.succeed({ rules: [], directories: [] }),
  }),
  Layer.mock(MCP.Service, {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    clients: () => Effect.succeed(mcpClients as never),
    tools: () => Effect.succeed(mcpTools),
    resources: (server) => resourceLoader(server),
    resourceTemplates: () => Effect.succeed({}),
  }),
  Layer.mock(Truncate.Service, { output: (text: string) => Effect.succeed({ content: text, truncated: false }) }),
  Layer.mock(ToolRegistry.Service, {
    tools: () => Effect.succeed([writeDefinition, ...extraDefinitions]),
    resolve: (input: { directTool?: DirectTool }) =>
      Effect.sync(() => {
        // The real registry returns only the explicit shell entry for a direct tool.
        if (input.directTool) return [directShellEntry(input.directTool)]
        const entries: ToolEntry[] = [writeDefinition, ...extraDefinitions].map((definition) =>
          builtinEntry(definition),
        )
        const hasResources = Object.values(mcpClients).some(
          (client) =>
            !!(client as { getServerCapabilities?: () => { resources?: unknown } }).getServerCapabilities?.()
              ?.resources,
        )
        if (hasResources) {
          for (const op of MCP_RESOURCE_ORDER) {
            const definition = MCP_RESOURCE_DEFINITIONS[op]
            entries.push({
              id: definition.id,
              source: { kind: "mcp-resource" as const, op, registrationID: `mcp-resource:${definition.id}` },
              effects: "read" as const,
              description: definition.description,
              jsonSchema: definition.jsonSchema,
            })
          }
        }
        entries.push(...mcpEntries(mcpTools))
        return entries
      }),
  }),
)
const it = testEffect(layers)
const resolve = (id: any, dir: string, directTool?: DirectTool) =>
  SessionTools.resolve({
    ...(directTool ? { directTool } : {}),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    agent: { name: "build", permission: [], options: {} } as any,
    model: ProviderTest.model(),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    session: { id, directory: dir, permission: [] } as any,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    processor: {
      message: { id: MessageID.ascending(), sessionID: id },
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    } as any,
    bypassAgentCheck: false,
    messages: [],
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    promptOps: {} as any,
  })
const options = (callID: string) => ({ toolCallId: callID, messages: [], abortSignal: new AbortController().signal })

const deferHook = {
  type: "command" as const,
  command: hookCommand(
    `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"defer"}}))`,
  ),
}
const exit2Hook = {
  type: "command" as const,
  command: hookCommand(`process.stderr.write("CROSS_AUDIT_EXIT2"); process.exit(2)`),
}

type PreparedSource = {
  tools: Record<string, any>
  toolName: string
  args: Record<string, unknown>
  executed: () => Effect.Effect<boolean>
  cleanup?: Effect.Effect<void>
}

type DeferSourceCase = {
  name: string
  prepare: (id: any, directory: string) => Effect.Effect<PreparedSource, never, any>
}

// Every source kind reaches the same host hook pipeline. Drive the shared
// defer/exit-2 assertions from one table instead of duplicating the body.
const deferSourceCases: DeferSourceCase[] = [
  {
    name: "built-in tool",
    prepare: (id, directory) => {
      const target = path.join(directory, "defer-native.txt")
      return resolve(id, directory).pipe(
        Effect.map((tools) => ({
          tools,
          toolName: "write",
          args: { filePath: target, content: "x" },
          executed: () => Effect.promise(() => Bun.file(target).exists()),
        })),
      )
    },
  },
  {
    name: "MCP tool",
    prepare: (id, directory) =>
      Effect.gen(function* () {
        let ran = false
        mcpTools = {
          fixture_probe: tool({
            inputSchema: jsonSchema({ type: "object", properties: {} }),
            execute: async () => {
              ran = true
              return { content: [{ type: "text" as const, text: "MCP_RAN" }] }
            },
          }),
        }
        const tools = yield* resolve(id, directory)
        return {
          tools,
          toolName: "fixture_probe",
          args: {},
          executed: () => Effect.sync(() => ran),
          cleanup: Effect.sync(() => {
            mcpTools = {}
          }),
        }
      }),
  },
  {
    name: "MCP resource tool",
    prepare: (id, directory) =>
      Effect.gen(function* () {
        let listed = false
        mcpClients = {
          fixture: {
            getServerCapabilities: () => ({ resources: {} }),
            listResources: async () => {
              listed = true
              return { resources: [] }
            },
          },
        }
        const tools = yield* resolve(id, directory)
        return {
          tools,
          toolName: "list_mcp_resources",
          args: {},
          executed: () => Effect.sync(() => listed),
          cleanup: Effect.sync(() => {
            mcpClients = {}
          }),
        }
      }),
  },
  {
    name: "direct-shell tool",
    prepare: (id, directory) =>
      Effect.gen(function* () {
        const target = path.join(directory, "defer-direct-shell.txt")
        const directTool: DirectTool = {
          id: "bash",
          description: "Fixture explicit user shell command",
          parameters: Schema.Struct({ command: Schema.String }),
          execute: () =>
            Effect.promise(async () => {
              await fs.writeFile(target, "x")
              return { title: "bash", metadata: {}, output: "DIRECT_SHELL_RAN" }
            }),
        }
        const tools = yield* resolve(id, directory, directTool)
        return {
          tools,
          toolName: "bash",
          args: { command: "true" },
          executed: () => Effect.promise(() => Bun.file(target).exists()),
        }
      }),
  },
]

describe("PreToolUse defer that the host cannot honor", () => {
  for (const source of deferSourceCases) {
    it.instance(`${source.name}: an unusable defer must not erase a sibling exit-2 rejection`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const store = yield* SessionHooks.Service
        const id = SessionID.descending()
        yield* store.add(id, { event: "PreToolUse", hooks: [deferHook, exit2Hook] })
        const prepared = yield* source.prepare(id, instance.directory)
        if (prepared.cleanup) yield* Effect.addFinalizer(() => prepared.cleanup!)
        const result = yield* Effect.promise(() =>
          Promise.resolve(
            prepared.tools[prepared.toolName].execute!(
              prepared.args,
              options(`defer-${source.name.replaceAll(/[^a-z0-9]+/gi, "-")}`),
            ),
          ),
        )
        expect(JSON.stringify(result)).toContain("CROSS_AUDIT_EXIT2")
        expect(yield* prepared.executed()).toBe(false)
      }),
    )
  }

  it.instance("built-in tool: an unusable defer alone is ignored and the tool runs", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const target = path.join(instance.directory, "defer-alone.txt")
      yield* store.add(id, { event: "PreToolUse", hooks: [deferHook] })
      const tools = yield* resolve(id, instance.directory)
      const result = yield* Effect.promise(() =>
        Promise.resolve(tools.write.execute!({ filePath: target, content: "x" }, options("defer-alone"))),
      )
      expect(JSON.stringify(result)).toContain("WRITE_COMPLETE")
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(true)
    }),
  )
})

const preContextHook = {
  type: "command" as const,
  command: hookCommand(
    `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"CROSS_AUDIT_PRE_CTX"}}))`,
  ),
}
const replaceAndCaptureHook = (capture: string) => ({
  type: "command" as const,
  command: hookCommand(
    `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(capture)},JSON.stringify(i));console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUse",updatedToolOutput:{title:"r",output:"CROSS_AUDIT_REPLACED",metadata:{}}}}))`,
  ),
})

describe("PreToolUse feedback survives PostToolUse output replacement", () => {
  it.instance("built-in tool: replacement keeps Pre context and the Post hook never sees it", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const capture = path.join(instance.directory, "post-input.json")
      yield* store.add(id, { event: "PreToolUse", hooks: [preContextHook] })
      yield* store.add(id, { event: "PostToolUse", hooks: [replaceAndCaptureHook(capture)] })
      const tools = yield* resolve(id, instance.directory)
      const result: any = yield* Effect.promise(() =>
        Promise.resolve(
          tools.write.execute!({ filePath: path.join(instance.directory, "d4.txt"), content: "x" }, options("d4")),
        ),
      )
      expect(result.output).toContain("CROSS_AUDIT_PRE_CTX")
      expect(result.output).toContain("CROSS_AUDIT_REPLACED")
      expect(result.output).not.toContain("WRITE_COMPLETE")
      const seen = JSON.parse(yield* Effect.promise(() => fs.readFile(capture, "utf8")))
      // CC hands PostToolUse scripts the structured response, not the model text.
      expect(seen.tool_response).toEqual({
        filepath: path.join(instance.directory, "d4.txt"),
        exists: false,
      })
      expect(JSON.stringify(seen.tool_response)).not.toContain("CROSS_AUDIT_PRE_CTX")
      // Direct SessionTools.resolve callers have no prompt-level transcript wrapper;
      // the hook envelope must still point at a materialized transcript file.
      expect(typeof seen.transcript_path).toBe("string")
      expect(seen.transcript_path.length).toBeGreaterThan(0)
      expect(yield* Effect.promise(() => fs.stat(seen.transcript_path))).toBeTruthy()
    }),
  )

  it.instance("MCP resource tool: replacement keeps Pre context and the Post hook never sees it", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const capture = path.join(instance.directory, "post-resource-input.json")
      mcpClients = { fixture: { getServerCapabilities: () => ({ resources: {} }) } }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          mcpClients = {}
        }),
      )
      yield* store.add(id, { event: "PreToolUse", hooks: [preContextHook] })
      yield* store.add(id, { event: "PostToolUse", hooks: [replaceAndCaptureHook(capture)] })
      const tools = yield* resolve(id, instance.directory)
      const result: any = yield* Effect.promise(() =>
        Promise.resolve(tools.list_mcp_resources.execute!({}, options("d4-resource"))),
      )
      expect(result.output).toContain("CROSS_AUDIT_PRE_CTX")
      expect(result.output).toContain("CROSS_AUDIT_REPLACED")
      const seen = JSON.parse(yield* Effect.promise(() => fs.readFile(capture, "utf8")))
      expect(JSON.stringify(seen.tool_response)).not.toContain("CROSS_AUDIT_PRE_CTX")
    }),
  )
})

const capturePostHook = (capture: string) => ({
  type: "command" as const,
  command: hookCommand(
    `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(capture)},JSON.stringify(i))`,
  ),
})

// CC gives PostToolUse scripts the tool's structured response, and V2 already
// passes `output.structured`; V1 must not fall back to the model-facing string.
describe("PostToolUse tool_response is the tool's structured output", () => {
  it.instance("built-in tool: hook receives metadata, not the model-facing output", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const capture = path.join(instance.directory, "post-structured.json")
      const target = path.join(instance.directory, "structured.txt")
      yield* store.add(id, { event: "PostToolUse", hooks: [capturePostHook(capture)] })
      const tools = yield* resolve(id, instance.directory)
      yield* Effect.promise(() =>
        Promise.resolve(tools.write.execute!({ filePath: target, content: "x" }, options("structured-builtin"))),
      )
      const seen = JSON.parse(yield* Effect.promise(() => fs.readFile(capture, "utf8")))
      expect(seen.tool_response).toEqual({ filepath: target, exists: false })
    }),
  )

  it.instance("MCP resource tool: hook receives metadata, not the model-facing output", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const capture = path.join(instance.directory, "post-structured-resource.json")
      mcpClients = {
        fixture: { getServerCapabilities: () => ({ resources: {} }), listResources: async () => ({ resources: [] }) },
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          mcpClients = {}
        }),
      )
      yield* store.add(id, { event: "PostToolUse", hooks: [capturePostHook(capture)] })
      const tools = yield* resolve(id, instance.directory)
      yield* Effect.promise(() =>
        Promise.resolve(tools.list_mcp_resources.execute!({}, options("structured-resource"))),
      )
      const seen = JSON.parse(yield* Effect.promise(() => fs.readFile(capture, "utf8")))
      expect(seen.tool_response).toEqual({ count: 0, servers: ["fixture"], truncated: false })
    }),
  )

  it.instance("MCP tool: hook receives the structured CallToolResult", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const capture = path.join(instance.directory, "post-structured-mcp.json")
      mcpTools = {
        fixture_probe: tool({
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => ({ content: [{ type: "text" as const, text: "MCP_STRUCTURED" }] }),
        }),
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          mcpTools = {}
        }),
      )
      yield* store.add(id, { event: "PostToolUse", hooks: [capturePostHook(capture)] })
      const tools = yield* resolve(id, instance.directory)
      yield* Effect.promise(() => Promise.resolve(tools.fixture_probe.execute!({}, options("structured-mcp"))))
      const seen = JSON.parse(yield* Effect.promise(() => fs.readFile(capture, "utf8")))
      expect(seen.tool_response).toEqual({ content: [{ type: "text", text: "MCP_STRUCTURED" }] })
    }),
  )
})

const askHook = {
  type: "command" as const,
  command: hookCommand(
    `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask"}}))`,
  ),
}
const denyWithContextHook = {
  type: "command" as const,
  command: hookCommand(
    `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"CROSS_AUDIT_DENY",additionalContext:"CROSS_AUDIT_PRE_CTX"}}))`,
  ),
}

describe("PreToolUse additionalContext stays with a rejected or failed tool result", () => {
  it.instance("deny keeps the context next to the denial", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      yield* store.add(id, { event: "PreToolUse", hooks: [denyWithContextHook] })
      const tools = yield* resolve(id, instance.directory)
      const result: any = yield* Effect.promise(() =>
        Promise.resolve(
          tools.write.execute!({ filePath: path.join(instance.directory, "p2.txt"), content: "x" }, options("p2-deny")),
        ),
      )
      expect(result.output).toContain("CROSS_AUDIT_DENY")
      expect(result.output).toContain("CROSS_AUDIT_PRE_CTX")
    }),
  )

  it.instance("a user's rejection of a hook ask keeps the context", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      askResult = Effect.fail(new PermissionV1.RejectedError())
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          askResult = Effect.void
        }),
      )
      yield* store.add(id, { event: "PreToolUse", hooks: [askHook, preContextHook] })
      const tools = yield* resolve(id, instance.directory)
      const result: any = yield* Effect.promise(() =>
        Promise.resolve(
          tools.write.execute!({ filePath: path.join(instance.directory, "p2.txt"), content: "x" }, options("p2-ask")),
        ),
      )
      expect(result.output).toContain("Tool denied by hook")
      expect(result.output).toContain("CROSS_AUDIT_PRE_CTX")
    }),
  )

  it.instance("a failed built-in execution keeps the context in the surfaced error", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      yield* store.add(id, { event: "PreToolUse", hooks: [preContextHook] })
      yield* store.add(id, {
        event: "PostToolUseFailure",
        hooks: [
          {
            type: "command",
            command: hookCommand(
              `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUseFailure",additionalContext:"CROSS_AUDIT_FAIL_CTX"}}))`,
            ),
          },
        ],
      })
      const tools = yield* resolve(id, instance.directory)
      const exit = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            tools.write.execute!(
              { filePath: path.join(instance.directory, "p2.txt"), content: "THROW" },
              options("p2-fail"),
            ),
          ),
        catch: (error) => error,
      }).pipe(Effect.flip)
      const message = exit instanceof Error ? exit.message : ""
      expect(message).toContain("CROSS_AUDIT_TOOL_FAILURE")
      expect(message).toContain("CROSS_AUDIT_PRE_CTX")
      expect(message).toContain("CROSS_AUDIT_FAIL_CTX")
    }),
  )

  it.instance("an ignored defer keeps the context while a real deferral drops it", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const target = path.join(instance.directory, "p2-defer.txt")
      yield* store.add(id, { event: "PreToolUse", hooks: [deferHook, preContextHook] })
      const tools = yield* resolve(id, instance.directory)
      const result: any = yield* Effect.promise(() =>
        Promise.resolve(tools.write.execute!({ filePath: target, content: "x" }, options("p2-defer"))),
      )
      expect(result.output).toContain("CROSS_AUDIT_PRE_CTX")
      expect(result.output).toContain("WRITE_COMPLETE")
    }),
  )
})

describe("PostToolUseFailure continue:false", () => {
  const stopFailureHook = {
    type: "command" as const,
    command: hookCommand(`console.log(JSON.stringify({continue:false,stopReason:"CROSS_AUDIT_STOP"}))`),
  }
  it.instance("surfaces a stop marker while keeping the original error", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      yield* store.add(id, { event: "PostToolUseFailure", hooks: [stopFailureHook] })
      const tools = yield* resolve(id, instance.directory)
      const error = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            tools.write.execute!(
              { filePath: path.join(instance.directory, "d5.txt"), content: "THROW" },
              options("d5"),
            ),
          ),
        catch: (error) => error,
      }).pipe(Effect.flip)
      expect(error instanceof Error ? error.message : "").toContain("CROSS_AUDIT_TOOL_FAILURE")
      expect(hookToolStop(error)?.stopReason).toBe("CROSS_AUDIT_STOP")
    }),
  )

  it.instance("does not mark an ordinary failure as a stop", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      yield* store.add(id, {
        event: "PostToolUseFailure",
        hooks: [
          {
            type: "command",
            command: hookCommand(`console.log(JSON.stringify({decision:"block",reason:"CROSS_AUDIT_FEEDBACK"}))`),
          },
        ],
      })
      const tools = yield* resolve(id, instance.directory)
      const error = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            tools.write.execute!(
              { filePath: path.join(instance.directory, "d5b.txt"), content: "THROW" },
              options("d5b"),
            ),
          ),
        catch: (error) => error,
      }).pipe(Effect.flip)
      expect(hookToolStop(error)).toBeUndefined()
      expect(error instanceof Error ? error.message : "").toContain("CROSS_AUDIT_FEEDBACK")
    }),
  )
})

describe("official MCP names in permission updates", () => {
  test("an exact official name addresses the native permission and keeps native names working", () => {
    expect(toolPermission("mcp__fixture__pick")).toBe("fixture_pick")
    expect(toolPermission("fixture_pick")).toBe("fixture_pick")
    expect(toolPermission("Bash")).toBe("bash")
  })

  test("a server-wide name widens deny and ask rules but never an allow", () => {
    expect(toolPermission("mcp__fixture", "deny")).toBe("fixture_*")
    expect(toolPermission("mcp__fixture__*", "ask")).toBe("fixture_*")
    expect(toolPermission("mcp__fixture__*", "allow")).toBe("mcp__fixture__*")
  })

  test("an added allow rule does not override an explicit deny", () => {
    const policy = updateSessionPolicy(
      { rules: [] },
      [
        {
          type: "addRules",
          behavior: "allow",
          destination: "session",
          rules: [{ toolName: "mcp__fixture__pick", ruleContent: "*" }],
        },
      ],
      "/tmp",
    )
    expect(policy.rules).toEqual([{ permission: "fixture_pick", pattern: "*", action: "allow" }])
    const explicitDeny = [{ permission: "fixture_pick", pattern: "*", action: "deny" as const }]
    expect(evaluate("fixture_pick", "*", policy.rules, explicitDeny).action).toBe("deny")
  })

  test("canonical tool names come from the real binding, not from the lossy key", () => {
    expect(McpCatalog.canonicalToolName({ server: "my server", tool: "do.it" })).toBe("mcp__my_server__do_it")
    const item = McpCatalog.bindTool({}, { server: "a_b", tool: "c", source: "unknown" })
    // `a_b_c` is ambiguous as a key; the binding still says server `a_b`, tool `c`.
    expect(McpCatalog.toolBinding(item)).toEqual({ server: "a_b", tool: "c", source: "unknown" })
    expect(McpCatalog.toolBinding({})).toBeUndefined()
  })
})

describe("question answered by a PreToolUse hook (the local defer round trip)", () => {
  const questions = [
    {
      question: "Which framework?",
      header: "Framework",
      options: [
        { label: "React", description: "Component library" },
        { label: "Vue", description: "Progressive framework" },
      ],
    },
    {
      question: "Which extras?",
      header: "Extras",
      multiple: true,
      options: [
        { label: "Router", description: "r" },
        { label: "Store", description: "s" },
      ],
    },
  ]
  const answerHook = (input: Record<string, unknown>, decision = "allow") => ({
    type: "command" as const,
    command: hookCommand(
      `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:${JSON.stringify(decision)},updatedInput:${JSON.stringify(input)}}}))`,
    ),
  })
  const run = (hooks: ReturnType<typeof answerHook>[], modelInput: Record<string, unknown> = { questions }) =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const asked: unknown[] = []
      const definition = yield* Effect.gen(function* () {
        const question = yield* QuestionTool
        return { id: question.id, ...(yield* question.init()) }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Question.Service, {
              ask: (input: unknown) =>
                Effect.sync(() => {
                  asked.push(input)
                  return [["USER_DIALOG"], ["USER_DIALOG"]]
                }),
            }),
            Layer.mock(Agent.Service, {
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
              get: () => Effect.succeed({ name: "build", mode: "primary", permission: [], options: {} } as never),
            }),
            Layer.mock(Truncate.Service, {
              output: (text: string) => Effect.succeed({ content: text, truncated: false }),
            }),
          ),
        ),
      )
      extraDefinitions = [definition]
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          extraDefinitions = []
        }),
      )
      if (hooks.length) yield* store.add(id, { event: "PreToolUse", matcher: "question", hooks })
      const tools = yield* resolve(id, instance.directory)
      const result = yield* Effect.tryPromise({
        try: () => Promise.resolve(tools.question.execute!(modelInput, options("answer"))),
        catch: (error) => error,
      }).pipe(Effect.exit)
      return { result, asked }
    })

  it.instance("allow + updatedInput.answers answers without opening a dialog", () =>
    Effect.gen(function* () {
      const { result, asked } = yield* run([
        answerHook({ questions, answers: { "Which framework?": "React", "Which extras?": "Router, Store" } }),
      ])
      expect(result._tag).toBe("Success")
      expect(asked).toHaveLength(0)
      const text = JSON.stringify(result)
      expect(text).toContain('\\"Which framework?\\"=\\"React\\"')
      expect(text).toContain("Router, Store")
    }),
  )

  it.instance("answers that do not match the questions are rejected and never reach the dialog", () =>
    Effect.gen(function* () {
      const { result, asked } = yield* run([answerHook({ questions, answers: { "Which framework?": "React" } })])
      expect(result._tag).toBe("Failure")
      expect(asked).toHaveLength(0)
    }),
  )

  it.instance("without allow the answers are ignored and the user is still asked", () =>
    Effect.gen(function* () {
      const { asked } = yield* run([answerHook({ questions, answers: { "Which framework?": "React" } }, "ask")])
      expect(asked).toHaveLength(1)
    }),
  )

  it.instance("a model-supplied answers field never skips the dialog", () =>
    Effect.gen(function* () {
      const { result, asked } = yield* run([], {
        questions,
        answers: { "Which framework?": "React", "Which extras?": "Router" },
      })
      expect(result._tag).toBe("Success")
      expect(asked).toHaveLength(1)
    }),
  )
})

describe("tool failure event boundaries", () => {
  for (const interrupted of [false, true]) {
    it.instance(`MCP resource rejection reports rewritten input (interrupted=${interrupted})`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const store = yield* SessionHooks.Service
        const id = SessionID.descending()
        const capture = path.join(instance.directory, "resource-failure-events.jsonl")
        const started = Promise.withResolvers<void>()
        const pending = Promise.withResolvers<never>()
        mcpClients = { fixture: { getServerCapabilities: () => ({ resources: {} }) } }
        resourceLoader = (server) =>
          Effect.promise(() => {
            expect(server).toBe("fixture")
            started.resolve()
            return pending.promise
          })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mcpClients = {}
            resourceLoader = () => Effect.succeed({})
          }),
        )
        yield* store.add(id, {
          event: "PreToolUse",
          hooks: [
            {
              type: "command",
              command: hookCommand(
                `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",updatedInput:{server:"fixture"}}}))`,
              ),
            },
          ],
        })
        for (const event of ["PostToolUse", "PostToolUseFailure"] as const) {
          yield* store.add(id, {
            event,
            hooks: [
              {
                type: "command",
                command: hookCommand(
                  `const {appendFile}=await import("node:fs/promises");await appendFile(${JSON.stringify(capture)},(await Bun.stdin.text())+"\\n")`,
                ),
              },
            ],
          })
        }
        const tools = yield* resolve(id, instance.directory)
        const controller = new AbortController()
        const result = Promise.resolve(
          tools.list_mcp_resources.execute!({}, { ...options("resource-reject"), abortSignal: controller.signal }),
        ).then(
          () => false,
          () => true,
        )
        yield* Effect.promise(() => started.promise)
        if (interrupted) controller.abort()
        pending.reject(new Error(interrupted ? "AbortError" : "RESOURCE_ERROR"))
        expect(yield* Effect.promise(() => result)).toBe(true)
        const rows = (yield* Effect.promise(() => fs.readFile(capture, "utf8")))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          hook_event_name: "PostToolUseFailure",
          tool_input: { server: "fixture" },
          tool_use_id: "resource-reject",
        })
        expect(rows[0].is_interrupt === true).toBe(interrupted)
      }),
    )
  }

  for (const [mode, slowHook] of [
    ["interrupt", false],
    ["interrupt", true],
    ["partial", false],
    ["reject", false],
  ] as const) {
    it.instance(`cancelled native execution (${mode}) delivers one failure and bounds slow hook=${slowHook}`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const store = yield* SessionHooks.Service
        const id = SessionID.descending()
        const capture = path.join(instance.directory, "interrupt-events.jsonl")
        const started = Promise.withResolvers<void>()
        extraDefinitions = [
          {
            id: "interruptible",
            description: "Interrupt fixture",
            parameters: Schema.Struct({}),
            execute: (_args: unknown, ctx: { abort: AbortSignal }) =>
              Effect.callback((resume) => {
                const abort = () =>
                  resume(
                    mode === "partial"
                      ? Effect.succeed({ title: "partial", output: "partial output", metadata: { interrupted: true } })
                      : mode === "reject"
                        ? Effect.die(new Error("AbortError"))
                        : Effect.interrupt,
                  )
                ctx.abort.addEventListener("abort", abort, { once: true })
                started.resolve()
                return Effect.sync(() => ctx.abort.removeEventListener("abort", abort))
              }),
          },
        ]
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            extraDefinitions = []
          }),
        )
        for (const event of ["PostToolUse", "PostToolUseFailure"] as const) {
          yield* store.add(id, {
            event,
            hooks: [
              {
                type: "command",
                command: hookCommand(
                  `const {appendFile}=await import("node:fs/promises");const input=await Bun.stdin.text();await appendFile(${JSON.stringify(capture)},input+"\\n");${slowHook ? "await Bun.sleep(10000)" : ""}`,
                ),
              },
            ],
          })
        }
        const tools = yield* resolve(id, instance.directory)
        const controller = new AbortController()
        const result = Promise.resolve(
          tools.interruptible.execute!({}, { ...options("interrupt-call"), abortSignal: controller.signal }),
        ).then(
          () => false,
          () => true,
        )
        yield* Effect.promise(() => started.promise)
        const before = Date.now()
        controller.abort()
        expect(yield* Effect.promise(() => result)).toBe(mode !== "partial")
        expect(Date.now() - before).toBeLessThan(2000)
        const rows = (yield* Effect.promise(() => fs.readFile(capture, "utf8")))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          hook_event_name: "PostToolUseFailure",
          is_interrupt: true,
          tool_use_id: "interrupt-call",
        })
      }),
    )
  }
})
