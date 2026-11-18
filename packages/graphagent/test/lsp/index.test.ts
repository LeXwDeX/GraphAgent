import { describe, expect, spyOn } from "bun:test"
import path from "path"
import { Deferred, Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const lspLayer = (flags: Parameters<typeof RuntimeFlags.layer>[0] = {}) =>
  LSP.layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.layer(flags)),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )

const it = testEffect(Layer.mergeAll(lspLayer(), CrossSpawnSpawner.defaultLayer))
const experimentalTyIt = testEffect(
  Layer.mergeAll(lspLayer({ experimentalLspTy: true }), CrossSpawnSpawner.defaultLayer),
)
const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
const disabledDownloadIt = testEffect(
  Layer.mergeAll(lspLayer({ disableLspDownload: true }), CrossSpawnSpawner.defaultLayer),
)

describe("lsp.spawn", () => {
  it.instance(
    "does not spawn builtin LSP for files outside instance",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.touchFile(path.join(dir, "..", "outside.ts"))
            yield* lsp.hover({
              file: path.join(dir, "..", "hover.ts"),
              line: 0,
              character: 0,
            })
            expect(spy).toHaveBeenCalledTimes(0)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance("does not spawn builtin LSP for files inside instance when LSP is unset", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

        try {
          yield* lsp.hover({
            file: path.join(dir, "src", "inside.ts"),
            line: 0,
            character: 0,
          })
          expect(spy).toHaveBeenCalledTimes(0)
        } finally {
          spy.mockRestore()
        }
      }),
    ),
  )

  it.instance(
    "would spawn builtin LSP for files inside instance when lsp is true",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.ts"),
              line: 0,
              character: 0,
            })
            expect(spy).toHaveBeenCalledTimes(1)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance(
    "publishes lsp.updated after custom LSP initialization",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const lsp = yield* LSP.Service
        const updated = yield* Deferred.make<void>()
        const events = yield* EventV2Bridge.Service
        const unsubscribe = yield* events.listen((event) => {
          if (event.type === LSP.Event.Updated.type) Deferred.doneUnsafe(updated, Effect.void)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        const file = path.join(dir, "sample.repro")
        yield* Effect.promise(() => Bun.write(file, "sample\n"))
        yield* lsp.touchFile(file)
        yield* awaitWithTimeout(Deferred.await(updated), "lsp.updated event was not published")
      }),
    {
      config: {
        lsp: {
          fake: {
            command: [process.execPath, fakeServerPath],
            extensions: [".repro"],
          },
        },
      },
    },
  )

  it.instance(
    "would spawn builtin LSP for files inside instance when config object is provided",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.ts"),
              line: 0,
              character: 0,
            })
            expect(spy).toHaveBeenCalledTimes(1)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    {
      config: {
        lsp: {
          eslint: { disabled: true },
        },
      },
    },
  )

  it.instance(
    "uses pyright instead of ty by default",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const ty = spyOn(LSPServer.Ty, "spawn").mockResolvedValue(undefined)
          const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.py"),
              line: 0,
              character: 0,
            })
            expect(ty).toHaveBeenCalledTimes(0)
            expect(pyright).toHaveBeenCalledTimes(1)
          } finally {
            ty.mockRestore()
            pyright.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  experimentalTyIt.instance(
    "uses ty instead of pyright when experimentalLspTy is enabled",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const ty = spyOn(LSPServer.Ty, "spawn").mockResolvedValue(undefined)
          const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.py"),
              line: 0,
              character: 0,
            })
            expect(ty).toHaveBeenCalledTimes(1)
            expect(pyright).toHaveBeenCalledTimes(0)
          } finally {
            ty.mockRestore()
            pyright.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  disabledDownloadIt.instance(
    "passes disableLspDownload to builtin LSP spawn",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.py"),
              line: 0,
              character: 0,
            })
            expect(pyright).toHaveBeenCalledTimes(1)
            expect(pyright.mock.calls[0]?.[2]).toMatchObject({ disableLspDownload: true })
          } finally {
            pyright.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )
})

describe("lsp.touchFile check status", () => {
  it.instance("is disabled when LSP is not configured", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        expect(yield* lsp.touchFile(path.join(dir, "src", "inside.ts"), "document")).toBe("disabled")
      }),
    ),
  )

  it.instance(
    "is disabled when LSP is turned off",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          expect(yield* lsp.touchFile(path.join(dir, "src", "inside.ts"), "document")).toBe("disabled")
        }),
      ),
    { config: { lsp: false } },
  )

  it.instance(
    "has no server for a file outside the project",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          expect(yield* lsp.touchFile(path.join(dir, "..", "outside.ts"), "document")).toBe("no_server")
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance(
    "has no server when no configured server handles the file",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "sample.unhandled")
          yield* Effect.promise(() => Bun.write(file, "sample\n"))
          expect(yield* lsp.touchFile(file, "document")).toBe("no_server")
        }),
      ),
    {
      config: {
        lsp: { fake: { command: [process.execPath, fakeServerPath], extensions: [".repro"] } },
      },
    },
  )

  it.instance(
    "has no server when the file cannot be opened on the server",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          // A matching server exists, but the file is gone: the open fails and nothing was checked.
          expect(yield* lsp.touchFile(path.join(dir, "missing.repro"), "document")).toBe("no_server")
        }),
      ),
    {
      config: {
        lsp: { fake: { command: [process.execPath, fakeServerPath], extensions: [".repro"] } },
      },
    },
  )

  it.instance(
    "is checked once the file is open when no diagnostics are waited for",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "sample.repro")
          yield* Effect.promise(() => Bun.write(file, "sample\n"))
          expect(yield* lsp.touchFile(file)).toBe("checked")
        }),
      ),
    {
      config: {
        lsp: { fake: { command: [process.execPath, fakeServerPath], extensions: [".repro"] } },
      },
    },
  )

  // The real wait: the fake server never publishes diagnostics, so the document wait runs its full 5 seconds.
  it.instance(
    "times out when the server publishes no diagnostics for the file",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "sample.repro")
          yield* Effect.promise(() => Bun.write(file, "sample\n"))
          expect(yield* lsp.touchFile(file, "document")).toBe("timed_out")
        }),
      ),
    {
      config: {
        lsp: { fake: { command: [process.execPath, fakeServerPath], extensions: [".repro"] } },
      },
    },
    30_000,
  )
})
