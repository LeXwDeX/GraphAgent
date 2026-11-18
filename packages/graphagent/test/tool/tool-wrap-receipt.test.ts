// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { logLines } from "effect/testing/TestConsole"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

const executeRaw = (execute: Tool.Def["execute"]) =>
  // oxlint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- test shim: invoke the wrapped execute with unrepaired raw args
  execute as unknown as (args: unknown, ctx: Tool.Context) => Effect.Effect<Tool.ExecuteResult>

function makeCtx(): Tool.Context {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

const NOTE_EXCESS = (tool: string, names: string) =>
  `Note: ${tool} does not take these arguments, so they were ignored: ${names}. Send only the documented parameters.`

const NOTE_REPAIRED = (detail: string) =>
  `Note: your arguments did not match the schema and were repaired before the call ran${detail}. Send the documented parameters.`

const NOTE_CLAMP = (param: string, requested: number, max: number) =>
  `Note: ${param} ${requested} is above the maximum ${max}; ${max} was used.`

const params = Schema.Struct({
  input: Schema.String,
  limit: Schema.optional(Schema.Number),
  context: Schema.optional(Schema.Number),
})

/** A wrapped tool whose own result is `result`; `received` collects the decoded arguments it ran with. */
const wrapped = Effect.fnUntraced(function* (
  id: string,
  options: Partial<Pick<Tool.Def, "clamps" | "structuredOutput">> & {
    result?: Partial<Tool.ExecuteResult>
    parameters?: Schema.Decoder<unknown>
  } = {},
) {
  const received: unknown[] = []
  const info = yield* Tool.define(
    id,
    Effect.succeed({
      description: "test tool",
      parameters: options.parameters ?? params,
      ...(options.clamps ? { clamps: options.clamps } : {}),
      ...(options.structuredOutput ? { structuredOutput: options.structuredOutput } : {}),
      execute(args: unknown) {
        received.push(args)
        return Effect.succeed({ title: "test", output: "ok", metadata: {}, ...options.result })
      },
    }),
  )
  const tool = yield* info.init()
  return { run: executeRaw(tool.execute), received }
})

describe("Tool.define argument notes", () => {
  it.instance("a call with a key the schema does not declare says it was ignored and records excess_keys", () =>
    Effect.gen(function* () {
      const { run, received } = yield* wrapped("receipt-excess")
      const result = yield* run({ input: "a", zz_dir_key: "/zz/secret/dir", zz_num_key: 7351 }, makeCtx())

      expect(result.output).toBe(`ok\n\n${NOTE_EXCESS("receipt-excess", "zz_dir_key, zz_num_key")}`)
      expect(result.metadata.corrections).toEqual(["excess_keys"])
      // The tool still runs with the declared keys only.
      expect(received).toEqual([{ input: "a" }])

      const logged = JSON.stringify(yield* logLines)
      expect(logged).toContain("tool call corrected")
      expect(logged).toContain('"tool.name":"receipt-excess"')
      expect(logged).toContain('"correction.kind":"excess_keys"')
      expect(logged).not.toContain("zz_dir_key")
      expect(logged).not.toContain("zz_num_key")
      expect(logged).not.toContain("/zz/secret/dir")
      expect(logged).not.toContain("7351")
    }),
  )

  it.instance("a legitimate call keeps its output and metadata exactly", () =>
    Effect.gen(function* () {
      const { run } = yield* wrapped("receipt-plain", { clamps: { limit: { max: 10 } } })
      const result = yield* run({ input: "a", limit: 10 }, makeCtx())

      expect(result.output).toBe("ok")
      expect(result.metadata).toEqual({ truncated: false })
      expect(JSON.stringify(yield* logLines)).not.toContain("tool call corrected")
    }),
  )

  it.instance("a tool with structuredOutput keeps its output and still records the kind", () =>
    Effect.gen(function* () {
      const { run } = yield* wrapped("receipt-json", {
        structuredOutput: true,
        clamps: { limit: { max: 10 } },
        result: { output: '{"valid":true}' },
      })
      const result = yield* run({ input: "a", limit: 99, extra: true }, makeCtx())

      expect(result.output).toBe('{"valid":true}')
      expect(JSON.parse(result.output)).toEqual({ valid: true })
      expect(result.metadata.corrections).toEqual(["excess_keys", "clamped"])
    }),
  )

  it.instance("a number above its declared maximum says what was used and records clamped", () =>
    Effect.gen(function* () {
      const { run, received } = yield* wrapped("receipt-clamp", {
        clamps: { limit: { max: 1000 }, context: { max: 20 } },
      })

      const both = yield* run({ input: "a", limit: 7351, context: 50 }, makeCtx())
      expect(both.output).toBe(`ok\n\n${NOTE_CLAMP("limit", 7351, 1000)}\n${NOTE_CLAMP("context", 50, 20)}`)
      expect(both.metadata.corrections).toEqual(["clamped"])
      // Capping the value is the tool's job: it still receives what the model asked for.
      expect(received).toEqual([{ input: "a", limit: 7351, context: 50 }])

      const one = yield* run({ input: "a", limit: 1000, context: 21 }, makeCtx())
      expect(one.output).toBe(`ok\n\n${NOTE_CLAMP("context", 21, 20)}`)

      const none = yield* run({ input: "a", limit: 1000, context: 20 }, makeCtx())
      expect(none.output).toBe("ok")
      expect(none.metadata.corrections).toBeUndefined()

      const logged = JSON.stringify(yield* logLines)
      expect(logged).toContain('"correction.kind":"clamped"')
      expect(logged).not.toContain("7351")
    }),
  )

  it.instance("the sentences come in order: excess keys first, then the capped numbers", () =>
    Effect.gen(function* () {
      const { run } = yield* wrapped("receipt-order", { clamps: { limit: { max: 10 } } })
      const result = yield* run({ input: "a", limit: 11, zz_key: "x" }, makeCtx())

      expect(result.output).toBe(`ok\n\n${NOTE_EXCESS("receipt-order", "zz_key")}\n${NOTE_CLAMP("limit", 11, 10)}`)
      expect(result.metadata.corrections).toEqual(["excess_keys", "clamped"])
    }),
  )

  it.instance("the notes follow the truncated output, whole, and a tool that cuts its own output gets them too", () =>
    Effect.gen(function* () {
      const long = Array.from({ length: 6000 }, (_, index) => `line ${index}`).join("\n")
      const clamps = { limit: { max: 10 } }

      const cut = yield* wrapped("receipt-cut", { clamps, result: { output: long } })
      const truncated = yield* cut.run({ input: "a", limit: 11 }, makeCtx())
      expect(truncated.metadata.truncated).toBe(true)
      expect(truncated.output.endsWith(`\n\n${NOTE_CLAMP("limit", 11, 10)}`)).toBe(true)
      // The cut happened once, before the note; the note is not part of what was cut.
      expect(truncated.output.split(NOTE_CLAMP("limit", 11, 10)).length).toBe(2)

      const own = yield* wrapped("receipt-own-cut", {
        clamps,
        result: { output: "page one", metadata: { truncated: true } },
      })
      const early = yield* own.run({ input: "a", limit: 11 }, makeCtx())
      expect(early.output).toBe(`page one\n\n${NOTE_CLAMP("limit", 11, 10)}`)
      expect(early.metadata).toEqual({ truncated: true, corrections: ["clamped"] })
    }),
  )
})

describe("Tool.define repair notes", () => {
  const repairing = Effect.fnUntraced(function* (options: { structuredOutput?: boolean } = {}) {
    const parameters = Schema.Struct({ background: Schema.optional(Schema.Boolean), note: Schema.String })
    const info = yield* Tool.define(
      "receipt-repair",
      Effect.succeed({
        description: "test tool",
        parameters,
        ...(options.structuredOutput ? { structuredOutput: true } : {}),
        repairArguments(value: unknown) {
          if (typeof value !== "object" || value === null || Array.isArray(value)) return value
          if (!("background" in value)) return value
          const background = Reflect.get(value, "background")
          if (background !== "true" && background !== "false") return value
          return { ...value, background: background === "true" }
        },
        execute() {
          return Effect.succeed({ title: "test", output: "ok", metadata: {} })
        },
      }),
    )
    return executeRaw((yield* info.init()).execute)
  })

  it.instance("a call that passes only after repair names what the repair set", () =>
    Effect.gen(function* () {
      const run = yield* repairing()
      const result = yield* run({ background: "true", note: "SECRET-NOTE-VALUE" }, makeCtx())

      expect(result.output).toBe(`ok\n\n${NOTE_REPAIRED(" (set: background)")}`)
      // The repair is recorded under its own kind; the repair sentence is not an excess-key sentence.
      expect(result.metadata.corrections).toEqual(["args_repaired"])

      const logged = JSON.stringify(yield* logLines)
      // The existing repair log is unchanged and nothing new is logged for it.
      expect(logged).toContain("tool arguments repaired")
      expect(logged).toContain("background:string->boolean")
      expect(logged).not.toContain("tool call corrected")
      expect(logged).not.toContain("SECRET-NOTE-VALUE")
    }),
  )

  it.instance("a key the repair did not use is named in the repair sentence, not under excess_keys", () =>
    Effect.gen(function* () {
      const run = yield* repairing()
      const result = yield* run({ background: "false", note: "n", cwd: "/tmp" }, makeCtx())

      expect(result.output).toBe(`ok\n\n${NOTE_REPAIRED(" (set: background; not used as sent: cwd)")}`)
      expect(result.metadata.corrections).toEqual(["args_repaired"])
    }),
  )

  it.instance("a repaired call of a tool with structuredOutput keeps its output", () =>
    Effect.gen(function* () {
      const run = yield* repairing({ structuredOutput: true })
      const result = yield* run({ background: "true", note: "n" }, makeCtx())

      expect(result.output).toBe("ok")
      expect(result.metadata.corrections).toEqual(["args_repaired"])
    }),
  )

  it.instance("a call whose arguments the repair moved names the keys it did not use as sent", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        params: Schema.Struct({ action: Schema.String, id: Schema.optional(Schema.String) }),
      })
      const info = yield* Tool.define(
        "receipt-flat",
        Effect.succeed({
          description: "test tool",
          parameters,
          repairContainerFields: ["params"],
          repairArguments(value: unknown) {
            if (typeof value !== "object" || value === null || Array.isArray(value)) return value
            if (Object.hasOwn(value, "params") || !Object.hasOwn(value, "action")) return value
            return { params: value }
          },
          execute() {
            return Effect.succeed({ title: "test", output: "ok", metadata: {} })
          },
        }),
      )
      const run = executeRaw((yield* info.init()).execute)

      const flat = yield* run({ action: "start", id: "w1" }, makeCtx())
      expect(flat.output).toBe(`ok\n\n${NOTE_REPAIRED(" (set: params; not used as sent: action, id)")}`)

      const stringified = yield* run({ params: '{"action":"start"}' }, makeCtx())
      expect(stringified.output).toBe(`ok\n\n${NOTE_REPAIRED(" (set: params)")}`)
    }),
  )

  it.instance("a repair that changed no top-level value still says the arguments were repaired", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({ nested: Schema.Struct({ flag: Schema.Boolean }) })
      const info = yield* Tool.define(
        "receipt-nested",
        Effect.succeed({
          description: "test tool",
          parameters,
          repairArguments(value: unknown) {
            if (typeof value !== "object" || value === null) return value
            const nested = Reflect.get(value, "nested")
            if (typeof nested !== "object" || nested === null) return value
            return { nested: { flag: Reflect.get(nested, "flag") === "true" } }
          },
          execute() {
            return Effect.succeed({ title: "test", output: "ok", metadata: {} })
          },
        }),
      )
      const run = executeRaw((yield* info.init()).execute)

      const result = yield* run({ nested: { flag: "true" } }, makeCtx())
      expect(result.output).toBe(`ok\n\n${NOTE_REPAIRED("")}`)
      expect(result.metadata.corrections).toEqual(["args_repaired"])
    }),
  )
})
