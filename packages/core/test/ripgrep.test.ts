import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Cause, Effect, Exit, Layer, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import { ExitCode, makeHandle, ProcessId, type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import type { ChildProcess } from "effect/unstable/process"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { AppProcess } from "@opencode-ai/core/process"
import { RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Ripgrep.defaultLayer)

type SpawnFault = (command: ChildProcess.Command) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError>

// Mutable spawn fault consumed by the rebuilt ripgrep layer below. Only tests
// that set it through acquireUseRelease observe a fault; all other tests run
// the real spawner.
let spawnFault: SpawnFault | undefined

const faultedAppProcess = Layer.effect(
  AppProcess.Service,
  Effect.gen(function* () {
    const real = yield* AppProcess.Service
    return AppProcess.Service.of({
      ...real,
      spawn: (command) => (spawnFault ? spawnFault(command) : real.spawn(command)),
    })
  }),
).pipe(Layer.provide(AppProcess.defaultLayer))

const faultedRipgrep = Ripgrep.layer.pipe(Layer.provide(Layer.merge(RipgrepBinary.defaultLayer, faultedAppProcess)))

// Dedicated harness for spawn-fault tests: the fault is consumed by the
// rebuilt ripgrep layer at construction time, so it is provided directly
// instead of merged over the default layer's already-built service.
const itFaulted = testEffect(faultedRipgrep)

const encode = (text: string) => new TextEncoder().encode(text)

const fakeStdout = (lines: readonly string[]) =>
  lines.length > 0 ? Stream.make(...lines.map((line) => encode(`${line}\n`))) : Stream.empty

const fakeHandle = (stdoutLines: readonly string[], stderr: string, exit: number) =>
  makeHandle({
    pid: ProcessId(1),
    exitCode: Effect.succeed(ExitCode(exit)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain as Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>,
    stdout: fakeStdout(stdoutLines),
    stderr: stderr ? Stream.make(encode(stderr)) : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain as Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })

const spawnEnoent = (target: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "ChildProcess",
    method: "access",
    pathOrDescriptor: target,
    syscall: "access",
    cause: new Error(`ENOENT: no such file or directory, access '${target}'`),
  })

const failureText = (exit: Exit.Exit<unknown, unknown>): string => {
  if (exit._tag !== "Failure") return ""
  const cause = Cause.squash(exit.cause)
  return cause instanceof Error ? cause.message : String(cause)
}

describe("Ripgrep", () => {
  itFaulted.live("retains the built-in abort error reason", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        spawnFault = () => Effect.never
      }),
      () =>
        Effect.gen(function* () {
          const controller = new AbortController()
          controller.abort(new Error("search cancelled by caller"))
          const exit = yield* Effect.exit(
            (yield* Ripgrep.Service).glob({ cwd: ".", pattern: "*", limit: 10, signal: controller.signal }),
          )
          expect(exit._tag).toBe("Failure")
          expect(failureText(exit)).toContain("search cancelled by caller")
        }),
      () =>
        Effect.sync(() => {
          spawnFault = undefined
        }),
    ),
  )

  it.live("keeps ignored files out of catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

          const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("never includes git metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".opencode")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".opencode", "config"), "needle\n"))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".git")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".git", "config"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service

          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make(".opencode/config"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))

          const observed: string[] = []
          const limited = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "**/*",
            limit: 1,
            onEntry: (entry) => Effect.sync(() => observed.push(entry.path)),
          })
          expect(observed).toEqual(limited.map((item) => item.path))

          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "config", limit: 10 })
          expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make(".opencode/config"))
          expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make(".git/config"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  it.live("returns context rows in file order", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "context.txt"),
              Array.from({ length: 5 }, (_, index) => `line${index + 1}`).join("\n"),
            ),
          )

          const rows = yield* (yield* Ripgrep.Service).grepContext({
            cwd: tmp.path,
            pattern: "line3",
            limit: 20,
            context: 1,
          })

          expect(rows.map((row) => `${row.kind}:${row.match.line}`)).toEqual(["context:2", "match:3", "context:4"])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("does not split surrogate pairs in oversized line previews", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              // Exactly 2000 code points: fits the preview limit as-is.
              fs.writeFile(path.join(tmp.path, "unicode-exact.txt"), `needle${"x".repeat(1_993)}😀\n`),
              // 2001 code points: the preview stops at 2000 without splitting 😀.
              fs.writeFile(path.join(tmp.path, "unicode-over.txt"), `needle${"x".repeat(1_994)}😀\n`),
            ]),
          )

          const exact = yield* (yield* Ripgrep.Service).grep({
            cwd: tmp.path,
            pattern: "needle",
            file: "unicode-exact.txt",
            limit: 10,
          })
          // An untruncated match keeps ripgrep's line terminator.
          expect(exact[0]?.text).toBe(`needle${"x".repeat(1_993)}😀\n`)
          expect(exact[0]?.textLength).toBeUndefined()

          const over = yield* (yield* Ripgrep.Service).grep({
            cwd: tmp.path,
            pattern: "needle",
            file: "unicode-over.txt",
            limit: 10,
          })
          expect(over[0]?.text).toBe(`needle${"x".repeat(1_994)}`)
          expect(over[0]?.textLength).toBe(2_001)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps other matches when one record is non-UTF-8 or oversized", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              // "needle 你好" with the CJK text encoded as GBK.
              fs.writeFile(
                path.join(tmp.path, "gbk.txt"),
                Buffer.concat([Buffer.from("needle "), Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a])]),
              ),
              fs.writeFile(path.join(tmp.path, "bundle.min.js"), `needle${"x".repeat(80_000)}\n`),
              fs.writeFile(path.join(tmp.path, "plain.txt"), "needle here\n"),
            ]),
          )

          const matches = yield* (yield* Ripgrep.Service).grep({
            cwd: tmp.path,
            pattern: "needle",
            limit: 10,
          })

          expect(matches.map((match) => String(match.entry.path)).sort()).toEqual(["gbk.txt", "plain.txt"])
          expect(matches.find((match) => String(match.entry.path) === "gbk.txt")?.text).toStartWith("needle ")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("surfaces directory traversal failures instead of a partial-success result", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          if (process.platform === "win32" || process.getuid?.() === 0) return
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "readable.txt"), "needle\n"))
          const locked = path.join(tmp.path, "locked.txt")
          yield* Effect.promise(() => fs.writeFile(locked, "needle\n"))
          yield* Effect.promise(() => fs.chmod(locked, 0o000))

          const exit = yield* Effect.exit(
            (yield* Ripgrep.Service).grep({ cwd: tmp.path, pattern: "needle", limit: 10 }),
          )
          yield* Effect.promise(() => fs.chmod(locked, 0o644))

          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") {
            const text = Cause.pretty(exit.cause)
            expect(text).toContain("Permission denied")
            expect(text).toContain("locked.txt")
          }
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("does not report an unreadable exact file as a no-match result", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          if (process.platform === "win32" || process.getuid?.() === 0) return
          const locked = path.join(tmp.path, "locked.txt")
          yield* Effect.promise(() => fs.writeFile(locked, "needle\n"))
          yield* Effect.promise(() => fs.chmod(locked, 0o000))

          const exit = yield* Effect.exit(
            (yield* Ripgrep.Service).grep({ cwd: tmp.path, pattern: "needle", file: "locked.txt", limit: 10 }),
          )
          yield* Effect.promise(() => fs.chmod(locked, 0o644))

          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") {
            const text = Cause.pretty(exit.cause)
            expect(text).toContain("Permission denied")
          }
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  itFaulted.live("keeps the filesystem category and path when the ripgrep process cannot start", () =>
    Effect.gen(function* () {
      const missing = path.join(os.tmpdir(), "opencode-ripgrep-spawn-fault-missing")
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          spawnFault = () => Effect.fail(spawnEnoent(missing))
          return undefined
        }),
        () =>
          Effect.gen(function* () {
            const ripgrep = yield* Ripgrep.Service
            const globExit = yield* Effect.exit(ripgrep.glob({ cwd: missing, pattern: "*.ts", limit: 10 }))
            expect(globExit._tag).toBe("Failure")
            expect(failureText(globExit)).toContain("ripgrep execution failed")
            expect(failureText(globExit)).toContain("NotFound")
            expect(failureText(globExit)).toContain("access")
            expect(failureText(globExit)).toContain(missing)

            const grepExit = yield* Effect.exit(ripgrep.grep({ cwd: missing, pattern: "x", limit: 10 }))
            expect(grepExit._tag).toBe("Failure")
            expect(failureText(grepExit)).toContain("ripgrep execution failed")
            expect(failureText(grepExit)).toContain("NotFound")
            expect(failureText(grepExit)).toContain(missing)
          }),
        () =>
          Effect.sync(() => {
            spawnFault = undefined
          }),
      )
    }),
  )

  itFaulted.live("surfaces glob traversal failures instead of partial or empty success", () =>
    Effect.gen(function* () {
      const stderr = "rg: locked: Permission denied (os error 13)"

      const withMatches = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          spawnFault = () => Effect.succeed(fakeHandle(["readable.txt"], stderr, 2))
          return undefined
        }),
        () =>
          Effect.gen(function* () {
            const ripgrep = yield* Ripgrep.Service
            return yield* Effect.exit(ripgrep.glob({ cwd: ".", pattern: "*.txt", limit: 10 }))
          }),
        () =>
          Effect.sync(() => {
            spawnFault = undefined
          }),
      )
      expect(withMatches._tag).toBe("Failure")
      expect(failureText(withMatches)).toContain("Permission denied")
      expect(failureText(withMatches)).toContain("locked")

      const withoutMatches = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          spawnFault = () => Effect.succeed(fakeHandle([], stderr, 2))
          return undefined
        }),
        () =>
          Effect.gen(function* () {
            const ripgrep = yield* Ripgrep.Service
            return yield* Effect.exit(ripgrep.glob({ cwd: ".", pattern: "*.txt", limit: 10 }))
          }),
        () =>
          Effect.sync(() => {
            spawnFault = undefined
          }),
      )
      expect(withoutMatches._tag).toBe("Failure")
      expect(failureText(withoutMatches)).toContain("Permission denied")
    }),
  )

  itFaulted.live("keeps intentional glob truncation and empty results compatible", () =>
    Effect.gen(function* () {
      const truncated = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          spawnFault = () => Effect.succeed(fakeHandle(["a.txt", "b.txt", "c.txt"], "", 0))
          return undefined
        }),
        () =>
          Effect.gen(function* () {
            const ripgrep = yield* Ripgrep.Service
            return yield* ripgrep.glob({ cwd: ".", pattern: "*.txt", limit: 2 })
          }),
        () =>
          Effect.sync(() => {
            spawnFault = undefined
          }),
      )
      expect(truncated.length).toBe(2)
      expect(truncated.map((entry) => entry.path)).toEqual([RelativePath.make("a.txt"), RelativePath.make("b.txt")])

      const empty = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          spawnFault = () => Effect.succeed(fakeHandle([], "", 1))
          return undefined
        }),
        () =>
          Effect.gen(function* () {
            const ripgrep = yield* Ripgrep.Service
            return yield* ripgrep.glob({ cwd: ".", pattern: "*.txt", limit: 10 })
          }),
        () =>
          Effect.sync(() => {
            spawnFault = undefined
          }),
      )
      expect(empty.length).toBe(0)
    }),
  )

  itFaulted.live("keeps a grep traversal failure failing through the process channel", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          spawnFault = () => Effect.succeed(fakeHandle([], "rg: locked: Permission denied (os error 13)", 2))
          return undefined
        }),
        () =>
          Effect.gen(function* () {
            const ripgrep = yield* Ripgrep.Service
            return yield* Effect.exit(ripgrep.grep({ cwd: ".", pattern: "needle", limit: 10 }))
          }),
        () =>
          Effect.sync(() => {
            spawnFault = undefined
          }),
      )
      expect(exit._tag).toBe("Failure")
      expect(failureText(exit)).toContain("Permission denied")
    }),
  )
})
