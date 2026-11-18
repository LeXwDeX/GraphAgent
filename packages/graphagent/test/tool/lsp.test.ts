import { PermissionV1 } from "@graphagent/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
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

const stub = (hasClients: boolean) =>
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(hasClients),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed([]),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: (query) =>
      Effect.sync(() => {
        workspaceSymbolQueries.push(query)
        return []
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
