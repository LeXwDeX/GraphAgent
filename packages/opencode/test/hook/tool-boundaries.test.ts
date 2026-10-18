import { Client } from "@modelcontextprotocol/client"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { decodeRecord, decodeOptionalRecord } from "../lib/hook-json"
import { Question } from "@/question"
import { handleElicitation } from "@/mcp/elicitation"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema, Cause, Fiber, Exit } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
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
import { testEffect, pollWithTimeout } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { buildAgentTools } from "@/hook/agent-tools"
import { jsonSchema, tool } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { ReadTool } from "@/tool/read"
import { GrepTool } from "@/tool/grep"
import { GlobTool } from "@/tool/glob"
import { Agent } from "@/agent/agent"
import { Instruction } from "@/session/instruction"
import { LSP } from "@/lsp/lsp"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { claudeHookCommand, nativeHookCommand, hookCommand } from "../fixture/claude-hook"

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
const jsonCommand = (json: unknown) => "printf '%s' " + quote(JSON.stringify(json))
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
      await fs.writeFile(args.filePath, args.content)
      return { title: "written", output: "WRITE_COMPLETE", metadata: {} }
    }),
}
const layers = Layer.mergeAll(
  hookLayer,
  Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
  Layer.mock(Permission.Service, {
    ask: () => Effect.void,
    hookPolicy: () => Effect.succeed({ rules: [], directories: [] }),
  }),
  Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
  Layer.mock(Truncate.Service, { output: (text: string) => Effect.succeed({ content: text, truncated: false }) }),
  Layer.mock(ToolRegistry.Service, {
    tools: () => Effect.succeed([writeDefinition]),
    registrations: () =>
      Effect.succeed([{ definition: writeDefinition, sourceKind: "host-builtin", registrationID: "test:write" }]),
  }),
)
const it = testEffect(layers)
const resolve = (id: any, dir: string) =>
  SessionTools.resolve({
    agent: { name: "build", permission: [], options: {} } as any,
    model: ProviderTest.model(),
    session: { id, directory: dir, permission: [] } as any,
    processor: {
      message: { id: MessageID.ascending(), sessionID: id },
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    } as any,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as any,
  })
const execute = (tools: any, filePath: string) =>
  Effect.promise(() =>
    tools.write.execute(
      { filePath, content: "audit-safe-fixture" },
      { toolCallId: "audit-write", messages: [], abortSignal: new AbortController().signal },
    ),
  )

const rejectingModel = (reason: string) =>
  new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: "text", text: JSON.stringify({ ok: false, reason }) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  })

const evaluatorServices = (model: MockLanguageModelV3) =>
  Layer.mergeAll(
    Layer.mock(Provider.Service, {
      defaultModel: () => Effect.succeed({ providerID: ProviderV2.ID.make("audit"), modelID: ModelV2.ID.make("test") }),
      getModel: () => Effect.succeed(ProviderTest.model()),
      getLanguage: () => Effect.succeed(model),
    }),
    Layer.mock(Auth.Service, { get: () => Effect.succeed({ type: "api" as const, key: "test-only" }) }),
  )

describe("real SessionTools call path", () => {
  for (const continueOnBlock of [false, true]) {
    it.instance(
      `prompt evaluator ${continueOnBlock ? "denies only the tool" : "stops the turn"} before the writer runs`,
      () =>
        Effect.gen(function* () {
          const instance = yield* TestInstance
          const store = yield* SessionHooks.Service
          const id = SessionID.descending()
          const target = path.join(instance.directory, `evaluator-${continueOnBlock}.txt`)
          yield* store.add(id, {
            event: "PreToolUse",
            hooks: [{ type: "prompt", prompt: "Check the write", continueOnBlock }],
          })
          const model = rejectingModel("model rejected write")
          const output = yield* Effect.gen(function* () {
            const tools = yield* resolve(id, instance.directory)
            return yield* execute(tools, target)
          }).pipe(Effect.provide(evaluatorServices(model)))
          expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
          expect(JSON.stringify(output)).toContain("model rejected write")
          expect(decodeOptionalRecord(decodeRecord(output).metadata)?.hookStopped).toBe(
            continueOnBlock ? undefined : true,
          )
          expect(model.doGenerateCalls).toHaveLength(1)
        }),
    )
  }

  it.instance("prompt PostToolUse continuation keeps the completed write and returns feedback", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const target = path.join(instance.directory, "post-evaluator.txt")
      yield* store.add(id, {
        event: "PostToolUse",
        hooks: [{ type: "prompt", prompt: "Check the output", continueOnBlock: true }],
      })
      const model = rejectingModel("revise the write")
      const output = yield* Effect.gen(function* () {
        const tools = yield* resolve(id, instance.directory)
        return yield* execute(tools, target)
      }).pipe(Effect.provide(evaluatorServices(model)))
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("audit-safe-fixture")
      expect(JSON.stringify(output)).toContain("revise the write")
      expect(decodeOptionalRecord(decodeRecord(output).metadata)?.hookStopped).toBeUndefined()
    }),
  )

  it.instance("prompt PostToolUse default stops after the completed write", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const target = path.join(instance.directory, "post-stop-evaluator.txt")
      yield* store.add(id, {
        event: "PostToolUse",
        hooks: [{ type: "prompt", prompt: "Check the output" }],
      })
      const output = yield* Effect.gen(function* () {
        const tools = yield* resolve(id, instance.directory)
        return yield* execute(tools, target)
      }).pipe(Effect.provide(evaluatorServices(rejectingModel("halt after write"))))
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("audit-safe-fixture")
      expect(JSON.stringify(output)).toContain("halt after write")
      expect(decodeOptionalRecord(decodeRecord(output).metadata)?.hookStopped).toBe(true)
    }),
  )

  it.instance("unwatched tool writes do not invent FileChanged events", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const capture = path.join(instance.directory, "filechanged.json")
      const target = path.join(instance.directory, "changed.txt")
      yield* store.add(id, { event: "FileChanged", hooks: [{ type: "command", command: "cat > " + quote(capture) }] })
      const tools = yield* resolve(id, instance.directory)
      yield* execute(tools, target)
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("audit-safe-fixture")
      expect(
        yield* Effect.promise(() =>
          fs.access(capture).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  )

  it.instance("PostToolUse block reason must be visible to the model", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      yield* store.add(id, {
        event: "PostToolUse",
        hooks: [{ type: "command", command: jsonCommand({ decision: "block", reason: "AUDIT_POST_REJECT" }) }],
      })
      const tools = yield* resolve(id, instance.directory)
      const result = yield* execute(tools, path.join(instance.directory, "changed.txt"))
      expect(JSON.stringify(result)).toContain("AUDIT_POST_REJECT")
    }),
  )

  it.instance("malformed hook output must not fail the tool execution", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      yield* store.add(id, {
        event: "PreToolUse",
        hooks: [{ type: "command", command: jsonCommand({ hookSpecificOutput: "broken" }) }],
      })
      const tools = yield* resolve(id, instance.directory)
      const result = yield* execute(tools, path.join(instance.directory, "changed.txt")).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
    }),
  )

  it.instance("rejected MCP calls run failure hooks and keep feedback", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const mcp = yield* MCP.Service
      const id = SessionID.descending()
      yield* store.add(id, {
        event: "PostToolUseFailure",
        hooks: [{ type: "command", command: jsonCommand({ decision: "block", reason: "MCP_FAILURE_FEEDBACK" }) }],
      })
      const tools = yield* resolve(id, instance.directory).pipe(
        Effect.provideService(MCP.Service, {
          ...mcp,
          tools: () =>
            Effect.succeed({
              audit_failure: tool({
                inputSchema: jsonSchema({ type: "object", properties: {} }),
                execute: async (): Promise<{ content: { type: "text"; text: string }[] }> => {
                  throw new Error("MCP transport rejected")
                },
              }),
            }),
        }),
      )
      const result = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            tools.audit_failure.execute!(
              {},
              {
                toolCallId: "audit-failure",
                messages: [],
                abortSignal: new AbortController().signal,
              },
            ),
          ),
        catch: (error) => error,
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") return
      const failure = String(Cause.squash(result.cause))
      expect(failure).toContain("MCP transport rejected")
      expect(failure).toContain("MCP_FAILURE_FEEDBACK")
    }),
  )
})

// Mirrors the shell result contract: a nonzero exit is a normal completion
// plus `hookFailure`, not a thrown error. The dispatcher must route it to the
// reference's failure event while leaving the model-facing output untouched.
const shellFailureDefinition = {
  id: "bash",
  description: "Fixture shell result that reports a hook-facing failure",
  parameters: Schema.Struct({ command: Schema.String }),
  execute: (_args: { command: string }) =>
    Effect.succeed({
      title: "exit 7",
      output: "FAILED_SHELL_OUTPUT",
      metadata: { exit: 7 },
      hookFailure: "Exit code 7\n\nFAILED_SHELL_OUTPUT",
    }),
}
const shellFailureLayers = Layer.mergeAll(
  hookLayer,
  Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
  Layer.mock(Permission.Service, {
    ask: () => Effect.void,
    hookPolicy: () => Effect.succeed({ rules: [], directories: [] }),
  }),
  Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
  Layer.mock(Truncate.Service, { output: (text: string) => Effect.succeed({ content: text, truncated: false }) }),
  Layer.mock(ToolRegistry.Service, {
    tools: () => Effect.succeed([shellFailureDefinition]),
    registrations: () =>
      Effect.succeed([{ definition: shellFailureDefinition, sourceKind: "host-builtin", registrationID: "test:bash" }]),
  }),
)
const shellFailureIt = testEffect(shellFailureLayers)
const executeShell = (tools: any) =>
  Effect.promise(() =>
    Promise.resolve(
      tools.bash.execute(
        { command: "false" },
        { toolCallId: "audit-shell-failure", messages: [], abortSignal: new AbortController().signal },
      ),
    ),
  )

describe("nonzero shell exits reach failure hooks", () => {
  shellFailureIt.instance("a completed nonzero exit fires PostToolUseFailure and keeps the model output", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const failure = path.join(instance.directory, "failure.json")
      const success = path.join(instance.directory, "success.json")
      yield* store.add(id, {
        event: "PostToolUseFailure",
        hooks: [{ type: "command", command: "cat > " + quote(failure) }],
      })
      yield* store.add(id, {
        event: "PostToolUse",
        hooks: [{ type: "command", command: "cat > " + quote(success) }],
      })
      const tools = yield* resolve(id, instance.directory)
      const result = yield* executeShell(tools)
      expect(result.output).toBe("FAILED_SHELL_OUTPUT")
      const envelope = JSON.parse(yield* Effect.promise(() => fs.readFile(failure, "utf8")))
      expect(envelope.hook_event_name).toBe("PostToolUseFailure")
      expect(envelope.tool_name).toBe("bash")
      expect(envelope.error).toBe("Exit code 7\n\nFAILED_SHELL_OUTPUT")
      expect(
        yield* Effect.promise(() =>
          fs.access(success).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  )
})

const agent = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, FSUtil.defaultLayer))
describe("agent tool runtime boundary", () => {
  agent.instance("read-only agent bash must not create a file using a newline", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const spawner = yield* ChildProcessSpawner
      const filesystem = yield* FSUtil.Service
      const tools = buildAgentTools({
        spawner,
        fs: filesystem,
        cwd: instance.directory,
        signal: new AbortController().signal,
        captured: { value: null },
      })
      const marker = path.join(instance.directory, "unauthorized-marker")
      const result = yield* Effect.promise(() =>
        Promise.resolve(
          tools.bash.execute!({ command: "echo harmless\ntouch " + quote(marker) }, {
            toolCallId: "audit",
            messages: [],
          } as any),
        ),
      )
      const exists = yield* Effect.promise(() =>
        fs.access(marker).then(
          () => true,
          () => false,
        ),
      )
      expect(JSON.stringify(result)).toContain("Error:")
      expect(exists).toBe(false)
    }),
  )

  agent.instance("agent bash must stop after its abort signal", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const spawner = yield* ChildProcessSpawner
      const filesystem = yield* FSUtil.Service
      const ac = new AbortController()
      const input = path.join(instance.directory, "follow.txt")
      yield* Effect.promise(() => fs.writeFile(input, "ready\n"))
      let pid: number | undefined
      let ready!: () => void
      const started = new Promise<void>((resolve) => {
        ready = resolve
      })
      const observed = {
        ...spawner,
        spawn: (...args: Parameters<typeof spawner.spawn>) =>
          spawner.spawn(...args).pipe(
            Effect.tap((handle) =>
              Effect.sync(() => {
                pid = Number(handle.pid)
                ready()
              }),
            ),
          ),
      }
      const tools = buildAgentTools({
        spawner: observed,
        fs: filesystem,
        cwd: instance.directory,
        signal: ac.signal,
        captured: { value: null },
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => ac.abort()))
      const task = Promise.resolve(
        tools.bash.execute!(
          { command: "tail -f " + quote(input) },
          { toolCallId: "cancel", messages: [], abortSignal: ac.signal },
        ),
      )
      yield* Effect.promise(() => started).pipe(Effect.timeout(2000))
      ac.abort()
      const result = yield* Effect.promise(() => task).pipe(Effect.timeout(3000))
      expect(JSON.stringify(result)).toContain("Error:")
      expect(pid).toBeDefined()
      expect(() => process.kill(pid!, 0)).toThrow()
    }),
  )
})

const discoveryDefinitions = Effect.gen(function* () {
  const read = yield* ReadTool
  const grep = yield* GrepTool
  const glob = yield* GlobTool
  return [
    { id: read.id, ...(yield* read.init()) },
    { id: grep.id, ...(yield* grep.init()) },
    { id: glob.id, ...(yield* glob.init()) },
  ]
})
const discoveryToolLayer = Layer.mergeAll(
  FSUtil.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Ripgrep.defaultLayer,
  Layer.mock(Agent.Service, {}),
  Layer.mock(Instruction.Service, { resolve: () => Effect.succeed([]) }),
  Layer.mock(LSP.Service, { touchFile: () => Effect.void }),
  Layer.mock(Truncate.Service, { output: (text: string) => Effect.succeed({ content: text, truncated: false }) }),
)
const discovery = testEffect(
  Layer.mergeAll(
    hookLayer,
    Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
    Layer.mock(Permission.Service, {
      ask: () => Effect.void,
      hookPolicy: () => Effect.succeed({ rules: [], directories: [] }),
    }),
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
    Layer.unwrap(
      Effect.gen(function* () {
        const definitions = yield* discoveryDefinitions
        return Layer.mock(ToolRegistry.Service, {
          tools: () => Effect.succeed(definitions),
          registrations: () =>
            Effect.succeed(
              definitions.map((definition) => ({
                definition,
                sourceKind: "host-builtin" as const,
                registrationID: `test:${definition.id}`,
              })),
            ),
        })
      }),
    ).pipe(Layer.provideMerge(discoveryToolLayer)),
  ),
)

describe("Claude command consumer with real discovery tools", () => {
  for (const name of ["read", "grep", "glob"] as const) {
    discovery.instance(`${name}: match -> stdin -> consumer JSON -> model-facing context`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const store = yield* SessionHooks.Service
        const id = SessionID.descending()
        const target = path.join(instance.directory, "target.txt")
        yield* Effect.promise(() => fs.writeFile(target, "HOOK_SEARCH_NEEDLE\n"))
        const event = name === "read" ? "PostToolUse" : "PreToolUse"
        yield* store.add(id, {
          event,
          matcher: name === "read" ? "Read" : "Grep|Glob",
          hooks: [
            { type: "command", command: claudeHookCommand, inputFormat: "claude-code" },
            { type: "command", command: nativeHookCommand },
          ],
        })
        const tools = yield* resolve(id, instance.directory)
        const args =
          name === "read"
            ? { filePath: target }
            : name === "grep"
              ? { pattern: "HOOK_SEARCH_NEEDLE", path: instance.directory, include: "target.txt" }
              : { pattern: "target.txt", path: instance.directory }
        const executeTool = tools[name].execute
        if (!executeTool) throw new Error("missing discovery tool executor")
        const result = yield* Effect.promise(() =>
          Promise.resolve(
            executeTool(args, {
              toolCallId: `compat-${name}`,
              messages: [],
              abortSignal: new AbortController().signal,
            }),
          ),
        )
        const output = result.output
        expect(output).toContain("CLAUDE_CONTEXT:")
        expect(output).toContain("NATIVE_CONTEXT:")
        const claude = JSON.parse(output.split("CLAUDE_CONTEXT:")[1].split("\n")[0])
        const native = JSON.parse(output.split("NATIVE_CONTEXT:")[1].split("\n")[0])
        expect(claude.tool_name).toBe(name[0].toUpperCase() + name.slice(1))
        expect(native.tool_name).toBe(name)
        expect(native.tool_input).toEqual(args)
        expect(claude.hook_event_name).toBe(event)
        expect(claude.tool_use_id).toBe(`compat-${name}`)
        if (name === "read") {
          expect(claude.tool_input.file_path).toBe(target)
          // PostToolUse carries the tool's structured metadata, not its text output.
          expect(claude.tool_response.preview).toContain("HOOK_SEARCH_NEEDLE")
        } else expect(output).toContain(target)
      }),
    )
  }

  discovery.instance("Claude updatedInput is applied to a real read, not silently discarded", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      const target = path.join(instance.directory, "rewritten.txt")
      yield* Effect.promise(() => fs.writeFile(target, "REWRITTEN_READ\n"))
      yield* store.add(id, {
        event: "PreToolUse",
        matcher: "Read",
        hooks: [
          {
            type: "command",
            inputFormat: "claude-code",
            command: hookCommand(
              `console.log(JSON.stringify(${JSON.stringify({
                hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { file_path: target } },
              })}))`,
            ),
          },
        ],
      })
      const tools = yield* resolve(id, instance.directory)
      const executeRead = tools.read.execute
      if (!executeRead) throw new Error("missing read executor")
      const result = yield* Effect.promise(() =>
        Promise.resolve(
          executeRead(
            { filePath: path.join(instance.directory, "missing.txt") },
            {
              toolCallId: "rewrite-read",
              messages: [],
              abortSignal: new AbortController().signal,
            },
          ),
        ),
      )
      expect(result.output).toContain("REWRITTEN_READ")
    }),
  )

  for (const program of ["console.log('{broken')", "console.log(''); process.exit(1)"]) {
    discovery.instance(`adapter preserves fail-open output handling: ${program}`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const store = yield* SessionHooks.Service
        const id = SessionID.descending()
        const target = path.join(instance.directory, "target.txt")
        yield* Effect.promise(() => fs.writeFile(target, "SUCCESS_WITH_FAILED_HOOK\n"))
        yield* store.add(id, {
          event: "PostToolUse",
          matcher: "Read",
          hooks: [{ type: "command", inputFormat: "claude-code", command: hookCommand(program) }],
        })
        const tools = yield* resolve(id, instance.directory)
        const executeRead = tools.read.execute
        if (!executeRead) throw new Error("missing read executor")
        const result = yield* Effect.promise(() =>
          Promise.resolve(
            executeRead(
              { filePath: target },
              {
                toolCallId: "failed-hook",
                messages: [],
                abortSignal: new AbortController().signal,
              },
            ),
          ),
        )
        expect(result.output).toContain("SUCCESS_WITH_FAILED_HOOK")
        expect(result.output).not.toContain("CLAUDE_CONTEXT")
      }),
    )
  }
})

const permission = testEffect(
  Permission.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provideMerge(hookLayer)),
)
describe("permission hook call path", () => {
  permission.instance("PermissionRequest nested deny resolves without user input", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const permissions = yield* Permission.Service
      const id = SessionID.descending()
      yield* store.add(id, {
        event: "PermissionRequest",
        hooks: [
          {
            type: "command",
            command: jsonCommand({
              hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: { behavior: "deny", message: "denied" },
              },
            }),
          },
        ],
      })
      const exit = yield* permissions
        .ask({ sessionID: id, permission: "bash", patterns: ["echo test"], always: [], metadata: {}, ruleset: [] })
        .pipe(Effect.timeout(1000), Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(exit._tag === "Failure" ? Cause.pretty(exit.cause) : "").not.toContain("Timeout")
      expect(yield* permissions.list()).toHaveLength(0)
    }),
  )
  permission.instance("PermissionRequest exit2 leaves the normal user permission flow unchanged", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const permissions = yield* Permission.Service
      const id = SessionID.descending()
      yield* store.add(id, {
        event: "PermissionRequest",
        hooks: [{ type: "command", command: "printf '%s' 'DISCARDED_STDERR' >&2; exit 2" }],
      })
      const pending = yield* permissions
        .ask({ sessionID: id, permission: "bash", patterns: ["echo test"], always: [], metadata: {}, ruleset: [] })
        .pipe(Effect.forkScoped)
      const requests = yield* pollWithTimeout(
        permissions.list().pipe(Effect.map((items) => (items.length ? items : undefined))),
        "permission dialog was not published",
      )
      expect(requests).toHaveLength(1)
      yield* permissions.reply({ requestID: requests[0].id, reply: "once" })
      expect(Exit.isSuccess(yield* Fiber.await(pending))).toBe(true)
    }),
  )
})

describe("hook consumer complete input and output replacement", () => {
  it.instance("real command hook removes omitted MCP input keys before execution", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const mcp = yield* MCP.Service
      const id = SessionID.descending()
      let executed: unknown
      yield* store.add(id, {
        event: "PreToolUse",
        hooks: [
          {
            type: "command",
            command: jsonCommand({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                updatedInput: { value: "new" },
              },
            }),
          },
        ],
      })
      const tools = yield* resolve(id, instance.directory).pipe(
        Effect.provideService(MCP.Service, {
          ...mcp,
          tools: () =>
            Effect.succeed({
              audit_replace: tool({
                inputSchema: jsonSchema({
                  type: "object",
                  properties: { value: { type: "string" }, obsolete: { type: "string" } },
                  required: ["value"],
                }),
                execute: async (args) => {
                  executed = args
                  return { content: [{ type: "text", text: "ok" }] }
                },
              }),
            }),
        }),
      )
      yield* Effect.promise(() =>
        Promise.resolve(
          tools.audit_replace.execute!(
            { value: "old", obsolete: "remove" },
            {
              toolCallId: "replace",
              messages: [],
              abortSignal: new AbortController().signal,
            },
          ),
        ),
      )
      expect(executed).toEqual({ value: "new" })
    }),
  )

  it.instance("real command hook replaces MCP output content and attachments", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const store = yield* SessionHooks.Service
      const mcp = yield* MCP.Service
      const id = SessionID.descending()
      yield* store.add(id, {
        event: "PostToolUse",
        hooks: [
          {
            type: "command",
            command: jsonCommand({
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                updatedToolOutput: { content: [{ type: "text", text: "REDACTED" }] },
              },
            }),
          },
        ],
      })
      const tools = yield* resolve(id, instance.directory).pipe(
        Effect.provideService(MCP.Service, {
          ...mcp,
          tools: () =>
            Effect.succeed({
              audit_replace: tool({
                inputSchema: jsonSchema({ type: "object", properties: {} }),
                execute: async () => ({
                  content: [
                    { type: "text", text: "ORIGINAL" },
                    { type: "image", data: "eA==", mimeType: "image/png" },
                  ],
                }),
              }),
            }),
        }),
        Effect.provide(
          Layer.mock(Truncate.Service, {
            output: (text: string) => Effect.succeed({ content: text, truncated: false }),
          }),
        ),
      )
      const result = yield* Effect.promise(() =>
        Promise.resolve(
          tools.audit_replace.execute!(
            {},
            {
              toolCallId: "replace",
              messages: [],
              abortSignal: new AbortController().signal,
            },
          ),
        ),
      )
      expect(JSON.stringify(result)).toContain("REDACTED")
      expect(JSON.stringify(result)).not.toContain("ORIGINAL")
      expect(decodeRecord(result).attachments).toEqual([])
    }),
  )
})

describe("elicitation command output consumer", () => {
  it.instance("command hook can answer before any Question UI is available", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      yield* store.add(id, {
        event: "Elicitation",
        hooks: [
          {
            type: "command",
            command: jsonCommand({
              hookSpecificOutput: { hookEventName: "Elicitation", action: "accept", content: { username: "fixture" } },
            }),
          },
        ],
      })
      const result = yield* handleElicitation({
        sessionID: id,
        message: "name",
        requestedSchema: {
          type: "object",
          properties: { username: { type: "string" } },
          required: ["username"],
        },
      })
      expect(result).toEqual({ action: "accept", content: { username: "fixture" } })
    }),
  )
})

describe("ElicitationResult real command output replacement", () => {
  for (const [action, expected] of [
    ["accept", { action: "accept", content: { username: "replacement" } }],
    ["decline", { action: "decline" }],
    ["cancel", { action: "cancel", content: { username: "submitted", unchanged: "original" } }],
  ] as const) {
    it.instance(`${action} is consumed before returning to MCP`, () =>
      Effect.gen(function* () {
        const store = yield* SessionHooks.Service
        const id = SessionID.descending()
        yield* store.add(id, {
          event: "ElicitationResult",
          hooks: [
            {
              type: "command",
              command: jsonCommand({
                hookSpecificOutput: {
                  hookEventName: "ElicitationResult",
                  action,
                  content: { username: "replacement" },
                },
              }),
            },
          ],
        })
        const response = yield* handleElicitation({
          sessionID: id,
          message: "form",
          requestedSchema: {
            type: "object",
            properties: { username: { type: "string" }, unchanged: { type: "string" } },
          },
        }).pipe(
          Effect.provide(Layer.mock(Question.Service, { ask: () => Effect.succeed([["submitted"], ["original"]]) })),
        )
        expect(response).toEqual(expected)
      }),
    )
  }
})

describe("resource tools consume real command hooks", () => {
  for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
    for (const denied of [true, false]) {
      it.instance(`${name} ${denied ? "prevents the remote read" : "replaces the result"}`, () =>
        Effect.gen(function* () {
          const instance = yield* TestInstance
          const hooks = yield* SessionHooks.Service
          const mcp = yield* MCP.Service
          const id = SessionID.descending()
          let calls = 0
          yield* hooks.add(id, {
            event: denied ? "PreToolUse" : "PostToolUse",
            hooks: [
              {
                type: "command",
                command: jsonCommand({
                  hookSpecificOutput: denied
                    ? { hookEventName: "PreToolUse", permissionDecision: "deny" }
                    : {
                        hookEventName: "PostToolUse",
                        updatedToolOutput: { title: "redacted", output: "REPLACED_RESOURCE", metadata: {} },
                      },
                }),
              },
            ],
          })
          const tools = yield* resolve(id, instance.directory).pipe(
            Effect.provideService(MCP.Service, {
              ...mcp,
              clients: () =>
                Effect.succeed({
                  fixture: Object.assign(new Client({ name: "resource-fixture", version: "0" }), {
                    getServerCapabilities: () => ({ resources: {} }),
                  }),
                }),
              resources: () =>
                Effect.sync(() => {
                  calls++
                  return { fixture: { client: "fixture", name: "original", uri: "fixture://original" } }
                }),
              resourceTemplates: () =>
                Effect.sync(() => {
                  calls++
                  return { fixture: { client: "fixture", name: "original", uriTemplate: "fixture://{name}" } }
                }),
              readResource: () =>
                Effect.sync(() => {
                  calls++
                  return { contents: [{ uri: "fixture://original", text: "ORIGINAL_RESOURCE" }] }
                }),
            }),
          )
          const result = yield* Effect.promise(() =>
            Promise.resolve(
              tools[name].execute!(
                { server: "fixture", uri: "fixture://original" },
                {
                  toolCallId: `resource-${name}`,
                  messages: [],
                  abortSignal: new AbortController().signal,
                },
              ),
            ),
          )
          expect(calls).toBe(denied ? 0 : 1)
          expect(JSON.stringify(result)).toContain(denied ? "Tool denied by hook" : "REPLACED_RESOURCE")
          expect(JSON.stringify(result)).not.toContain("ORIGINAL_RESOURCE")
        }),
      )
    }
  }
})

it.instance("continue:false beats ignored defer on the actual V1 tool path", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const id = SessionID.descending()
    yield* (yield* SessionHooks.Service).add(id, {
      event: "PreToolUse",
      hooks: [
        {
          type: "command",
          command: jsonCommand({
            continue: false,
            stopReason: "V1_STOP_OVER_DEFER",
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" },
          }),
        },
      ],
    })
    const target = path.join(instance.directory, "must-not-execute.txt")
    const result = yield* execute(yield* resolve(id, instance.directory), target)
    expect(JSON.stringify(result)).toContain("V1_STOP_OVER_DEFER")
    expect(JSON.stringify(result)).not.toContain("hookDeferred")
    expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
  }),
)
