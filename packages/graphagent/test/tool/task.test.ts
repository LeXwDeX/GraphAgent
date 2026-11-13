import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { SettingsHook, type TriggerResult } from "@/hook"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { WorkflowTool } from "../../src/tool/workflow"
import { GoalLoop } from "@/goal/loop"
import type { Goal } from "@/goal/goal"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { initTaskTool } from "../lib/child-runs"
import { ChildBindingTable, ChildRunTable } from "@graphagent/core/session/child.sql"
import { ChildRegistry } from "@/session/child/registry"
import { ChildStore } from "@/session/child/store"
import { EngineProcess } from "@/session/engine-process"
import { eq } from "drizzle-orm"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    EventV2Bridge.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    Database.defaultLayer,
    RuntimeFlags.layer(flags),
  ).pipe(Layer.provide(Ripgrep.defaultLayer))

const it = testEffect(layer())
const background = testEffect(layer())
const goalWakes: { sessionID: string; match: Goal.WakeMatch; payload?: string; evaluate?: boolean }[] = []
const backgroundWithGoal = testEffect(
  Layer.mergeAll(
    layer(),
    Layer.succeed(
      GoalLoop.Service,
      GoalLoop.Service.of({
        init: () => Effect.void,
        wake: (sessionID, match, payload, options) =>
          Effect.sync(() => {
            goalWakes.push({ sessionID, match, payload, evaluate: options?.evaluate })
            return true
          }),
      }),
    ),
  ),
)
const stopped = testEffect(
  Layer.mergeAll(
    layer(),
    Layer.mock(SettingsHook.Service, {
      trigger: (payload): Effect.Effect<TriggerResult> =>
        Effect.succeed(
          payload.event === "SubagentStop" && !payload.stopHookActive
            ? {
                additionalContexts: [],
                systemMessages: [],
                blocked: { reason: "verify the continuation", command: "mock" },
              }
            : { additionalContexts: [], systemMessages: [] },
        ),
      unregisterScoped: () => Effect.void,
    }),
  ),
)
const executeRaw = (execute: Tool.Def["execute"]) =>
  // oxlint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- test shim: invoke the wrapped execute with unrepaired raw args
  execute as unknown as (args: unknown, ctx: Tool.Context) => Effect.Effect<Tool.ExecuteResult>

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function assistantReply(
  input: SessionPrompt.PromptInput,
  options: { text: string; finish?: string; reasoning?: number; output?: number; error?: SessionV1.Assistant["error"] },
): SessionV1.WithParts {
  const message = reply(input, options.text)
  if (message.info.role !== "assistant") return message
  return {
    ...message,
    info: {
      ...message.info,
      ...(options.error ? { error: options.error } : {}),
      finish: options.finish ?? "stop",
      tokens: {
        ...message.info.tokens,
        output: options.output ?? 0,
        reasoning: options.reasoning ?? 0,
      },
    },
  }
}

const TRUNCATED = { text: "", finish: "length", reasoning: 32_000, output: 0 } as const

describe("tool.task", () => {
  it.instance("rejects direct task execution from a child before permission or session creation", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ title: "DAG child", parentID: chat.id })
      const state = { asks: 0, prompts: 0 }
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      const exit = yield* def
        .execute(
          {
            description: "escape orchestration",
            prompt: "start an unmanaged grandchild",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: assistant.id,
            agent: "plan",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                onPrompt: () => {
                  state.prompts += 1
                },
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () =>
              Effect.sync(() => {
                state.asks += 1
              }),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(state).toEqual({ asks: 0, prompts: 0 })
      expect((yield* sessions.list()).filter((info) => info.parentID === child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        if (!build) throw new Error("Expected configured agent fixture")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "workflow description lists configured subagents in stable name order",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        if (!build) throw new Error("Expected configured agent fixture")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === WorkflowTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)
        expect(first.indexOf("- alpha: Alpha agent")).toBeGreaterThan(-1)
        expect(first).toContain("- alpha: Alpha agent [model: inherited]")
        expect(first.indexOf("- zebra: Zebra agent")).toBeGreaterThan(first.indexOf("- alpha: Alpha agent"))
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "workflow description excludes primary hidden and denied agents",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        if (!build) throw new Error("Expected configured agent fixture")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === WorkflowTool.id)?.description ??
          ""
        const taskDescription =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("denied-agent")
        expect(description).not.toContain("hidden-agent")
        expect(description).not.toContain("primary-agent")
        expect(taskDescription).toContain("- hidden-agent: Hidden agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            "denied-agent": "deny",
          },
        },
        agent: {
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
          "denied-agent": {
            description: "Denied agent",
            mode: "subagent",
          },
          "hidden-agent": {
            description: "Hidden agent",
            mode: "subagent",
            hidden: true,
          },
          "primary-agent": {
            description: "Primary agent",
            mode: "primary",
          },
        },
      },
    },
  )

  it.instance(
    "workflow description exposes concise role metadata without prompts or permissions",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        if (!build) throw new Error("Expected configured agent fixture")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === WorkflowTool.id)?.description ??
          ""

        expect(description).toContain("- alpha: Alpha agent [model: configured]")
        expect(description).not.toContain("SECRET SYSTEM PROMPT")
        expect(description).not.toContain("dangerous-command")
      }),
    {
      config: {
        agent: {
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
            model: "test/test-model",
            prompt: "SECRET SYSTEM PROMPT",
            permission: {
              "dangerous-command": "deny",
            },
          },
        },
      },
    },
  )

  it.instance(
    "workflow catalog leaves the task tool agent guidance compatible",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        if (!build) throw new Error("Expected configured agent fixture")
        const registry = yield* ToolRegistry.Service
        const tools = yield* registry.tools({ ...ref, agent: build })
        const taskDescription = tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        const workflowDescription = tools.find((tool) => tool.id === WorkflowTool.id)?.description ?? ""

        expect(taskDescription).toContain("Available agent types:")
        expect(taskDescription).toContain("- alpha: Alpha agent")
        expect(taskDescription).not.toContain("Available workflow worker_type values:")
        expect(workflowDescription).toContain("Available workflow worker_type values:")
      }),
    {
      config: {
        agent: {
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("workflow worker_type catalog lists primary build and plan, task catalog does not", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("Expected configured agent fixture")
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({ ...ref, agent: build })
      const taskDescription = tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
      const workflowDescription = tools.find((tool) => tool.id === WorkflowTool.id)?.description ?? ""

      // blocks compile coding/prototype to build and plan blocks to plan, so
      // the workflow catalog must let the model name them explicitly
      expect(workflowDescription).toContain("- build:")
      expect(workflowDescription).toContain("- plan:")
      expect(workflowDescription).toContain("- general:")
      expect(workflowDescription).toContain("- explore:")
      // hidden primaries stay hidden and the task catalog stays subagent-only
      expect(workflowDescription).not.toContain("- compaction:")
      expect(taskDescription).not.toContain("- build:")
      expect(taskDescription).not.toContain("- plan:")
    }),
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        if (!build) throw new Error("Expected configured agent fixture")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      // An earlier task run of this conversation that already finished.
      const earlier = yield* def.children
        .forParent(chat.id)
        .start({ childSessionID: child.id, owner: { kind: "task", toolCallID: "call_earlier" }, detached: false })
      yield* earlier.settle({ type: "completed" })
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionID).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute reports a child that ended on an error instead of an empty completion", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.sync(() => {
            const message = reply(input, "half an answer")
            if (message.info.role !== "assistant") return message
            return {
              ...message,
              info: { ...message.info, error: { name: "MessageOutputLengthError" as const, data: {} } },
            }
          }),
      }

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("MessageOutputLengthError")
        expect(message).toContain("half an answer")
      }
    }),
  )

  it.instance("continues a child truncated at the output cap once and returns the continued answer", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      const prompts: { input: SessionPrompt.PromptInput; options?: SessionPrompt.AdmissionOptions }[] = []
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input, options) =>
          Effect.sync(() => {
            prompts.push({ input, options })
            return prompts.length === 1
              ? assistantReply(input, TRUNCATED)
              : assistantReply(input, { text: "CONTINUED ANSWER" })
          }),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "review the diff",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain('state="completed"')
      expect(result.output).toContain("CONTINUED ANSWER")
      expect(prompts).toHaveLength(2)
      expect(prompts[0]?.options).toEqual({ internalDelegation: true })
      expect(prompts[1]?.options).toEqual({ continueToolBudget: true, internalDelegation: true })
      expect(prompts[1]?.input.sessionID).toBe(prompts[0]?.input.sessionID)
      const continuation = prompts[1]?.input.parts[0]
      expect(continuation?.type).toBe("text")
      if (continuation?.type === "text") expect(continuation.text).toContain("output token limit")
    }),
  )

  it.instance("fails a foreground child still truncated after one continuation with the token split", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      let prompts = 0
      let childSession = ""
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            prompts += 1
            childSession ||= input.sessionID
            return assistantReply(input, TRUNCATED)
          }),
      }

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "review the diff",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(prompts).toBe(2)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("output token cap")
        expect(message).toContain("reasoning 32000")
        expect(message).toContain("text 0")
        expect(message).toContain(`task_id="${childSession}"`)
        expect(message).toContain('prompt="Continue the task and write the final answer now."')
      }
    }),
  )

  it.instance("fails a foreground child whose continued answer is empty", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      let prompts = 0
      let childSession = ""
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            prompts += 1
            childSession ||= input.sessionID
            return prompts === 1 ? assistantReply(input, TRUNCATED) : assistantReply(input, { text: "" })
          }),
      }

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "review the diff",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(prompts).toBe(2)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("empty final answer")
        expect(message).toContain(`task_id="${childSession}"`)
      }
    }),
  )

  const PARTIAL = { text: "PARTIAL", finish: "length", output: 100 } as const

  const partialRetention = [
    {
      name: "empty continued answer",
      second: (input: SessionPrompt.PromptInput) => Effect.succeed(assistantReply(input, { text: "" })),
      expected: "empty final answer",
    },
    {
      name: "continued provider error",
      second: (input: SessionPrompt.PromptInput) =>
        Effect.succeed(
          assistantReply(input, { text: "", error: { name: "MessageOutputLengthError" as const, data: {} } }),
        ),
      expected: "MessageOutputLengthError",
    },
    {
      name: "continued execution defect",
      second: () => Effect.die(new Error("continuation socket closed")),
      expected: "continuation socket closed",
    },
  ] as const

  for (const scenario of partialRetention) {
    it.instance(`retains the first partial answer when the continuation fails with ${scenario.name}`, () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* initTaskTool(tool)
        let prompts = 0
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) => {
            prompts += 1
            return prompts === 1 ? Effect.succeed(assistantReply(input, PARTIAL)) : scenario.second(input)
          },
        }

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "review the diff",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(prompts).toBe(2)
        if (Exit.isFailure(exit)) {
          const message = Cause.pretty(exit.cause)
          expect(message).toContain(scenario.expected)
          expect(message).toContain("PARTIAL")
        }
      }),
    )
  }

  background.instance("background task truncated after one continuation settles as an error", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let childPrompts = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id)
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "noted")))
          childPrompts += 1
          return Effect.succeed(assistantReply(input, TRUNCATED))
        },
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "review the diff",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionID, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("error")
      expect(waited.info?.error).toContain("output token cap")
      expect(waited.info?.error).toContain("reasoning 32000")
      expect(childPrompts).toBe(2)
      const notification = yield* awaitWithTimeout(
        Deferred.await(injected),
        "background truncation result was not injected into the parent",
      )
      const part = notification.parts[0]
      expect(part?.type).toBe("text")
      if (part?.type === "text") {
        expect(part.text).toContain('state="error"')
        expect(part.text).toContain("output token cap")
        expect(part.text).not.toContain('state="completed"')
      }
    }),
  )

  background.instance("background task failure notification retains the first partial answer", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let childPrompts = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id)
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "noted")))
          childPrompts += 1
          return Effect.succeed(
            childPrompts === 1 ? assistantReply(input, PARTIAL) : assistantReply(input, { text: "" }),
          )
        },
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "review the diff",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionID, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("error")
      expect(waited.info?.error).toContain("empty final answer")
      expect(waited.info?.error).toContain("PARTIAL")
      expect(childPrompts).toBe(2)
      const notification = yield* awaitWithTimeout(
        Deferred.await(injected),
        "background failure result was not injected into the parent",
      )
      const part = notification.parts[0]
      expect(part?.type).toBe("text")
      if (part?.type === "text") {
        expect(part.text).toContain('state="error"')
        expect(part.text).toContain("PARTIAL")
        expect(part.text).not.toContain('state="completed"')
      }
    }),
  )

  stopped.instance("fails a SubagentStop continuation whose continued answer is truncated", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      let prompts = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            prompts += 1
            return prompts === 1 ? assistantReply(input, { text: "FIRST ANSWER" }) : assistantReply(input, TRUNCATED)
          }),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "review the diff",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain('state="error"')
      expect(result.output).toContain("output token cap")
      expect(result.output).toContain("reasoning 32000")
      expect(result.output).not.toContain('state="completed"')
      expect(prompts).toBe(2)
    }),
  )

  stopped.instance("returns a complete SubagentStop continuation answer to the parent", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      let prompts = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            prompts += 1
            return prompts === 1
              ? assistantReply(input, { text: "STALE-FIRST-ANSWER" })
              : assistantReply(input, { text: "FINAL-VERIFIED-ANSWER" })
          }),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "review the diff",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain('state="completed"')
      expect(result.output).toContain("FINAL-VERIFIED-ANSWER")
      expect(result.output).not.toContain("STALE-FIRST-ANSWER")
      expect(prompts).toBe(2)
    }),
  )

  stopped.instance("fails the task when a SubagentStop continuation execution fails", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      let prompts = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          prompts += 1
          return prompts === 1
            ? Effect.succeed(assistantReply(input, { text: "FIRST ANSWER" }))
            : Effect.die(new Error("stop continuation socket closed"))
        },
      }

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "review the diff",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(prompts).toBe(2)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("stop continuation socket closed")
        expect(message).not.toContain('state="completed"')
      }
    }),
  )

  stopped.instance("fails the task when a SubagentStop continuation ends on a provider error", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      let prompts = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.succeed(
            prompts++ === 0
              ? assistantReply(input, { text: "FIRST ANSWER" })
              : assistantReply(input, {
                  text: "PARTIAL",
                  error: { name: "MessageOutputLengthError" as const, data: {} },
                }),
          ),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "review the diff",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain('state="error"')
      expect(result.output).toContain("MessageOutputLengthError")
      expect(result.output).toContain("PARTIAL")
      expect(result.output).not.toContain('state="completed"')
      expect(prompts).toBe(2)
    }),
  )

  stopped.instance("propagates interruption from a SubagentStop continuation", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      let prompts = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          prompts += 1
          return prompts === 1 ? Effect.succeed(assistantReply(input, { text: "FIRST ANSWER" })) : Effect.interrupt
        },
      }

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "review the diff",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(prompts).toBe(2)
      if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute refuses a missing task_id without creating a replacement child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: "ses_missing",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(0)
      expect(seen).toBeUndefined()
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("Session not found: ses_missing")
    }),
  )

  for (const failure of ["defect", "interruption"] as const) {
    it.instance(`execute preserves resume lookup ${failure} without creating a replacement child`, () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
        const lookupError = new Error("resume database read failed")
        let prompted = false
        const tool = yield* TaskTool.pipe(
          Effect.provideService(Session.Service, {
            ...sessions,
            get: (id) =>
              id === child.id ? (failure === "defect" ? Effect.die(lookupError) : Effect.interrupt) : sessions.get(id),
          }),
        )
        const def = yield* initTaskTool(tool)
        const result = yield* def
          .execute(
            {
              description: "resume work",
              prompt: "continue from the previous result",
              subagent_type: "general",
              task_id: child.id,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                promptOps: stubOps({
                  onPrompt: () => {
                    prompted = true
                  },
                }),
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)
        expect((yield* sessions.children(chat.id)).map((item) => item.id)).toEqual([child.id])
        expect(prompted).toBe(false)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          if (failure === "interruption") expect(Cause.hasInterrupts(result.cause)).toBe(true)
          else expect(Cause.squash(result.cause)).toBe(lookupError)
        }
      }),
    )
  }

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* initTaskTool(tool)
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionID)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionID).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionID))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionID })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)

      const execute = executeRaw(def.execute)
      const result = yield* execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: "true",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionID)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  it.instance("treats the exact string false as foreground task execution", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      const execute = executeRaw(def.execute)

      const result = yield* execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: "false",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "foreground done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain('state="completed"')
      expect(result.metadata.background).not.toBe(true)
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionID,
        },
        context,
      )

      expect(result.metadata.sessionID).toBe(started.metadata.sessionID)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionID))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionID, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  backgroundWithGoal.instance("a finished background task wakes only the goal wait for its task id", () =>
    Effect.gen(function* () {
      goalWakes.length = 0
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionID, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      for (let i = 0; i < 50 && goalWakes.length === 0; i++) yield* Effect.sleep("10 millis")
      // The result prompt follows, so the wake only flips goal state.
      expect(goalWakes).toEqual([
        {
          sessionID: chat.id,
          match: { source: "background_job", ids: [result.metadata.sessionID] },
          payload: "Background task completed: inspect bug",
          evaluate: false,
        },
      ])
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionID, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionID, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionID, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionID)
      const waited = yield* jobs.wait({ id: result.metadata.sessionID, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionID, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionID: chat.id, sessionID: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionID: chat.id, sessionID: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionID: child.id, sessionID: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("rejects non-exact string booleans for background with the schema error", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      const execute = executeRaw(def.execute)

      for (const value of ["TRUE", "FALSE", " true", "true ", "1", "yes", ""]) {
        const exit = yield* execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: value,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        ).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("background")
      }
    }),
  )

  it.instance("ignores prototype-chain background lookalikes and runs in the foreground", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      const execute = executeRaw(def.execute)

      const raw = Object.assign(Object.create({ background: "true" }), {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      const result = yield* execute(raw, {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps({ text: "foreground done" }) },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })

      expect(result.metadata.background).not.toBe(true)
      expect(result.output).toContain('state="completed"')
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
    }),
  )

  background.instance("three concurrent reviewer tasks tolerate mixed background encodings", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* initTaskTool(tool)
      const execute = executeRaw(def.execute)
      const promptOps = stubOps({ text: "reviewer done" })

      const ctx = () => ({
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })
      const argsFor = (background: unknown) => ({
        description: "review changes",
        prompt: "review the diff",
        subagent_type: "general",
        background,
      })

      const [stringTrue, stringFalse, nativeTrue] = yield* Effect.all(
        [execute(argsFor("true"), ctx()), execute(argsFor("false"), ctx()), execute(argsFor(true), ctx())],
        { concurrency: 3 },
      )

      expect(stringTrue.metadata.background).toBe(true)
      expect(stringFalse.metadata.background).not.toBe(true)
      expect(nativeTrue.metadata.background).toBe(true)

      const sessionIds = new Set([
        stringTrue.metadata.sessionID,
        stringFalse.metadata.sessionID,
        nativeTrue.metadata.sessionID,
      ])
      expect(sessionIds.size).toBe(3)
      expect((yield* sessions.children(chat.id)).length).toBe(3)

      yield* jobs.wait({ id: stringTrue.metadata.sessionID, timeout: 5_000 })
      expect((yield* jobs.get(stringTrue.metadata.sessionID))?.status).toBe("completed")
    }),
  )
})

// Issue #1026 PR1: the task tool registers every child session with ChildRuns,
// verifies task_id ownership before anything is written to the target session,
// ends the run with the job that carries it, and lets the main agent cancel a
// background task.
const runsOf = (childSessionID: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(ChildRunTable)
      .where(eq(ChildRunTable.child_session_id, childSessionID))
      .all()
      .pipe(Effect.orDie)
  })

const bindingsOf = (childSessionID: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(ChildBindingTable)
      .where(eq(ChildBindingTable.child_session_id, childSessionID))
      .all()
      .pipe(Effect.orDie)
  })

// The watcher settles the run when the job ends, a moment after the tool call returns.
const endedRun = (childSessionID: SessionID, attempt = 1) =>
  pollWithTimeout(
    runsOf(childSessionID).pipe(
      Effect.map((rows) => rows.find((row) => row.attempt === attempt && row.state === "ended")),
    ),
    `run ${attempt} of ${childSessionID} never ended`,
  )

const taskCtx = (
  chat: Session.Info,
  assistant: SessionV1.Assistant,
  promptOps: TaskPromptOps,
  extra: Partial<Tool.Context> = {},
): Tool.Context => ({
  sessionID: chat.id,
  messageID: assistant.id,
  agent: "build",
  abort: new AbortController().signal,
  extra: { promptOps },
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  ...extra,
})

const general = { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" }

describe("tool.task child runs", () => {
  it.instance("registers one binding and one run for a foreground task and ends the run with the job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* initTaskTool(yield* TaskTool)

      const result = yield* def.execute(general, taskCtx(chat, assistant, stubOps(), { callID: "call_fg" }))

      const child = SessionID.make(result.metadata.sessionID)
      const ended = yield* endedRun(child)
      expect(ended).toMatchObject({
        parent_session_id: chat.id,
        owner_kind: "task",
        owner_id: "call_fg",
        attempt: 1,
        detached: false,
        state: "ended",
        outcome: { type: "completed" },
        runner_id: EngineProcess.runner.id,
      })
      // The run ended with the job: same outcome, and counted as reported at once.
      expect((yield* jobs.get(child))?.status).toBe("completed")
      expect(ended.reported_at).toBe(ended.time_ended ?? -1)
      const bindings = yield* bindingsOf(child)
      expect(bindings).toHaveLength(1)
      expect(bindings[0]).toMatchObject({ parent_session_id: chat.id, owner_kind: "task", owner_ref: "call_fg" })
      expect(yield* runsOf(child)).toHaveLength(1)
      expect(ChildRegistry.activeFor(child)).toBeUndefined()
    }),
  )

  background.instance("records a background task as detached and a failing job as an error outcome", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* initTaskTool(yield* TaskTool)
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.succeed(reply(input, "noted"))
            : Effect.succeed(assistantReply(input, TRUNCATED)),
      }

      const started = yield* def.execute(
        { ...general, background: true },
        taskCtx(chat, assistant, promptOps, { callID: "call_bg" }),
      )

      const child = SessionID.make(started.metadata.sessionID)
      const waited = yield* jobs.wait({ id: child, timeout: 2_000 })
      expect(waited.info?.status).toBe("error")
      const ended = yield* endedRun(child)
      expect(ended.detached).toBe(true)
      expect(ended.outcome).toMatchObject({ type: "error" })
      expect(ChildStore.parseOutcome(ended.outcome)).toMatchObject({ type: "error" })
      expect(JSON.stringify(ended.outcome)).toContain("output token cap")
    }),
  )

  it.instance("ends the run cancelled when its job is cancelled", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* initTaskTool(yield* TaskTool)
      const ready = yield* Deferred.make<SessionPrompt.PromptInput>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => Deferred.succeed(ready, input).pipe(Effect.andThen(Effect.never)),
      }

      const fiber = yield* def.execute(general, taskCtx(chat, assistant, promptOps)).pipe(Effect.forkChild)
      const child = SessionID.make((yield* Deferred.await(ready)).sessionID)
      expect((yield* runsOf(child))[0]?.state).toBe("running")
      // What the ESC cascade does to a running task job.
      yield* jobs.cancel(child)

      const ended = yield* endedRun(child)
      expect(ended.outcome).toEqual({ type: "cancelled", by: { kind: "engine", reason: "job-cancelled" } })
      expect((yield* jobs.get(child))?.status).toBe("cancelled")
      expect(ChildRegistry.activeFor(child)).toBeUndefined()
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.instance("an interruption before the job starts still ends the registered run", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* initTaskTool(yield* TaskTool)
      const blocked = yield* Deferred.make<void>()

      // The run is registered when the child session is created; the tool then
      // announces itself (ctx.metadata) before it starts the job. Stop it there.
      const fiber = yield* def
        .execute(
          general,
          taskCtx(chat, assistant, stubOps(), {
            metadata: () => Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(blocked)
      const child = (yield* sessions.children(chat.id))[0].id
      expect((yield* runsOf(child))[0]?.state).toBe("queued")
      yield* Fiber.interrupt(fiber)

      const ended = yield* endedRun(child)
      expect(ended.outcome).toEqual({ type: "cancelled", by: { kind: "engine", reason: "tool-interrupted" } })
      expect(yield* jobs.get(child)).toBeUndefined()
      expect(ChildRegistry.activeFor(child)).toBeUndefined()
    }),
  )

  it.instance("resuming a finished task adds attempt 2 under the same binding", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* initTaskTool(yield* TaskTool)
      const first = yield* def.execute(general, taskCtx(chat, assistant, stubOps(), { callID: "call_first" }))
      const child = SessionID.make(first.metadata.sessionID)
      yield* endedRun(child)

      const resumed = yield* def.execute(
        { ...general, task_id: child },
        taskCtx(chat, assistant, stubOps(), { callID: "call_resume" }),
      )

      expect(resumed.metadata.sessionID).toBe(child)
      const second = yield* endedRun(child, 2)
      expect(second).toMatchObject({ owner_id: "call_resume", state: "ended", outcome: { type: "completed" } })
      expect(yield* runsOf(child)).toHaveLength(2)
      expect(yield* bindingsOf(child)).toHaveLength(1)
    }),
  )

  background.instance("resuming a running background task appends input and adds no run row", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* initTaskTool(yield* TaskTool)
      const first = defer<void>()
      const second = defer<void>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) return Effect.succeed(reply(input, "noted"))
          prompts++
          return prompts === 1
            ? Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
            : Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const ctx = taskCtx(chat, assistant, promptOps)

      const started = yield* def.execute({ ...general, background: true }, ctx)
      const child = SessionID.make(started.metadata.sessionID)
      const updated = yield* def.execute({ ...general, prompt: "also inspect cancellation", task_id: child }, ctx)

      expect(updated.output).toContain("Background task updated")
      const rows = yield* runsOf(child)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.attempt).toBe(1)
      expect(yield* bindingsOf(child)).toHaveLength(1)

      first.resolve()
      second.resolve()
      expect((yield* jobs.wait({ id: child, timeout: 2_000 })).info?.status).toBe("completed")
      expect((yield* endedRun(child)).outcome).toEqual({ type: "completed" })
      expect(yield* runsOf(child)).toHaveLength(1)
    }),
  )

  it.instance("refuses a task_id that is not a task of this conversation before writing anything to it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const other = yield* seed("Other conversation")
      const def = yield* initTaskTool(yield* TaskTool)
      const scoped = def.children.forParent(chat.id)

      // Another conversation's task session, already finished.
      const theirs = yield* sessions.create({ parentID: other.chat.id, title: "their task" })
      yield* def.children
        .forParent(other.chat.id)
        .start({ childSessionID: theirs.id, owner: { kind: "task" }, detached: false })
        .pipe(Effect.flatMap((run) => run.settle({ type: "completed" })))
      // A DAG node's session of this very conversation.
      const dagNode = yield* sessions.create({ parentID: chat.id, title: "node (DAG node)" })
      yield* scoped
        .start({
          childSessionID: dagNode.id,
          owner: { kind: "dag_node", workflowID: "wf_1", nodeID: "node_1", attempt: 1 },
          detached: true,
        })
        .pipe(Effect.flatMap((run) => run.settle({ type: "completed" })))
      // A child session of this conversation that nobody registered.
      const unregistered = yield* sessions.create({ parentID: chat.id, title: "unregistered child" })

      const targets: Array<[string, SessionID]> = [
        ["another conversation's task session", theirs.id],
        ["a top-level session", other.chat.id],
        ["the calling session itself", chat.id],
        ["a DAG node session", dagNode.id],
        ["an unregistered child session", unregistered.id],
      ]
      for (const [label, target] of targets) {
        let prompted = false
        let metadataCalls = 0
        const messagesBefore = (yield* sessions.messages({ sessionID: target })).length
        const runsBefore = (yield* runsOf(target)).length
        const exit = yield* def
          .execute(
            { ...general, task_id: target },
            taskCtx(
              chat,
              assistant,
              stubOps({
                onPrompt: () => {
                  prompted = true
                },
              }),
              {
                metadata: () =>
                  Effect.sync(() => {
                    metadataCalls += 1
                  }),
              },
            ),
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit), label).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause), label).toContain("is not a task started by this conversation")
        expect(prompted, label).toBe(false)
        expect(metadataCalls, label).toBe(0)
        expect((yield* sessions.messages({ sessionID: target })).length, label).toBe(messagesBefore)
        expect((yield* runsOf(target)).length, label).toBe(runsBefore)
        expect(yield* jobs.get(target), label).toBeUndefined()
      }
      // Only the two legitimate children of this conversation exist; nothing was created for a refused call.
      expect((yield* sessions.children(chat.id)).map((child) => child.id).toSorted()).toEqual(
        [dagNode.id, unregistered.id].toSorted(),
      )
    }),
  )

  const cancelFixture = Effect.gen(function* () {
    const { chat, assistant } = yield* seed()
    const cancels: string[] = []
    const jobCancels: SessionID[] = []
    const def = yield* initTaskTool(yield* TaskTool, (sessionID, options) =>
      Effect.sync(() => {
        cancels.push(`${sessionID}:${options?.reason?.reason}:${options?.reason?.actor}`)
      }),
    )
    const release = yield* Deferred.make<void>()
    const injected: SessionPrompt.PromptInput[] = []
    const promptOps: TaskPromptOps = {
      cancel: (sessionID) =>
        Effect.sync(() => {
          jobCancels.push(sessionID)
        }),
      resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
      prompt: (input) => {
        if (input.sessionID === chat.id) {
          injected.push(input)
          return Effect.succeed(reply(input, "noted"))
        }
        return Deferred.await(release).pipe(Effect.as(reply(input, "late answer")))
      },
    }
    return { chat, assistant, def, cancels, jobCancels, release, injected, promptOps }
  })

  const runningTask = (fixture: Effect.Success<typeof cancelFixture>, callID = "call_start") =>
    Effect.gen(function* () {
      const { chat, assistant, def, promptOps } = fixture
      const started = yield* def.execute(
        { ...general, background: true },
        taskCtx(chat, assistant, promptOps, { callID }),
      )
      const child = SessionID.make(started.metadata.sessionID)
      yield* pollWithTimeout(
        runsOf(child).pipe(Effect.map((rows) => (rows[0]?.state === "running" ? true : undefined))),
        "task run never reached running",
      )
      return child
    })

  background.instance("action cancel stops a background task: run cancelled, job cancelled, no result delivered", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant, def, cancels, jobCancels, release, injected, promptOps } = yield* cancelFixture
      const started = yield* def.execute(
        { ...general, background: true },
        taskCtx(chat, assistant, promptOps, { callID: "call_start" }),
      )
      const child = SessionID.make(started.metadata.sessionID)
      yield* pollWithTimeout(
        runsOf(child).pipe(Effect.map((rows) => (rows[0]?.state === "running" ? true : undefined))),
        "task run never reached running",
      )

      const result = yield* def.execute(
        { action: "cancel", task_id: child },
        taskCtx(chat, assistant, promptOps, { callID: "call_cancel" }),
      )

      expect(result.output).toContain(`<task id="${child}" state="cancelled">`)
      const ended = yield* endedRun(child)
      expect(ended.outcome).toEqual({ type: "cancelled", by: { kind: "main_agent_tool", toolCallID: "call_cancel" } })
      expect((yield* jobs.get(child))?.status).toBe("cancelled")
      // The child's turn was told to stop, with a reason naming the main agent.
      yield* pollWithTimeout(
        Effect.sync(() => (cancels.length > 0 ? true : undefined)),
        "the child turn was never cancelled",
      )
      expect(cancels).toEqual([`${child}:task-cancelled:main-agent`])
      expect(jobCancels).toContain(child)
      // A late answer from the cancelled child must not reach the parent.
      yield* Deferred.succeed(release, undefined)
      yield* Effect.sleep("100 millis")
      expect(injected).toEqual([])
      expect(ChildRegistry.activeFor(child)).toBeUndefined()
    }),
  )

  background.instance("action cancel refuses foreground, foreign, unknown and finished tasks", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant, def, release, promptOps } = yield* cancelFixture
      const other = yield* seed("Other conversation")
      const cancel = (task_id: string) =>
        def.execute({ action: "cancel", task_id }, taskCtx(chat, assistant, promptOps, { callID: "call_cancel" })).pipe(
          Effect.exit,
          Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "cancelled")),
        )

      // A running foreground task of this conversation.
      const foreground = yield* def
        .execute(general, taskCtx(chat, assistant, promptOps, { callID: "call_fg" }))
        .pipe(Effect.forkChild)
      const foregroundChild = yield* pollWithTimeout(
        sessions.children(chat.id).pipe(Effect.map((kids) => kids[0]?.id)),
        "foreground task was never created",
      )
      yield* pollWithTimeout(
        runsOf(foregroundChild).pipe(Effect.map((rows) => (rows[0]?.state === "running" ? true : undefined))),
        "foreground run never reached running",
      )
      expect(yield* cancel(foregroundChild)).toContain("is a foreground task")
      expect((yield* runsOf(foregroundChild))[0]?.state).toBe("running")

      // Another conversation's background task, an unknown id, a top-level session.
      const theirs = yield* sessions.create({ parentID: other.chat.id, title: "their task" })
      const theirRun = yield* def.children
        .forParent(other.chat.id)
        .start({ childSessionID: theirs.id, owner: { kind: "task" }, detached: true })
      expect(yield* cancel(theirs.id)).toContain("is not a task started by this conversation")
      expect(yield* cancel("ses_does_not_exist")).toContain("is not a task started by this conversation")
      expect(yield* cancel("not even a session id")).toContain("is not a task started by this conversation")
      expect(yield* cancel(other.chat.id)).toContain("is not a task started by this conversation")
      expect(ChildRegistry.activeFor(theirs.id)?.id).toBe(theirRun.id)

      // A task that already finished.
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(foreground)
      yield* endedRun(foregroundChild)
      expect(yield* cancel(foregroundChild)).toContain("already finished")
      yield* theirRun.settle({ type: "completed" })
    }),
  )

  background.instance("action cancel waits for the task permission before it stops anything", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const fixture = yield* cancelFixture
      const { chat, assistant, def, cancels, jobCancels, release, promptOps } = fixture
      const child = yield* runningTask(fixture)
      const asks: Array<Parameters<Tool.Context["ask"]>[0]> = []
      const asked = yield* Deferred.make<void>()
      const approval = yield* Deferred.make<void>()

      const cancelling = yield* def
        .execute(
          { action: "cancel", task_id: child },
          taskCtx(chat, assistant, promptOps, {
            callID: "call_cancel",
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }).pipe(Effect.andThen(Deferred.succeed(asked, undefined)), Effect.andThen(Deferred.await(approval))),
          }),
        )
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(asked), "the cancel call never asked the task permission")

      // The permission is the one starting or resuming this task asks, for the agent it runs.
      expect(asks).toEqual([
        {
          permission: "task",
          patterns: ["general"],
          always: ["*"],
          metadata: {
            action: "cancel",
            task_id: child,
            subagent_type: "general",
            description: expect.stringContaining("inspect bug"),
          },
        },
      ])
      // While the user has not answered, nothing was touched.
      expect((yield* runsOf(child))[0]).toMatchObject({ state: "running", outcome: null })
      expect(ChildRegistry.activeFor(child)?.phase).toBe("running")
      expect((yield* jobs.get(child))?.status).toBe("running")
      expect(cancels).toEqual([])
      expect(jobCancels).toEqual([])

      yield* Deferred.succeed(approval, undefined)
      const result = yield* Fiber.join(cancelling)

      expect(result.output).toContain('state="cancelled"')
      expect((yield* endedRun(child)).outcome).toEqual({
        type: "cancelled",
        by: { kind: "main_agent_tool", toolCallID: "call_cancel" },
      })
      expect(cancels).toEqual([`${child}:task-cancelled:main-agent`])
      yield* Deferred.succeed(release, undefined)
    }),
  )

  background.instance("action cancel denied by the task permission touches nothing", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const fixture = yield* cancelFixture
      const { chat, assistant, def, cancels, jobCancels, release, injected, promptOps } = fixture
      const child = yield* runningTask(fixture)
      const asks: Array<Parameters<Tool.Context["ask"]>[0]> = []

      // A denial reaches the tool as a defect, the way the engine's `ctx.ask` raises it.
      const exit = yield* def
        .execute(
          { action: "cancel", task_id: child },
          taskCtx(chat, assistant, promptOps, {
            callID: "call_cancel",
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }).pipe(Effect.andThen(Effect.die(new Error("The task permission is denied for general")))),
          }),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("The task permission is denied")
      expect(asks).toHaveLength(1)
      expect((yield* runsOf(child))[0]).toMatchObject({ state: "running", outcome: null })
      expect(ChildRegistry.activeFor(child)?.phase).toBe("running")
      expect((yield* jobs.get(child))?.status).toBe("running")
      expect(cancels).toEqual([])
      expect(jobCancels).toEqual([])

      // The task carries on and still delivers its result.
      yield* Deferred.succeed(release, undefined)
      expect((yield* jobs.wait({ id: child, timeout: 2_000 })).info?.status).toBe("completed")
      expect((yield* endedRun(child)).outcome).toEqual({ type: "completed" })
      yield* pollWithTimeout(
        Effect.sync(() => (injected.length > 0 ? true : undefined)),
        "the finished task was never delivered",
      )
    }),
  )

  background.instance("action cancel skips the permission check when the agent was invoked explicitly", () =>
    Effect.gen(function* () {
      const fixture = yield* cancelFixture
      const { chat, assistant, def, release, promptOps } = fixture
      const child = yield* runningTask(fixture)
      const asks: Array<Parameters<Tool.Context["ask"]>[0]> = []

      // Like starting a task, a user-invoked agent (`@general`) bypasses the permission prompt.
      const result = yield* def.execute(
        { action: "cancel", task_id: child },
        taskCtx(chat, assistant, promptOps, {
          callID: "call_cancel",
          extra: { promptOps, bypassAgentCheck: true },
          ask: (input) =>
            Effect.sync(() => {
              asks.push(input)
            }),
        }),
      )

      expect(result.output).toContain('state="cancelled"')
      expect(asks).toEqual([])
      yield* Deferred.succeed(release, undefined)
    }),
  )

  it.instance("action cancel without a task_id is rejected by the schema", () =>
    Effect.gen(function* () {
      const { chat, assistant, def, promptOps } = yield* cancelFixture
      const exit = yield* executeRaw(def.execute)({ action: "cancel" }, taskCtx(chat, assistant, promptOps)).pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("fails closed without a children capability", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const exit = yield* def.execute(general, taskCtx(chat, assistant, stubOps())).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("requires ctx.children")
    }),
  )
})
