import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { jsonSchema, tool } from "ai"
import { SessionTools } from "@/session/tools"
import { SessionHooks } from "@/hook/session-hooks"
import { SettingsHook } from "@/hook/settings"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { ToolRegistry } from "@/tool/registry"
import { Plugin } from "@/plugin"
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
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

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
      return { title: "written", output: "WRITE_COMPLETE", metadata: {} }
    }),
}
let extraDefinitions: any[] = []
let mcpTools: Record<string, any> = {}
let mcpClients: Record<string, unknown> = {}
let askResult: Effect.Effect<void, PermissionV1.RejectedError> = Effect.void
const layers = Layer.mergeAll(
  hookLayer,
  Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
  Layer.mock(Permission.Service, {
    ask: () => askResult,
    hookPolicy: () => Effect.succeed({ rules: [], directories: [] }),
  }),
  Layer.mock(MCP.Service, {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    clients: () => Effect.succeed(mcpClients as never),
    tools: () => Effect.succeed(mcpTools),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
  }),
  Layer.mock(Truncate.Service, { output: (text: string) => Effect.succeed({ content: text, truncated: false }) }),
  Layer.mock(ToolRegistry.Service, {
    tools: () => Effect.succeed([writeDefinition, ...extraDefinitions]),
    registrations: () =>
      Effect.succeed(
        [writeDefinition, ...extraDefinitions].map((definition) => ({
          definition,
          sourceKind: "host-builtin" as const,
          registrationID: `test:${definition.id}`,
        })),
      ),
  }),
)
const it = testEffect(layers)
const resolve = (id: any, dir: string) =>
  SessionTools.resolve({
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

describe("PreToolUse defer that the host cannot honor", () => {
  it.instance("native tool: an unusable defer must not erase a sibling exit-2 rejection", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const target = path.join(instance.directory, "defer-native.txt")
      yield* store.add(id, { event: "PreToolUse", hooks: [deferHook, exit2Hook] })
      const tools = yield* resolve(id, instance.directory)
      const result = yield* Effect.promise(() =>
        Promise.resolve(tools.write.execute!({ filePath: target, content: "x" }, options("defer-native"))),
      )
      expect(JSON.stringify(result)).toContain("CROSS_AUDIT_EXIT2")
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
    }),
  )

  it.instance("native tool: an unusable defer alone is ignored and the tool runs", () =>
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

  it.instance("MCP tool: an unusable defer must not erase a sibling exit-2 rejection", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
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
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          mcpTools = {}
        }),
      )
      yield* store.add(id, { event: "PreToolUse", hooks: [deferHook, exit2Hook] })
      const tools = yield* resolve(id, instance.directory)
      const result = yield* Effect.promise(() =>
        Promise.resolve(tools.fixture_probe.execute!({}, options("defer-mcp"))),
      )
      expect(JSON.stringify(result)).toContain("CROSS_AUDIT_EXIT2")
      expect(ran).toBe(false)
    }),
  )

  it.instance("MCP resource tool: an unusable defer must not erase a sibling exit-2 rejection", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
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
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          mcpClients = {}
        }),
      )
      yield* store.add(id, { event: "PreToolUse", hooks: [deferHook, exit2Hook] })
      const tools = yield* resolve(id, instance.directory)
      const result = yield* Effect.promise(() =>
        Promise.resolve(tools.list_mcp_resources.execute!({}, options("defer-resource"))),
      )
      expect(JSON.stringify(result)).toContain("CROSS_AUDIT_EXIT2")
      expect(listed).toBe(false)
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
      expect(JSON.stringify(seen.tool_response)).toContain("WRITE_COMPLETE")
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
