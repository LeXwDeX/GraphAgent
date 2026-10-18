import { describe, expect } from "bun:test"
import { Tool } from "@opencode-ai/core/tool/tool"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { SessionConversationHooks } from "@opencode-ai/core/session/conversation-hooks"
import { PermissionHookScope } from "@opencode-ai/core/permission/hook-scope"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ContextFoldingToolSourceLedger } from "@opencode-ai/core/session/context-folding/tool-source-ledger"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ContextFoldingBuiltins } from "@opencode-ai/core/tool/context-folding-builtins"
import { CoreContextFolding } from "@opencode-ai/core/session/runner/context-folding"
import { toLLMMessagesWithBindings } from "@opencode-ai/core/session/runner/to-llm-message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { executeTool, settleTool, toolDefinitions } from "./lib/tool"
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
  Scope,
} from "effect"
import { testEffect } from "./lib/effect"

const bounds: ToolOutputStore.BoundInput[] = []
const retentionFailure = new ToolOutputStore.StorageError({ operation: "write", cause: new Error("disk full") })
const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => {
    if (input.toolCallID === "call-retention-failure") return Effect.fail(retentionFailure)
    return Effect.sync(() => bounds.push(input)).pipe(
      Effect.as(
        input.toolCallID === "call-bounded"
          ? {
              output: { structured: {}, content: [{ type: "text" as const, text: "bounded reference" }] },
              outputPaths: ["/managed/generic"],
            }
          : { output: input.output, outputPaths: [] },
      ),
    )
  },
})
const registry = ToolRegistry.layer.pipe(Layer.provide(ApplicationTools.layer), Layer.provide(outputStore))
const it = testEffect(registry)
const integrated = testEffect(Layer.mergeAll(ApplicationTools.layer, registry))
const ledgerOnly = testEffect(ContextFoldingToolSourceLedger.layer)
const identity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_registry"),
}
const sessionID = SessionV2.ID.make("ses_registry")
const foldingModel = Model.make({ id: "registry-model", provider: "registry-provider", route: OpenAIChat.route })
const foldingModelRef = {
  id: ModelV2.ID.make(String(foldingModel.id)),
  providerID: ProviderV2.ID.make(String(foldingModel.provider)),
}
const now = DateTime.makeUnsafe(1)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const call = (name: string, id = `call-${name}`): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id, name, input: { text: name } },
})

const make = (permission?: string) => {
  const tool = Tool.make({
    description: "Echo text",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: ({ text }) => Effect.succeed({ text }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  })
  return permission ? Tool.withPermission(tool, permission) : tool
}

const foldable = () =>
  Tool.make({
    contextFolding: { instructions: "none" },
    description: "Foldable echo text",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: ({ text }) => Effect.succeed({ text }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  })

const settledMessage = Effect.fnUntraced(function* (
  turn: ToolRegistry.Materialization,
  messageID: string,
  callID: string,
) {
  const input = { text: "same structured content" }
  const settled = yield* turn.settle({
    sessionID,
    agent: identity.agent,
    assistantMessageID: SessionMessage.ID.make(messageID),
    call: { type: "tool-call", id: callID, name: "grep", input },
  })
  if (!settled.output || !isRecord(settled.output.structured)) return yield* Effect.die("expected successful output")
  return {
    id: SessionMessage.ID.make(messageID),
    type: "assistant" as const,
    agent: identity.agent,
    model: foldingModelRef,
    time: { created: now, completed: now },
    content: [
      {
        type: "tool" as const,
        id: callID,
        name: "grep",
        state: {
          status: "completed" as const,
          input,
          structured: settled.output.structured,
          content: settled.output.content,
        },
        time: { created: now, ran: now, completed: now },
      },
    ],
  } satisfies SessionMessage.Assistant
})

const recent = (prefix: string) =>
  Array.from({ length: 4 }, (_, index) =>
    SessionMessage.Assistant.make({
      id: SessionMessage.ID.make(`msg_${prefix}_recent_${index}`),
      type: "assistant",
      agent: identity.agent,
      model: foldingModelRef,
      time: { created: now, completed: now },
      content: [{ type: "text", id: `${prefix}-text-${index}`, text: "recent".repeat(4_000) }],
    }),
  )

const foldingHistory = Effect.fnUntraced(function* (
  messages: readonly SessionMessage.Message[],
  ledger: ContextFoldingToolSourceLedger.Interface,
) {
  const conversion = toLLMMessagesWithBindings(messages, foldingModel)
  return yield* CoreContextFolding.history({ sessionID, messages, conversion, model: foldingModel, ledger })
})

describe("ToolRegistry", () => {
  ledgerOnly.effect("does not trust pre-restart history in a fresh provenance ledger", () =>
    Effect.gen(function* () {
      const ledger = yield* ContextFoldingToolSourceLedger.Service
      const generation = yield* ledger.activate([
        { toolName: "read", sourceKind: "host-builtin", registrationID: "read-before-restart", instructions: "none" },
      ])
      yield* ledger.record({
        sessionID,
        assistantMessageID: identity.assistantMessageID,
        callID: "call-before-restart",
        toolName: "read",
        source: {
          sourceKind: "host-builtin",
          registrationID: "read-before-restart",
          registrationGeneration: generation,
          instructions: "none",
        },
      })
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: identity.assistantMessageID,
          callID: "call-before-restart",
          toolName: "read",
        }),
      ).toBeDefined()

      const restarted = yield* Effect.gen(function* () {
        const fresh = yield* ContextFoldingToolSourceLedger.Service
        return yield* fresh.lookup({
          sessionID,
          assistantMessageID: identity.assistantMessageID,
          callID: "call-before-restart",
          toolName: "read",
        })
      }).pipe(Effect.provide(ContextFoldingToolSourceLedger.layer.pipe(Layer.fresh)))
      expect(restarted).toBeUndefined()
    }),
  )

  integrated.effect(
    "keeps application and ordinary local settlement provenance untrusted and invalidates overridden history",
    () =>
      Effect.gen(function* () {
        const applications = yield* ApplicationTools.Service
        const service = yield* ToolRegistry.Service
        const ledger = yield* ContextFoldingToolSourceLedger.Service
        yield* applications.register({ echo: foldable() })

        const applicationTurn = yield* service.materialize()
        yield* applicationTurn.settle(call("echo", "call-application"))
        expect(
          yield* ledger.lookup({
            sessionID,
            assistantMessageID: identity.assistantMessageID,
            callID: "call-application",
            toolName: "echo",
          }),
        ).toMatchObject({ identity: { sourceKind: "custom" }, instructions: "none" })

        yield* service.register({ echo: foldable() })
        const localTurn = yield* service.materialize()
        expect(
          yield* ledger.lookup({
            sessionID,
            assistantMessageID: identity.assistantMessageID,
            callID: "call-application",
            toolName: "echo",
          }),
        ).toBeUndefined()
        yield* localTurn.settle(call("echo", "call-local"))
        expect(
          yield* ledger.lookup({
            sessionID,
            assistantMessageID: identity.assistantMessageID,
            callID: "call-local",
            toolName: "echo",
          }),
        ).toMatchObject({ identity: { sourceKind: "custom" }, instructions: "none" })
      }),
  )

  it.effect(
    "rejects same-name public overrides and restores trusted builtins only for fresh-generation settlements",
    () =>
      Effect.gen(function* () {
        const service = yield* ToolRegistry.Service
        const builtins = yield* ContextFoldingBuiltins.Service
        const ledger = yield* ContextFoldingToolSourceLedger.Service
        yield* builtins.register({ grep: foldable() })

        const originalTurn = yield* service.materialize()
        yield* settledMessage(originalTurn, "msg_original_builtin", "call-original-builtin")
        expect(
          yield* ledger.lookup({
            sessionID,
            assistantMessageID: "msg_original_builtin",
            callID: "call-original-builtin",
            toolName: "grep",
          }),
        ).toMatchObject({ identity: { sourceKind: "host-builtin" }, instructions: "none" })

        const overrideScope = yield* Scope.make()
        yield* service.register({ grep: foldable() }).pipe(Scope.provide(overrideScope))
        const overrideTurn = yield* service.materialize()
        expect(
          yield* ledger.lookup({
            sessionID,
            assistantMessageID: "msg_original_builtin",
            callID: "call-original-builtin",
            toolName: "grep",
          }),
        ).toBeUndefined()

        const customMessages = [
          yield* settledMessage(overrideTurn, "msg_custom_source", "call-custom-source"),
          yield* settledMessage(overrideTurn, "msg_custom_witness", "call-custom-witness"),
          ...recent("custom"),
        ]
        for (const [messageID, callID] of [
          ["msg_custom_source", "call-custom-source"],
          ["msg_custom_witness", "call-custom-witness"],
        ] as const)
          expect(
            yield* ledger.lookup({ sessionID, assistantMessageID: messageID, callID, toolName: "grep" }),
          ).toMatchObject({ identity: { sourceKind: "custom" }, instructions: "none" })
        const customHistory = yield* foldingHistory(customMessages, ledger)
        expect(customHistory.duplicatePlan.replacements).toEqual([])
        expect(customHistory.duplicatePlan.exclusions).toEqual(
          expect.arrayContaining([
            {
              ref: { messageID: "msg_custom_source", partID: "call-custom-source", callID: "call-custom-source" },
              reason: "untrusted-source",
            },
            {
              ref: {
                messageID: "msg_custom_witness",
                partID: "call-custom-witness",
                callID: "call-custom-witness",
              },
              reason: "untrusted-source",
            },
          ]),
        )

        yield* Scope.close(overrideScope, Exit.void)
        const restoredTurn = yield* service.materialize()
        expect(
          yield* ledger.lookup({
            sessionID,
            assistantMessageID: "msg_custom_source",
            callID: "call-custom-source",
            toolName: "grep",
          }),
        ).toBeUndefined()

        yield* originalTurn.settle({
          sessionID,
          agent: identity.agent,
          assistantMessageID: SessionMessage.ID.make("msg_stale_generation"),
          call: {
            type: "tool-call",
            id: "call-stale-generation",
            name: "grep",
            input: { text: "same structured content" },
          },
        })
        expect(
          yield* ledger.lookup({
            sessionID,
            assistantMessageID: "msg_stale_generation",
            callID: "call-stale-generation",
            toolName: "grep",
          }),
        ).toBeUndefined()

        const builtinMessages = [
          yield* settledMessage(restoredTurn, "msg_builtin_source", "call-builtin-source"),
          yield* settledMessage(restoredTurn, "msg_builtin_witness", "call-builtin-witness"),
          ...recent("builtin"),
        ]
        for (const [messageID, callID] of [
          ["msg_builtin_source", "call-builtin-source"],
          ["msg_builtin_witness", "call-builtin-witness"],
        ] as const)
          expect(
            yield* ledger.lookup({ sessionID, assistantMessageID: messageID, callID, toolName: "grep" }),
          ).toMatchObject({ identity: { sourceKind: "host-builtin" }, instructions: "none" })
        expect((yield* foldingHistory(builtinMessages, ledger)).duplicatePlan.replacements).toEqual([
          {
            source: {
              messageID: "msg_builtin_source",
              partID: "call-builtin-source",
              callID: "call-builtin-source",
            },
            witness: {
              messageID: "msg_builtin_witness",
              partID: "call-builtin-witness",
              callID: "call-builtin-witness",
            },
            resultKind: "text",
            anchor: true,
          },
        ])
      }),
  )

  it.effect("fails closed for missing provenance and invalidates recorded history after a generation change", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const ledger = yield* ContextFoldingToolSourceLedger.Service
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: identity.assistantMessageID,
          callID: "call-missing",
          toolName: "echo",
        }),
      ).toBeUndefined()

      yield* service.register({ echo: foldable() })
      const first = yield* service.materialize()
      yield* first.settle(call("echo", "call-old-generation"))
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: identity.assistantMessageID,
          callID: "call-old-generation",
          toolName: "echo",
        }),
      ).toBeDefined()

      yield* service.register({ another: foldable() })
      yield* service.materialize()
      expect(
        yield* ledger.lookup({
          sessionID,
          assistantMessageID: identity.assistantMessageID,
          callID: "call-old-generation",
          toolName: "echo",
        }),
      ).toBeUndefined()
    }),
  )

  it.effect("filters disabled tools with edit aliases and ordered wildcard precedence", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({
        question: make(),
        bash: make(),
        edit: make("edit"),
        write: make("edit"),
        apply_patch: make("edit"),
      })
      const names = (rules: Parameters<ToolRegistry.Interface["materialize"]>[0]) =>
        toolDefinitions(service, rules).pipe(Effect.map((definitions) => definitions.map((tool) => tool.name)))

      expect(yield* names([{ action: "question", resource: "*", effect: "deny" }])).toEqual([
        "bash",
        "edit",
        "write",
        "apply_patch",
      ])
      expect(
        yield* names([
          { action: "*", resource: "*", effect: "deny" },
          { action: "question", resource: "private", effect: "allow" },
        ]),
      ).toEqual(["question"])
      expect(
        yield* names([
          { action: "question", resource: "private", effect: "allow" },
          { action: "*", resource: "*", effect: "deny" },
        ]),
      ).toEqual([])
      expect(yield* names([{ action: "edit", resource: "*", effect: "deny" }])).toEqual(["question", "bash"])
    }),
  )

  it.effect("keeps permission decoration isolated between registrations", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const shared = make()
      yield* service.register({ first: shared })
      yield* service.register({ second: Tool.withPermission(shared, "edit") })
      Tool.withPermission(shared, "question")

      expect(
        (yield* toolDefinitions(service, [{ action: "edit", resource: "*", effect: "deny" }])).map(
          (definition) => definition.name,
        ),
      ).toEqual(["first"])
    }),
  )

  it.effect("reuses model definitions across provider turns", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const first = yield* toolDefinitions(service)
      const second = yield* toolDefinitions(service)

      expect(second[0]).toBe(first[0])
    }),
  )

  it.effect("removes a scoped registration", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* service.register({ echo: make() }).pipe(Scope.provide(scope))
      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["echo"])
      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(service)).toEqual([])
    }),
  )

  it.effect("preserves an interrupted registration until its scope closes", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      const registered = yield* Deferred.make<void>()
      const fiber = yield* service
        .register({ echo: make() })
        .pipe(
          Effect.andThen(Deferred.succeed(registered, undefined)),
          Effect.andThen(Effect.never),
          Scope.provide(scope),
          Effect.forkChild,
        )
      yield* Deferred.await(registered)
      yield* Fiber.interrupt(fiber)

      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["echo"])
      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(service)).toEqual([])
    }),
  )

  it.effect("returns model errors without swallowing interruption or defects", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({
        failed: Tool.make({
          description: "Failed",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.fail(new Tool.Failure({ message: "Denied" })),
        }),
      })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "failed", name: "failed", input: {} },
        }),
      ).toEqual({ type: "error", value: "Denied" })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "missing", name: "missing", input: {} },
        }),
      ).toEqual({ type: "error", value: "Unknown tool: missing" })

      yield* service.register({
        defect: Tool.make({
          description: "Defect",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die("unexpected executor defect"),
        }),
      })
      expect(
        yield* service.materialize().pipe(
          Effect.flatMap((materialized) =>
            materialized.settle({
              sessionID,
              ...identity,
              call: { type: "tool-call", id: "defect", name: "defect", input: {} },
            }),
          ),
          Effect.catchDefect(Effect.succeed),
        ),
      ).toBe("unexpected executor defect")
    }),
  )

  it.effect("propagates retention failures through settlement", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const materialized = yield* service.materialize()
      const exit = yield* materialized.settle(call("echo", "call-retention-failure")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(retentionFailure)
      expect(retentionFailure.message).toBe("Failed to write tool output: disk full")
    }),
  )

  it.effect("exposes settlement only through materialization", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      expect("definitions" in service).toBe(false)
      expect("execute" in service).toBe(false)
      expect("settle" in service).toBe(false)
      expect(typeof service.materialize).toBe("function")
    }),
  )

  it.effect("passes complete invocation identity to the canonical handler", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []
      yield* service.register({
        context: Tool.make({
          description: "Context",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: (_, context) => Effect.sync(() => contexts.push(context)).pipe(Effect.as({ ok: true })),
        }),
      })
      yield* executeTool(service, {
        sessionID,
        ...identity,
        call: { type: "tool-call", id: "call-context", name: "context", input: {} },
      })
      expect(contexts).toEqual([{ sessionID, ...identity, toolCallID: "call-context" }])
    }),
  )

  it.effect("encodes output and applies generic settlement bounding", () =>
    Effect.gen(function* () {
      bounds.length = 0
      const service = yield* ToolRegistry.Service
      yield* service.register({ bounded: make() })
      expect(
        yield* settleTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "call-bounded", name: "bounded", input: { text: "complete" } },
        }),
      ).toEqual({
        result: { type: "text", value: "bounded reference" },
        output: { structured: {}, content: [{ type: "text", text: "bounded reference" }] },
        outputPaths: ["/managed/generic"],
      })
      expect(bounds).toHaveLength(1)
    }),
  )

  it.effect("enforces transformed codecs at execution and projection boundaries", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const executed: string[] = []
      const Transformed = Schema.Boolean.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform((value) => (value ? "yes" : "no")),
          encode: SchemaGetter.transform((value) => value === "yes"),
        }),
      )
      yield* service.register({
        transformed: Tool.make({
          description: "Transform values",
          input: Schema.Struct({ value: Transformed }),
          output: Schema.Struct({ value: Transformed }),
          execute: ({ value }) => Effect.sync(() => executed.push(value)).pipe(Effect.as({ value })),
          toModelOutput: ({ output }) => [{ type: "text", text: String(output.value) }],
        }),
      })

      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "transformed", name: "transformed", input: { value: true } },
        }),
      ).toEqual({ type: "text", value: "true" })
      expect(executed).toEqual(["yes"])
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "invalid-input", name: "transformed", input: { value: "yes" } },
        }),
      ).toMatchObject({ type: "error", value: expect.stringContaining("Invalid tool input") })
      expect(executed).toEqual(["yes"])

      yield* service.register({
        invalid_output: Tool.make({
          description: "Return invalid output",
          input: Schema.Struct({}),
          output: Schema.Struct({
            value: Schema.Boolean.pipe(
              Schema.decodeTo(Schema.String, {
                decode: SchemaGetter.transform((value) => String(value)),
                encode: SchemaGetter.transformOrFail((value) =>
                  value === "valid"
                    ? Effect.succeed(true)
                    : Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message: "invalid output" })),
                ),
              }),
            ),
          }),
          execute: () => Effect.succeed({ value: "invalid" }),
        }),
      })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "invalid-output", name: "invalid_output", input: {} },
        }),
      ).toMatchObject({ type: "error", value: expect.stringContaining("invalid value for its output schema") })
    }),
  )

  it.effect("executes the unchanged registration advertised for a provider turn", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const materialized = yield* service.materialize()

      expect((yield* materialized.settle(call("echo"))).result).toEqual({ type: "text", value: "echo" })
    }),
  )

  it.effect("rejects a call when its advertised registration was removed", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* service.register({ echo: make() }).pipe(Scope.provide(scope))
      const materialized = yield* service.materialize()
      yield* Scope.close(scope, Exit.void)

      expect((yield* materialized.settle(call("echo"))).result).toEqual({
        type: "error",
        value: "Stale tool call: echo",
      })
    }),
  )

  it.effect("rejects only the replaced name from a multi-tool provider turn", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ first: make(), second: make() })
      const materialized = yield* service.materialize()
      yield* service.register({ first: make() })

      expect((yield* materialized.settle(call("first"))).result).toEqual({
        type: "error",
        value: "Stale tool call: first",
      })
      expect((yield* materialized.settle(call("second"))).result).toEqual({ type: "text", value: "second" })
    }),
  )

  it.effect("treats revealing a previous overlay as stale", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const overlay = yield* Scope.make()
      yield* service.register({ echo: make() }).pipe(Scope.provide(overlay))
      const materialized = yield* service.materialize()
      yield* Scope.close(overlay, Exit.void)

      expect((yield* materialized.settle(call("echo"))).result).toEqual({
        type: "error",
        value: "Stale tool call: echo",
      })
    }),
  )

  integrated.effect("rejects an application call after a Location override is registered", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const service = yield* ToolRegistry.Service
      yield* applications.register({ echo: make() })
      const materialized = yield* service.materialize()
      yield* service.register({ echo: make() })

      expect((yield* materialized.settle(call("echo"))).result).toEqual({
        type: "error",
        value: "Stale tool call: echo",
      })
    }),
  )

  integrated.effect("rejects a Location call after removal reveals an application registration", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const service = yield* ToolRegistry.Service
      yield* applications.register({ echo: make() })
      const scope = yield* Scope.make()
      yield* service.register({ echo: make() }).pipe(Scope.provide(scope))
      const materialized = yield* service.materialize()
      yield* Scope.close(scope, Exit.void)

      expect((yield* materialized.settle(call("echo"))).result).toEqual({
        type: "error",
        value: "Stale tool call: echo",
      })
    }),
  )

  it.effect("keeps captured execution running after registration mutation", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* service
        .register({
          echo: Tool.make({
            description: "Echo text",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            execute: ({ text }) =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as({ text })),
            toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          }),
        })
        .pipe(Scope.provide(scope))
      const materialized = yield* service.materialize()
      const settlement = yield* materialized.settle(call("echo")).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Scope.close(scope, Exit.void)
      yield* service.register({ echo: make() })
      yield* Deferred.succeed(release, undefined)

      expect(yield* Fiber.join(settlement)).toMatchObject({ result: { type: "text", value: "echo" } })
    }),
  )
})

const conversationHooks = (
  change: Partial<SessionConversationHooks.Interface> = {},
): SessionConversationHooks.Interface => ({
  admit: () => Effect.void,
  beforeTool: (input) => Effect.succeed({ toolInput: input.toolInput }),
  afterTool: () => Effect.succeed({}),
  ...change,
})
it.effect("invalid original input does not run tool hooks", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    yield* registry.register({ echo: make() })
    let hooks = 0
    const input = call("echo")
    const result = yield* settleTool(registry, { ...input, call: { ...input.call, input: { text: 5 } } }).pipe(
      Effect.provideService(
        SessionConversationHooks.Service,
        conversationHooks({
          beforeTool: (input) =>
            Effect.sync(() => {
              hooks++
              return { toolInput: input.toolInput }
            }),
          afterTool: () =>
            Effect.sync(() => {
              hooks++
              return {}
            }),
        }),
      ),
    )
    expect(result.result.type).toBe("error")
    expect(hooks).toBe(0)
  }),
)
for (const replacement of [{ text: "replaced" }, null])
  it.effect(`hook output replacement uses canonical output codec: ${replacement === null ? "invalid" : "valid"}`, () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.register({ echo: make() })
      const result = yield* settleTool(registry, call("echo")).pipe(
        Effect.provideService(
          SessionConversationHooks.Service,
          conversationHooks({ afterTool: () => Effect.succeed({ hasReplacement: true, replacement }) }),
        ),
      )
      expect(result.result).toEqual({ type: "text", value: replacement === null ? "echo" : "replaced" })
    }),
  )
it.effect("a custom shadow never gains permission rewrite from its tool name", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    let executions = 0
    yield* registry.register({
      write: Tool.make({
        description: "custom",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.String,
        execute: () =>
          Effect.gen(function* () {
            executions++
            const scope = Option.getOrUndefined(yield* Effect.serviceOption(PermissionHookScope.Service))
            if (scope) scope.pendingInput = { text: "replacement" }
            return yield* new Tool.Failure({ message: "permission replacement" })
          }),
      }),
    })
    const result = yield* settleTool(registry, call("write")).pipe(
      Effect.provideService(
        SessionConversationHooks.Service,
        conversationHooks({
          beforeTool: (input) =>
            Effect.succeed({
              toolInput: input.toolInput,
              permissionHooks: {
                policy: () => Effect.succeed({ rules: [] }),
                request: () => Effect.succeed({}),
                confirm: () => Effect.void,
              },
            }),
        }),
      ),
    )
    expect(result.result).toEqual({
      type: "error",
      value: "Permission input replacement cannot safely restart this tool",
    })
    expect(executions).toBe(1)
  }),
)
