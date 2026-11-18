import { PermissionV1 } from "@graphagent/core/v1/permission"
import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect"
import path from "path"
import { createHash } from "node:crypto"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { FSUtil } from "@graphagent/core/fs-util"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { FileState } from "@/session/file-state"
import { Parameters, ReadTool } from "../../src/tool/read"
import { WriteTool } from "../../src/tool/write"
import { Format } from "../../src/format"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Filesystem } from "@/util/filesystem"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")

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

const readLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Instruction.defaultLayer,
    FileState.defaultLayer,
    LSP.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
  )

const it = testEffect(Layer.mergeAll(readLayer(), testInstanceStoreLayer))

const init = Effect.fn("ReadToolTest.init")(function* () {
  const info = yield* ReadTool
  return yield* info.init()
})

const run = Effect.fn("ReadToolTest.run")(function* (
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("ReadToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("ReadToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected read to fail")
})

const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")
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
const git = Effect.fn("ReadToolTest.git")(function* (cwd: string, args: string[]) {
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
const put = Effect.fn("ReadToolTest.put")(function* (p: string, content: string | Buffer | Uint8Array) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})
const load = Effect.fn("ReadToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
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

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
)
// A file that reads as a PDF (magic bytes and extension) of exactly `size` bytes.
const pdfBytes = (size: number) => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(size - 9, 0x20)])

describe("tool.read external_directory permission", () => {
  it.live("allows reading absolute path inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "test.txt"), "hello world")

      const result = yield* exec(dir, { filePath: path.join(dir, "test.txt") })
      expect(result.output).toContain("hello world")
    }),
  )

  it.live("allows reading file in subdirectory inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "test.txt"), "nested content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "test.txt") })
      expect(result.output).toContain("nested content")
    }),
  )

  it.live("asks for external_directory permission when reading absolute path outside project", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "secret.txt"), "secret data")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "secret.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "*")))
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes read permission paths on Windows", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* put(path.join(dir, "test.txt"), "hello world")

        const { items, next } = asks()
        const target = path.join(dir, "test.txt")
        const alt = target
          .replace(/^[A-Za-z]:/, "")
          .replaceAll("\\", "/")
          .toLowerCase()

        yield* exec(dir, { filePath: alt }, next)
        const read = items.find((item) => item.permission === "read")
        expect(read).toBeDefined()
        expect(read!.patterns).toEqual([path.relative(dir, full(target))])
      }),
    )
  }

  it.live("uses worktree-relative path for read permission so user rules match like edit/write", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "src", "secret.ts"), "shh")

      const { items, next } = asks()
      yield* exec(dir, { filePath: path.join(dir, "src", "secret.ts") }, next)
      const read = items.find((item) => item.permission === "read")
      expect(read).toBeDefined()
      expect(read!.patterns).toEqual([path.join("src", "secret.ts")])
    }),
  )

  it.live("asks for directory-scoped external_directory permission when reading external directory", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "external", "a.txt"), "a")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "external") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "external", "*")))
    }),
  )

  it.live("asks for external_directory permission when reading relative path outside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      const { items, next } = asks()

      yield* fail(dir, { filePath: "../outside.txt" }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
    }),
  )

  it.live("does not ask for external_directory permission when reading inside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "internal.txt"), "internal content")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(dir, "internal.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeUndefined()
    }),
  )
})

describe("tool.read env file permissions", () => {
  const cases: [string, boolean][] = [
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    [".env.development.local", true],
    [".env.example", false],
    [".envrc", false],
    ["environment.ts", false],
  ]

  for (const agentName of ["build", "plan"] as const) {
    describe(`agent=${agentName}`, () => {
      for (const [filename, shouldAsk] of cases) {
        it.live(`${filename} asks=${shouldAsk}`, () =>
          Effect.gen(function* () {
            const dir = yield* tmpdirScoped()
            yield* put(path.join(dir, filename), "content")

            const asked = yield* provideInstance(dir)(
              Effect.gen(function* () {
                const agent = yield* Agent.Service
                const info = yield* agent.get(agentName)
                if (!info) throw new Error("Expected configured agent fixture")
                let asked = false
                const next = {
                  ...ctx,
                  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      for (const pattern of req.patterns) {
                        const rule = Permission.evaluate(req.permission, pattern, info.permission)
                        if (rule.action === "ask" && req.permission === "read") {
                          asked = true
                        }
                        if (rule.action === "deny") {
                          throw new PermissionV1.DeniedError({ ruleset: info.permission })
                        }
                      }
                    }),
                }

                yield* run({ filePath: path.join(dir, filename) }, next)
                return asked
              }),
            )

            expect(asked).toBe(shouldAsk)
          }),
        )
      }
    })
  }
})

describe("tool.read truncation", () => {
  it.instance("truncates large file by bytes and sets truncated metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const base = yield* load(path.join(FIXTURES_DIR, "models-api.json"))
      const target = 60 * 1024
      const content = base.length >= target ? base : base.repeat(Math.ceil(target / base.length))
      yield* put(path.join(test.directory, "large.json"), content)

      const result = yield* run({ filePath: path.join(test.directory, "large.json") })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("[truncated: showing lines 1-")
      expect(result.output).toContain("(50 KB limit)")
      expect(result.output).toContain("Continue: read filePath=")
    }),
  )

  it.instance("stops streaming after the byte cap", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "huge.txt")
      const content = `${"x".repeat(80)}\n`.repeat(50_000)
      yield* put(filepath, content)

      const fs = yield* FSUtil.Service
      const counter = { bytes: 0 }
      const result = yield* run({ filePath: filepath }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            stream: (file, options) =>
              fs.stream(file, options).pipe(
                Stream.tap((chunk) =>
                  Effect.sync(() => {
                    counter.bytes += chunk.length
                  }),
                ),
              ),
          }),
        ),
      )

      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("[truncated: showing lines 1-")
      expect(counter.bytes).toBeLessThan(Buffer.byteLength(content, "utf-8") / 2)
    }),
  )

  it.instance("truncates by line count when limit is specified", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      yield* put(path.join(test.directory, "many-lines.txt"), lines)

      const result = yield* run({ filePath: path.join(test.directory, "many-lines.txt"), limit: 10 })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("[truncated: showing lines 1-10 of 100.")
      expect(result.output).toContain("90 lines omitted after this range.")
      expect(result.output).toContain("Continue: read filePath=")
      expect(result.output).toContain("offset=11")
      expect(result.output).toContain("line0")
      expect(result.output).toContain("line9")
      expect(result.output).not.toContain("line10")
    }),
  )

  it.instance("does not count lines before offset as omitted after the cut", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "late.txt")
      const content = Array.from({ length: 300 }, () => "x".repeat(1024)).join("\n")
      yield* put(filepath, content)

      const result = yield* run({ filePath: filepath, offset: 201 })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("[truncated: showing lines 201-")
      // The 200 skipped lines (~200 KB) are before the shown range. Only the
      // ~52 KB after the cut is omitted; the full-file subtraction would report
      // ~251 KB.
      const omitted = /about ([\d.]+) KB omitted/.exec(result.output)?.[1]
      expect(omitted).toBeTruthy()
      expect(Number(omitted)).toBeGreaterThan(40)
      expect(Number(omitted)).toBeLessThan(60)
    }),
  )

  it.instance("does not truncate small file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "small.txt"), "hello world")

      const result = yield* run({ filePath: path.join(test.directory, "small.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file")
      expect(result.metadata.display).toMatchObject({
        type: "file",
        path: path.join(test.directory, "small.txt"),
        text: "hello world",
        lineStart: 1,
        lineEnd: 1,
        totalLines: 1,
        truncated: false,
      })
    }),
  )

  it.live("respects offset parameter", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "offset.txt"), lines)

      const result = yield* exec(dir, { filePath: path.join(dir, "offset.txt"), offset: 10, limit: 5 })
      expect(result.output).toContain("10: line10")
      expect(result.output).toContain("14: line14")
      expect(result.output).not.toContain("9: line10")
      expect(result.output).not.toContain("15: line15")
      expect(result.output).toContain("line10")
      expect(result.output).toContain("line14")
      expect(result.output).not.toContain("line0")
      expect(result.output).not.toContain("line15")
    }),
  )

  it.live("reads pages from the end without an offset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 1000 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "pages.txt"), lines)

      const end = yield* exec(dir, { filePath: path.join(dir, "pages.txt"), page: -1 })
      expect(end.output).toContain("801: line801")
      expect(end.output).toContain("1000: line1000")
      expect(end.output).not.toMatch(/^800: line800$/m)

      const back = yield* exec(dir, { filePath: path.join(dir, "pages.txt"), page: -2 })
      expect(back.output).toContain("601: line601")
      expect(back.output).toContain("800: line800")
      expect(back.output).not.toMatch(/^801: line801$/m)

      const first = yield* exec(dir, { filePath: path.join(dir, "pages.txt"), page: 1 })
      expect(first.output).toContain("1: line1")
      expect(first.output).toContain("200: line200")
      expect(first.output).not.toMatch(/^201: line201$/m)
    }),
  )

  it.live("page size follows limit and rejects conflicting offsets", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "pages.txt"), lines)

      const result = yield* exec(dir, { filePath: path.join(dir, "pages.txt"), page: -1, limit: 10 })
      expect(result.output).toContain("91: line91")
      expect(result.output).toContain("100: line100")
      expect(result.output).not.toMatch(/^90: line90$/m)

      const conflict = yield* fail(dir, { filePath: path.join(dir, "pages.txt"), page: 1, offset: 1 })
      expect(conflict.message).toContain("Use page or offset, not both.")
      const zero = yield* fail(dir, { filePath: path.join(dir, "pages.txt"), page: 0 })
      expect(zero.message).toContain("page must not be 0")
    }),
  )

  it.live("throws when offset is beyond end of file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 3 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "short.txt"), lines)

      const err = yield* fail(dir, { filePath: path.join(dir, "short.txt"), offset: 4, limit: 5 })
      expect(err.message).toContain("Offset 4 is out of range for this file (3 lines)")
    }),
  )

  it.live("a missing file with no similar name in its folder ends with the glob next step", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "unrelated.txt"), "x")

      const missing = path.join(dir, "zzz-missing.md")
      const err = yield* fail(dir, { filePath: missing })
      expect(err.message).toBe(`File not found: ${missing}. Check the path with glob.`)
    }),
  )

  it.live("a missing file with a similar name keeps its suggestions and not the glob hint", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "notes.txt"), "x")

      const err = yield* fail(dir, { filePath: path.join(dir, "notes") })
      expect(err.message).toContain("Did you mean one of these?")
      expect(err.message).not.toContain("Check the path with glob")
    }),
  )

  it.live("allows reading empty file at default offset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const result = yield* exec(dir, { filePath: path.join(dir, "empty.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file - total 0 lines")
    }),
  )

  it.live("throws when offset > 1 for empty file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const err = yield* fail(dir, { filePath: path.join(dir, "empty.txt"), offset: 2 })
      expect(err.message).toContain("Offset 2 is out of range for this file (0 lines)")
    }),
  )

  it.live("reads the last page of an empty file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const result = yield* exec(dir, { filePath: path.join(dir, "empty.txt"), page: -1 })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file - total 0 lines")
    }),
  )

  it.live("reads the last page of an empty directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fs = yield* FSUtil.Service
      yield* fs.ensureDir(path.join(dir, "empty"))

      const result = yield* exec(dir, { filePath: path.join(dir, "empty"), page: -1 })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("(0 entries)")
    }),
  )

  it.live("rejects an earlier page of an empty file with singular wording", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const err = yield* fail(dir, { filePath: path.join(dir, "empty.txt"), page: -2 })
      expect(err.message).toContain(
        `page -2 is before the first page; 0 lines make 1 page of ${Truncate.PAGE_LINES} lines.`,
      )
    }),
  )

  it.live("does not mark final directory page as truncated", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.forEach(
        Array.from({ length: 10 }, (_, i) => i),
        (i) => put(path.join(dir, "dir", `file-${i + 1}.txt`), `line${i}`),
        {
          concurrency: "unbounded",
        },
      )

      const result = yield* exec(dir, { filePath: path.join(dir, "dir"), offset: 6, limit: 5 })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).not.toContain("Showing 5 of 10 entries")
      expect(result.metadata.display).toMatchObject({
        type: "directory",
        path: path.join(dir, "dir"),
        entries: ["file-5.txt", "file-6.txt", "file-7.txt", "file-8.txt", "file-9.txt"],
        offset: 6,
        totalEntries: 10,
        truncated: false,
      })
    }),
  )

  it.live("truncates long lines", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "long-line.txt"), "x".repeat(3000))

      const result = yield* exec(dir, { filePath: path.join(dir, "long-line.txt") })
      expect(result.output).toContain("(line truncated to 2000 of 3000 chars;")
      expect(result.output).toContain("offset=1 limit=1 charOffset=2001 maxLineLength=1000")
      expect(result.output.length).toBeLessThan(3000)
    }),
  )

  it.live("continues a line beyond the per-line fetch cap with charOffset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "very-long-line.txt")
      yield* put(filepath, "x".repeat(60_000))

      const first = yield* exec(dir, { filePath: filepath })
      expect(first.output).toContain("charOffset=2001 maxLineLength=2000")

      const second = yield* exec(dir, {
        filePath: filepath,
        offset: 1,
        limit: 1,
        charOffset: 2001,
        maxLineLength: 50_000,
      })
      expect(second.output).toContain("x".repeat(50_000))
      expect(second.output).toContain("charOffset=52001 maxLineLength=8000")

      const third = yield* exec(dir, {
        filePath: filepath,
        offset: 1,
        limit: 1,
        charOffset: 52_001,
        maxLineLength: 8000,
      })
      expect(third.output).toContain("x".repeat(8000))
      expect(third.output).not.toContain("line truncated")
    }),
  )

  it.live("continues a multibyte line whose bytes exceed the output cap", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "multibyte-line.txt")
      yield* put(filepath, "😀".repeat(20_000))

      const first = yield* exec(dir, { filePath: filepath })
      expect(first.output).toContain("😀")
      const next = Number(first.output.match(/charOffset=(\d+)/)?.[1])
      expect(next).toBeGreaterThan(1)

      const second = yield* exec(dir, { filePath: filepath, offset: 1, limit: 1, charOffset: next })
      expect(second.output).toContain("😀")
      const advanced = Number(second.output.match(/charOffset=(\d+)/)?.[1] ?? Number.MAX_SAFE_INTEGER)
      expect(advanced).toBeGreaterThan(next)
    }),
  )

  it.live("keeps a wide multibyte line inside the byte cap when maxLineLength is large", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "wide-cjk.txt")
      yield* put(filepath, "漢".repeat(20_000))

      const first = yield* exec(dir, { filePath: filepath, maxLineLength: 50_000 })
      expect(Buffer.byteLength(first.output, "utf8")).toBeLessThan(Truncate.MAX_BYTES + 4_096)
      expect(first.output).toContain("of 20000 chars")
      expect(first.output).not.toContain("�")
      const next = Number(first.output.match(/charOffset=(\d+)/)?.[1])
      expect(next).toBeGreaterThan(1)

      const second = yield* exec(dir, {
        filePath: filepath,
        offset: 1,
        limit: 1,
        charOffset: next,
        maxLineLength: 50_000,
      })
      expect(second.output).toContain("漢")
      expect(second.output).not.toContain("�")
    }),
  )

  it.live("counts charOffset in code points for astral characters", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "astral-line.txt")
      const line = "😀".repeat(3_000)
      yield* put(filepath, line)

      const first = yield* exec(dir, { filePath: filepath })
      expect(first.output).toContain("(line truncated to 2000 of 3000 chars;")
      expect(first.output).toContain("charOffset=2001 maxLineLength=1000")
      expect(first.output).not.toContain("�")

      const second = yield* exec(dir, {
        filePath: filepath,
        offset: 1,
        limit: 1,
        charOffset: 2001,
        maxLineLength: 2_000,
      })
      expect(second.output).toContain("😀".repeat(1_000))
      expect(second.output).not.toContain("line truncated")
      expect(second.output).not.toContain("�")
    }),
  )

  it.live("keeps negative pages disjoint when the file does not divide evenly", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "pages-250.txt")
      const lines = Array.from({ length: 250 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(filepath, lines)

      const last = yield* exec(dir, { filePath: filepath, page: -1 })
      expect(last.output).toContain("51: line51")
      expect(last.output).toContain("250: line250")
      expect(last.output).not.toMatch(/^50: line50$/m)

      const before = yield* exec(dir, { filePath: filepath, page: -2 })
      expect(before.output).toContain("1: line1")
      expect(before.output).toContain("50: line50")
      expect(before.output).not.toMatch(/^51: line51$/m)

      const past = yield* fail(dir, { filePath: filepath, page: -3 })
      expect(past.message).toContain("page -3 is before the first page; 250 lines make 2 pages of 200 lines.")
    }),
  )

  it.live("leaves a single line on the page before a partial final page", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "pages-401.txt")
      const lines = Array.from({ length: 401 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(filepath, lines)

      const before = yield* exec(dir, { filePath: filepath, page: -3 })
      expect(before.output).toContain("1: line1")
      expect(before.output).not.toMatch(/^2: line2$/m)
    }),
  )

  it.live("shows the full long line when maxLineLength asks for it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "long-line.txt"), "x".repeat(3000))

      const result = yield* exec(dir, {
        filePath: path.join(dir, "long-line.txt"),
        maxLineLength: 3000,
      })
      expect(result.output).toContain("x".repeat(3000))
      expect(result.output).not.toContain("(line truncated")
    }),
  )

  it.live("image files set truncated to false", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      yield* put(path.join(dir, "image.png"), png)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live("detects attachment media from file contents", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
      yield* put(path.join(dir, "image.bin"), jpeg)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.bin") })
      expect(result.output).toBe("Image read successfully")
      expect(result.attachments?.[0].mime).toBe("image/jpeg")
      expect(result.attachments?.[0].url.startsWith("data:image/jpeg;base64,")).toBe(true)
    }),
  )

  it.live("large image files are properly attached without error", () =>
    Effect.gen(function* () {
      const result = yield* exec(FIXTURES_DIR, { filePath: path.join(FIXTURES_DIR, "large-image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0].type).toBe("file")
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live(".fbs files (FlatBuffers schema) are read as text, not images", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fbs = `namespace MyGame;

table Monster {
  pos:Vec3;
  name:string;
  inventory:[ubyte];
}

root_type Monster;`
      yield* put(path.join(dir, "schema.fbs"), fbs)

      const result = yield* exec(dir, { filePath: path.join(dir, "schema.fbs") })
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain("namespace MyGame")
      expect(result.output).toContain("table Monster")
    }),
  )

  it.live("falls through unsupported image mime types to text", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const cases = [
        ["image.bmp", "BM text content"],
        ["photo.tiff", "II text content"],
        ["photo.avif", "avif text content"],
      ] as const

      for (const item of cases) {
        yield* put(path.join(dir, item[0]), item[1])
        const result = yield* exec(dir, { filePath: path.join(dir, item[0]) })
        expect(result.attachments).toBeUndefined()
        expect(result.output).toContain(item[1])
      }
    }),
  )
})

// The byte and line caps of a read are the output budget: the constants without a model on the call, a share of the
// model's window with one (#1448). The line numbers a page shows count against the byte cap too.
describe("tool.read output budget (#1448)", () => {
  const small = { model: ProviderTest.model({ limit: { context: 32_000, output: 4_096 } }) }
  const configured = testEffect(
    Layer.mergeAll(
      readLayer(),
      testInstanceStoreLayer,
      TestConfig.layer({ get: () => Effect.succeed({ tool_output: { max_bytes: 2048 } }) }),
    ),
  )

  // 2000 lines of 30 characters: each shown line costs its text, a newline and its `<number>: ` prefix.
  const rows = Array.from({ length: 2000 }, () => "x".repeat(30)).join("\n") + "\n"
  const shown = (output: string) => Number(/showing lines 1-(\d+) of/.exec(output)?.[1])

  it.instance("counts the line-number prefix against the byte cap", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "short-lines.txt")
      yield* put(file, rows)

      const result = yield* run({ filePath: file })

      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(50 * 1024 + 1024)
      expect(shown(result.output)).toBe(1413)
      expect(result.output).toContain("(50 KB limit)")
      expect(result.output).toContain('Continue: read filePath="' + file + '" offset=1414.')
    }),
  )

  it.instance("cuts a file at the byte budget of a 32K window and says so", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "short-lines.txt")
      yield* put(file, rows)

      const result = yield* run({ filePath: file }, { ...ctx, extra: small })

      expect(shown(result.output)).toBe(180)
      expect(result.output).toContain("(6.25 KB limit)")
      expect(result.output).toContain('Continue: read filePath="' + file + '" offset=181.')
      expect(result.metadata.truncated).toBe(true)
      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(6_400 + 1024)
    }),
  )

  it.instance("caps the lines of a page at the line limit of a 32K window", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "many-lines.txt")
      yield* put(file, Array.from({ length: 1000 }, () => "a").join("\n") + "\n")

      const capped = yield* run({ filePath: file }, { ...ctx, extra: small })
      expect(capped.output).toContain("[truncated: showing lines 1-250 of 1000. 750 lines omitted after this range.")
      expect(capped.output).toContain('Continue: read filePath="' + file + '" offset=251.')

      // The same call without a model keeps the 2000-line cap, so the whole file is shown.
      const whole = yield* run({ filePath: file })
      expect(whole.output).toContain("(End of file - total 1000 lines)")
      expect(whole.metadata.truncated).toBe(false)
    }),
  )

  it.instance("fits one long line into the budget of a 32K window and says how to continue it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "wide-cjk.txt")
      yield* put(file, "漢".repeat(5_000))

      const result = yield* run({ filePath: file, maxLineLength: 50_000 }, { ...ctx, extra: small })

      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(6_400 + 1_024)
      expect(result.output).toContain("of 5000 chars; continue with read filePath=")
      expect(result.output).not.toContain("�")
      // Without a model the same line is under the 50 KB cap and `maxLineLength` is the only cut.
      const whole = yield* run({ filePath: file, maxLineLength: 50_000 })
      expect(whole.output).not.toContain("line truncated")
    }),
  )

  it.instance("cuts a directory listing at the byte budget and continues where it stopped", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "wide")
      // 100 names of 100 bytes: each entry costs its name and a newline.
      for (let index = 0; index < 100; index++) {
        yield* put(path.join(dir, `${String(index).padStart(3, "0")}${"n".repeat(93)}.txt`), "")
      }

      const capped = yield* run({ filePath: dir }, { ...ctx, extra: small })
      expect(capped.output).toContain("Showing 63 of 100 entries. Continue:")
      expect(capped.output).toContain(`offset=64.)`)
      expect(capped.metadata.truncated).toBe(true)
      expect(capped.output.split("\n").filter((line) => line.endsWith(".txt"))).toHaveLength(63)

      // The 37 entries after them fit the budget, so the second page ends the listing.
      const next = yield* run({ filePath: dir, offset: 64 }, { ...ctx, extra: small })
      expect(next.output).toContain("(100 entries)")
      expect(next.output.split("\n").filter((line) => line.endsWith(".txt"))).toHaveLength(37)
      expect(next.metadata.truncated).toBe(false)

      // Without a model the listing is whole.
      const whole = yield* run({ filePath: dir })
      expect(whole.output).toContain("(100 entries)")
      expect(whole.metadata.truncated).toBe(false)
    }),
  )

  configured.instance("lets tool_output.max_bytes override the budget and names it in the notice", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "short-lines.txt")
      yield* put(file, rows)

      const result = yield* run({ filePath: file })

      expect(shown(result.output)).toBe(58)
      expect(result.output).toContain("(2 KB limit)")
      // The window of the model does not lift an explicit limit.
      const modeled = yield* run({ filePath: file }, { ...ctx, extra: { model: ProviderTest.model() } })
      expect(shown(modeled.output)).toBe(58)
    }),
  )
})

describe("tool.read attachment limits", () => {
  // The model a call runs under: ProviderTest.model() accepts neither images nor PDFs.
  const model = (input: { pdf?: boolean; image?: boolean } = {}) => {
    const base = ProviderTest.model()
    return ProviderTest.model({
      capabilities: { ...base.capabilities, input: { ...base.capabilities.input, ...input } },
    })
  }
  const under = (value: ReturnType<typeof model>): Tool.Context => ({ ...ctx, extra: { model: value } })

  it.live("refuses a PDF the model does not accept and names a command that extracts its text", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "doc.pdf")
      yield* put(file, pdfBytes(1024))

      const error = yield* fail(dir, { filePath: file }, under(model()))
      expect(error.message).toBe(
        `Cannot attach ${file}: openai/gpt-5.2 does not accept PDF input. Extract text with the shell tool: pdftotext -layout "${file}" -`,
      )
    }),
  )

  it.live("refuses an image the model does not accept and names a command that inspects it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "image.png")
      yield* put(file, ONE_PIXEL_PNG)

      const error = yield* fail(dir, { filePath: file }, under(model({ pdf: true })))
      expect(error.message).toBe(
        `Cannot attach ${file}: openai/gpt-5.2 does not accept image input. Inspect it with the shell tool: file "${file}"`,
      )
    }),
  )

  it.live("refuses a PDF over 10 MB even for a model that accepts PDF", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "big.pdf")
      yield* put(file, pdfBytes(12 * 1024 * 1024))

      const error = yield* fail(dir, { filePath: file }, under(model({ pdf: true })))
      expect(error.message).toBe(
        `PDF ${file} is 12.0 MB, over the 10.0 MB limit. Extract pages: pdftotext -f 1 -l 20 -layout "${file}" -`,
      )
    }),
  )

  it.live("attaches a PDF of exactly 10 MB and an image to a model that accepts them", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "limit.pdf"), pdfBytes(10 * 1024 * 1024))
      yield* put(path.join(dir, "image.png"), ONE_PIXEL_PNG)
      const next = under(model({ pdf: true, image: true }))

      const pdf = yield* exec(dir, { filePath: path.join(dir, "limit.pdf") }, next)
      expect(pdf.output).toBe("PDF read successfully")
      expect(pdf.attachments?.[0]?.mime).toBe("application/pdf")

      const image = yield* exec(dir, { filePath: path.join(dir, "image.png") }, next)
      expect(image.output).toBe("Image read successfully")
      expect(image.attachments?.[0]?.mime).toBe("image/png")
    }),
  )

  it.live("attaches as before when the call carries no model", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "doc.pdf"), pdfBytes(1024))
      yield* put(path.join(dir, "image.png"), ONE_PIXEL_PNG)

      for (const next of [ctx, { ...ctx, extra: {} }, { ...ctx, extra: { model: "not-a-model" } }]) {
        const pdf = yield* exec(dir, { filePath: path.join(dir, "doc.pdf") }, next)
        expect(pdf.attachments?.[0]?.mime).toBe("application/pdf")
        const image = yield* exec(dir, { filePath: path.join(dir, "image.png") }, next)
        expect(image.attachments?.[0]?.mime).toBe("image/png")
      }
    }),
  )

  it.live("a refused read leaves the nearby instructions for the next read", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "AGENTS.md"), "# Test Instructions\nDo something special.")
      yield* put(path.join(dir, "subdir", "nested", "doc.pdf"), pdfBytes(1024))
      yield* put(path.join(dir, "subdir", "nested", "test.txt"), "test content")
      const next = under(model())

      yield* fail(dir, { filePath: path.join(dir, "subdir", "nested", "doc.pdf") }, next)
      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "nested", "test.txt") }, next)
      expect(result.output).toContain("Test Instructions")
    }),
  )
})

describe("tool.read loaded instructions", () => {
  it.live("loads AGENTS.md from parent directory and includes in metadata", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "AGENTS.md"), "# Test Instructions\nDo something special.")
      yield* put(path.join(dir, "subdir", "nested", "test.txt"), "test content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "nested", "test.txt") })
      expect(result.output).toContain("test content")
      // The nearby file arrives as its own instruction-file block; the tool adds no wrapper of its own (#1456).
      const agents = path.join(dir, "subdir", "AGENTS.md")
      expect(result.output).toEndWith(
        `\n\n<system-reminder source="instruction-file" path="${agents}">\n# Test Instructions\nDo something special.\n</system-reminder>`,
      )
      expect(result.output).not.toContain('source="reminder"')
      expect(result.output.match(/<system-reminder/g)).toHaveLength(1)
      expect(result.metadata.loaded).toBeDefined()
      expect(result.metadata.loaded).toContain(path.join(dir, "subdir", "AGENTS.md"))
    }),
  )

  it.live("includes nearby instructions when the file read is an image or a PDF", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "AGENTS.md"), "# Test Instructions\nDo something special.")
      yield* put(path.join(dir, "subdir", "nested", "image.png"), ONE_PIXEL_PNG)
      yield* put(path.join(dir, "subdir", "nested", "doc.pdf"), pdfBytes(1024))

      for (const [name, preview] of [
        ["image.png", "Image read successfully"],
        ["doc.pdf", "PDF read successfully"],
      ] as const) {
        // The first read delivers the instructions; a second read of a file under the same message finds them claimed.
        const result = yield* exec(
          dir,
          { filePath: path.join(dir, "subdir", "nested", name) },
          { ...ctx, messageID: MessageID.make(`msg_${name}`) },
        )
        expect(result.output).toStartWith(preview)
        expect(result.output).toBe(
          `${preview}\n\n<system-reminder source="instruction-file" path="${path.join(dir, "subdir", "AGENTS.md")}">\n# Test Instructions\nDo something special.\n</system-reminder>`,
        )
        expect(result.metadata.preview).toBe(preview)
        expect(result.metadata.loaded).toEqual([path.join(dir, "subdir", "AGENTS.md")])
        expect(result.attachments?.length).toBe(1)
      }
    }),
  )

  it.live("a media read without nearby instructions has no reminder", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "image.png"), ONE_PIXEL_PNG)
      const result = yield* exec(dir, { filePath: path.join(dir, "image.png") })
      expect(result.output).toBe("Image read successfully")
      expect(result.metadata.loaded).toEqual([])
    }),
  )
})

// A truncated result points at a file the 7-day cleanup removes; reading it afterwards must say so.
describe("tool.read saved output", () => {
  it.live("reports a removed saved output as expired and says how to regenerate it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const saved = path.join(Truncate.DIR, "tool_missing")

      const err = yield* fail(dir, { filePath: saved })
      expect(err.message).toContain("has expired")
      expect(err.message).toBe(
        `Saved output has expired: ${saved} was removed by the 7-day cleanup. Run the original command again to regenerate it.`,
      )
    }),
  )

  it.live("keeps the plain not-found message for other missing files in that directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const other = path.join(Truncate.DIR, "other_missing")

      const err = yield* fail(dir, { filePath: other })
      expect(err.message).toContain(`File not found: ${other}`)
      expect(err.message).not.toContain("has expired")
    }),
  )

  // The notice of a cut first line and `read` must count characters the same way, or the continuation skips or
  // repeats some: both count code points.
  it.live("the notice of a cut first line continues at the character after the last one shown", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // Four-byte characters among letters, so that code points and UTF-16 units differ.
      const line = Array.from({ length: 60_000 }, (_, index) =>
        index % 7 === 0 ? "😀" : String.fromCharCode(97 + (index % 26)),
      ).join("")
      const cut = yield* (yield* Truncate.Service).output(`${line}\nsecond\nthird`)
      if (!cut.truncated || cut.outputPath === undefined) throw new Error("expected a saved truncation")
      const params = /offset=1 limit=1 charOffset=(\d+) maxLineLength=(\d+)/.exec(cut.content)
      if (!params) throw new Error("the notice names no continuation")
      expect(Number(params[1])).toBe(cut.details.shownChars + 1)

      const next = yield* exec(dir, {
        filePath: cut.outputPath,
        offset: 1,
        limit: 1,
        charOffset: Number(params[1]),
        maxLineLength: Number(params[2]),
      })

      const rest = Array.from(line)
        .slice(cut.details.shownChars, cut.details.shownChars + 50)
        .join("")
      expect(next.output).toContain(`1: ${rest}`)
    }),
  )
})

describe("tool.read binary detection", () => {
  it.live("rejects text extension files with null bytes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64])
      yield* put(path.join(dir, "null-byte.txt"), bytes)

      const err = yield* fail(dir, { filePath: path.join(dir, "null-byte.txt") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )

  it.live("rejects known binary extensions", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "module.wasm"), "not really wasm")

      const err = yield* fail(dir, { filePath: path.join(dir, "module.wasm") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )
})

describe("tool.read file state (#1452)", () => {
  const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")
  const recorded = (dir: string, filepath: string) =>
    provideInstance(dir)(
      Effect.gen(function* () {
        return yield* (yield* FileState.Service).get(ctx.sessionID, filepath)
      }),
    )

  it.live("records a text read under the read source", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "notes.txt")
      yield* put(file, "line one\nline two\n")

      yield* exec(dir, { filePath: file })

      const entry = yield* recorded(dir, file)
      expect(entry?.source).toBe("read")
      expect(entry?.hash).toBe(sha256("line one\nline two\n"))
      expect(entry?.size).toBe(18)
    }),
  )

  it.live("records the whole file for a partial read", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "long.txt")
      const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
      yield* put(file, content)

      yield* exec(dir, { filePath: file, offset: 10, limit: 5 })

      expect((yield* recorded(dir, file))?.hash).toBe(sha256(content))
    }),
  )

  it.live("records a relative path under its absolute path", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "rel.txt")
      yield* put(file, "relative")

      yield* exec(dir, { filePath: "rel.txt" })

      expect((yield* recorded(dir, file))?.hash).toBe(sha256("relative"))
    }),
  )

  it.live("does not record a directory listing", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "sub", "a.txt"), "a")

      yield* exec(dir, { filePath: path.join(dir, "sub") })

      expect(yield* recorded(dir, path.join(dir, "sub"))).toBeUndefined()
      expect(yield* recorded(dir, path.join(dir, "sub", "a.txt"))).toBeUndefined()
    }),
  )

  it.live("does not record an image read", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const image = path.join(dir, "image.png")
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      yield* put(image, png)

      const result = yield* exec(dir, { filePath: image })

      expect(result.attachments).toHaveLength(1)
      expect(yield* recorded(dir, image)).toBeUndefined()
    }),
  )

  it.live("does not record a read that failed", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const binary = path.join(dir, "module.wasm")
      yield* put(binary, "not really wasm")
      const missing = path.join(dir, "missing.txt")

      yield* fail(dir, { filePath: binary })
      yield* fail(dir, { filePath: missing })

      expect(yield* recorded(dir, binary)).toBeUndefined()
      expect(yield* recorded(dir, missing)).toBeUndefined()
    }),
  )
})

// #1452 review finding: a read used to record whatever the file held when the record was made, which can be a
// version that replaced the one the read consumed. A file change that lands after the read consumed the file and
// before it records it is simulated by a FileState whose `record` first runs `raceAfterRead`.
let raceAfterRead: (() => Promise<unknown>) | undefined

const racingFileState = Layer.effect(
  FileState.Service,
  Effect.gen(function* () {
    const real = yield* FileState.Service
    return FileState.Service.of({
      ...real,
      record: (...args) =>
        Effect.gen(function* () {
          const change = raceAfterRead
          raceAfterRead = undefined
          if (change) yield* Effect.promise(change)
          yield* real.record(...args)
        }),
    })
  }),
).pipe(Layer.provide(FileState.defaultLayer))

const racing = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Instruction.defaultLayer,
    LSP.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
    Format.defaultLayer,
    EventV2Bridge.defaultLayer,
    racingFileState,
    testInstanceStoreLayer,
  ),
)

describe("tool.read records the version it consumed (#1452)", () => {
  const overwrite = Effect.fn("ReadToolTest.overwrite")(function* (dir: string, filePath: string, content: string) {
    const tool = yield* (yield* WriteTool).init()
    const exit = yield* provideInstance(dir)(tool.execute({ filePath, content }, ctx)).pipe(Effect.exit)
    if (Exit.isSuccess(exit)) throw new Error("expected the overwrite to be refused")
    const error = Cause.squash(exit.cause)
    return error instanceof Error ? error : new Error(String(error))
  })

  racing.live("a file changed between the read and its record cannot be overwritten afterwards", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "target.txt")
      yield* put(file, "what the model read\n")
      raceAfterRead = () => Bun.write(file, "changed by someone else\n")

      const result = yield* exec(dir, { filePath: file })

      expect(result.output).toContain("what the model read")
      expect(result.output).not.toContain("changed by someone else")
      const error = yield* overwrite(dir, file, "clobbered\n")
      expect(error.message).toContain("was not read in this session")
      expect(yield* load(file)).toBe("changed by someone else\n")
    }),
  )

  racing.live("an older record is not replaced by a version the read did not consume", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "target.txt")
      yield* put(file, "first version\n")
      yield* exec(dir, { filePath: file })
      raceAfterRead = () => Bun.write(file, "second version, written during the next read\n")

      yield* exec(dir, { filePath: file })

      const error = yield* overwrite(dir, file, "clobbered\n")
      expect(error.message).toContain("changed after it was last read")
      expect(yield* load(file)).toBe("second version, written during the next read\n")
    }),
  )

  racing.live("a change that keeps the size and the mtime is still caught, because the hash decides", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "target.txt")
      yield* put(file, "aaaa\n")
      raceAfterRead = async () => {
        const before = await Bun.file(file).stat()
        await Bun.write(file, "bbbb\n")
        await import("fs/promises").then((fs) => fs.utimes(file, before.atime, before.mtime))
      }

      yield* exec(dir, { filePath: file })

      const error = yield* overwrite(dir, file, "clobbered\n")
      expect(error.message).toContain("was not read in this session")
    }),
  )

  racing.live("a file that does not change is recorded and can be overwritten", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "target.txt")
      yield* put(file, "stable\n")
      raceAfterRead = () => Promise.resolve()

      yield* exec(dir, { filePath: file })
      const tool = yield* (yield* WriteTool).init()
      yield* provideInstance(dir)(tool.execute({ filePath: file, content: "replaced\n" }, ctx))

      expect(yield* load(file)).toBe("replaced\n")
    }),
  )
})

// The public codec rejects invalid pagination before filesystem work.
for (const field of ["offset", "limit"] as const) {
  for (const value of [0, -1, 1.5]) {
    test(`read rejects ${field}=${value}`, () => {
      expect(() => Schema.decodeUnknownSync(Parameters)({ filePath: "/unused", [field]: value })).toThrow()
    })
  }
}
