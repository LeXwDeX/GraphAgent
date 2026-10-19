import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Cause, Effect, Layer } from "effect"
import * as PlatformError from "effect/PlatformError"
import { GrepTool } from "../../src/tool/grep"
import { provideInstance, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"
import { Git } from "@/git"

const toolLayer = () =>
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    FSUtil.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Git.defaultLayer,
  )

const it = testEffect(toolLayer())
const rooted = testEffect(Layer.mergeAll(toolLayer(), testInstanceStoreLayer))

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

const root = path.join(__dirname, "../..")

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

const failingGrep = (params: { pattern: string; path: string }, next?: Partial<typeof ctx>) =>
  Effect.gen(function* () {
    const info = yield* GrepTool
    const grep = yield* info.init()
    return yield* grep.execute(params, { ...ctx, ...next })
  })

describe("tool.grep", () => {
  rooted.live("basic search", () =>
    Effect.gen(function* () {
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* provideInstance(root)(
        grep.execute(
          {
            pattern: "export",
            path: path.join(root, "src/tool"),
            include: "*.ts",
          },
          ctx,
        ),
      )
      expect(result.metadata.matches).toBeGreaterThan(0)
      expect(result.output).toContain("Found")
    }),
  )

  it.instance("no matches returns correct output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "hello world"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "xyznonexistentpatternxyz123",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.matches).toBe(0)
      expect(result.output).toBe("No files found")
    }),
  )

  it.instance("finds matches in tmp instance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "line1\nline2\nline3"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "line",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.matches).toBeGreaterThan(0)
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
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory, include: "*.txt" }, ctx)
      expect(result.metadata.matches).toBe(100)
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toStartWith("Found 100 matches\n")
      expect(result.output).not.toContain("Results truncated")
      expect(result.output).not.toContain("more matches available")
    }),
  )

  it.instance("does not report an unknown total when results are truncated", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 101 }, (_, index) =>
            Bun.write(path.join(test.directory, `match-${index}.txt`), "needle"),
          ),
        ),
      )
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory, include: "*.txt" }, ctx)

      expect(result.output).toContain("(Results truncated. Consider using a more specific path or pattern.)")
      expect(result.output).not.toMatch(/showing \d+ of \d+ matches/)
    }),
  )

  it.instance("supports exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "test.txt")
      yield* Effect.promise(() => Bun.write(file, "line1\nline2\nline3"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "sibling.txt"), "line2 from sibling"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "line2",
          path: file,
        },
        ctx,
      )
      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(file)
      expect(result.output).toContain("Line 2: line2")
      expect(result.output).not.toContain("sibling.txt")
    }),
  )

  it.instance("identifies a missing absolute search path with a discovery hint", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const missing = path.join(test.directory, "missing.txt")
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "sibling.txt"), "needle"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* Effect.exit(grep.execute({ pattern: "needle", path: missing }, ctx))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const text = Cause.pretty(result.cause)
        expect(text).toContain(`Search path does not exist: ${missing}`)
        expect(text).toContain("Verify the path with Glob")
        expect(text).not.toContain("permission")
      }
    }),
  )

  it.instance("reports a missing relative search path with the resolved location", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const resolved = path.join(test.directory, "config")
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* Effect.exit(grep.execute({ pattern: "needle", path: "config" }, ctx))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const text = Cause.pretty(result.cause)
        expect(text).toContain(`Search path does not exist: ${resolved}`)
        expect(text).toContain("Verify the path with Glob")
      }
    }),
  )

  it.instance("reports a filesystem permission denial distinctly from a policy rejection", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const faultFS = yield* statFaultLayer(test.directory, () => Effect.fail(statDenial(test.directory)))
      const result = yield* Effect.exit(
        failingGrep({ pattern: "needle", path: test.directory }).pipe(Effect.provide(faultFS)),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const text = Cause.pretty(result.cause)
        expect(text).toContain(`Filesystem permission denied for search path: ${test.directory}`)
        expect(text).toContain("not an OpenCode permission policy rejection")
        expect(text).not.toContain("does not exist")
      }
    }),
  )

  it.instance("keeps an unclassified stat failure carrying its actual cause", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const faultFS = yield* statFaultLayer(test.directory, () => Effect.fail(statUnknown(test.directory)))
      const result = yield* Effect.exit(
        failingGrep({ pattern: "needle", path: test.directory }).pipe(Effect.provide(faultFS)),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const text = Cause.pretty(result.cause)
        expect(text).toContain(`Cannot access search path: ${test.directory}`)
        expect(text).toContain("simulated storage failure")
        expect(text).not.toContain("Filesystem permission denied")
        expect(text).not.toContain("does not exist")
      }
    }),
  )

  it.instance("reports an invalid path component distinctly", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "real.txt")
      yield* Effect.promise(() => Bun.write(file, "needle"))
      const invalid = path.join(file, "child.txt")
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* Effect.exit(grep.execute({ pattern: "needle", path: invalid }, ctx))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const text = Cause.pretty(result.cause)
        expect(text).toContain(`Invalid search path: ${invalid}`)
        expect(text).not.toContain("does not exist")
        expect(text).not.toContain("Filesystem permission denied")
      }
    }),
  )

  it.instance("keeps permission policy rejection separate from filesystem errors", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const result = yield* Effect.exit(
        failingGrep(
          { pattern: "needle", path: test.directory },
          {
            ask: () => Effect.die(new Error("User declined the grep permission request")),
          },
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const text = Cause.pretty(result.cause)
        expect(text).toContain("User declined the grep permission request")
        expect(text).not.toContain("Filesystem permission denied")
        expect(text).not.toContain("does not exist")
      }
    }),
  )

  it.instance("keeps traversal failures visible after a successful stat", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      if (process.getuid?.() === 0) return
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "readable.txt"), "needle"))
      const locked = path.join(test.directory, "locked.txt")
      yield* Effect.promise(() => Bun.write(locked, "needle"))
      yield* Effect.promise(() => fs.chmod(locked, 0o000))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* Effect.exit(grep.execute({ pattern: "needle", path: test.directory }, ctx))
      yield* Effect.promise(() => fs.chmod(locked, 0o644))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const text = Cause.pretty(result.cause)
        expect(text).toContain("Permission denied")
      }
    }),
  )

  it.instance("keeps directory searches constrained by include", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "target.md")
      yield* Effect.promise(() => Bun.write(file, "needle"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "sibling.txt"), "needle"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory, include: "*.md" }, ctx)
      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(file)
      expect(result.output).not.toContain("sibling.txt")
    }),
  )

  it.instance("does not ask for external_directory when alias path is allowed", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      yield* TestInstance
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-grep-alias-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      const real = path.join(tmp, "real")
      const alias = path.join(tmp, "alias")
      yield* Effect.promise(() => fs.mkdir(real))
      yield* Effect.promise(() => fs.symlink(real, alias, "dir"))
      yield* Effect.promise(() => Bun.write(path.join(real, "test.txt"), "needle"))

      const ruleset = Permission.fromConfig({
        grep: "allow",
        external_directory: {
          [path.join(alias, "*")]: "allow",
        },
      })
      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const next: Tool.Context = {
        ...ctx,
        ask: (req) =>
          Effect.sync(() => {
            const needsAsk = req.patterns.some(
              (pattern) => Permission.evaluate(req.permission, pattern, ruleset).action !== "allow",
            )
            if (needsAsk) requests.push(req)
          }),
      }

      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "needle",
          path: alias,
          include: "*.txt",
        },
        next,
      )

      expect(result.metadata.matches).toBe(1)
      expect(requests.find((req) => req.permission === "external_directory")).toBeUndefined()
    }),
  )
})
