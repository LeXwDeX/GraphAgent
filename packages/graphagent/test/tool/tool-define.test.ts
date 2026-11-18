import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { logLines } from "effect/testing/TestConsole"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Parameters as WebFetchParameters } from "@/tool/webfetch"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))
const executeRaw = (execute: Tool.Def["execute"]) =>
  // oxlint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- test shim: invoke the wrapped execute with unrepaired raw args
  execute as unknown as (args: unknown, ctx: Tool.Context) => Effect.Effect<Tool.ExecuteResult>

const params = Schema.Struct({ input: Schema.String })

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

function makeTool(id: string, executeFn?: () => void) {
  return {
    description: "test tool",
    parameters: params,
    execute() {
      executeFn?.()
      return Effect.succeed({ title: "test", output: "ok", metadata: {} })
    },
  }
}

describe("Tool.define", () => {
  it.effect("object-defined tool does not mutate the original init object", () =>
    Effect.gen(function* () {
      const original = makeTool("test")
      const originalExecute = original.execute

      const info = yield* Tool.define("test-tool", Effect.succeed(original))

      yield* info.init()
      yield* info.init()
      yield* info.init()

      expect(original.execute).toBe(originalExecute)
    }),
  )

  it.effect("effect-defined tool returns fresh objects and is unaffected", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "test-fn-tool",
        Effect.succeed(() => Effect.succeed(makeTool("test"))),
      )

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("object-defined tool returns distinct objects per init() call", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define("test-copy", Effect.succeed(makeTool("test")))

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("execute receives decoded parameters", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        count: Schema.NumberFromString.pipe(Schema.optional, Schema.withDecodingDefaultType(Effect.succeed(5))),
      })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-decoded",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const ctx = makeCtx()
      const tool = yield* info.init()
      const execute = executeRaw(tool.execute)

      yield* execute({}, ctx)
      yield* execute({ count: "7" }, ctx)

      expect(calls).toEqual([{ count: 5 }, { count: 7 }])
    }),
  )

  // Regression for #297: qwen-family models string-encode a nested-union
  // property value ({"params": "{\"action\": \"list\"}"}). The execute wrap
  // must retry with the container re-parsed so the tool still runs.
  it.effect("stringified container arguments decode through the lenient retry", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        params: Schema.Union([
          Schema.Struct({ action: Schema.Literal("list") }),
          Schema.Struct({ action: Schema.Literal("validate"), spec_path: Schema.String }),
        ]),
      })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-repair",
        Effect.succeed({
          description: "test tool",
          parameters,
          parseOptions: { onExcessProperty: "error" },
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const ctx = makeCtx()
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      yield* execute({ params: '{"action": "list"}' }, ctx)
      yield* execute({ params: '{"action": "validate", "spec_path": "spec.yaml"}' }, ctx)
      yield* execute({ params: { action: "list" } }, ctx)

      expect(calls).toEqual([
        { params: { action: "list" } },
        { params: { action: "validate", spec_path: "spec.yaml" } },
        { params: { action: "list" } },
      ])
    }),
  )

  it.effect("repairs only explicitly requested exact string boolean fields after strict decoding fails", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({ background: Schema.optional(Schema.Boolean), note: Schema.String })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-background-repair",
        Effect.succeed({
          description: "test tool",
          parameters,
          repairArguments(value: unknown) {
            if (typeof value !== "object" || value === null || Array.isArray(value)) return value
            if (!("background" in value)) return value
            const background = Reflect.get(value, "background")
            if (background !== "true" && background !== "false") return value
            return { ...value, background: background === "true" }
          },
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = executeRaw(tool.execute)

      yield* execute({ background: "true", note: "true" }, makeCtx())
      yield* execute({ background: "false", note: "false" }, makeCtx())
      yield* execute({ background: true, note: "true" }, makeCtx())

      for (const background of ["1", "yes", "", null, {}, []]) {
        const exit = yield* execute({ background, note: "preserved" }, makeCtx()).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }

      expect(calls).toEqual([
        { background: true, note: "true" },
        { background: false, note: "false" },
        { background: true, note: "true" },
      ])
    }),
  )

  it.effect("repair diagnostics log key names and type transitions without argument values", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({ background: Schema.optional(Schema.Boolean), note: Schema.String })
      const info = yield* Tool.define(
        "test-repair-log",
        Effect.succeed({
          description: "test tool",
          parameters,
          repairArguments(value: unknown) {
            if (typeof value !== "object" || value === null || Array.isArray(value)) return value
            if (!("background" in value)) return value
            const background = Reflect.get(value, "background")
            if (background !== "true" && background !== "false") return value
            return { ...value, background: background === "true" }
          },
          execute() {
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = executeRaw(tool.execute)

      yield* execute({ background: "true", note: "SECRET-NOTE-VALUE" }, makeCtx())
      const logged = JSON.stringify(yield* logLines)
      expect(logged).toContain("tool arguments repaired")
      expect(logged).toContain('"tool.name":"test-repair-log"')
      expect(logged).toContain("background:string->boolean")
      expect(logged).not.toContain("SECRET-NOTE-VALUE")
      expect(logged).not.toContain('"\\"true\\"')
    }),
  )

  it.effect("container repair and tool repair compose on one call", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        background: Schema.optional(Schema.Boolean),
        meta: Schema.optional(Schema.Struct({ flag: Schema.Boolean })),
      })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-combined-repair",
        Effect.succeed({
          description: "test tool",
          parameters,
          repairArguments(value: unknown) {
            if (typeof value !== "object" || value === null || Array.isArray(value)) return value
            if (!("background" in value)) return value
            const background = Reflect.get(value, "background")
            if (background !== "true" && background !== "false") return value
            return { ...value, background: background === "true" }
          },
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = executeRaw(tool.execute)

      yield* execute({ background: "true", meta: '{"flag":true}' }, makeCtx())
      expect(calls[0]).toEqual({ background: true, meta: { flag: true } })

      // Nested lookalike fields are not repaired — the hook only touches the
      // exact top-level key.
      const nested = yield* execute({ background: true, meta: { flag: "true" } }, makeCtx()).pipe(Effect.exit)
      expect(Exit.isFailure(nested)).toBe(true)
    }),
  )

  it.effect("prototype-chain lookalikes are ignored and not promoted to own properties", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({ background: Schema.optional(Schema.Boolean), note: Schema.String })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-proto-repair",
        Effect.succeed({
          description: "test tool",
          parameters,
          repairArguments(value: unknown) {
            if (typeof value !== "object" || value === null || Array.isArray(value)) return value
            if (!Object.hasOwn(value, "background")) return value
            const background = Reflect.get(value, "background")
            if (background !== "true" && background !== "false") return value
            return { ...value, background: background === "true" }
          },
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = executeRaw(tool.execute)

      const raw = Object.assign(Object.create({ background: "true" }), { note: "own only" })
      yield* execute(raw, makeCtx())
      expect(calls[0]).toEqual({ note: "own only" })
      expect(Object.hasOwn(calls[0], "background")).toBe(false)
    }),
  )

  it.effect("unrepairable arguments still surface as InvalidArgumentsError", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        params: Schema.Union([Schema.Struct({ action: Schema.Literal("list") })]),
      })
      const info = yield* Tool.define(
        "test-repair-fail",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute() {
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      const exit = yield* execute({ params: "not a container" }, makeCtx()).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const die = exit.cause.reasons.find(Cause.isDieReason)
      expect(die?.defect).toBeInstanceOf(Tool.InvalidArgumentsError)
    }),
  )

  // #1473: a call that only decodes after the harness repaired its arguments says so in its result metadata.
  describe("args_repaired", () => {
    const backgroundTool = (name: string, metadata: Record<string, unknown>) =>
      Tool.define(
        name,
        Effect.succeed({
          description: "test tool",
          parameters: Schema.Struct({ background: Schema.optional(Schema.Boolean) }),
          repairArguments(value: unknown) {
            if (typeof value !== "object" || value === null || Reflect.get(value, "background") !== "true") return value
            return { ...value, background: true }
          },
          execute() {
            return Effect.succeed({ title: "test", output: "ok", metadata })
          },
        }),
      )

    it.instance("marks a repaired call, whether or not the tool reports truncation itself", () =>
      Effect.gen(function* () {
        const open = yield* backgroundTool("test-marks-open", { diff: "d" })
        const closed = yield* backgroundTool("test-marks-closed", { truncated: false })
        const openTool = yield* open.init()
        const closedTool = yield* closed.init()

        const viaTruncate = yield* executeRaw(openTool.execute)({ background: "true" }, makeCtx())
        const early = yield* executeRaw(closedTool.execute)({ background: "true" }, makeCtx())

        expect(viaTruncate.metadata).toEqual({ diff: "d", truncated: false, corrections: ["args_repaired"] })
        expect(early.metadata).toEqual({ truncated: false, corrections: ["args_repaired"] })
      }),
    )

    it.instance("leaves a call that decodes strictly unmarked", () =>
      Effect.gen(function* () {
        const info = yield* backgroundTool("test-unmarked", { diff: "d" })
        const tool = yield* info.init()

        const result = yield* executeRaw(tool.execute)({ background: true }, makeCtx())

        expect(result.metadata).toEqual({ diff: "d", truncated: false })
        expect(Object.hasOwn(result.metadata, "corrections")).toBe(false)
      }),
    )

    it.instance("adds the mark after the kinds the tool itself recorded", () =>
      Effect.gen(function* () {
        const info = yield* backgroundTool("test-mark-order", { corrections: ["fuzzy_match"] })
        const tool = yield* info.init()

        const result = yield* executeRaw(tool.execute)({ background: "true" }, makeCtx())

        expect(result.metadata.corrections).toEqual(["fuzzy_match", "args_repaired"])
      }),
    )

    it.instance("marks a call repaired through the stringified-container pass", () =>
      Effect.gen(function* () {
        const parameters = Schema.Struct({
          params: Schema.Union([Schema.Struct({ action: Schema.Literal("list") })]),
        })
        const info = yield* Tool.define(
          "test-marks-container",
          Effect.succeed({
            description: "test tool",
            parameters,
            execute() {
              return Effect.succeed({ title: "test", output: "ok", metadata: {} })
            },
          }),
        )
        const tool = yield* info.init()
        const execute = executeRaw(tool.execute)

        expect((yield* execute({ params: '{"action":"list"}' }, makeCtx())).metadata.corrections).toEqual([
          "args_repaired",
        ])
        expect((yield* execute({ params: { action: "list" } }, makeCtx())).metadata.corrections).toBeUndefined()
      }),
    )

    it.effect("does not mark a call whose arguments stay invalid", () =>
      Effect.gen(function* () {
        const info = yield* backgroundTool("test-still-invalid", {})
        const tool = yield* info.init()

        const exit = yield* executeRaw(tool.execute)({ background: "maybe" }, makeCtx()).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  // #1473: a string parameter holding JSON-shaped text must reach the tool as text. The tool's own
  // repair runs on the raw input first, so the generic container repair never turns the text into an object.
  it.effect("tool repair runs on the raw input and keeps JSON-shaped string values", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({ filePath: Schema.String, content: Schema.String })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-raw-repair",
        Effect.succeed({
          description: "test tool",
          parameters,
          repairArguments(value: unknown) {
            if (typeof value !== "object" || value === null || !Object.hasOwn(value, "file_path")) return value
            const { file_path: filePath, ...rest } = Object.fromEntries(Object.entries(value))
            return { ...rest, filePath }
          },
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = executeRaw(tool.execute)

      yield* execute({ file_path: "a.txt", content: '{"k":1}' }, makeCtx())

      expect(calls).toEqual([{ filePath: "a.txt", content: '{"k":1}' }])
    }),
  )

  it.effect("a failing argument does not turn a JSON-shaped string value into an object", () =>
    Effect.gen(function* () {
      // `content` is declared first, so a `content` turned into an object would be the first failure reported
      // and hide the argument that is really missing.
      const parameters = Schema.Struct({ content: Schema.String, filePath: Schema.String })
      const info = yield* Tool.define(
        "test-string-keep",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute() {
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = executeRaw(tool.execute)

      const exit = yield* execute({ content: '{"k":1}' }, makeCtx()).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const error = exit.cause.reasons.find(Cause.isDieReason)?.defect
      if (!(error instanceof Tool.InvalidArgumentsError)) throw new Error("expected InvalidArgumentsError")
      expect(error.message).toContain("filePath")
      expect(error.message).not.toContain("content")
    }),
  )

  it.effect("plain string parameters that look like JSON are not re-parsed", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({ note: Schema.String })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-string-passthrough",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      yield* execute({ note: '{"kept": "string"}' }, makeCtx())

      expect(calls).toEqual([{ note: '{"kept": "string"}' }])
    }),
  )

  // Regression for #28438: the wrap is the canonical "untyped → typed" boundary.
  // When the LLM emits a tool call with a payload that fails the parameter
  // schema, the wrap must surface a typed `Tool.InvalidArgumentsError` whose
  // `.message` is the actionable prose the AI SDK feeds back to the model.
  it.effect("invalid args surface as Tool.InvalidArgumentsError with friendly message and JSON path", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        questions: Schema.Array(
          Schema.Struct({
            question: Schema.String,
            options: Schema.Array(Schema.String),
          }),
        ),
      })
      const info = yield* Tool.define(
        "qtest",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute() {
            return Effect.succeed({ title: "ok", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      // Missing required `question` field on the first questions[] entry.
      const exit = yield* execute({ questions: [{ options: ["a"] }] }, makeCtx()).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return

      // The wrap ends with Effect.orDie, so the failure lives in the cause as a
      // defect. Recover the typed instance from there.
      const die = exit.cause.reasons.find(Cause.isDieReason)
      const error = die?.defect
      expect(error).toBeInstanceOf(Tool.InvalidArgumentsError)
      const args = error as Tool.InvalidArgumentsError
      expect(args.tool).toBe("qtest")
      expect(args.message).toContain("qtest tool was called with invalid arguments")
      expect(args.message).toContain("Fix them and call qtest again.")
      expect(args.message).toContain(`["questions"][0]["question"] missing required field, expected string`)
    }),
  )

  // Each case names what the schema accepts and what to do next, and never
  // echoes the rejected value: `.message` is what the model reads back.
  const invalidMessage = (parameters: Schema.Decoder<unknown>, args: unknown) =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "qtest",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute() {
            return Effect.succeed({ title: "ok", output: "ok", metadata: {} })
          },
        }),
      )
      const tool = yield* info.init()
      const exit = yield* executeRaw(tool.execute)(args, makeCtx()).pipe(Effect.exit)
      if (!Exit.isFailure(exit)) throw new Error("expected the arguments to be rejected")
      const error = exit.cause.reasons.find(Cause.isDieReason)?.defect
      if (!(error instanceof Tool.InvalidArgumentsError)) throw new Error("expected InvalidArgumentsError")
      return error.message
    })

  const expectBounded = (message: string, secret: string) => {
    expect(message).not.toContain(secret)
    expect(message.length).toBeLessThan(600)
  }

  const secret = "SECRET-VALUE-9f3a"
  const invalidCases: ReadonlyArray<{
    name: string
    parameters: Schema.Decoder<unknown>
    args: unknown
    detail: string
    secret: string
  }> = [
    {
      name: "a wrong enum value lists the allowed values",
      parameters: Schema.Struct({ format: Schema.Literals(["text", "markdown"]) }),
      args: { format: "md" },
      detail: `["format"] invalid value, expected one of "text", "markdown"`,
      secret: `"md"`,
    },
    {
      name: "a missing field names its type",
      parameters: Schema.Struct({ filePath: Schema.String }),
      args: {},
      detail: `["filePath"] missing required field, expected string`,
      secret,
    },
    {
      name: "a wrong type names the expected type",
      parameters: Schema.Struct({ limit: Schema.Number }),
      args: { limit: secret },
      detail: `["limit"] wrong type, expected number`,
      secret,
    },
    {
      name: "a failed check says what the check requires",
      parameters: Schema.Struct({ limit: Schema.Number.check(Schema.isGreaterThan(0)) }),
      args: { limit: -7 },
      detail: `["limit"] invalid value, expected a value greater than 0`,
      secret: "-7",
    },
    {
      name: "an optional enum field still lists the allowed values",
      parameters: Schema.Struct({ format: Schema.optional(Schema.Literals(["text", "markdown"])) }),
      args: { format: "md" },
      detail: `["format"] invalid value, expected one of "text", "markdown"`,
      secret: `"md"`,
    },
    {
      name: "an optional enum field given a number lists the allowed values",
      parameters: Schema.Struct({ format: Schema.optional(Schema.Literals(["text", "markdown"])) }),
      args: { format: 5 },
      detail: `["format"] invalid value, expected one of "text", "markdown"`,
      secret: "5",
    },
    {
      name: "a missing enum field lists the allowed values",
      parameters: Schema.Struct({ format: Schema.Literals(["text", "markdown"]) }),
      args: {},
      detail: `["format"] missing required field, expected one of "text", "markdown"`,
      secret,
    },
    {
      name: "webfetch reports its allowed formats",
      parameters: WebFetchParameters,
      args: { url: "https://example.test", format: "md" },
      detail: `["format"] invalid value, expected one of "text", "markdown", "html"`,
      secret: `"md"`,
    },
  ]
  for (const item of invalidCases) {
    it.effect(`invalid arguments: ${item.name}`, () =>
      Effect.gen(function* () {
        const message = yield* invalidMessage(item.parameters, item.args)
        expect(message).toBe(
          `The qtest tool was called with invalid arguments: ${item.detail}. Fix them and call qtest again.`,
        )
        expectBounded(message, item.secret)
      }),
    )
  }

  it.effect("invalid arguments: an enum with 25 values lists 20 and counts the rest", () =>
    Effect.gen(function* () {
      const values = Array.from({ length: 25 }, (_, index) => `v${index}`)
      const message = yield* invalidMessage(Schema.Struct({ format: Schema.Literals(values) }), { format: secret })
      expect(message).toContain(`"v19", ... (first 20 of 25)`)
      expect(message).not.toContain(`"v20"`)
      expectBounded(message, secret)
    }),
  )

  it.effect("bounds and redacts fallback errors for tools without a formatter", () =>
    Effect.gen(function* () {
      const secret = `SECRET-${"x".repeat(5_000)}`
      const parameters = Schema.Struct({
        value: Schema.Union([Schema.Struct({ a: Schema.String }), Schema.Struct({ b: Schema.String })]),
      })
      const info = yield* Tool.define(
        "union-secret",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute() {
            return Effect.succeed({ title: "ok", output: "ok", metadata: {} })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = executeRaw(tool.execute)

      const exit = yield* execute({ value: { a: 1, secret } }, makeCtx()).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const error = exit.cause.reasons.find(Cause.isDieReason)?.defect
      if (!(error instanceof Tool.InvalidArgumentsError)) throw new Error("expected InvalidArgumentsError")
      expect(error.message).toContain("invalid arguments")
      expect(error.message).toContain("value")
      expect(error.message).not.toContain("SECRET-")
      expect(error.message.length).toBeLessThan(600)
    }),
  )

  it.effect("rejects a root-combinator parameter schema at construction time", () =>
    Effect.gen(function* () {
      const union = yield* Tool.define(
        "unionroot",
        Effect.succeed({
          ...makeTool("unionroot"),
          parameters: Schema.Union([Schema.Struct({ a: Schema.String }), Schema.Struct({ b: Schema.String })]) as never,
        }),
      )
      const exit = yield* Effect.exit(union.init())
      if (Exit.isSuccess(exit)) throw new Error("expected construction to die")
      const die = exit.cause.reasons.find(Cause.isDieReason)
      const message = String(die?.defect)
      expect(message).toContain("unionroot")
      expect(message).toContain("plain object")
      expect(message).toContain("params")
    }),
  )
})
