import { decodeRecord } from "../lib/hook-json"
import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Schema } from "effect"
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
import type { Tool } from "@/tool/tool"
import { TestInstance } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { jsonSchema, tool } from "ai"

// A PreToolUse `permissionDecision:"ask"` must always surface a dialog, even when
// the agent's ruleset is a wildcard deny with pattern-scoped allows (plan agent
// style). The tool's own permission request — with the real pattern — still
// enforces deny rules after the user approves the hook ask.

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
const hookLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)

let directory = ""
const editDefinition = {
  id: "edit",
  description: "Fixture edit tool that requests the real path pattern",
  parameters: Schema.Struct({ filePath: Schema.String }),
  execute: (args: { filePath: string }, ctx: Tool.Context) =>
    ctx
      .ask({ permission: "edit", patterns: [path.relative(directory, args.filePath)], always: ["*"], metadata: {} })
      .pipe(Effect.as({ title: "edited", output: "EDIT_COMPLETE", metadata: {} })),
}
const bashDefinition = {
  id: "bash",
  description: "Fixture bash tool that requests the real command pattern",
  parameters: Schema.Struct({ command: Schema.String }),
  execute: (args: { command: string }, ctx: Tool.Context) =>
    ctx
      .metadata({ title: "running", metadata: {} })
      .pipe(
        Effect.andThen(ctx.ask({ permission: "bash", patterns: [args.command], always: ["*"], metadata: {} })),
        Effect.as({ title: "ran", output: `BASH_COMPLETE ${args.command}`, metadata: {} }),
      ),
}
// Tool-part inputs recorded through ctx.metadata, in call order.
const recordedInputs: unknown[] = []
const it = testEffect(
  Layer.mergeAll(
    Permission.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provideMerge(hookLayer)),
    Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
    Layer.mock(Truncate.Service, {}),
    Layer.mock(ToolRegistry.Service, {
      tools: () => Effect.succeed([editDefinition, bashDefinition]),
      registrations: () =>
        Effect.succeed([
          { definition: editDefinition, sourceKind: "host-builtin", registrationID: "test:edit" },
          { definition: bashDefinition, sourceKind: "host-builtin", registrationID: "test:bash" },
        ]),
    }),
  ),
)

const PLAN_RULES = [
  { permission: "edit", pattern: "*", action: "deny" as const },
  { permission: "edit", pattern: ".opencode/plans/*.md", action: "allow" as const },
  { permission: "bash", pattern: "*", action: "deny" as const },
  { permission: "bash", pattern: "git *", action: "allow" as const },
]

type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }

const setupWith = (hookOutput: Record<string, unknown>, agentName: string, rules: Rule[]) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    directory = instance.directory
    const store = yield* SessionHooks.Service
    const id = SessionID.descending()
    yield* store.add(id, {
      event: "PreToolUse",
      hooks: [{ type: "command", command: "printf '%s' " + quote(JSON.stringify(hookOutput)) }],
    })
    const tools = yield* SessionTools.resolve({
      agent: { name: agentName, permission: rules, options: {} } as any,
      model: ProviderTest.model(),
      session: { id, directory, permission: [] } as any,
      processor: {
        message: { id: MessageID.ascending(), sessionID: id },
        updateToolCall: (
          _callID: string,
          update: (match: { state: { status: string } }) => { state: { input?: unknown } },
        ) =>
          Effect.sync(() => {
            recordedInputs.push(update({ state: { status: "running" } }).state.input)
          }),
        completeToolCall: () => Effect.void,
      } as any,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as any,
    })
    return { tools: tools as Record<string, any>, directory, id }
  })

const setup = setupWith(
  {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "confirm" },
  },
  "plan",
  PLAN_RULES,
)

// Runs the tool, approves the hook's confirmation dialog once, returns the tool exit.
const runApprovingHookAsk = (tools: Record<string, any>, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* Effect.tryPromise(() =>
      tools[name].execute(args, {
        toolCallId: `call-${name}`,
        messages: [],
        abortSignal: new AbortController().signal,
      }),
    ).pipe(Effect.forkScoped)
    const pending = yield* pollWithTimeout(
      permission.list().pipe(Effect.map((list) => (list.length > 0 ? list : undefined))),
      "hook ask did not surface a permission dialog",
    )
    expect(pending).toHaveLength(1)
    expect(pending[0].metadata).toMatchObject({ hookAsk: true })
    yield* permission.reply({ requestID: pending[0].id, reply: "once" })
    return yield* Fiber.await(fiber)
  })

describe("hook permissionDecision ask with pattern-scoped rulesets", () => {
  it.instance("Edit ask prompts despite a wildcard deny; the allowed plan path then runs", () =>
    Effect.gen(function* () {
      const { tools, directory } = yield* setup
      const exit = yield* runApprovingHookAsk(tools, "edit", {
        filePath: path.join(directory, ".opencode", "plans", "a.md"),
      })
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(JSON.stringify(exit.value)).toContain("EDIT_COMPLETE")
    }),
  )

  it.instance("Edit ask approval does not bypass a deny on the real path", () =>
    Effect.gen(function* () {
      const { tools, directory } = yield* setup
      const exit = yield* runApprovingHookAsk(tools, "edit", { filePath: path.join(directory, "src", "a.ts") })
      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* Permission.Service.use((p) => p.list())).length).toBe(0)
    }),
  )

  it.instance("Bash ask prompts despite a wildcard deny; allowed and denied commands", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup
      const allowed = yield* runApprovingHookAsk(tools, "bash", { command: "git status" })
      expect(Exit.isSuccess(allowed)).toBe(true)
      const denied = yield* runApprovingHookAsk(tools, "bash", { command: "curl example.com" })
      expect(Exit.isFailure(denied)).toBe(true)
    }),
  )
})

// The user confirms exactly what will run: a hook-rewritten input is shown in the forced dialog, and that
// confirmation settles the tool's own ask-level check for the same call. Deny rules still apply.
const setupRewrite = (rules: Rule[]) =>
  setupWith(
    {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "rewritten command",
        updatedInput: { command: "git log --oneline" },
      },
    },
    "build",
    rules,
  ).pipe(Effect.map((result) => result.tools))

describe("hook permissionDecision ask confirms the effective input once", () => {
  it.instance("shows the rewritten input and reason, then runs without a second dialog", () =>
    Effect.gen(function* () {
      const tools = yield* setupRewrite([{ permission: "bash", pattern: "*", action: "ask" }])
      const permission = yield* Permission.Service
      const fiber = yield* Effect.tryPromise(() =>
        tools.bash.execute(
          { command: "make clean" },
          { toolCallId: "call-rewrite", messages: [], abortSignal: new AbortController().signal },
        ),
      ).pipe(Effect.forkScoped)
      const pending = yield* pollWithTimeout(
        permission.list().pipe(Effect.map((list) => (list.length > 0 ? list : undefined))),
        "hook ask did not surface a permission dialog",
      )
      expect(pending).toHaveLength(1)
      expect(pending[0].always).toEqual([])
      expect(pending[0].metadata).toMatchObject({
        hookAsk: true,
        reason: "rewritten command",
        input: { command: "git log --oneline" },
      })
      recordedInputs.length = 0
      yield* permission.reply({ requestID: pending[0].id, reply: "once" })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(JSON.stringify(exit.value)).toContain("BASH_COMPLETE git log --oneline")
      // The tool part records what actually ran, including the full hook replacement.
      expect(recordedInputs.length).toBeGreaterThan(0)
      expect(
        recordedInputs.every((input) => JSON.stringify(input) === JSON.stringify({ command: "git log --oneline" })),
      ).toBe(true)
      expect((yield* permission.list()).length).toBe(0)
    }),
  )

  it.instance("a confirmed forced ask still loses to a deny rule on the effective input", () =>
    Effect.gen(function* () {
      const tools = yield* setupRewrite([
        { permission: "bash", pattern: "*", action: "ask" },
        { permission: "bash", pattern: "git log *", action: "deny" },
      ])
      const exit = yield* runApprovingHookAsk(tools, "bash", { command: "echo hi" })
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

// MCP tools take the same forced-ask path: the dialog shows the rewritten arguments, approval runs exactly those
// arguments without the tool's own second dialog, and rejection never reaches the MCP server.
const mcpCalls: unknown[] = []
const withMcpEcho = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    return yield* effect.pipe(
      Effect.provideService(MCP.Service, {
        ...mcp,
        tools: () =>
          Effect.succeed({
            fixture_echo: tool({
              inputSchema: jsonSchema<{ text: string }>({
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              }),
              execute: async (args: { text: string }) => {
                mcpCalls.push(args)
                return { content: [{ type: "text" as const, text: `MCP_COMPLETE ${args.text}` }] }
              },
            }),
          }),
      }),
      Effect.provideService(
        Truncate.Service,
        Truncate.Service.of({
          cleanup: () => Effect.void,
          write: (text) => Effect.succeed(text),
          output: (text) => Effect.succeed({ content: text, truncated: false }),
          limits: () => Effect.succeed({ maxLines: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER }),
        }),
      ),
    )
  })

const setupMcpRewrite = withMcpEcho(
  setupWith(
    {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "rewritten arguments",
        updatedInput: { text: "rewritten" },
      },
    },
    "build",
    [{ permission: "fixture_echo", pattern: "*", action: "ask" }],
  ),
).pipe(Effect.map((result) => result.tools))

const runMcpEcho = (tools: Record<string, any>, reply: "once" | "reject") =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    mcpCalls.length = 0
    const fiber = yield* Effect.tryPromise(() =>
      tools.fixture_echo.execute(
        { text: "original" },
        { toolCallId: "call-mcp-echo", messages: [], abortSignal: new AbortController().signal },
      ),
    ).pipe(Effect.forkScoped)
    const pending = yield* pollWithTimeout(
      permission.list().pipe(Effect.map((list) => (list.length > 0 ? list : undefined))),
      "MCP hook ask did not surface a permission dialog",
    )
    expect(pending).toHaveLength(1)
    expect(pending[0].always).toEqual([])
    expect(pending[0].metadata).toMatchObject({
      hookAsk: true,
      reason: "rewritten arguments",
      input: { text: "rewritten" },
    })
    yield* permission.reply({ requestID: pending[0].id, reply })
    const exit = yield* Fiber.await(fiber)
    return { exit, remaining: yield* permission.list() }
  })

describe("hook permissionDecision ask on MCP tools", () => {
  it.instance("confirms the rewritten MCP arguments once and runs them", () =>
    Effect.gen(function* () {
      const { exit, remaining } = yield* runMcpEcho(yield* setupMcpRewrite, "once")
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(JSON.stringify(exit.value)).toContain("MCP_COMPLETE rewritten")
      expect(mcpCalls).toEqual([{ text: "rewritten" }])
      expect(remaining).toHaveLength(0)
    }),
  )

  it.instance("a rejected MCP hook ask never calls the server", () =>
    Effect.gen(function* () {
      const { exit, remaining } = yield* runMcpEcho(yield* setupMcpRewrite, "reject")
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit))
        expect(JSON.stringify(exit.value)).toContain("[Tool denied by hook] rewritten arguments")
      expect(mcpCalls).toEqual([])
      expect(remaining).toHaveLength(0)
    }),
  )
})

describe("PermissionRequest nested command decisions govern tool execution", () => {
  for (const interrupt of [false, true]) {
    it.instance(`deny message preserves interrupt=${interrupt} meaning`, () =>
      Effect.gen(function* () {
        const { tools, id } = yield* setupWith({}, "build", [{ permission: "*", pattern: "*", action: "ask" }])
        const hooks = yield* SessionHooks.Service
        yield* hooks.add(id, {
          event: "PermissionRequest",
          hooks: [
            {
              type: "command",
              command:
                "printf '%s' " +
                quote(
                  JSON.stringify({
                    hookSpecificOutput: {
                      hookEventName: "PermissionRequest",
                      decision: { behavior: "deny", message: "permission-fixture", interrupt },
                    },
                  }),
                ),
            },
          ],
        })
        const exit = yield* Effect.tryPromise(() =>
          tools.bash.execute(
            { command: "echo old" },
            {
              toolCallId: "nested-deny",
              messages: [],
              abortSignal: new AbortController().signal,
            },
          ),
        ).pipe(Effect.exit)
        if (interrupt) {
          expect(exit._tag).toBe("Success")
          if (Exit.isSuccess(exit))
            expect(decodeRecord(exit.value).metadata).toMatchObject({
              hookStopped: true,
              stopReason: "permission-fixture",
            })
        } else expect(exit._tag).toBe("Failure")
      }),
    )
  }
  it.instance("complete replacement restarts only the pre-side-effect builtin and executes rewritten input", () =>
    Effect.gen(function* () {
      const { tools, id } = yield* setupWith({}, "build", [{ permission: "*", pattern: "*", action: "ask" }])
      const hooks = yield* SessionHooks.Service
      yield* hooks.add(id, {
        event: "PermissionRequest",
        hooks: [
          {
            type: "command",
            command:
              "printf '%s' " +
              quote(
                JSON.stringify({
                  hookSpecificOutput: {
                    hookEventName: "PermissionRequest",
                    decision: { behavior: "allow", updatedInput: { command: "echo replacement" } },
                  },
                }),
              ),
          },
        ],
      })
      const result = yield* Effect.promise(() =>
        tools.bash.execute(
          { command: "echo old", obsolete: "remove" },
          {
            toolCallId: "nested-rewrite",
            messages: [],
            abortSignal: new AbortController().signal,
          },
        ),
      )
      expect(decodeRecord(result).output).toContain("BASH_COMPLETE echo replacement")
      expect(yield* Permission.Service.use((permission) => permission.list())).toHaveLength(0)
    }),
  )
})

describe("configured deny remains authoritative over hook allow", () => {
  it.instance("PreToolUse allow cannot bypass a command deny", () =>
    Effect.gen(function* () {
      const { tools } = yield* setupWith(
        { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
        "build",
        [{ permission: "bash", pattern: "dangerous *", action: "deny" }],
      )
      const exit = yield* Effect.tryPromise(() =>
        tools.bash.execute(
          { command: "dangerous command" },
          {
            toolCallId: "deny-preserved",
            messages: [],
            abortSignal: new AbortController().signal,
          },
        ),
      ).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})

describe("hook allow boundaries", () => {
  it.instance("allow skips only an implicit default permission question", () =>
    Effect.gen(function* () {
      const { tools } = yield* setupWith(
        { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
        "build",
        [],
      )
      const exit = yield* Effect.tryPromise(() =>
        tools.bash.execute(
          { command: "echo safe" },
          {
            toolCallId: "default-allow",
            messages: [],
            abortSignal: new AbortController().signal,
          },
        ),
      ).pipe(Effect.timeout(200), Effect.exit)
      expect(exit._tag).toBe("Success")
    }),
  )
  it.instance("a PermissionRequest rewrite is re-evaluated against configured deny before effects", () =>
    Effect.gen(function* () {
      const { tools, id } = yield* setupWith({}, "build", [
        { permission: "bash", pattern: "dangerous *", action: "deny" },
      ])
      yield* (yield* SessionHooks.Service).add(id, {
        event: "PermissionRequest",
        hooks: [
          {
            type: "command",
            command:
              "printf '%s' " +
              quote(
                JSON.stringify({
                  hookSpecificOutput: {
                    hookEventName: "PermissionRequest",
                    decision: { behavior: "allow", updatedInput: { command: "dangerous replacement" } },
                  },
                }),
              ),
          },
        ],
      })
      const exit = yield* Effect.tryPromise(() =>
        tools.bash.execute(
          { command: "echo safe" },
          {
            toolCallId: "rewrite-deny",
            messages: [],
            abortSignal: new AbortController().signal,
          },
        ),
      ).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(yield* Permission.Service.use((permission) => permission.list())).toHaveLength(0)
    }),
  )
  it.instance("native deny cannot be overridden by a mutable permission layer", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const id = SessionID.descending()
      const exit = yield* permission
        .ask(
          { sessionID: id, permission: "bash", patterns: ["dangerous command"], always: [], metadata: {}, ruleset: [] },
          {
            resolveRuleset: () =>
              Effect.succeed({
                native: [{ permission: "bash", pattern: "dangerous *", action: "deny" }],
                rules: [{ permission: "bash", pattern: "*", action: "allow" }],
              }),
          },
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(yield* permission.list()).toHaveLength(0)
    }),
  )
})

describe("MCP permission input replacement has a single external execution", () => {
  for (const valid of [true, false]) {
    it.instance(`rewritten schema valid=${valid} is checked before the MCP call`, () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        let calls = 0
        let executed: unknown
        const { tools, id } = yield* setupWith({}, "build", []).pipe(
          Effect.provideService(MCP.Service, {
            ...mcp,
            tools: () =>
              Effect.succeed({
                fixture_mcp: tool({
                  inputSchema: jsonSchema({
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                  }),
                  execute: async (args) => {
                    calls++
                    executed = args
                    return { content: [{ type: "text", text: "finished" }] }
                  },
                }),
              }),
          }),
          Effect.provide(
            Layer.mock(Truncate.Service, {
              output: (text: string) => Effect.succeed({ content: text, truncated: false }),
            }),
          ),
        )
        yield* (yield* SessionHooks.Service).add(id, {
          event: "PermissionRequest",
          hooks: [
            {
              type: "command",
              command:
                "printf '%s' " +
                quote(
                  JSON.stringify({
                    hookSpecificOutput: {
                      hookEventName: "PermissionRequest",
                      decision: {
                        behavior: "allow",
                        updatedInput: valid ? { value: "replacement" } : {},
                      },
                    },
                  }),
                ),
            },
          ],
        })
        const result = yield* Effect.tryPromise(() =>
          tools.fixture_mcp.execute(
            { value: "original", obsolete: "remove" },
            {
              toolCallId: "mcp-rewrite",
              messages: [],
              abortSignal: new AbortController().signal,
            },
          ),
        ).pipe(Effect.exit)
        expect(Exit.isSuccess(result)).toBe(valid)
        expect(calls).toBe(valid ? 1 : 0)
        if (valid) expect(executed).toEqual({ value: "replacement" })
      }),
    )
  }
})

describe("MCP replacement validates dependentRequired without losing constraints", () => {
  for (const valid of [true, false]) {
    it.instance(`dependentRequired schema valid=${valid} is checked before the MCP call`, () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        let calls = 0
        let executed: unknown
        const { tools, id } = yield* setupWith({}, "build", []).pipe(
          Effect.provideService(MCP.Service, {
            ...mcp,
            tools: () =>
              Effect.succeed({
                fixture_mcp: tool({
                  inputSchema: jsonSchema(
                    Object.assign(
                      {
                        type: "object" as const,
                        properties: { value: { type: "string" as const }, companion: { type: "string" as const } },
                        required: ["value"],
                      },
                      { dependentRequired: { value: ["companion"] } },
                    ),
                  ),
                  execute: async (args) => {
                    calls++
                    executed = args
                    return { content: [{ type: "text", text: "finished" }] }
                  },
                }),
              }),
          }),
          Effect.provide(
            Layer.mock(Truncate.Service, {
              output: (text: string) => Effect.succeed({ content: text, truncated: false }),
            }),
          ),
        )
        yield* (yield* SessionHooks.Service).add(id, {
          event: "PermissionRequest",
          hooks: [
            {
              type: "command",
              command:
                "printf '%s' " +
                quote(
                  JSON.stringify({
                    hookSpecificOutput: {
                      hookEventName: "PermissionRequest",
                      decision: {
                        behavior: "allow",
                        updatedInput: valid ? { value: "replacement", companion: "new" } : { value: "replacement" },
                      },
                    },
                  }),
                ),
            },
          ],
        })
        const result = yield* Effect.tryPromise(() =>
          tools.fixture_mcp.execute(
            { value: "original", companion: "original", obsolete: "remove" },
            {
              toolCallId: "mcp-rewrite",
              messages: [],
              abortSignal: new AbortController().signal,
            },
          ),
        ).pipe(Effect.exit)
        expect(Exit.isSuccess(result)).toBe(valid)
        expect(calls).toBe(valid ? 1 : 0)
        if (valid) expect(executed).toEqual({ value: "replacement", companion: "new" })
      }),
    )
  }
})
