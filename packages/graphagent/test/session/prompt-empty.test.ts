// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { NodeFileSystem } from "@effect/platform-node"
import { Database } from "@graphagent/core/database/database"
import { FetchHttpClient } from "effect/http"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SessionRunState } from "../../src/session/run-state"
import { SessionRevert } from "../../src/session/revert"
import { SessionCompaction } from "../../src/session/compaction"
import { AgentScheduler } from "../../src/session/agent-scheduler"
import { Instruction } from "../../src/session/instruction"
import { SystemPrompt } from "../../src/session/system"
import { Image } from "../../src/image/image"
import { Snapshot } from "../../src/snapshot"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { Permission } from "../../src/permission"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { FSUtil } from "@graphagent/core/fs-util"
import { BackgroundJob } from "@/background/job"
import { Todo } from "../../src/session/todo"
import { Question } from "../../src/question"
import { ToolRegistry } from "@/tool/registry"
import { FileState } from "@/session/file-state"
import { Truncate } from "@/tool/truncate"
import { SettingsHook, type HookPayload } from "@/hook"
import { Dag } from "@/dag/dag"
import { DagControl } from "@/dag/control"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagStore } from "@graphagent/core/dag/store"
import { DagAgentMessages } from "@/dag/agent-messages"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import { Memory } from "@/memory/memory"
import { Skill } from "../../src/skill"
import { Goal } from "@/goal/goal"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { Format } from "../../src/format"
import { EventV2Bridge } from "@/event-v2-bridge"
import { it } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMEvent } from "@graphagent/llm"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Stream } from "effect"
import { TuiEvent } from "@graphagent/schema/tui-event"
import { ChildRegistry } from "../../src/session/child/registry"
import { HINT_TEXT, renderHint } from "../../src/session/turn/hints"
import { ToolError } from "../../src/tool/tool-error"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarizeTurn: () => Effect.void,
    read: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.succeed<LSP.Diagnostic.CheckStatus>("checked"),
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed([]),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-empty tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-empty tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-empty tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const hookRecorded: HookPayload[] = []
const hookRecorderLayer = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: (payload) =>
      Effect.gen(function* () {
        hookRecorded.push(payload)
        return {
          blocked: undefined,
          preventContinuation: false,
          permissionDecision: undefined,
          permissionDecisionReason: undefined,
          additionalContexts: [],
          systemMessages: [],
          hookSpecificOutput: undefined,
        }
      }),
    list: () => Effect.succeed([]),
  }),
)

const memoryLayer = Layer.mock(Memory.Service, {
  init: () => Effect.void,
  prepare: () => Effect.void,
  context: () => Effect.succeed([]),
  checkpoint: () => Effect.succeed([]),
  setEnabled: (enabled) => Effect.succeed(enabled ? ("Memory on" as const) : ("Memory off" as const)),
  statusReason: () => Effect.succeed(undefined),
  status: () => Effect.succeed("Memory on"),
})

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

const flags = RuntimeFlags.layer()

const deps = Layer.mergeAll(
  hookRecorderLayer,
  memoryLayer,
  Session.defaultLayer,
  Snapshot.defaultLayer,
  Env.defaultLayer,
  AgentSvc.defaultLayer,
  Command.defaultLayer,
  Permission.defaultLayer,
  Config.defaultLayer,
  ProviderSvc.defaultLayer,
  lsp,
  mcp,
  FSUtil.defaultLayer,
  BackgroundJob.defaultLayer,
  status,
  Database.defaultLayer,
  DagMessages.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
  AgentScheduler.defaultLayer,
).pipe(Layer.provideMerge(infra))

const question = Question.layer.pipe(Layer.provideMerge(deps))
const todo = Todo.layer.pipe(Layer.provideMerge(deps))
const registry = ToolRegistry.layer.pipe(
  Layer.provide(DagAgentMessages.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Dag.defaultLayer),
  Layer.provide(DagControl.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(Ripgrep.defaultLayer),
  Layer.provide(Format.defaultLayer),
  Layer.provide(FileState.defaultLayer),
  Layer.provide(flags),
  Layer.provideMerge(todo),
  Layer.provideMerge(question),
  Layer.provideMerge(deps),
)
const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))

const makePrompt = (llmLayer: Layer.Layer<LLM.Service>) => {
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(deps),
    Layer.provideMerge(llmLayer),
  )
  const compact = SessionCompaction.layer.pipe(Layer.provide(flags), Layer.provideMerge(proc), Layer.provideMerge(deps))
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(Goal.defaultLayer),
    Layer.provide(
      SystemPrompt.layer.pipe(
        Layer.provide(Skill.defaultLayer),
        Layer.provide(LocationServiceMap.layer),
        Layer.provide(Goal.defaultLayer),
        Layer.provide(deps),
      ),
    ),
    Layer.provide(flags),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

const emptyUnknown: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
  LLMEvent.finish({ reason: "unknown" }),
]

const validScript: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-1" }),
  LLMEvent.textDelta({ id: "text-1", text: "done" }),
  LLMEvent.textEnd({ id: "text-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

it.instance(
  "session.prompt loop retries an empty response and finishes the same turn with real content",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const llmLayer = Layer.succeed(
        LLM.Service,
        LLM.Service.of({
          organizer: () => Effect.succeed(undefined),
          stream: () => {
            const script = calls === 0 ? emptyUnknown : validScript
            calls += 1
            return Stream.fromIterable(script)
          },
        }),
      )
      yield* Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Empty retry" })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "say something" }],
        })

        const looped = yield* prompt.loop({ sessionID: chat.id })

        expect(looped.info.role).toBe("assistant")
        if (looped.info.role !== "assistant") throw new Error("expected an assistant reply")
        expect(looped.info.finish).toBe("stop")
        expect(looped.info.error).toBeUndefined()
        expect(looped.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
        expect(calls).toBe(2)

        // Single-turn history: exactly one user and one assistant message.
        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages).toHaveLength(2)
        expect(messages[0]?.info.role).toBe("user")
        expect(messages[1]?.info.role).toBe("assistant")
        expect(messages[1]?.info.id).toBe(looped.info.id)
      }).pipe(Effect.provide(makePrompt(llmLayer)))
    }),
  { config: cfg },
)

const pseudoToolCallScript: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-1" }),
  LLMEvent.textDelta({
    id: "text-1",
    text: 'Reading it now.\n<tool_call>{"name":"read","arguments":{}}</tool_call>',
  }),
  LLMEvent.textEnd({ id: "text-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

/** Plain text of one model message, whatever shape the content has. */
const messageText = (message: LLM.StreamInput["messages"][number] | undefined) => {
  if (!message) return ""
  if (typeof message.content === "string") return message.content
  return message.content.map((part) => ("text" in part ? part.text : "")).join("")
}

it.instance(
  "session.prompt loop answers a tool call written into the text with one runtime hint and a second step",
  () =>
    Effect.gen(function* () {
      const requests: LLM.StreamInput["messages"][] = []
      const llmLayer = Layer.succeed(
        LLM.Service,
        LLM.Service.of({
          organizer: () => Effect.succeed(undefined),
          stream: (input) => {
            const script = requests.length === 0 ? pseudoToolCallScript : validScript
            requests.push(input.messages)
            return Stream.fromIterable(script)
          },
        }),
      )
      yield* Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pseudo tool call" })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "read the file" }],
        })

        const looped = yield* prompt.loop({ sessionID: chat.id })

        expect(requests).toHaveLength(2)
        expect(looped.info.role).toBe("assistant")
        if (looped.info.role !== "assistant") throw new Error("expected an assistant reply")
        expect(looped.info.error).toBeUndefined()
        expect(looped.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)

        // user, the assistant reply with the pseudo call, the runtime hint, the second reply.
        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages.map((message) => message.info.role)).toEqual(["user", "assistant", "user", "assistant"])

        // The second request ends with the hint as a user message; the first request did not carry it.
        expect(messageText(requests[0]?.at(-1))).not.toContain(HINT_TEXT.pseudo_tool_call)
        const lastOfSecond = requests[1]?.at(-1)
        expect(lastOfSecond?.role).toBe("user")
        expect(messageText(lastOfSecond)).toContain(HINT_TEXT.pseudo_tool_call)
      }).pipe(Effect.provide(makePrompt(llmLayer)))
    }),
  { config: cfg },
)

// The turn's mode is read from its last user message, so the runtime hint that continues the turn must carry it.
for (const hookMode of ["interactive", "noninteractive", undefined] as const) {
  it.instance(
    `session.prompt loop keeps the turn's hook mode on the runtime hint message (${hookMode ?? "unset"})`,
    () =>
      Effect.gen(function* () {
        let calls = 0
        const llmLayer = Layer.succeed(
          LLM.Service,
          LLM.Service.of({
            organizer: () => Effect.succeed(undefined),
            stream: () => {
              const script = calls === 0 ? pseudoToolCallScript : validScript
              calls += 1
              return Stream.fromIterable(script)
            },
          }),
        )
        yield* Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Hint hook mode" })
          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            ...(hookMode === undefined ? {} : { hookMode }),
            parts: [{ type: "text", text: "read the file" }],
          })

          yield* prompt.loop({ sessionID: chat.id })

          expect(calls).toBe(2)
          const messages = yield* sessions.messages({ sessionID: chat.id })
          const users = messages.flatMap((message) => (message.info.role === "user" ? [message.info] : []))
          // The original message holds the mode the turn was started with; the hint continues the same turn.
          expect(users).toHaveLength(2)
          expect(users[0]?.hookMode).toBe(hookMode)
          expect(users[1]?.hookMode).toBe(hookMode)
        }).pipe(Effect.provide(makePrompt(llmLayer)))
      }),
    { config: cfg },
  )
}

// ---------------------------------------------------------------------------
// Output cut off by the output limit (#1464)
// ---------------------------------------------------------------------------

/** What the model requests receive: each request takes the next script, the last one repeats. */
const scriptedLLM = (scripts: ReadonlyArray<ReadonlyArray<LLMEvent>>) => {
  const requests: LLM.StreamInput["messages"][] = []
  const layer = Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      organizer: () => Effect.succeed(undefined),
      stream: (input) => {
        const script = scripts[Math.min(requests.length, scripts.length - 1)]
        requests.push(input.messages)
        return Stream.fromIterable(script)
      },
    }),
  )
  return { requests, layer }
}

const textsOf = (parts: ReadonlyArray<SessionV1.Part>) =>
  parts.flatMap((part) => (part.type === "text" ? [part.text] : []))

const cutText: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-1" }),
  LLMEvent.textDelta({ id: "text-1", text: "The report begins with" }),
  LLMEvent.textEnd({ id: "text-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "length" }),
  LLMEvent.finish({ reason: "length" }),
]

it.instance(
  "session.prompt loop continues a text cut off by the output limit with one runtime hint and a second request",
  () =>
    Effect.gen(function* () {
      const { requests, layer } = scriptedLLM([cutText, validScript])
      yield* Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Cut text" })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "write the report" }],
        })

        const looped = yield* prompt.loop({ sessionID: chat.id })

        expect(requests).toHaveLength(2)
        expect(looped.info.role).toBe("assistant")
        if (looped.info.role !== "assistant") throw new Error("expected an assistant reply")
        // The turn returns the last assistant message, which holds only what was written after the cut.
        expect(looped.info.finish).toBe("stop")
        expect(looped.info.error).toBeUndefined()
        expect(textsOf(looped.parts)).toEqual(["done"])

        // user, the cut-off reply, the runtime hint, the continuation.
        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages.map((message) => message.info.role)).toEqual(["user", "assistant", "user", "assistant"])
        // The cut-off message keeps its text and its finish.
        const cut = messages[1]
        expect(cut?.info.role === "assistant" ? cut.info.finish : undefined).toBe("length")
        expect(textsOf(cut?.parts ?? [])).toEqual(["The report begins with"])
        // The hint is one synthetic text part, rendered by renderHint.
        const hint = messages[2]
        expect(hint?.parts).toHaveLength(1)
        expect(hint?.parts[0]).toMatchObject({ type: "text", text: renderHint("output_truncated"), synthetic: true })

        // The second request ends with the hint after the cut-off reply; the first did not carry it.
        expect(messageText(requests[0]?.at(-1))).not.toContain(HINT_TEXT.output_truncated)
        const lastOfSecond = requests[1]?.at(-1)
        expect(lastOfSecond?.role).toBe("user")
        expect(messageText(lastOfSecond)).toContain(renderHint("output_truncated"))
        expect(JSON.stringify(requests[1])).toContain("The report begins with")
      }).pipe(Effect.provide(makePrompt(layer)))
    }),
  { config: cfg },
)

it.instance(
  "session.prompt loop stops after three continuations, ends on length and tells the user once",
  () =>
    Effect.gen(function* () {
      const { requests, layer } = scriptedLLM([cutText])
      yield* Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const toasts: unknown[] = []
        const off = yield* events.listen((event) => {
          if (event.type === TuiEvent.ToastShow.type) toasts.push(event.data)
          return Effect.void
        })
        const chat = yield* sessions.create({ title: "Always cut" })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "write the report" }],
        })

        const looped = yield* prompt.loop({ sessionID: chat.id })
        yield* off

        // The first request and three continuations; the fourth reply is still cut off and no fifth request follows.
        expect(requests).toHaveLength(4)
        expect(looped.info.role).toBe("assistant")
        if (looped.info.role !== "assistant") throw new Error("expected an assistant reply")
        expect(looped.info.finish).toBe("length")
        expect(looped.info.error).toBeUndefined()

        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages.map((message) => message.info.role)).toEqual([
          "user",
          "assistant",
          "user",
          "assistant",
          "user",
          "assistant",
          "user",
          "assistant",
        ])
        const hints = messages.filter((message, index) => message.info.role === "user" && index > 0)
        expect(hints).toHaveLength(3)
        for (const hint of hints) expect(textsOf(hint.parts)).toEqual([renderHint("output_truncated")])

        // The user hears about it once: a warning toast titled Output limit.
        expect(toasts).toEqual([expect.objectContaining({ title: "Output limit", variant: "warning" })])
      }).pipe(Effect.provide(makePrompt(layer)))
    }),
  { config: cfg },
)

it.instance(
  "session.prompt loop does not continue a cut-off reply of a child session",
  () =>
    Effect.gen(function* () {
      const { requests, layer } = scriptedLLM([cutText, validScript])
      yield* Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const toasts: unknown[] = []
        const off = yield* events.listen((event) => {
          if (event.type === TuiEvent.ToastShow.type) toasts.push(event.data)
          return Effect.void
        })
        const parent = yield* sessions.create({ title: "Parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
        const run = yield* (yield* prompt.children).start({
          parentSessionID: parent.id,
          childSessionID: child.id,
          owner: { kind: "task", toolCallID: "call_1" },
          detached: false,
        })
        yield* prompt.prompt(
          {
            sessionID: child.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "write the report" }],
          },
          undefined,
          { credential: ChildRegistry.credentialOf(child.id) },
        )

        const looped = yield* prompt.loop({ sessionID: child.id })
        yield* off
        yield* run.settle({ type: "completed" })

        // The owner of a child session decides what to do with a cut-off result.
        expect(requests).toHaveLength(1)
        expect(looped.info.role === "assistant" ? looped.info.finish : undefined).toBe("length")
        const messages = yield* sessions.messages({ sessionID: child.id })
        expect(messages.map((message) => message.info.role)).toEqual(["user", "assistant"])
        expect(toasts).toEqual([])
      }).pipe(Effect.provide(makePrompt(layer)))
    }),
  { config: cfg },
)

it.instance(
  "session.prompt loop does not continue a length finish that wrote no answer text",
  () =>
    Effect.gen(function* () {
      const { requests, layer } = scriptedLLM([
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reason-1" }),
          LLMEvent.reasoningDelta({ id: "reason-1", text: "thinking without end" }),
          LLMEvent.reasoningEnd({ id: "reason-1" }),
          LLMEvent.stepFinish({ index: 0, reason: "length" }),
          LLMEvent.finish({ reason: "length" }),
        ],
        validScript,
      ])
      yield* Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Reasoning only" })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "think hard" }],
        })

        const looped = yield* prompt.loop({ sessionID: chat.id })

        expect(requests).toHaveLength(1)
        expect(looped.info.role === "assistant" ? looped.info.finish : undefined).toBe("length")
      }).pipe(Effect.provide(makePrompt(layer)))
    }),
  { config: cfg },
)

const cutWriteInput = '{"filePath":"a.ts","content":"const a'

const cutWrite: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolInputStart({ id: "call-1", name: "write" }),
  LLMEvent.toolInputDelta({ id: "call-1", name: "write", text: cutWriteInput }),
  LLMEvent.stepFinish({ index: 0, reason: "length" }),
  LLMEvent.finish({ reason: "length" }),
]

const toolPartsOf = (parts: ReadonlyArray<SessionV1.Part>) =>
  parts.flatMap((part) => (part.type === "tool" ? [part] : []))

it.instance(
  "session.prompt loop answers a tool call cut off by the output limit with an error and a second request",
  () =>
    Effect.gen(function* () {
      const { requests, layer } = scriptedLLM([cutWrite, validScript])
      yield* Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Cut write" })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "write the file" }],
        })

        const looped = yield* prompt.loop({ sessionID: chat.id })

        expect(requests).toHaveLength(2)
        expect(looped.info.role === "assistant" ? looped.info.finish : undefined).toBe("stop")
        expect(textsOf(looped.parts)).toEqual(["done"])

        // No hint message: the error of the call is what the next request carries.
        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages.map((message) => message.info.role)).toEqual(["user", "assistant", "assistant"])
        const calls = toolPartsOf(messages[1]?.parts ?? [])
        expect(calls).toHaveLength(1)
        const cut = calls[0]
        expect(cut?.state.status).toBe("error")
        if (cut?.state.status === "error") {
          expect(cut.state.error).toBe(
            ToolError.render({ kind: "truncated_arguments", tool: "write", length: cutWriteInput.length }),
          )
          expect(cut.state.metadata?.argumentsTruncated).toBe(true)
          expect(cut.state.metadata?.outcome).toBe("arguments_truncated")
          expect(cut.state.metadata?.interrupted).toBeUndefined()
        }
        expect(JSON.stringify(requests[1])).toContain("were cut off at character")
      }).pipe(Effect.provide(makePrompt(layer)))
    }),
  { config: cfg },
)

it.instance(
  "session.prompt loop answers a cut-off tool call with its error, not with a text continuation hint",
  () =>
    Effect.gen(function* () {
      const { requests, layer } = scriptedLLM([
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-1" }),
          LLMEvent.textDelta({ id: "text-1", text: "Writing the file now." }),
          LLMEvent.textEnd({ id: "text-1" }),
          LLMEvent.toolInputStart({ id: "call-1", name: "write" }),
          LLMEvent.toolInputDelta({ id: "call-1", name: "write", text: cutWriteInput }),
          LLMEvent.stepFinish({ index: 0, reason: "length" }),
          LLMEvent.finish({ reason: "length" }),
        ],
        validScript,
      ])
      yield* Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Text and cut write" })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "write the file" }],
        })

        yield* prompt.loop({ sessionID: chat.id })

        expect(requests).toHaveLength(2)
        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages.map((message) => message.info.role)).toEqual(["user", "assistant", "assistant"])
        expect(JSON.stringify(requests[1])).not.toContain(HINT_TEXT.output_truncated)
      }).pipe(Effect.provide(makePrompt(layer)))
    }),
  { config: cfg },
)
