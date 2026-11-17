// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// Issue #1357: the task tool decides foreground or background in code, once per call, and records the decision in
// the call's metadata. The priority itself is covered by task-execution.test.ts; this file drives the tool.

import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import type { SessionPrompt } from "@/session/prompt"
import { Database } from "@graphagent/core/database/database"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ToolRegistry } from "@/tool/registry"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { initTaskTool } from "../lib/child-runs"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const it = testEffect(
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
    RuntimeFlags.layer({}),
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

// The four agents the cases below call: one that declares each mode, one that is interactive (its rules name
// `question`), and one that declares the background while it is interactive (a declaration the hard constraint
// must outrank).
const config = {
  agent: {
    "bg-worker": {
      description: "Runs in the background by default",
      mode: "subagent" as const,
      execution: "background" as const,
    },
    "fg-worker": {
      description: "Always waits for its result",
      mode: "subagent" as const,
      execution: "foreground" as const,
    },
    asker: {
      description: "Interactive: its rules name question",
      mode: "subagent" as const,
      permission: { question: "allow" as const },
    },
    "asker-bg": {
      description: "Interactive, and declares the background",
      mode: "subagent" as const,
      execution: "background" as const,
      permission: { question: "allow" as const },
    },
  },
}

const seed = Effect.fn("TaskExecutionRunTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Execution" })
  const user = yield* sessions.updateMessage({
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
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return { chat, assistant }
})

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
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

/** The prompt side of a task: every child prompt is counted and answered at once. */
function stubOps(prompts: { count: number } = { count: 0 }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        prompts.count += 1
        return reply(input, "child answer")
      }),
  }
}

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

const call = { description: "inspect bug", prompt: "look into the cache key path" }

describe("task execution mode", () => {
  it.instance(
    "an agent that declares the background runs detached when the call says nothing",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const def = yield* initTaskTool(yield* TaskTool)

        const result = yield* def.execute({ ...call, subagent_type: "bg-worker" }, taskCtx(chat, assistant, stubOps()))

        expect(result.output).toContain("Background task started")
        expect(result.metadata).toMatchObject({
          initiator: "agent",
          background: true,
          execution: "background",
          executionSource: "agent",
        })
        // A model-made call is ordinary background work: it does not survive Esc.
        expect(result.metadata.survivesSessionCancel).toBeUndefined()
        expect((yield* jobs.wait({ id: result.metadata.sessionID, timeout: 2_000 })).info?.status).toBe("completed")
      }),
    { config },
  )

  it.instance(
    "background=false makes an agent that declares the background wait for its result",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const def = yield* initTaskTool(yield* TaskTool)

        const result = yield* def.execute(
          { ...call, subagent_type: "bg-worker", background: false },
          taskCtx(chat, assistant, stubOps()),
        )

        expect(result.output).toContain('state="completed"')
        expect(result.output).toContain("child answer")
        expect(result.metadata).toMatchObject({ execution: "foreground", executionSource: "param" })
        expect(result.metadata.background).toBeUndefined()
        expect((yield* jobs.get(result.metadata.sessionID))?.metadata?.background).toBeUndefined()
      }),
    { config },
  )

  it.instance(
    "background=true outranks an agent that declares the foreground",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const def = yield* initTaskTool(yield* TaskTool)

        const result = yield* def.execute(
          { ...call, subagent_type: "fg-worker", background: true },
          taskCtx(chat, assistant, stubOps()),
        )

        expect(result.metadata).toMatchObject({ background: true, execution: "background", executionSource: "param" })
        expect((yield* jobs.wait({ id: result.metadata.sessionID, timeout: 2_000 })).info?.status).toBe("completed")
      }),
    { config },
  )

  it.instance("an agent without a declaration runs in the foreground by default", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* initTaskTool(yield* TaskTool)

      const result = yield* def.execute({ ...call, subagent_type: "general" }, taskCtx(chat, assistant, stubOps()))

      expect(result.output).toContain('state="completed"')
      expect(result.metadata).toMatchObject({ execution: "foreground", executionSource: "default" })
      expect(result.metadata.background).toBeUndefined()
    }),
  )

  it.instance(
    "an explicit background=true on an interactive agent is refused before any session or run exists",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const def = yield* initTaskTool(yield* TaskTool)
        const prompts = { count: 0 }

        const exit = yield* def
          .execute({ ...call, subagent_type: "asker", background: true }, taskCtx(chat, assistant, stubOps(prompts)))
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        const message = Cause.pretty(exit.cause)
        // Readable: the agent, the rule it hit, why, and what to do instead.
        expect(message).toContain('"asker"')
        expect(message).toContain("F-1")
        expect(message).toContain("question or plan_exit")
        expect(message).toContain("background=false")
        expect(prompts.count).toBe(0)
        expect((yield* sessions.list()).filter((info) => info.parentID === chat.id)).toHaveLength(0)
        expect(yield* jobs.list()).toHaveLength(0)
      }),
    { config },
  )

  it.instance(
    "the same agent runs in the foreground when the call asks for no background",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const def = yield* initTaskTool(yield* TaskTool)

        const absent = yield* def.execute({ ...call, subagent_type: "asker" }, taskCtx(chat, assistant, stubOps()))
        const explicit = yield* def.execute(
          { ...call, subagent_type: "asker", background: false },
          taskCtx(chat, assistant, stubOps()),
        )

        expect(absent.output).toContain('state="completed"')
        expect(absent.metadata).toMatchObject({ execution: "foreground", executionSource: "default" })
        expect(explicit.output).toContain('state="completed"')
        expect(explicit.metadata).toMatchObject({ execution: "foreground", executionSource: "param" })
      }),
    { config },
  )

  it.instance(
    "an agent's own background declaration cannot outrank the hard constraint",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const def = yield* initTaskTool(yield* TaskTool)

        const result = yield* def.execute({ ...call, subagent_type: "asker-bg" }, taskCtx(chat, assistant, stubOps()))

        expect(result.output).toContain('state="completed"')
        expect(result.metadata).toMatchObject({ execution: "foreground", executionSource: "constraint" })
        expect(result.metadata.background).toBeUndefined()
      }),
    { config },
  )

  it.instance(
    "the compaction agent is constrained by F-2",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const def = yield* initTaskTool(yield* TaskTool)

        const exit = yield* def
          .execute({ ...call, subagent_type: "compaction", background: true }, taskCtx(chat, assistant, stubOps()))
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        expect(Cause.pretty(exit.cause)).toContain("F-2")
      }),
    { config },
  )

  describe("a command's declaration", () => {
    const origin = (commandExecution: "foreground" | "background" | "auto") => ({
      initiator: "user" as const,
      command: "deep-check",
      commandExecution,
    })

    it.instance("runs a user-issued call detached, and the run survives Esc", () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const def = yield* initTaskTool(yield* TaskTool)
        const promptOps = stubOps()

        const result = yield* def.execute(
          { ...call, subagent_type: "general" },
          taskCtx(chat, assistant, promptOps, { extra: { promptOps, taskOrigin: origin("background") } }),
        )

        expect(result.metadata).toMatchObject({
          initiator: "user",
          command: "deep-check",
          background: true,
          survivesSessionCancel: true,
          execution: "background",
          executionSource: "command",
        })
        expect((yield* jobs.wait({ id: result.metadata.sessionID, timeout: 2_000 })).info?.status).toBe("completed")
      }),
    )

    it.instance(
      "outranks the agent's declaration",
      () =>
        Effect.gen(function* () {
          const { chat, assistant } = yield* seed()
          const def = yield* initTaskTool(yield* TaskTool)
          const promptOps = stubOps()

          const result = yield* def.execute(
            { ...call, subagent_type: "bg-worker" },
            taskCtx(chat, assistant, promptOps, { extra: { promptOps, taskOrigin: origin("foreground") } }),
          )

          expect(result.output).toContain('state="completed"')
          expect(result.metadata).toMatchObject({ execution: "foreground", executionSource: "command" })
          expect(result.metadata.background).toBeUndefined()
        }),
      { config },
    )

    it.instance(
      "auto leaves the decision to the agent's declaration",
      () =>
        Effect.gen(function* () {
          const jobs = yield* BackgroundJob.Service
          const { chat, assistant } = yield* seed()
          const def = yield* initTaskTool(yield* TaskTool)
          const promptOps = stubOps()

          const result = yield* def.execute(
            { ...call, subagent_type: "bg-worker" },
            taskCtx(chat, assistant, promptOps, { extra: { promptOps, taskOrigin: origin("auto") } }),
          )

          expect(result.metadata).toMatchObject({ background: true, execution: "background", executionSource: "agent" })
          expect((yield* jobs.wait({ id: result.metadata.sessionID, timeout: 2_000 })).info?.status).toBe("completed")
        }),
      { config },
    )

    it.instance("is outranked by the call's own background argument", () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const def = yield* initTaskTool(yield* TaskTool)
        const promptOps = stubOps()

        const result = yield* def.execute(
          { ...call, subagent_type: "general", background: false },
          taskCtx(chat, assistant, promptOps, { extra: { promptOps, taskOrigin: origin("background") } }),
        )

        expect(result.output).toContain('state="completed"')
        expect(result.metadata).toMatchObject({ execution: "foreground", executionSource: "param" })
        expect(result.metadata.survivesSessionCancel).toBeUndefined()
      }),
    )

    it.instance(
      "cannot outrank a hard constraint",
      () =>
        Effect.gen(function* () {
          const { chat, assistant } = yield* seed()
          const def = yield* initTaskTool(yield* TaskTool)
          const promptOps = stubOps()

          const result = yield* def.execute(
            { ...call, subagent_type: "asker" },
            taskCtx(chat, assistant, promptOps, { extra: { promptOps, taskOrigin: origin("background") } }),
          )

          expect(result.output).toContain('state="completed"')
          expect(result.metadata).toMatchObject({ execution: "foreground", executionSource: "constraint" })
        }),
      { config },
    )
  })

  describe("the decision is made once", () => {
    it.instance(
      "every metadata write of one call carries the same decision, the result included",
      () =>
        Effect.gen(function* () {
          const jobs = yield* BackgroundJob.Service
          const { chat, assistant } = yield* seed()
          const def = yield* initTaskTool(yield* TaskTool)
          const seen: Array<Record<string, unknown> | undefined> = []

          const result = yield* def.execute(
            { ...call, subagent_type: "bg-worker" },
            taskCtx(chat, assistant, stubOps(), {
              metadata: (input) =>
                Effect.sync(() => {
                  seen.push(input.metadata)
                }),
            }),
          )
          yield* jobs.wait({ id: result.metadata.sessionID, timeout: 2_000 })

          expect(seen.length).toBeGreaterThan(0)
          for (const metadata of [...seen, result.metadata]) {
            expect(metadata).toMatchObject({ execution: "background", executionSource: "agent" })
          }
          // The job the run belongs to carries the same record, for whoever reads the run later.
          expect((yield* jobs.get(result.metadata.sessionID))?.metadata).toMatchObject({
            execution: "background",
            executionSource: "agent",
          })
        }),
      { config },
    )

    it.instance("a promoted foreground call keeps the decision it was given and only adds that it was promoted", () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const def = yield* initTaskTool(yield* TaskTool)
        const ready = yield* Deferred.make<void>()
        const done = yield* Deferred.make<void>()
        const promptOps: TaskPromptOps = {
          ...stubOps(),
          prompt: (input) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(done)
              return reply(input, "late answer")
            }),
        }

        const fiber = yield* def
          .execute({ ...call, subagent_type: "general" }, taskCtx(chat, assistant, promptOps))
          .pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        const job = (yield* jobs.list())[0]
        if (!job) throw new Error("task job not found")
        yield* jobs.promote(job.id)

        const result = yield* Fiber.join(fiber)
        expect(result.metadata).toMatchObject({
          background: true,
          promoted: true,
          execution: "foreground",
          executionSource: "default",
        })
        yield* Deferred.succeed(done, undefined)
        yield* jobs.wait({ id: result.metadata.sessionID, timeout: 2_000 })
      }),
    )

    it.instance(
      "input appended to a running background task records that it joined the background",
      () =>
        Effect.gen(function* () {
          const jobs = yield* BackgroundJob.Service
          const { chat, assistant } = yield* seed()
          const def = yield* initTaskTool(yield* TaskTool)
          const release = yield* Deferred.make<void>()
          const promptOps: TaskPromptOps = {
            ...stubOps(),
            prompt: (input) => Deferred.await(release).pipe(Effect.as(reply(input, "child answer"))),
          }
          const ctx = taskCtx(chat, assistant, promptOps)

          const started = yield* def.execute({ ...call, subagent_type: "bg-worker" }, ctx)
          // The follow-up names no mode, and fg-worker would wait: the run it joins is already in the background.
          const updated = yield* def.execute(
            {
              ...call,
              subagent_type: "fg-worker",
              prompt: "also check cancellation",
              task_id: started.metadata.sessionID,
            },
            ctx,
          )

          expect(updated.output).toContain("Background task updated")
          expect(updated.metadata).toMatchObject({
            background: true,
            execution: "background",
            executionSource: "running",
          })
          yield* Deferred.succeed(release, undefined)
          expect((yield* jobs.wait({ id: started.metadata.sessionID, timeout: 2_000 })).info?.status).toBe("completed")
        }),
      { config },
    )

    // A call that is entered again for a part that already holds its decision (a replay or a recovery) reads the
    // record. Resolving again would use the catalog as it is now, which may no longer say what it said then.
    it.instance(
      "a replay reads the recorded decision and does not resolve the call again",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const { chat, assistant } = yield* seed()
          const def = yield* initTaskTool(yield* TaskTool)
          // The part of the call as it was left: its argument asked for the background and that was recorded.
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: chat.id,
            type: "tool",
            callID: "call_replayed",
            tool: "task",
            state: {
              status: "running",
              input: { ...call, subagent_type: "fg-worker" },
              metadata: { initiator: "agent", execution: "background", executionSource: "param", background: true },
              time: { start: Date.now() },
            },
          })

          // fg-worker declares the foreground and this call has no argument: resolved again, it would wait.
          const replayed = yield* def.execute(
            { ...call, subagent_type: "fg-worker" },
            taskCtx(chat, assistant, stubOps(), { callID: "call_replayed" }),
          )
          expect(replayed.output).toContain("Background task started")
          expect(replayed.metadata).toMatchObject({
            background: true,
            execution: "background",
            executionSource: "param",
          })
          yield* jobs.wait({ id: replayed.metadata.sessionID, timeout: 2_000 })

          // A call that has no recorded part is decided on its own terms.
          const fresh = yield* def.execute(
            { ...call, subagent_type: "fg-worker" },
            taskCtx(chat, assistant, stubOps(), { callID: "call_fresh" }),
          )
          expect(fresh.output).toContain('state="completed"')
          expect(fresh.metadata).toMatchObject({ execution: "foreground", executionSource: "agent" })
        }),
      { config },
    )

    it.instance("a part that records no decision is resolved, not trusted", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const def = yield* initTaskTool(yield* TaskTool)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: chat.id,
          type: "tool",
          callID: "call_bare",
          tool: "task",
          state: { status: "running", input: { ...call }, time: { start: Date.now() } },
        })

        const result = yield* def.execute(
          { ...call, subagent_type: "general" },
          taskCtx(chat, assistant, stubOps(), { callID: "call_bare" }),
        )

        expect(result.metadata).toMatchObject({ execution: "foreground", executionSource: "default" })
      }),
    )
  })
})
