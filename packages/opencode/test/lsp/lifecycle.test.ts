import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LSP.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("LSP service lifecycle", () => {
  let spawnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    spawnSpy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)
  })

  afterEach(() => {
    spawnSpy.mockRestore()
  })

  it.instance("init() completes without error", () => LSP.Service.use((lsp) => lsp.init()))

  it.instance("status() returns empty array initially", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.status()
        expect(Array.isArray(result)).toBe(true)
        expect(result.length).toBe(0)
      }),
    ),
  )

  it.instance("diagnostics() returns empty object initially", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.diagnostics()
        expect(typeof result).toBe("object")
        expect(Object.keys(result).length).toBe(0)
      }),
    ),
  )

  it.instance("hasClients() returns false for .ts files in instance when LSP is unset", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.hasClients(path.join((yield* TestInstance).directory, "test.ts"))
        expect(result).toBe(false)
      }),
    ),
  )

  it.instance(
    "hasClients() returns true for .ts files in instance when lsp is true",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.hasClients(path.join((yield* TestInstance).directory, "test.ts"))
          expect(result).toBe(true)
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance(
    "hasClients() keeps built-in LSPs when config object is provided",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.hasClients(path.join((yield* TestInstance).directory, "test.ts"))
          expect(result).toBe(true)
        }),
      ),
    { config: { lsp: { eslint: { disabled: true } } } },
  )

  it.instance("hasClients() returns false for files outside instance", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.hasClients(path.join((yield* TestInstance).directory, "..", "outside.ts"))
        expect(typeof result).toBe("boolean")
      }),
    ),
  )

  it.instance("workspaceSymbol() returns empty array with no clients", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.workspaceSymbol("test")
        expect(Array.isArray(result)).toBe(true)
        expect(result.length).toBe(0)
      }),
    ),
  )

  it.instance("definition() returns empty array for unknown file", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.definition({
          file: path.join((yield* TestInstance).directory, "nonexistent.ts"),
          line: 0,
          character: 0,
        })
        expect(Array.isArray(result)).toBe(true)
      }),
    ),
  )

  it.instance("references() returns empty array for unknown file", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.references({
          file: path.join((yield* TestInstance).directory, "nonexistent.ts"),
          line: 0,
          character: 0,
        })
        expect(Array.isArray(result)).toBe(true)
      }),
    ),
  )

  it.instance("multiple init() calls are idempotent", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        yield* lsp.init()
        yield* lsp.init()
        yield* lsp.init()
      }),
    ),
  )
})

describe("LSP.Diagnostic", () => {
  test("pretty() formats error diagnostic", () => {
    const result = LSP.Diagnostic.pretty({
      range: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } },
      message: "Type 'string' is not assignable to type 'number'",
      severity: 1,
    } as any)
    expect(result).toBe("ERROR [10:5] Type 'string' is not assignable to type 'number'")
  })

  test("pretty() formats warning diagnostic", () => {
    const result = LSP.Diagnostic.pretty({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      message: "Unused variable",
      severity: 2,
    } as any)
    expect(result).toBe("WARN [1:1] Unused variable")
  })

  test("pretty() defaults to ERROR when no severity", () => {
    const result = LSP.Diagnostic.pretty({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: "Something wrong",
    } as any)
    expect(result).toBe("ERROR [1:1] Something wrong")
  })

  test("changedRanges() reports the edited line with no surrounding context", () => {
    const ranges = LSP.Diagnostic.changedRanges("a\nb\nc\nd\ne\n", "a\nb\nc\nX\ne\n")
    expect(ranges).toEqual([{ start: 4, end: 4 }])
  })

  test("changedRanges() anchors a pure deletion at the following line", () => {
    const ranges = LSP.Diagnostic.changedRanges("a\nb\nc\n", "a\nc\n")
    expect(ranges).toEqual([{ start: 2, end: 2 }])
  })

  test("changedRanges() ignores a line-ending-only rewrite", () => {
    const ranges = LSP.Diagnostic.changedRanges("a\r\nb\r\nc\r\nd\r\n", "a\nb\nc\nX\nd\n")
    expect(ranges).toEqual([{ start: 4, end: 4 }])
  })

  test("afterEdit() keeps errors in and around the change and drops pre-existing ones", () => {
    const issues = (line: number, message: string) =>
      ({
        range: { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 1 } },
        message,
        severity: 1,
      }) as any
    const block = LSP.Diagnostic.afterEdit(
      "file.ts",
      [issues(4, "changed"), issues(6, "nearby"), issues(9, "pre-existing")],
      "a\nb\nc\nd\ne\nf\ng\nh\ni\n",
      "a\nb\nc\nX\ne\nf\ng\nh\ni\n",
    )
    expect(block).toContain("changed")
    expect(block).toContain("nearby")
    expect(block).not.toContain("pre-existing")
  })

  test("afterEdit() reports a whole new file and nothing when unchanged", () => {
    const issue = {
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
      message: "new error",
      severity: 1,
    } as any
    expect(LSP.Diagnostic.afterEdit("new.ts", [issue], "", "a\nb\nc\n")).toContain("new error")
    expect(LSP.Diagnostic.afterEdit("same.ts", [issue], "a\nb\nc\n", "a\nb\nc\n")).toBe("")
  })
})
