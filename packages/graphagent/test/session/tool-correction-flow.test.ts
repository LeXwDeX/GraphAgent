// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- The scripted provider calls the AI SDK tool wrapper the way the SDK does, with an input the tool validates itself.

import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Stream } from "effect"
import { Database } from "@graphagent/core/database/database"
import { ToolOutcomeTable } from "@graphagent/core/session/outcome.sql"
import { LLMEvent } from "@graphagent/llm"
import type { StreamInput } from "@/session/llm"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { TestInstance } from "../fixture/fixture"
import { makeFakeProvider, textScript } from "../lib/fake-provider"
import { testEffect } from "../lib/effect"
import { makePerfLayer, perfConfig } from "../perf/harness"

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
