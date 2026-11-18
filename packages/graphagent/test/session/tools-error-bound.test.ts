// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- partial agent, session and processor fixtures use `as never`.
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { describe, expect } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { SafetyGuard } from "@/permission/safety-guard"
import { MessageID, SessionID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { boundErrorCause } from "@/tool/pipeline"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { builtinEntry, mcpEntries, mcpResourceEntries } from "../fixture/tool-registry"
import { testEffect } from "../lib/effect"

/**
 * #1446: the text of a tool's error is model-visible text like its output, so
 * an error that is far larger than the output cap is cut once, the whole of it
 * is saved, and the model is told where. The cause keeps its kind: a refusal
 * the user made and an interruption are never turned into text.
 */

const LONG = 100_000

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const configLayer = TestConfig.layer({ dagGlobal: () => Effect.succeed({}) })

const mcpTools = (size: number) => ({
  srv_boom: McpCatalog.bindTool(
    tool({
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async (): Promise<{ content: { type: "text"; text: string }[] }> => {
        throw new Error("m".repeat(size))
      },
    }),
    { server: "srv", tool: "boom", source: "unknown" },
  ),
})
let size = LONG

const boomDefinition = {
  id: "boom",
  description: "Fixture tool whose call fails with a very long text",
  parameters: Schema.Struct({}),
  execute: () => Effect.die(new Error("b".repeat(size))),
}

// The fixture client advertises resources, and the read of one dies with the long text.
const resourceClient = { getServerCapabilities: () => ({ resources: {} }) }

const it = testEffect(
  Layer.mergeAll(
    Permission.layer.pipe(
      Layer.provide(database),
      Layer.provide(bridge),
      Layer.provide(SafetyGuard.layer),
      Layer.provide(configLayer),
    ),
    database,
    events,
    bridge,
    Layer.mock(MCP.Service, {
      clients: () => Effect.succeed({ srv: resourceClient } as never),
      tools: () => Effect.sync(() => mcpTools(size)),
      readResource: () => Effect.die(new Error("r".repeat(size))),
    }),
    Truncate.defaultLayer,
    Layer.mock(ToolRegistry.Service, {
      tools: () => Effect.succeed([boomDefinition]),
      resolve: () =>
        Effect.sync(() => [
          builtinEntry(boomDefinition as never),
          ...mcpEntries(mcpTools(size)),
          ...mcpResourceEntries(["read"]),
        ]),
    }),
  ),
)

const ALLOW_ALL = [{ permission: "*", pattern: "*", action: "allow" as const }]

type Tools = Record<string, { execute: (args: unknown, options: unknown) => Promise<unknown> }>

/** The tools of one session as the model's runtime would run them, wrapped by the real pipeline. */
const resolveTools = Effect.gen(function* () {
  const instance = yield* TestInstance
  const sessionID = SessionID.descending()
  return (yield* SessionTools.resolve({
    agent: { name: "general", permission: ALLOW_ALL, options: {} } as never,
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
  })) as unknown as Tools
})

/** What a rejected call tells the model: the text of the error the tool's promise ends in. */
const rejection = (tools: Tools, name: string, args: unknown = {}) =>
  Effect.tryPromise({
    try: () =>
      tools[name].execute(args, {
        toolCallId: `call-${name}`,
        messages: [],
        abortSignal: new AbortController().signal,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Error ? error.message : String(error))),
  )

const savedPath = (text: string) => /Full output: (\S+?)\]/.exec(text)?.[1]

const agent = { name: "general", permission: [], options: {} } as never

describe("boundErrorCause (#1446)", () => {
  it.live("bounds a very long error and keeps the whole text in a saved file", () =>
    Effect.gen(function* () {
      const truncate = yield* Truncate.Service
      const error = new Error("e".repeat(LONG))

      const exit = yield* boundErrorCause(truncate, agent, Cause.fail(error)).pipe(Effect.exit)

      if (!Exit.isFailure(exit)) throw new Error("expected a failure")
      const bounded = Cause.squash(exit.cause)
      if (!(bounded instanceof Error)) throw new Error("expected an Error")
      expect(bounded.message).toContain("Full output: ")
      expect(bounded.message.length).toBeLessThan(60_000)
      expect(bounded.cause).toBe(error)
      const saved = savedPath(bounded.message)
      expect(saved).toBeDefined()
      expect(yield* Effect.promise(() => Bun.file(saved!).text())).toBe("e".repeat(LONG))
    }),
  )

  it.live("keeps a defect a defect", () =>
    Effect.gen(function* () {
      const truncate = yield* Truncate.Service

      const exit = yield* boundErrorCause(truncate, agent, Cause.die(new Error("d".repeat(LONG)))).pipe(Effect.exit)

      if (!Exit.isFailure(exit)) throw new Error("expected a failure")
      expect(Cause.hasDies(exit.cause)).toBe(true)
      const bounded = Cause.squash(exit.cause)
      expect(bounded instanceof Error && bounded.message).toContain("Full output: ")
    }),
  )

  it.live("returns the cause of a short error as it was", () =>
    Effect.gen(function* () {
      const truncate = yield* Truncate.Service
      const error = new Error("short")

      const exit = yield* boundErrorCause(truncate, agent, Cause.fail(error)).pipe(Effect.exit)

      if (!Exit.isFailure(exit)) throw new Error("expected a failure")
      expect(Cause.squash(exit.cause)).toBe(error)
    }),
  )

  it.live("leaves a permission refusal alone however long its text is", () =>
    Effect.gen(function* () {
      const truncate = yield* Truncate.Service
      const long = "p".repeat(LONG)
      const refusals = [
        new PermissionV1.DeniedError({ ruleset: [], reason: long }),
        new PermissionV1.CorrectedError({ feedback: long }),
        new PermissionV1.RejectedError(),
      ]

      for (const refusal of refusals) {
        const exit = yield* boundErrorCause(truncate, agent, Cause.fail(refusal)).pipe(Effect.exit)
        if (!Exit.isFailure(exit)) throw new Error("expected a failure")
        expect(Cause.squash(exit.cause)).toBe(refusal)
      }
    }),
  )

  it.live("leaves an interruption alone", () =>
    Effect.gen(function* () {
      const truncate = yield* Truncate.Service
      const cause = Cause.interrupt()

      const exit = yield* boundErrorCause(truncate, agent, cause).pipe(Effect.exit)

      if (!Exit.isFailure(exit)) throw new Error("expected a failure")
      expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    }),
  )
})

describe("a tool error that reaches the model (#1446)", () => {
  it.instance("a built-in tool's very long error is bounded and saved", () =>
    Effect.gen(function* () {
      size = LONG
      const tools = yield* resolveTools

      const message = yield* rejection(tools, "boom")

      expect(message).toContain("Full output: ")
      expect(message.length).toBeLessThan(60_000)
      expect(yield* Effect.promise(() => Bun.file(savedPath(message)!).text())).toBe("b".repeat(LONG))
    }),
  )

  it.instance("an MCP tool's very long error is bounded and saved", () =>
    Effect.gen(function* () {
      size = LONG
      const tools = yield* resolveTools

      const message = yield* rejection(tools, "srv_boom")

      expect(message).toContain("Full output: ")
      expect(message.length).toBeLessThan(60_000)
      expect(yield* Effect.promise(() => Bun.file(savedPath(message)!).text())).toBe("m".repeat(LONG))
    }),
  )

  it.instance("an MCP resource tool's very long error is bounded and saved", () =>
    Effect.gen(function* () {
      size = LONG
      const tools = yield* resolveTools

      const message = yield* rejection(tools, "read_mcp_resource", { server: "srv", uri: "file:///a" })

      expect(message).toContain("Full output: ")
      expect(message.length).toBeLessThan(60_000)
      expect(yield* Effect.promise(() => Bun.file(savedPath(message)!).text())).toBe("r".repeat(LONG))
    }),
  )

  it.instance("a short error reaches the model unchanged", () =>
    Effect.gen(function* () {
      size = 40
      const tools = yield* resolveTools

      expect(yield* rejection(tools, "boom")).toContain("b".repeat(40))
      expect(yield* rejection(tools, "srv_boom")).not.toContain("Full output: ")
      expect(yield* rejection(tools, "read_mcp_resource", { server: "srv", uri: "file:///a" })).not.toContain(
        "Full output: ",
      )
    }),
  )
})
