import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import * as PlatformError from "effect/PlatformError"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { GlobTool } from "../../src/tool/glob"
import { SessionID, MessageID } from "../../src/session/schema"
import { AppProcess } from "@opencode-ai/core/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
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

const globExecute = (params: { pattern: string; path?: string }, next?: Partial<typeof ctx>) =>
  Effect.gen(function* () {
    const info = yield* GlobTool
    const glob = yield* info.init()
    return yield* glob.execute(params, { ...ctx, ...next })
  })

const githubBase = <A, E, R>(url: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = url
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous) process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = previous
        else delete process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
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
      expect(failureMessage(result)).toContain("not an OpenCode permission policy rejection")
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
      expect(result.output).not.toContain("Results are truncated")
    }),
  )

  it.instance("does not treat the intentional result limit as a failure", () =>
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
      expect(result.output).toContain("(Results are truncated")
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
