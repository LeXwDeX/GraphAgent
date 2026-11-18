import { PermissionV1 } from "@graphagent/core/v1/permission"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import * as PlatformError from "effect/PlatformError"
import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner"
import { GlobTool } from "../../src/tool/glob"
import { SessionID, MessageID } from "../../src/session/schema"
import { AppProcess } from "@graphagent/core/process"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { RipgrepBinary } from "@graphagent/core/ripgrep/binary"
import { FSUtil } from "@graphagent/core/fs-util"
import { Global } from "@graphagent/core/global"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { Filesystem } from "@/util/filesystem"
import { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"

const toolLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    FSUtil.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Git.defaultLayer,
  )

const it = testEffect(toolLayer())
// 1000 absolute paths are more than 50 KB wherever the temp directory is long (macOS), and the count cap is what
// these tests are about: lift the byte budget.
const unbounded = testEffect(
  Layer.mergeAll(toolLayer(), TestConfig.layer({ get: () => Effect.succeed({ tool_output: { max_bytes: 1 << 30 } }) })),
)
const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)

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
    } satisfies Tool.Context,
  }
}

/**
 * Builds a filesystem layer that fails stat() on one exact target path.
 * Deterministic and portable across privileged CI users because it never
 * relies on OS-level chmod.
 */
const statFaultLayer = (target: string, fault: () => Effect.Effect<never, PlatformError.PlatformError>) =>
  Effect.map(FSUtil.Service, (fs) =>
    Layer.succeed(FSUtil.Service, {
      ...fs,
      stat: (p: string) => (p === target ? fault() : fs.stat(p)),
    }),
  )

const statDenial = (target: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "stat",
    pathOrDescriptor: target,
    syscall: "stat",
    cause: new Error("simulated EACCES: Permission denied"),
  })

const statUnknown = (target: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "stat",
    pathOrDescriptor: target,
    syscall: "stat",
    description: "simulated storage failure",
    cause: new Error("simulated storage failure"),
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

// Mutable spawn fault consumed by the rebuilt ripgrep layer below. Only tests
// that set it through acquireUseRelease observe a fault; all other tests run
// the real spawner.
let spawnFault: (() => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError>) | undefined

const faultedRipgrep = Ripgrep.layer.pipe(
  Layer.provide(
    Layer.merge(
      RipgrepBinary.defaultLayer,
      Layer.effect(
        AppProcess.Service,
        Effect.gen(function* () {
          const real = yield* AppProcess.Service
          return AppProcess.Service.of({
            ...real,
            spawn: (command) => (spawnFault ? spawnFault() : real.spawn(command)),
          })
        }),
      ).pipe(Layer.provide(AppProcess.defaultLayer)),
    ),
  ),
)

const failureMessage = (exit: Exit.Exit<unknown, unknown>): string => {
  if (!Exit.isFailure(exit)) return ""
  const cause = Cause.squash(exit.cause)
  return cause instanceof Error ? cause.message : String(cause)
}

// Dedicated harness for the post-stat spawn-fault test: the fault is consumed
// by the rebuilt ripgrep layer at construction time, so it replaces the
// toolLayer's ripgrep directly instead of being merged over an already-built
// service.
const itFaulted = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    FSUtil.defaultLayer,
    faultedRipgrep,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Git.defaultLayer,
  ),
)

const globExecute = (params: { pattern: string; path?: string; limit?: number }, next?: Partial<Tool.Context>) =>
  Effect.gen(function* () {
    const info = yield* GlobTool
    const glob = yield* info.init()
    return yield* glob.execute(params, { ...ctx, ...next })
  })

const githubBase = <A, E, R>(url: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.GRAPHAGENT_REPO_CLONE_GITHUB_BASE_URL
      process.env.GRAPHAGENT_REPO_CLONE_GITHUB_BASE_URL = url
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous) process.env.GRAPHAGENT_REPO_CLONE_GITHUB_BASE_URL = previous
        else delete process.env.GRAPHAGENT_REPO_CLONE_GITHUB_BASE_URL
      }),
  )

const git = Effect.fn("GlobToolTest.git")(function* (cwd: string, args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
    return stdout.trim()
  })
})

describe("tool.glob", () => {
  it.instance("matches files from a directory path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "export const a = 1\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "b.txt"), "hello\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const result = yield* glob.execute(
        {
          pattern: "*.ts",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.count).toBe(1)
      expect(result.output).toContain(path.join(test.directory, "a.ts"))
      expect(result.output).not.toContain(path.join(test.directory, "b.txt"))
    }),
  )

  it.instance("rejects exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "a.ts")
      yield* Effect.promise(() => Bun.write(file, "export const a = 1\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const exit = yield* glob
        .execute(
          {
            pattern: "*.ts",
            path: file,
          },
          ctx,
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err instanceof Error ? err.message : String(err)).toContain("glob path must be a directory")
      }
    }),
  )

  it.instance("identifies a missing glob directory with a discovery hint", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const missing = path.join(test.directory, "missing-dir")
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "export const a = 1\n"))
      const result = yield* Effect.exit(globExecute({ pattern: "*.ts", path: missing }))
      expect(result._tag).toBe("Failure")
      expect(failureMessage(result)).toContain(`Search path does not exist: ${missing}`)
      expect(failureMessage(result)).toContain("Check the nearest existing parent directory")
      expect(failureMessage(result)).not.toContain("permission")
    }),
  )

  it.instance("reports a missing relative glob directory at its resolved location", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const resolved = path.join(test.directory, "missing-rel")
      const result = yield* Effect.exit(globExecute({ pattern: "*.ts", path: "missing-rel" }))
      expect(result._tag).toBe("Failure")
      expect(failureMessage(result)).toContain(`Search path does not exist: ${resolved}`)
      expect(failureMessage(result)).toContain("Check the nearest existing parent directory")
    }),
  )

  it.instance("reports a filesystem permission denial distinctly from a policy rejection", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const faultFS = yield* statFaultLayer(test.directory, () => Effect.fail(statDenial(test.directory)))
      const result = yield* Effect.exit(
        globExecute({ pattern: "*.ts", path: test.directory }).pipe(Effect.provide(faultFS)),
      )
      expect(result._tag).toBe("Failure")
      expect(failureMessage(result)).toContain(`Filesystem permission denied for search path: ${test.directory}`)
      expect(failureMessage(result)).toContain("not a GraphAgent permission policy rejection")
      expect(failureMessage(result)).not.toContain("does not exist")
    }),
  )

  it.instance("keeps an unclassified stat failure carrying its actual cause", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const faultFS = yield* statFaultLayer(test.directory, () => Effect.fail(statUnknown(test.directory)))
      const result = yield* Effect.exit(
        globExecute({ pattern: "*.ts", path: test.directory }).pipe(Effect.provide(faultFS)),
      )
      expect(result._tag).toBe("Failure")
      expect(failureMessage(result)).toContain(`Cannot access search path: ${test.directory}`)
      expect(failureMessage(result)).toContain("simulated storage failure")
      expect(failureMessage(result)).not.toContain("Filesystem permission denied")
      expect(failureMessage(result)).not.toContain("does not exist")
    }),
  )

  it.instance("reports an invalid glob path component distinctly", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "real.txt")
      yield* Effect.promise(() => Bun.write(file, "needle"))
      const invalid = path.join(file, "child")
      const result = yield* Effect.exit(globExecute({ pattern: "*.ts", path: invalid }))
      expect(result._tag).toBe("Failure")
      expect(failureMessage(result)).toContain(`Invalid search path: ${invalid}`)
      expect(failureMessage(result)).not.toContain("does not exist")
      expect(failureMessage(result)).not.toContain("Filesystem permission denied")
    }),
  )

  it.instance("keeps permission policy rejection separate from filesystem errors", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const result = yield* Effect.exit(
        globExecute(
          { pattern: "*.ts", path: test.directory },
          {
            ask: () => Effect.die(new Error("User declined the glob permission request")),
          },
        ),
      )
      expect(result._tag).toBe("Failure")
      expect(failureMessage(result)).toContain("User declined the glob permission request")
      expect(failureMessage(result)).not.toContain("does not exist")
      expect(failureMessage(result)).not.toContain("Filesystem permission denied")
    }),
  )

  it.instance("keeps traversal failures visible after a successful stat", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      if (process.getuid?.() === 0) return
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "visible.txt"), "needle"))
      const locked = path.join(test.directory, "locked")
      yield* Effect.promise(() => fs.mkdir(locked))
      yield* Effect.promise(() => Bun.write(path.join(locked, "inner.txt"), "needle"))
      yield* Effect.promise(() => fs.chmod(locked, 0o000))

      const withMatches = yield* Effect.exit(globExecute({ pattern: "*.txt", path: test.directory }))
      const withoutMatches = yield* Effect.exit(globExecute({ pattern: "*.nomatch", path: test.directory }))
      yield* Effect.promise(() => fs.chmod(locked, 0o755))

      expect(withMatches._tag).toBe("Failure")
      expect(failureMessage(withMatches)).toContain("Permission denied")
      expect(withoutMatches._tag).toBe("Failure")
      expect(failureMessage(withoutMatches)).toContain("Permission denied")
      expect(failureMessage(withoutMatches)).not.toContain("No files found")
    }),
  )

  itFaulted.instance("keeps post-stat spawn failures carrying their filesystem category", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "ok.txt"), "needle"))
      const result = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          spawnFault = () => Effect.fail(spawnEnoent(test.directory))
          return undefined
        }),
        () => Effect.exit(globExecute({ pattern: "*.txt", path: test.directory })),
        () =>
          Effect.sync(() => {
            spawnFault = undefined
          }),
      )
      expect(result._tag).toBe("Failure")
      expect(failureMessage(result)).toContain("ripgrep execution failed")
      expect(failureMessage(result)).toContain("NotFound")
      expect(failureMessage(result)).toContain(test.directory)
      expect(failureMessage(result)).not.toContain("No files found")
    }),
  )

  // The same search lists the same paths in the same order on every machine, so a cut list is the first N of a
  // known order and the model can tell what it has not seen (#1448).
  it.instance("lists paths in path order, whatever order the files were made in", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      for (let index = 0; index < 100; index++) {
        const name = `f${String((index * 37) % 100).padStart(3, "0")}.txt`
        yield* Effect.promise(() => Bun.write(path.join(test.directory, name), "x"))
      }
      const result = yield* globExecute({ pattern: "*.txt", path: test.directory, limit: 100 })
      const paths = result.output.split("\n").filter((line) => line.endsWith(".txt"))
      expect(paths).toHaveLength(100)
      expect(paths).toEqual([...paths].sort())
      expect(paths[0]).toBe(path.join(test.directory, "f000.txt"))
      expect(paths[99]).toBe(path.join(test.directory, "f099.txt"))
    }),
  )

  // The list has a byte budget of its own, a share of the model's window; a call without a model keeps 50 KB.
  it.instance("cuts the list at the byte budget of a 32K window and says why", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 100 }, (_, index) =>
            Bun.write(path.join(test.directory, `${String(index).padStart(3, "0")}-${"n".repeat(52)}.txt`), "x"),
          ),
        ),
      )
      const model = ProviderTest.model({ limit: { context: 32_000, output: 4_096 } })
      const params = { pattern: "*.txt", path: test.directory }
      const lines = (output: string) => output.split("\n").filter((line) => line.endsWith(".txt"))

      const small = yield* globExecute(params, { extra: { model } })
      const listed = lines(small.output)
      expect(listed.length).toBeGreaterThan(0)
      expect(listed.length).toBeLessThan(100)
      expect(listed.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)).toBeLessThanOrEqual(6_400)
      expect(small.metadata.count).toBe(listed.length)
      expect(small.metadata.truncated).toBe(true)
      expect(small.output).toContain(`[truncated: showing the first ${listed.length} of 100 paths.`)
      expect(small.output).toContain("output byte budget (6.3 KB)")
      expect(small.output).toContain("Continue: narrow path/pattern.")

      const whole = yield* globExecute(params)
      expect(lines(whole.output)).toHaveLength(100)
      expect(whole.metadata.count).toBe(100)
      expect(whole.metadata.truncated).toBe(false)
      expect(whole.output).not.toContain("[truncated:")
    }),
  )

  it.instance("exactly 100 matches are complete", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 100 }, (_, index) =>
            Bun.write(path.join(test.directory, `complete-${index}.txt`), "needle"),
          ),
        ),
      )
      const result = yield* globExecute({ pattern: "*.txt", path: test.directory })
      expect(result.metadata.count).toBe(100)
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).not.toContain("[truncated:")
    }),
  )

  it.instance("reports the exact omitted count and how to continue past the limit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 101 }, (_, index) => Bun.write(path.join(test.directory, `file-${index}.txt`), "x")),
        ),
      )
      const result = yield* globExecute({ pattern: "*.txt", path: test.directory })
      expect(result.metadata.count).toBe(100)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("[truncated: showing the first 100 of 101 paths. 1 paths omitted.")
      expect(result.output).toContain("glob limit=101")

      const limited = yield* globExecute({ pattern: "*.txt", path: test.directory, limit: 5 })
      expect(limited.metadata.count).toBe(5)
      expect(limited.metadata.truncated).toBe(true)
      expect(limited.output).toContain("[truncated: showing the first 5 of 101 paths.")
      expect(limited.output).toContain("Continue: narrow path/pattern, or glob limit=101")
    }),
  )

  unbounded.instance("offers a usable limit continuation when the scan cap stops the listing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(async () => {
        for (let index = 0; index < 1001; index++) {
          await Bun.write(path.join(test.directory, `cap-${index}.txt`), "x")
        }
      })
      const result = yield* globExecute({ pattern: "*.txt", path: test.directory })
      expect(result.metadata.count).toBe(100)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("[truncated: showing the first 100 of at least 1000 paths.")
      expect(result.output).toContain("glob limit=1000 to show up to 1000 paths")

      const wide = yield* globExecute({ pattern: "*.txt", path: test.directory, limit: 1000 })
      expect(wide.metadata.count).toBe(1000)
      expect(wide.metadata.truncated).toBe(true)
      expect(wide.output).toContain("[truncated: showing the first 1000 of at least 1000 paths.")
      expect(wide.output).toContain("Continue: narrow path/pattern.")

      const capped = yield* globExecute({ pattern: "*.txt", path: test.directory, limit: 5000 })
      expect(capped.metadata.count).toBe(1000)
      expect(capped.metadata.truncated).toBe(true)
      expect(capped.output).toContain("[truncated: showing the first 1000 of at least 1000 paths.")
      expect(capped.output).toContain("Continue: narrow path/pattern.")
    }),
  )

  it.instance("says a limit above the maximum was capped and records clamped (#1451)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.txt"), "x"))

      const capped = yield* globExecute({ pattern: "*.txt", path: test.directory, limit: 5000 })
      expect(capped.output).toEndWith("\n\nNote: limit 5000 is above the maximum 1000; 1000 was used.")
      expect(capped.metadata).toMatchObject({ corrections: ["clamped"] })

      const exact = yield* globExecute({ pattern: "*.txt", path: test.directory, limit: 1000 })
      expect(exact.output).not.toContain("Note:")
      expect(exact.metadata).not.toHaveProperty("corrections")
    }),
  )

  it.instance("supports relative directories and normal no-match results", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sub = path.join(test.directory, "sub")
      yield* Effect.promise(() => fs.mkdir(sub))
      yield* Effect.promise(() => Bun.write(path.join(sub, "a.ts"), "export const a = 1\n"))

      const found = yield* globExecute({ pattern: "*.ts", path: "sub" })
      expect(found.metadata.count).toBe(1)
      expect(found.output).toContain(path.join(sub, "a.ts"))

      const none = yield* globExecute({ pattern: "*.doesnotexist", path: test.directory })
      expect(none.metadata.count).toBe(0)
      expect(none.output).toContain("No files found")
    }),
  )
})
