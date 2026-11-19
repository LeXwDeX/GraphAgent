import { PermissionV1 } from "@graphagent/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { FSUtil } from "@graphagent/core/fs-util"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { LspTool } from "../../src/tool/lsp"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  canned.definition = []
  canned.workspaceSymbol = []
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const workspaceSymbolQueries: string[] = []
// What the stub language server answers; a case sets the one it reads and the afterEach below clears them.
const canned: { definition: unknown[]; workspaceSymbol: LSP.Symbol[] } = { definition: [], workspaceSymbol: [] }

const stub = (hasClients: boolean) =>
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(hasClients),
    touchFile: () => Effect.succeed<LSP.Diagnostic.CheckStatus>("checked"),
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed([]),
    definition: () => Effect.succeed(canned.definition),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: (query) =>
      Effect.sync(() => {
        workspaceSymbolQueries.push(query)
        return canned.workspaceSymbol
      }),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  })

const lsp = Layer.succeed(LSP.Service, stub(true))
const noServer = Layer.succeed(LSP.Service, stub(false))

const base = Layer.mergeAll(
  Agent.defaultLayer,
  FSUtil.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Truncate.defaultLayer,
)
const it = testEffect(Layer.mergeAll(base, lsp))
const itNoServer = testEffect(Layer.mergeAll(base, noServer))

const init = Effect.fn("LspToolTest.init")(function* () {
  const info = yield* LspTool
  return yield* info.init()
})

const run = Effect.fn("LspToolTest.run")(function* (
  args: Tool.InferParameters<typeof LspTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("LspToolTest.fail")(function* (args: Tool.InferParameters<typeof LspTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected lsp to fail")
})

const put = Effect.fn("LspToolTest.put")(function* (file: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, "export const x = 1\n")
})

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

describe("tool.lsp", () => {
  describe("permission metadata", () => {
    it.instance(
      "keeps cursor details for position-based operations",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          const result = yield* run({ operation: "goToDefinition", filePath: file, line: 3, character: 7 }, next)
          const req = items.find((item) => item.permission === "lsp")

          expect(req).toBeDefined()
          expect(req!.metadata).toEqual({
            operation: "goToDefinition",
            filePath: file,
            line: 3,
            character: 7,
          })
          expect(result.title).toBe("goToDefinition test.ts:3:7")
        }),
      { git: true },
    )

    it.instance(
      "omits cursor details for documentSymbol",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          const result = yield* run({ operation: "documentSymbol", filePath: file, line: 3, character: 7 }, next)
          const req = items.find((item) => item.permission === "lsp")

          expect(req).toBeDefined()
          expect(req!.metadata).toEqual({
            operation: "documentSymbol",
            filePath: file,
          })
          expect(result.title).toBe("documentSymbol test.ts")
        }),
      { git: true },
    )

    it.instance(
      "omits file and cursor details for workspaceSymbol",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          workspaceSymbolQueries.length = 0
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          const result = yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7 }, next)
          const req = items.find((item) => item.permission === "lsp")

          expect(req).toBeDefined()
          expect(req!.metadata).toEqual({
            operation: "workspaceSymbol",
          })
          expect(result.title).toBe("workspaceSymbol")
        }),
      { git: true },
    )

    it.instance(
      "passes workspaceSymbol query to LSP",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          workspaceSymbolQueries.length = 0
          const file = path.join(dir, "test.ts")
          yield* put(file)

          yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7, query: "TestSymbol" })
          yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7 })

          expect(workspaceSymbolQueries).toEqual(["TestSymbol", ""])
        }),
      { git: true },
    )
  })

  describe("line and character are checked when the call runs (#1450)", () => {
    // The seven operations that act at a cursor position; the other two take none.
    const positional = [
      "goToDefinition",
      "findReferences",
      "hover",
      "goToImplementation",
      "prepareCallHierarchy",
      "incomingCalls",
      "outgoingCalls",
    ] as const

    it.instance(
      "rejects a positional operation without a line before it asks anything",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)

          for (const operation of positional) {
            const { items, next } = asks()
            const exit = yield* run({ operation, filePath: file, character: 3 }, next).pipe(Effect.exit)
            const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
            if (!(error instanceof Tool.InvalidArgumentsError)) throw new Error(`${operation} was not rejected`)
            expect(error.detail).toBe(
              `line and character (1-based, as shown by read) are required for ${operation}; only documentSymbol and workspaceSymbol work without them.`,
            )
            expect(items).toEqual([])
          }
        }),
      { git: true },
    )

    it.instance(
      "rejects a positional operation without a character",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          const exit = yield* run({ operation: "hover", filePath: file, line: 1 }, next).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(items).toEqual([])
        }),
      { git: true },
    )

    it.instance(
      "documentSymbol and workspaceSymbol work without a line or a character",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const symbols = yield* run({ operation: "documentSymbol", filePath: file })
          expect(symbols.title).toBe("documentSymbol test.ts")
          const workspace = yield* run({ operation: "workspaceSymbol", filePath: file, query: "x" })
          expect(workspace.title).toBe("workspaceSymbol")
        }),
      { git: true },
    )
  })

  describe("results use the numbers and paths read shows (#1450)", () => {
    it.instance(
      "a location comes back 1-based with an absolute path and no file:// URI",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)
          const range = { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } }
          canned.definition = [{ uri: pathToFileURL(file).href, range }]

          const result = yield* run({ operation: "goToDefinition", filePath: file, line: 3, character: 7 })

          expect(result.output).not.toContain("file://")
          expect(JSON.parse(result.output)).toEqual([
            { path: file, range: { start: { line: 5, character: 3 }, end: { line: 5, character: 10 } } },
          ])
          // The raw answer stays in the metadata for consumers that read LSP coordinates.
          expect(result.metadata).toMatchObject({ result: [{ uri: pathToFileURL(file).href, range }] })
        }),
      { git: true },
    )

    it.instance(
      "workspaceSymbol shows 10 symbols and states the total when it cuts",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)
          const symbol = (index: number): LSP.Symbol => ({
            name: `symbol${index}`,
            kind: 12,
            location: {
              uri: pathToFileURL(file).href,
              range: { start: { line: index, character: 0 }, end: { line: index, character: 4 } },
            },
          })
          canned.workspaceSymbol = Array.from({ length: 25 }, (_, index) => symbol(index))

          const result = yield* run({ operation: "workspaceSymbol", filePath: file, query: "symbol" })

          const [first, ...body] = result.output.split("\n")
          expect(first).toBe("workspaceSymbol: showing 10 of 25 symbols. Narrow the query to see others.")
          const shown = JSON.parse(body.join("\n"))
          expect(shown).toHaveLength(10)
          // 1-based with an absolute path in the text.
          expect(shown[0]).toEqual({
            name: "symbol0",
            kind: 12,
            location: { path: file, range: { start: { line: 1, character: 1 }, end: { line: 1, character: 5 } } },
          })
          // The metadata keeps the first ten raw (0-based) symbols.
          expect(result.metadata).toMatchObject({ result: canned.workspaceSymbol.slice(0, 10) })
        }),
      { git: true },
    )

    it.instance(
      "workspaceSymbol with ten symbols or fewer writes no count line",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)
          canned.workspaceSymbol = [
            {
              name: "only",
              kind: 12,
              location: {
                uri: pathToFileURL(file).href,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
              },
            },
          ]

          const result = yield* run({ operation: "workspaceSymbol", filePath: file, query: "only" })

          expect(result.output.startsWith("[")).toBe(true)
          expect(result.output).not.toContain("showing")
        }),
      { git: true },
    )
  })

  describe("failures name the next step", () => {
    it.instance(
      "a missing file says to check the path with glob",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "missing.ts")

          const err = yield* fail({ operation: "hover", filePath: file, line: 1, character: 1 })
          expect(err.message).toBe(`File not found: ${file}. Check the path with glob.`)
        }),
      { git: true },
    )

    itNoServer.instance(
      "a file type without a language server points to grep and read",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "notes.txt")
          yield* put(file)

          const err = yield* fail({ operation: "hover", filePath: file, line: 1, character: 1 })
          expect(err.message).toBe("No LSP server available for this file type. Use grep or read instead.")
        }),
      { git: true },
    )
  })
})
