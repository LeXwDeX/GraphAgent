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

  it.instance("returns the requested context around each match", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "context.txt")
      yield* Effect.promise(() =>
        Bun.write(file, Array.from({ length: 20 }, (_, index) => `line${index + 1}`).join("\n")),
      )
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "line10", path: file, context: 2 }, ctx)

      expect(result.output).toStartWith("Found 1 matches\n")
      expect(result.output).toContain("Line 10: line10")
      expect(result.output).toContain("Line 8- line8")
      expect(result.output).toContain("Line 9- line9")
      expect(result.output).toContain("Line 11- line11")
      expect(result.output).toContain("Line 12- line12")
      expect(result.output).not.toContain("line7")
      expect(result.output).not.toContain("line13")
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
      expect(result.output).not.toContain("[truncated:")
    }),
  )

  it.instance("keeps long-line matches within the shared output byte budget", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 60 }, (_, index) =>
            Bun.write(path.join(test.directory, `wide-${index}.txt`), `needle ${"x".repeat(1_900)}`),
          ),
        ),
      )
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory, include: "*.txt" }, ctx)

      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThan(Truncate.MAX_BYTES + 1_024)
      expect(result.metadata.truncated).toBe(true)
      expect(result.metadata.matches).toBeLessThan(60)
      expect(result.output).toContain(`[truncated: showing ${result.metadata.matches} of 60 matches.`)
      expect(result.output).toContain("the byte budget stopped the preview")
      expect(result.output).toContain("Full output: ")
      expect(result.output).toContain("Continue: read filePath=")
    }),
  )

  it.instance("reports the total and the saved listing when results are truncated", () =>
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

      expect(result.output).toContain("[truncated: showing 100 of 101 matches. 1 match omitted.")
      expect(result.output).toContain("Full output: ")
      expect(result.output).toContain("raise grep limit to 200 to show more")
      expect(result.metadata.matches).toBe(100)
      expect(result.metadata.truncated).toBe(true)
    }),
  )

  it.instance("does not point past the saved listing when the match cap is hit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "many.txt")
      yield* Effect.promise(() =>
        Bun.write(file, Array.from({ length: 1001 }, (_, index) => `needle ${index}`).join("\n") + "\n"),
      )
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        { pattern: "needle", path: test.directory, include: "*.txt", limit: 1000 },
        ctx,
      )

      expect(result.metadata.truncated).toBe(true)
      expect(result.metadata.matches).toBe(1_000)
      expect(result.output).toContain("The scan stopped at the match cap.")
      const full = /Full output: (.+)\]/m.exec(result.output)?.[1]
      expect(full).toBeTruthy()
      // The probe that proved the cap was hit is not saved, and the preview
      // already covers every saved match. An offset would land past the end of
      // the listing, so the continuation must ask the agent to narrow instead.
      expect(result.output).not.toContain("offset=")
      expect(result.output).toContain("Continue: narrow path/include or use a more specific pattern")
      const saved = yield* Effect.promise(() => fs.readFile(full!, "utf8"))
      const lines = saved.trimEnd().split("\n")
      expect(lines.at(-1)).toContain("needle 999")
      expect(lines.join("\n")).not.toContain("needle 1000")
    }),
  )

  it.instance("points the saved-listing continuation at the first omitted match", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "many.txt")
      yield* Effect.promise(() =>
        Bun.write(file, Array.from({ length: 101 }, (_, index) => `needle ${index}`).join("\n") + "\n"),
      )
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory, include: "*.txt", limit: 100 }, ctx)

      expect(result.metadata.truncated).toBe(true)
      const full = /Full output: (.+)\]/m.exec(result.output)?.[1]
      const next = /offset=(\d+)/.exec(result.output)?.[1]
      expect(full).toBeTruthy()
      expect(next).toBeTruthy()
      const lines = (yield* Effect.promise(() => fs.readFile(full!, "utf8"))).split("\n")
      expect(lines[Number(next) - 1]).toContain("needle 100")
    }),
  )

  it.instance("reports context lines dropped by the byte budget instead of silently trimming", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "context-budget.txt")
      const matches = Array.from({ length: 5 }, (_, index) => `needle ${index}`)
      // Context rows are capped at 2000 code points, so ASCII padding would fit
      // the byte budget. Astral characters make each kept context row ~8 KB and
      // force the budget to stop the preview with matches still fully shown.
      const context = Array.from({ length: 20 }, (_, index) => `after-${index} ${"😀".repeat(2_000)}`)
      yield* Effect.promise(() => Bun.write(file, [...matches, ...context].join("\n")))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: file, context: 20 }, ctx)

      // Every match fits before the byte budget stops the preview, so the only
      // omitted rows are context; the notice must say so and point at the
      // complete saved listing.
      expect(result.metadata.matches).toBe(5)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("[truncated: showing 5 of 5 matches.")
      expect(result.output).toContain("Context lines were omitted by the output byte budget.")
      expect(result.output).toContain("the byte budget stopped the preview, so read the saved listing")
      const full = /Full output: (.+)\]/m.exec(result.output)?.[1]
      expect(full).toBeTruthy()
      const saved = yield* Effect.promise(() => fs.readFile(full!, "utf8"))
      expect(saved).toContain("after-19")
    }),
  )

  it.instance("truncates match text by code points and continues on a character boundary", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "astral.txt")
      const line = "😀".repeat(2_500) + "needle"
      yield* Effect.promise(() => Bun.write(file, line))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: file }, ctx)

      expect(result.output).toContain("line truncated to 2000 of 2506 chars")
      expect(result.output).toContain("charOffset=2001 maxLineLength=506")
      // Cutting UTF-16 units would leave a lone surrogate, rendered as U+FFFD.
      expect(result.output).not.toContain("�")
    }),
  )

  it.instance("caps an oversized limit at the scan cap and says the scan stopped", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "oversized-limit.txt")
      yield* Effect.promise(() =>
        Bun.write(file, Array.from({ length: 1_200 }, (_, index) => `needle ${index}`).join("\n") + "\n"),
      )
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: file, limit: 5_000 }, ctx)

      expect(result.metadata.matches).toBe(1_000)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("[truncated: showing 1000 of at least 1001 matches.")
      expect(result.output).toContain("The scan stopped at the match cap.")
    }),
  )

  it.instance("caps context at 20 lines on each side", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "context-cap.txt")
      yield* Effect.promise(() =>
        Bun.write(file, Array.from({ length: 60 }, (_, index) => `line${index + 1}`).join("\n")),
      )
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "line30", path: file, context: 25 }, ctx)

      expect(result.output).toContain("Line 10- line10")
      expect(result.output).toContain("Line 50- line50")
      expect(result.output).not.toContain("Line 9- line9")
      expect(result.output).not.toContain("Line 51- line51")
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
