// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- The scripted provider calls the AI SDK tool wrapper the way the SDK does, with an input the tool validates itself.

import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Layer, Stream } from "effect"
import { Database } from "@graphagent/core/database/database"
import { ToolOutcomeTable } from "@graphagent/core/session/outcome.sql"
import { LLMEvent } from "@graphagent/llm"
import type { StreamInput } from "@/session/llm"
import { SettingsHook } from "@/hook"
import { SessionHooks } from "@/hook/session-hooks"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { hookCommand } from "../fixture/claude-hook"
import { TestInstance } from "../fixture/fixture"
import { makeFakeProvider, textScript, toolCallScript } from "../lib/fake-provider"
import { testEffect } from "../lib/effect"
import { makePerfLayer, perfConfig, stubLsp } from "../perf/harness"

/**
 * One scripted request in which the model calls a tool and the tool fails. The
 * AI SDK reports a rejected `execute` as a `tool-error` carrying the thrown
 * value, which the processor settles through `failToolCall`.
 */
function failingToolCall(
  input: StreamInput,
  call: { id: string; name: string; input: unknown },
): Stream.Stream<LLMEvent, unknown> {
  const head = [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: call.id, name: call.name }),
    LLMEvent.toolInputDelta({ id: call.id, name: call.name, text: JSON.stringify(call.input) }),
    LLMEvent.toolInputEnd({ id: call.id, name: call.name }),
    LLMEvent.toolCall({ id: call.id, name: call.name, input: call.input }),
  ]
  const tail = Effect.gen(function* () {
    const execute = input.tools[call.name]?.execute as
      ((args: unknown, options: unknown) => PromiseLike<unknown>) | undefined
    if (!execute) return yield* Effect.die(new Error(`scripted tool ${call.name} is unavailable`))
    const error = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          execute(call.input, {
            toolCallId: call.id,
            messages: input.messages,
            abortSignal: new AbortController().signal,
          }),
        ),
      catch: (thrown) => thrown,
    }).pipe(
      Effect.match({
        onFailure: (thrown) => thrown,
        onSuccess: () => new Error("expected the tool to fail"),
      }),
    )
    return [
      LLMEvent.toolError({
        id: call.id,
        name: call.name,
        message: error instanceof Error ? error.message : String(error),
        error,
      }),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ] satisfies LLMEvent[]
  })
  return Stream.fromIterable(head).pipe(
    Stream.concat(Stream.fromEffect(tail).pipe(Stream.flatMap((events) => Stream.fromIterable(events)))),
  )
}

let requests = 0
let missing = ""
const fake = makeFakeProvider({
  title: "Tool correction flow",
  script: (input) => {
    requests += 1
    // The legacy oldText/newText keys fail the strict decode and are repaired; the file then does not exist.
    return requests === 1
      ? failingToolCall(input, {
          id: "call-edit",
          name: "edit",
          input: { filePath: missing, oldText: "alpha", newText: "beta" },
        })
      : textScript("done")
  },
})

const it = testEffect(makePerfLayer(fake))

describe("a repaired tool call that then fails", () => {
  it.instance(
    "reports args_repaired on its error part and in its tool_outcome row",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        requests = 0
        missing = path.join(test.directory, "missing.txt")
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "tool correction flow" })

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "edit the file" }],
        })

        const parts = (yield* sessions.messages({ sessionID: session.id })).flatMap((message) => message.parts)
        const edit = parts.find((part) => part.type === "tool" && part.tool === "edit")
        expect(edit?.type).toBe("tool")
        if (edit?.type !== "tool" || edit.state.status !== "error") throw new Error("expected a failed edit call")
        expect(edit.state.error).toContain("not found")
        expect(edit.state.metadata).toEqual({ corrections: ["args_repaired"], outcome: "execution_error" })

        const { db } = yield* Database.Service
        const rows = yield* db.select().from(ToolOutcomeTable).all()
        expect(rows).toMatchObject([{ tool: "edit", outcome: "execution_error", corrections: ["args_repaired"] }])
      }),
    { git: true, config: perfConfig },
    { timeout: 60_000 },
  )
})

// A PostToolUse hook may replace the whole result of a call, metadata included. What the harness recorded about the
// call before the hook ran is not the hook's to take away.
let hookRequests = 0
let hookTarget = ""
const hookFake = makeFakeProvider({
  title: "Tool correction hook",
  script: (input) => {
    hookRequests += 1
    return hookRequests === 1
      ? toolCallScript(input, {
          id: "call-edit-hook",
          name: "edit",
          input: { filePath: hookTarget, oldText: "alpha", newText: "gamma" },
        })
      : textScript("done")
  },
})

const rewriteOutput = hookCommand(`console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PostToolUse",
  updatedToolOutput: { title: "redacted", output: "REPLACED_BY_HOOK", metadata: {} }
} }))`)

// SettingsHook.layer only needs SessionHooks for the command handler.
const hooks: Layer.Layer<SettingsHook.Service> = SettingsHook.layer.pipe(Layer.provideMerge(SessionHooks.defaultLayer))
const itHook = testEffect(makePerfLayer(hookFake, { hooks }))

describe("a repaired tool call whose result a PostToolUse hook rewrites", () => {
  itHook.instance(
    "keeps args_repaired in its part and in its tool_outcome row",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        hookRequests = 0
        hookTarget = path.join(test.directory, "target.txt")
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "tool correction hook" })

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "edit the file" }],
        })

        expect(yield* Effect.promise(() => Bun.file(hookTarget).text())).toBe("gamma beta\n")
        const parts = (yield* sessions.messages({ sessionID: session.id })).flatMap((message) => message.parts)
        const edit = parts.find((part) => part.type === "tool" && part.tool === "edit")
        if (edit?.type !== "tool" || edit.state.status !== "completed")
          throw new Error("expected a completed edit call")
        // The hook's result replaced the output and the metadata; the correction the harness made survives it.
        expect(edit.state.output).toContain("REPLACED_BY_HOOK")
        expect(edit.state.metadata).toEqual({ corrections: ["args_repaired"] })

        const { db } = yield* Database.Service
        const rows = yield* db.select().from(ToolOutcomeTable).all()
        expect(rows).toMatchObject([{ tool: "edit", outcome: "ok", corrections: ["args_repaired"] }])
      }),
    {
      git: true,
      config: perfConfig,
      init: (directory) =>
        Effect.promise(async () => {
          await fs.mkdir(path.join(directory, ".agents"), { recursive: true })
          const hook = { type: "command", command: rewriteOutput, timeout: 10 }
          await Bun.write(
            path.join(directory, ".agents", "hooks.json"),
            JSON.stringify({ PostToolUse: [{ matcher: "edit", hooks: [hook] }] }),
          )
          await Bun.write(path.join(directory, "target.txt"), "alpha beta\n")
        }),
    },
    { timeout: 60_000 },
  )
})

// A fuzzy edit is on disk before the harness waits for the language server. A call stopped there, while the tool is
// still running, has to carry the match it already made: the aborted part is settled from what the call reported.
const waiting: { reached?: Deferred.Deferred<void>; release?: Deferred.Deferred<void> } = {}

/** Diagnostics that do not come until the test lets them, so the tool stays inside its wait. */
const waitingLsp = stubLsp({
  diagnostics: () =>
    Effect.gen(function* () {
      if (waiting.reached) yield* Deferred.succeed(waiting.reached, undefined)
      if (waiting.release) yield* Deferred.await(waiting.release)
      return {}
    }),
})

/**
 * One scripted request in which the model calls a tool and the stream then ends while the tool is still running:
 * the processor does not wait for it and settles it as aborted, once the tool has reached its wait.
 */
function endedWhileRunning(
  input: StreamInput,
  call: { id: string; name: string; input: unknown },
  running: Promise<unknown>[],
): Stream.Stream<LLMEvent, unknown> {
  const head = [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: call.id, name: call.name }),
    LLMEvent.toolInputDelta({ id: call.id, name: call.name, text: JSON.stringify(call.input) }),
    LLMEvent.toolInputEnd({ id: call.id, name: call.name }),
    LLMEvent.toolCall({ id: call.id, name: call.name, input: call.input }),
  ]
  const tail = Effect.gen(function* () {
    const execute = input.tools[call.name]?.execute as
      ((args: unknown, options: unknown) => PromiseLike<unknown>) | undefined
    if (!execute) return yield* Effect.die(new Error(`scripted tool ${call.name} is unavailable`))
    const reached = waiting.reached
    if (!reached) return yield* Effect.die(new Error("the test did not set up its wait"))
    running.push(
      Promise.resolve(
        execute(call.input, {
          toolCallId: call.id,
          messages: input.messages,
          abortSignal: new AbortController().signal,
        }),
      ).catch(() => undefined),
    )
    yield* Deferred.await(reached)
    return [
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ] satisfies LLMEvent[]
  })
  return Stream.fromIterable(head).pipe(
    Stream.concat(Stream.fromEffect(tail).pipe(Stream.flatMap((events) => Stream.fromIterable(events)))),
  )
}

let waitingRequests = 0
let waitingEdit: unknown
const waitingRunning: Promise<unknown>[] = []
const waitingFake = makeFakeProvider({
  title: "Tool correction abort",
  script: (input) => {
    waitingRequests += 1
    return waitingRequests === 1
      ? endedWhileRunning(input, { id: "call-edit-abort", name: "edit", input: waitingEdit }, waitingRunning)
      : textScript("done")
  },
})

const itWaiting = testEffect(makePerfLayer(waitingFake, { lsp: waitingLsp }))

describe("a fuzzy edit that is stopped while it waits for diagnostics", () => {
  const cases = [
    {
      name: "reports fuzzy_match on its aborted part and in its tool_outcome row",
      args: (file: string) => ({ filePath: file, oldString: "const a = 1\nconst b = 2", newString: "const c = 3" }),
      corrections: ["fuzzy_match"],
    },
    {
      name: "reports fuzzy_match and args_repaired when its arguments were repaired too",
      args: (file: string) => ({ filePath: file, oldText: "const a = 1\nconst b = 2", newText: "const c = 3" }),
      corrections: ["fuzzy_match", "args_repaired"],
    },
  ]

  for (const variant of cases) {
    itWaiting.instance(
      variant.name,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const file = path.join(test.directory, "fuzzy.ts")
          yield* Effect.promise(() => Bun.write(file, "  const a = 1\n  const b = 2\n"))
          waitingRequests = 0
          waitingEdit = variant.args(file)
          waiting.reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          waiting.release = release
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const session = yield* sessions.create({ title: "tool correction abort" })

          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "edit the file" }],
          })
          // Let the tool finish its wait, so nothing is left running behind the test.
          yield* Deferred.succeed(release, undefined)
          yield* Effect.promise(() => Promise.all(waitingRunning.splice(0)))

          // The replacement reached the disk before the call was stopped.
          expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("const c = 3\n")
          const parts = (yield* sessions.messages({ sessionID: session.id })).flatMap((message) => message.parts)
          const edit = parts.find((part) => part.type === "tool" && part.tool === "edit")
          if (edit?.type !== "tool" || edit.state.status !== "error") throw new Error("expected an aborted edit call")
          expect(edit.state.error).toBe("Tool execution aborted")
          expect(edit.state.metadata).toMatchObject({
            corrections: variant.corrections,
            interrupted: true,
            outcome: "aborted",
          })
          expect(typeof edit.state.metadata?.diff).toBe("string")

          const { db } = yield* Database.Service
          const rows = yield* db.select().from(ToolOutcomeTable).all()
          expect(rows).toMatchObject([{ tool: "edit", outcome: "aborted", corrections: variant.corrections }])
        }),
      { git: true, config: perfConfig },
      { timeout: 60_000 },
    )
  }
})
