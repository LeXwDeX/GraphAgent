import { describe, expect } from "bun:test"
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
import { Tool } from "@/tool/tool"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { SessionID, MessageID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { hookCommand } from "../fixture/claude-hook"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { MCP_RESOURCE_DEFINITIONS, MCP_RESOURCE_ORDER } from "@/tool/mcp-resource"
import { builtinEntry, directShellEntry, mcpEntries } from "../fixture/tool-registry"

// One table for every source kind that reaches the shared tool pipeline. The
// deny and unusable-defer boundaries already run as source tables in
// tool-boundaries.test.ts and cross-audit-tools.test.ts; keeping those there
// avoids a second copy that could drift. This file covers the remaining
// PreToolUse/PostToolUse behaviors: updatedInput (accepted and rejected),
// continue:false, an ask rejected by the permission layer, mid-execution
// aborts, output truncation, and PostToolUse output replacement.

const hookLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)

const truncatedOutput = {
  content: "MATRIX_TRUNCATED_PREVIEW",
  truncated: true,
  outputPath: "/tmp/matrix-truncated-output.txt",
  details: {
    direction: "head",
    truncatedBy: "lines",
    totalLines: 100,
    totalBytes: 4096,
    startLine: 1,
    endLine: 1,
    outputBytes: 25,
    lineBytes: 0,
    maxBytes: 50 * 1024,
    partialLine: false,
  },
} as const

let truncateMode: "passthrough" | "truncate" = "passthrough"
let askResult: Effect.Effect<void, PermissionV1.RejectedError> = Effect.void
let extraDefinitions: any[] = []
let mcpTools: Record<string, any> = {}
let mcpClients: Record<string, unknown> = {}
let resourceLoader: MCP.Interface["resources"] = () => Effect.succeed({})

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
  Layer.mock(Truncate.Service, {
    output: (text: string) =>
      truncateMode === "truncate"
        ? Effect.succeed(truncatedOutput)
        : Effect.succeed({ content: text, truncated: false as const }),
  }),
  Layer.mock(Agent.Service, {
    // Tool.define's truncation wrapper resolves the executing agent before capping output.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    get: () => Effect.succeed({ name: "build", permission: [], options: {} } as never),
  }),
  Layer.mock(ToolRegistry.Service, {
    tools: () => Effect.succeed(extraDefinitions),
    resolve: (input: { directTool?: DirectTool }) =>
      Effect.sync(() => {
        // The real registry returns only the explicit shell entry for a direct tool.
        if (input.directTool) return [directShellEntry(input.directTool)]
        const entries: ToolEntry[] = extraDefinitions.map((definition) => builtinEntry(definition))
        const hasResources = Object.values(mcpClients).some((client) => {
          if (client === null || typeof client !== "object") return false
          const getCapabilities = Reflect.get(client, "getServerCapabilities")
          if (typeof getCapabilities !== "function") return false
          const capabilities: unknown = Reflect.apply(getCapabilities, client, [])
          return capabilities !== null && typeof capabilities === "object" && !!Reflect.get(capabilities, "resources")
        })
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

type PrepareMode = "normal" | "interrupt"

type PreparedSource = {
  tools: Record<string, any>
  toolName: string
  originalArgs: Record<string, unknown>
  updatedArgs: Record<string, unknown>
  invalidArgs: Record<string, unknown>
  /** Model-visible text the tool itself produces before any hook replacement. */
  originalMarker: string
  /** Exact model-visible text for a PreToolUse continue:false result. */
  expectedStopOutput: string
  /** What the execution body observed after a valid updatedInput. */
  expectedUpdatedObserved: unknown
  /** hookSpecificOutput to send from the PostToolUse replacement hook. */
  replacement: Record<string, unknown>
  /** Where the source applies the shared output cap; direct-shell never does. */
  truncation: boolean
  executed: () => Effect.Effect<boolean>
  observed: () => Effect.Effect<unknown>
  /** Resolves once the execution body has started (interrupt cases). */
  started?: Promise<void>
  /** Reject the pending backend promise after abort (MCP resource case). */
  onAbort?: () => void
  cleanup?: Effect.Effect<void>
}

type SourceCase = {
  name: string
  prepare: (id: any, directory: string, mode: PrepareMode) => Effect.Effect<PreparedSource, never, any>
}

const sourceCases: SourceCase[] = [
  {
    name: "built-in tool",
    prepare: (id, directory, mode) =>
      Effect.gen(function* () {
        const originalTarget = path.join(directory, "matrix-builtin-original.txt")
        const updatedTarget = path.join(directory, "matrix-builtin-updated.txt")
        const started = Promise.withResolvers<void>()
        const info = yield* Tool.define(
          "matrix_write",
          Effect.succeed({
            description: "Matrix fixture writer",
            parameters: Schema.Struct({ filePath: Schema.String, content: Schema.String }),
            execute: (args: { filePath: string; content: string }, ctx: Tool.Context) => {
              if (mode === "interrupt")
                return Effect.callback<never>((resume) => {
                  const abort = () => resume(Effect.interrupt)
                  ctx.abort.addEventListener("abort", abort, { once: true })
                  started.resolve()
                  return Effect.sync(() => ctx.abort.removeEventListener("abort", abort))
                })
              return Effect.promise(async () => {
                await fs.writeFile(args.filePath, args.content)
                return { title: "written", output: "MATRIX_BUILTIN_ORIGINAL", metadata: {} }
              })
            },
          }),
        )
        const definition = yield* Tool.init(info)
        extraDefinitions = [definition]
        const tools = yield* resolve(id, directory)
        return {
          tools,
          toolName: definition.id,
          originalArgs: { filePath: originalTarget, content: "original" },
          updatedArgs: { filePath: updatedTarget, content: "rewritten" },
          invalidArgs: { filePath: 42, content: "bad" },
          originalMarker: "MATRIX_BUILTIN_ORIGINAL",
          expectedStopOutput: "[Hook stopped] MATRIX_STOP",
          expectedUpdatedObserved: { filePath: updatedTarget, content: "rewritten" },
          replacement: {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              updatedToolOutput: { title: "replaced", output: "MATRIX_REPLACED", metadata: { replaced: true } },
            },
          },
          truncation: true,
          executed: () =>
            Effect.promise(async () => {
              if (await Bun.file(originalTarget).exists()) return true
              return Bun.file(updatedTarget).exists()
            }),
          observed: () =>
            Effect.promise(async () => {
              for (const target of [originalTarget, updatedTarget]) {
                if (await Bun.file(target).exists()) return { filePath: target, content: await Bun.file(target).text() }
              }
              return undefined
            }),
          ...(mode === "interrupt" ? { started: started.promise } : {}),
          cleanup: Effect.sync(() => {
            extraDefinitions = []
          }),
        }
      }),
  },
  {
    name: "MCP tool",
    prepare: (id, directory, mode) =>
      Effect.gen(function* () {
        let completed = false
        let seen: unknown
        const started = Promise.withResolvers<void>()
        mcpTools = {
          matrix_probe: tool({
            inputSchema: jsonSchema<{ value: string }>({
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            }),
            execute: async (args, opts) => {
              seen = args
              if (mode === "interrupt") {
                started.resolve()
                await new Promise<never>((_resolve, reject) => {
                  opts.abortSignal!.addEventListener("abort", () => reject(new Error("MATRIX_MCP_ABORTED")), {
                    once: true,
                  })
                })
              }
              completed = true
              return { content: [{ type: "text" as const, text: "MATRIX_MCP_ORIGINAL" }] }
            },
          }),
        }
        const tools = yield* resolve(id, directory)
        return {
          tools,
          toolName: "matrix_probe",
          originalArgs: { value: "original" },
          updatedArgs: { value: "rewritten" },
          invalidArgs: { value: 42 },
          originalMarker: "MATRIX_MCP_ORIGINAL",
          expectedStopOutput: "[Hook stopped] MATRIX_STOP",
          expectedUpdatedObserved: { value: "rewritten" },
          replacement: {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              updatedToolOutput: { content: [{ type: "text", text: "MATRIX_REPLACED" }] },
            },
          },
          truncation: true,
          executed: () => Effect.sync(() => completed),
          observed: () => Effect.sync(() => seen),
          ...(mode === "interrupt" ? { started: started.promise } : {}),
          cleanup: Effect.sync(() => {
            mcpTools = {}
          }),
        }
      }),
  },
  {
    name: "MCP resource tool",
    prepare: (id, directory, mode) =>
      Effect.gen(function* () {
        let completed = false
        let seenServer: unknown
        const started = Promise.withResolvers<void>()
        const pending = Promise.withResolvers<never>()
        mcpClients = { matrix: { getServerCapabilities: () => ({ resources: {} }) } }
        resourceLoader = (server) => {
          seenServer = server
          if (mode === "interrupt") {
            started.resolve()
            return Effect.promise(() => pending.promise)
          }
          completed = true
          return Effect.succeed({
            "matrix://original": {
              client: "matrix",
              name: "MATRIX_RESOURCE_ORIGINAL",
              uri: "matrix://original",
            },
          })
        }
        const tools = yield* resolve(id, directory)
        return {
          tools,
          toolName: "list_mcp_resources",
          originalArgs: {},
          updatedArgs: { server: "matrix" },
          invalidArgs: { server: 42 },
          originalMarker: "MATRIX_RESOURCE_ORIGINAL",
          expectedStopOutput: "[Hook stopped] MATRIX_STOP",
          expectedUpdatedObserved: { server: "matrix" },
          replacement: {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              updatedToolOutput: { title: "replaced", output: "MATRIX_REPLACED", metadata: { replaced: true } },
            },
          },
          truncation: true,
          executed: () => Effect.sync(() => completed),
          observed: () => Effect.sync(() => ({ server: seenServer })),
          ...(mode === "interrupt"
            ? { started: started.promise, onAbort: () => pending.reject(new Error("MATRIX_RESOURCE_ABORTED")) }
            : {}),
          cleanup: Effect.sync(() => {
            mcpClients = {}
            resourceLoader = () => Effect.succeed({})
          }),
        }
      }),
  },
  {
    name: "direct-shell tool",
    prepare: (id, directory, mode) =>
      Effect.gen(function* () {
        const target = path.join(directory, "matrix-direct-shell.txt")
        const started = Promise.withResolvers<void>()
        const directTool: DirectTool = {
          id: "bash",
          description: "Matrix fixture explicit shell command",
          parameters: Schema.Struct({ command: Schema.String }),
          execute: (args: { command: string }, ctx) => {
            if (mode === "interrupt")
              return Effect.callback<never>((resume) => {
                const abort = () => resume(Effect.interrupt)
                ctx.abort.addEventListener("abort", abort, { once: true })
                started.resolve()
                return Effect.sync(() => ctx.abort.removeEventListener("abort", abort))
              })
            return Effect.promise(async () => {
              await fs.writeFile(target, args.command)
              return { title: "bash", metadata: {}, output: "MATRIX_DIRECT_SHELL_ORIGINAL" }
            })
          },
        }
        const tools = yield* resolve(id, directory, directTool)
        return {
          tools,
          toolName: "bash",
          originalArgs: { command: "original" },
          updatedArgs: { command: "rewritten" },
          invalidArgs: { command: 42 },
          originalMarker: "MATRIX_DIRECT_SHELL_ORIGINAL",
          expectedStopOutput: "[Hook stopped] MATRIX_STOP",
          expectedUpdatedObserved: { command: "rewritten" },
          replacement: {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              updatedToolOutput: { title: "replaced", output: "MATRIX_REPLACED", metadata: { replaced: true } },
            },
          },
          // Explicit user shell commands have no model-facing transcript entry:
          // the pipeline neither wraps nor truncates their output.
          truncation: false,
          executed: () => Effect.promise(() => Bun.file(target).exists()),
          observed: () => Effect.promise(async () => ({ command: await Bun.file(target).text() })),
          ...(mode === "interrupt" ? { started: started.promise } : {}),
        }
      }),
  },
]

const options = (callID: string, abortSignal?: AbortSignal) => ({
  toolCallId: callID,
  messages: [],
  abortSignal: abortSignal ?? new AbortController().signal,
})

const callTool = (prepared: PreparedSource, args: Record<string, unknown>, callID: string, abortSignal?: AbortSignal) =>
  Promise.resolve(prepared.tools[prepared.toolName].execute!(args, options(callID, abortSignal)))

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined

/** The text a model would see: builtin results expose `output`, MCP denials expose `content`. */
const visibleText = (result: unknown) => {
  const output = field(result, "output")
  if (typeof output === "string") return output
  const content = field(result, "content")
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is { type: "text"; text: string } => {
        return field(part, "type") === "text" && typeof field(part, "text") === "string"
      })
      .map((part) => part.text)
    if (text.length > 0) return text.join("\n")
  }
  return JSON.stringify(result)
}

const jsonHook = (value: unknown) => ({
  type: "command" as const,
  command: hookCommand(`console.log(JSON.stringify(${JSON.stringify(value)}))`),
})

const updatedInputHook = (input: Record<string, unknown>) =>
  jsonHook({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: input } })

const stopHook = jsonHook({ continue: false, stopReason: "MATRIX_STOP" })

const askHook = jsonHook({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } })

const preContextHook = jsonHook({
  hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "MATRIX_PRE_CTX" },
})

const prepareIn = (source: SourceCase, id: any, directory: string, mode: PrepareMode = "normal") =>
  source.prepare(id, directory, mode)

describe("tool source matrix", () => {
  for (const source of sourceCases) {
    describe(source.name, () => {
      it.instance("a valid updatedInput reaches the execution body", () =>
        Effect.gen(function* () {
          const instance = yield* TestInstance
          const store = yield* SessionHooks.Service
          const id = SessionID.descending()
          const prepared = yield* prepareIn(source, id, instance.directory)
          if (prepared.cleanup) yield* Effect.addFinalizer(() => prepared.cleanup!)
          yield* store.add(id, { event: "PreToolUse", hooks: [updatedInputHook(prepared.updatedArgs)] })
          yield* Effect.promise(() => callTool(prepared, prepared.originalArgs, "matrix-updated"))
          expect(yield* prepared.executed()).toBe(true)
          expect(yield* prepared.observed()).toEqual(prepared.expectedUpdatedObserved)
        }),
      )

      it.instance("an updatedInput that fails validation rejects before execution", () =>
        Effect.gen(function* () {
          const instance = yield* TestInstance
          const store = yield* SessionHooks.Service
          const id = SessionID.descending()
          const prepared = yield* prepareIn(source, id, instance.directory)
          if (prepared.cleanup) yield* Effect.addFinalizer(() => prepared.cleanup!)
          yield* store.add(id, { event: "PreToolUse", hooks: [updatedInputHook(prepared.invalidArgs)] })
          const outcome = yield* Effect.promise(() =>
            callTool(prepared, prepared.originalArgs, "matrix-invalid").then(
              () => "resolved" as const,
              (error: unknown) => error,
            ),
          )
          expect(outcome).not.toBe("resolved")
          expect(String(outcome)).toContain("Hook replacement does not match tool input schema")
          expect(yield* prepared.executed()).toBe(false)
        }),
      )

      it.instance("continue:false returns the source's hook stop result without executing", () =>
        Effect.gen(function* () {
          const instance = yield* TestInstance
          const store = yield* SessionHooks.Service
          const id = SessionID.descending()
          const prepared = yield* prepareIn(source, id, instance.directory)
          if (prepared.cleanup) yield* Effect.addFinalizer(() => prepared.cleanup!)
          yield* store.add(id, { event: "PreToolUse", hooks: [stopHook] })
          const result = yield* Effect.promise(() => callTool(prepared, prepared.originalArgs, "matrix-stop"))
          expect(visibleText(result)).toBe(prepared.expectedStopOutput)
          expect(field(field(result, "metadata"), "hookStopped")).toBe(true)
          expect(yield* prepared.executed()).toBe(false)
        }),
      )

      it.instance("a hook ask rejected by the permission layer denies without executing", () =>
        Effect.gen(function* () {
          const instance = yield* TestInstance
          const store = yield* SessionHooks.Service
          const id = SessionID.descending()
          const prepared = yield* prepareIn(source, id, instance.directory)
          if (prepared.cleanup) yield* Effect.addFinalizer(() => prepared.cleanup!)
          askResult = Effect.fail(new PermissionV1.RejectedError())
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              askResult = Effect.void
            }),
          )
          yield* store.add(id, { event: "PreToolUse", hooks: [askHook] })
          const result = yield* Effect.promise(() => callTool(prepared, prepared.originalArgs, "matrix-ask"))
          expect(visibleText(result)).toContain("[Tool denied by hook]")
          expect(yield* prepared.executed()).toBe(false)
        }),
      )

      it.instance("aborting mid-execution rejects without a successful result", () =>
        Effect.gen(function* () {
          const instance = yield* TestInstance
          const id = SessionID.descending()
          const prepared = yield* prepareIn(source, id, instance.directory, "interrupt")
          if (prepared.cleanup) yield* Effect.addFinalizer(() => prepared.cleanup!)
          if (!prepared.started) throw new Error("interrupt fixture did not expose a start signal")
          const controller = new AbortController()
          const outcome = callTool(prepared, prepared.originalArgs, "matrix-interrupt", controller.signal).then(
            () => "resolved" as const,
            (error: unknown) => error,
          )
          yield* Effect.promise(() => prepared.started!)
          controller.abort()
          if (prepared.onAbort) yield* Effect.sync(() => prepared.onAbort!())
          expect(yield* Effect.promise(() => outcome)).not.toBe("resolved")
          expect(yield* prepared.executed()).toBe(false)
        }),
      )

      it.instance("long output is truncated per source, except the direct shell", () =>
        Effect.gen(function* () {
          const instance = yield* TestInstance
          const id = SessionID.descending()
          const prepared = yield* prepareIn(source, id, instance.directory)
          if (prepared.cleanup) yield* Effect.addFinalizer(() => prepared.cleanup!)
          truncateMode = "truncate"
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              truncateMode = "passthrough"
            }),
          )
          const result = yield* Effect.promise(() => callTool(prepared, prepared.originalArgs, "matrix-truncate"))
          const metadata = field(result, "metadata")
          const text = visibleText(result)
          if (prepared.truncation) {
            expect(field(metadata, "truncated")).toBe(true)
            expect(typeof field(metadata, "outputPath")).toBe("string")
            expect(text).toContain("MATRIX_TRUNCATED_PREVIEW")
          } else {
            // The explicit shell result is shown to the user, not fed back to a
            // model, so its output is deliberately left untruncated.
            expect(field(metadata, "truncated")).toBeUndefined()
            expect(field(metadata, "outputPath")).toBeUndefined()
            expect(text).toContain(prepared.originalMarker)
          }
        }),
      )

      it.instance("PostToolUse output replacement keeps the PreToolUse context", () =>
        Effect.gen(function* () {
          const instance = yield* TestInstance
          const store = yield* SessionHooks.Service
          const id = SessionID.descending()
          const prepared = yield* prepareIn(source, id, instance.directory)
          if (prepared.cleanup) yield* Effect.addFinalizer(() => prepared.cleanup!)
          yield* store.add(id, { event: "PreToolUse", hooks: [preContextHook] })
          yield* store.add(id, { event: "PostToolUse", hooks: [jsonHook(prepared.replacement)] })
          const result = yield* Effect.promise(() => callTool(prepared, prepared.originalArgs, "matrix-replace"))
          const text = visibleText(result)
          expect(text).toContain("MATRIX_REPLACED")
          expect(text).toContain("MATRIX_PRE_CTX")
          expect(text).not.toContain(prepared.originalMarker)
        }),
      )
    })
  }
})
