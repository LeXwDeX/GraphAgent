import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import * as PlatformError from "effect/PlatformError"
import { EditTool, replace } from "../../src/tool/edit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@graphagent/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import { Watcher } from "@graphagent/core/filesystem/watcher"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = Layer.mergeAll(
  LSP.defaultLayer,
  FSUtil.defaultLayer,
  Format.defaultLayer,
  EventV2Bridge.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
)

const it = testEffect(layer)

const init = Effect.fn("EditToolTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("EditToolTest.fail")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const runRaw = Effect.fn("EditToolTest.runRaw")(function* (args: unknown, next: Tool.Context = ctx) {
  const tool = yield* init()
  // oxlint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- test shim: invoke the wrapped execute with unrepaired raw args
  const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>
  return yield* execute(args, next)
})

const failRaw = Effect.fn("EditToolTest.failRaw")(function* (args: unknown) {
  const exit = yield* runRaw(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const put = Effect.fn("EditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("EditToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("EditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

// A filesystem whose stat of one file fails with a read error, not a missing file. Portable: it never relies on chmod.
const statFaultFS = (target: string) =>
  Effect.map(FSUtil.Service, (fs) =>
    Layer.succeed(FSUtil.Service, {
      ...fs,
      stat: (p: string) =>
        p === target
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "stat",
                pathOrDescriptor: target,
                syscall: "stat",
                description: "simulated EACCES",
              }),
            )
          : fs.stat(p),
    }),
  )

const makeDirectory = Effect.fn("EditToolTest.makeDirectory")(function* (p: string) {
  const fs = yield* FSUtil.Service
  yield* fs.makeDirectory(p)
})

const onceBus = Effect.fn("EditToolTest.onceBus")(function* (def: typeof Watcher.Event.Updated) {
  const events = yield* EventV2Bridge.Service
  const deferred = yield* Deferred.make<void>()
  const unsub = yield* events.listen((event) => {
    if (event.type === def.type) Deferred.doneUnsafe(deferred, Effect.void)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsub)
  return deferred
})

describe("tool.edit", () => {
  describe("creating new files", () => {
    it.instance("creates new file when oldString is empty", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, oldString: "", newString: "new content" })

        expect(result.metadata.diff).toContain("new content")
        expect(yield* load(filepath)).toBe("new content")
      }),
    )

    it.instance("rejects empty oldString on existing files and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        const original = `${bom}using System;\n`
        yield* put(filepath, original)

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "using Up;\n" })).message).toContain(
          "oldString cannot be empty",
        )

        const content = yield* loadRaw(filepath)
        expect(content).toBe(original)
      }),
    )

    it.instance("creates new file with nested directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "dir", "file.txt")

        yield* run({ filePath: filepath, oldString: "", newString: "nested file" })

        expect(yield* load(filepath)).toBe("nested file")
      }),
    )

    it.instance("emits add event for new files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: path.join(test.directory, "new.txt"), oldString: "", newString: "content" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("editing existing files", () => {
    it.instance("replaces text in existing file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "old content here")

        const result = yield* run({ filePath: filepath, oldString: "old content", newString: "new content" })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("replaces the first visible line in BOM files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}using System;\nclass Test {}\n`)

        const result = yield* run({ filePath: filepath, oldString: "using System;", newString: "using Up;" })

        expect(result.metadata.diff).toContain("-using System;")
        expect(result.metadata.diff).toContain("+using Up;")
        expect(result.metadata.diff).not.toContain(bom)

        const content = yield* loadRaw(filepath)
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\nclass Test {}\n")
      }),
    )

    it.instance("throws error when file does not exist", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect(
          (yield* fail({ filePath: path.join(test.directory, "nonexistent.txt"), oldString: "old", newString: "new" }))
            .message,
        ).toContain("not found. Check the path with glob.")
      }),
    )

    it.instance("reports a stat failure other than a missing file instead of calling the file not found", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "unreadable.txt")
        yield* put(target, "content")
        const faultFS = yield* statFaultFS(target)

        const exit = yield* run({ filePath: target, oldString: "content", newString: "other" }).pipe(
          Effect.provide(faultFS),
          Effect.exit,
        )
        if (!Exit.isFailure(exit)) throw new Error("expected the stat failure to fail the edit")
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("PermissionDenied")
        expect(message).not.toContain("not found")
        expect(message).not.toContain("Check the path with glob")
        expect(yield* load(target)).toBe("content")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "same", newString: "same" })).message).toContain(
          "identical",
        )
      }),
    )

    it.instance("refuses to rewrite a non-UTF-8 file and leaves its bytes intact", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "gbk.txt")
        // "你好\nA\n" encoded as GBK.
        const original = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0x41, 0x0a])
        yield* Effect.promise(() => fs.writeFile(filepath, original))

        expect((yield* fail({ filePath: filepath, oldString: "A", newString: "B" })).message).toContain(
          "not valid UTF-8",
        )
        expect(Buffer.compare(yield* Effect.promise(() => fs.readFile(filepath)), original)).toBe(0)
      }),
    )

    it.instance("throws error when oldString not found in file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "actual content")

        expect(yield* fail({ filePath: filepath, oldString: "not in file", newString: "replacement" })).toBeInstanceOf(
          Error,
        )
      }),
    )

    it.instance("rejects loose block-anchor matches and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = [
          "function configure() {",
          "  keepImportantState()",
          "  removeAllUserData()",
          "  archiveBackups()",
          "  auditLog()",
          "}",
        ].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("rejects block-anchor matches with unrelated middle content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = ["function configure() {", "  removeAllUserData()", "}"].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("replaces all occurrences with replaceAll option", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "foo bar foo baz foo")

        yield* run({ filePath: filepath, oldString: "foo", newString: "qux", replaceAll: true })

        expect(yield* load(filepath)).toBe("qux bar qux baz qux")
      }),
    )

    it.instance("replaceAll keeps dollar sequences in newString literal", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.sh")
        yield* put(filepath, "echo A\necho A\n")

        yield* run({ filePath: filepath, oldString: "A", newString: "$'\\n' $$ $&", replaceAll: true })

        expect(yield* load(filepath)).toBe("echo $'\\n' $$ $&\necho $'\\n' $$ $&\n")
      }),
    )

    it.instance("emits change event for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "original")
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: filepath, oldString: "original", newString: "modified" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("edge cases", () => {
    it.instance("handles multiline replacements", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        yield* run({ filePath: filepath, oldString: "line2", newString: "new line 2\nextra line" })

        expect(yield* load(filepath)).toBe("line1\nnew line 2\nextra line\nline3")
      }),
    )

    it.instance("handles CRLF line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\r\nold\r\nline3")

        yield* run({ filePath: filepath, oldString: "old", newString: "new" })

        expect(yield* load(filepath)).toBe("line1\r\nnew\r\nline3")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "" })).message).toContain("identical")
      }),
    )

    it.instance("throws error when path is directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dirpath = path.join(test.directory, "adir")
        yield* makeDirectory(dirpath)

        expect((yield* fail({ filePath: dirpath, oldString: "old", newString: "new" })).message).toContain("directory")
      }),
    )

    it.instance("tracks file diff statistics", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        const result = yield* run({ filePath: filepath, oldString: "line2", newString: "new line a\nnew line b" })

        expect(result.metadata.filediff).toBeDefined()
        expect(result.metadata.filediff.file).toBe(filepath)
        expect(result.metadata.filediff.additions).toBeGreaterThan(0)
      }),
    )
  })

  describe("line endings", () => {
    const old = "alpha\nbeta\ngamma"
    const next = "alpha\nbeta-updated\ngamma"
    const alt = "alpha\nbeta\nomega"

    const normalize = (text: string, ending: "\n" | "\r\n") => {
      const normalized = text.replaceAll("\r\n", "\n")
      if (ending === "\n") return normalized
      return normalized.replaceAll("\n", "\r\n")
    }

    const count = (content: string) => {
      const crlf = content.match(/\r\n/g)?.length ?? 0
      const lf = content.match(/\n/g)?.length ?? 0
      return {
        crlf,
        lf: lf - crlf,
      }
    }

    const expectLf = (content: string) => {
      const counts = count(content)
      expect(counts.crlf).toBe(0)
      expect(counts.lf).toBeGreaterThan(0)
    }

    const expectCrlf = (content: string) => {
      const counts = count(content)
      expect(counts.lf).toBe(0)
      expect(counts.crlf).toBeGreaterThan(0)
    }

    type Input = {
      content: string
      oldString: string
      newString: string
      replaceAll?: boolean
    }

    const apply = Effect.fn("EditToolTest.lineEndings.apply")(function* (input: Input) {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "test.txt")
      yield* put(filePath, input.content)
      yield* run({
        filePath,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll,
      })
      return yield* load(filePath)
    })

    it.instance("preserves LF with LF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with CRLF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when old/new use CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when old/new use LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when newString uses CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when newString uses LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: "alpha\nbeta\r\ngamma",
          newString: "alpha\r\nbeta\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: "alpha\r\nbeta\ngamma",
          newString: "alpha\nbeta\r\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("replaceAll preserves LF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\n"),
          newString: normalize(blockNew, "\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("replaceAll preserves CRLF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\r\n"),
          newString: normalize(blockNew, "\r\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )
  })

  describe("concurrent editing", () => {
    it.instance("preserves concurrent edits to different sections of the same file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\nmiddle = keep\nbottom = 0\n")

        const firstAsk = yield* Deferred.make<void>()
        let asks = 0
        const delayedCtx = {
          ...ctx,
          ask: () =>
            Effect.gen(function* () {
              asks++
              if (asks !== 1) return
              yield* Deferred.succeed(firstAsk, undefined)
              yield* Effect.sleep("50 millis")
            }),
        }

        const first = yield* run(
          {
            filePath: filepath,
            oldString: "top = 0",
            newString: "top = 1",
          },
          delayedCtx,
        ).pipe(Effect.forkScoped)

        yield* Deferred.await(firstAsk)
        yield* Effect.all([
          Fiber.join(first),
          run(
            {
              filePath: filepath,
              oldString: "bottom = 0",
              newString: "bottom = 2",
            },
            delayedCtx,
          ),
        ])

        expect(yield* load(filepath)).toBe("top = 1\nmiddle = keep\nbottom = 2\n")
      }),
    )
  })

  describe("ambiguous matches", () => {
    it.instance("reports every exact match with its line number", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = "const value = 1\nconst value = 2\n"
        yield* put(filepath, original)

        const error = yield* fail({ filePath: filepath, oldString: "const value", newString: "const next" })

        expect(error.message).toContain("Found 2 matches for oldString")
        expect(error.message).toContain("- line 1: const value")
        expect(error.message).toContain("- line 2: const value")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("reports every fuzzy match instead of choosing one", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = ["if (a) {", "  doThing()", "}", "if (a) {", "    doThing()", "}", ""].join("\n")
        yield* put(filepath, original)

        const error = yield* fail({
          filePath: filepath,
          oldString: ["if (a) {", "doThing()", "}"].join("\n"),
          newString: ["if (a) {", "  doOther()", "}"].join("\n"),
        })

        expect(error.message).toContain("Found 2 matches for oldString")
        expect(error.message).toContain("line 1")
        expect(error.message).toContain("line 4")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("rejects replaceAll when the fuzzy match is ambiguous", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = ["if (a) {", "  doThing()", "}", "if (a) {", "    doThing()", "}", ""].join("\n")
        yield* put(filepath, original)

        const error = yield* fail({
          filePath: filepath,
          oldString: ["if (a) {", "doThing()", "}"].join("\n"),
          newString: ["if (a) {", "  doOther()", "}"].join("\n"),
          replaceAll: true,
        })

        expect(error.message).toContain("Found 2 matches for oldString")
        expect(error.message).not.toContain("replaceAll")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("omits the closest snippet when similarity is below the cutoff", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = "const total = compute(items)\n"
        yield* put(filepath, original)

        const error = yield* fail({
          filePath: filepath,
          oldString: "zzzzzzzzzzzzzzzzzzzzzzzz",
          newString: "const total = compute(other)",
        })

        expect(error.message).toContain("Could not find oldString")
        expect(error.message).not.toContain("Closest match")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("suggests the closest line when oldString is not found", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = "const total = compute(items)\n"
        yield* put(filepath, original)

        const error = yield* fail({
          filePath: filepath,
          oldString: "const totl = compute(items)",
          newString: "const total = compute(other)",
        })

        expect(error.message).toContain("Could not find oldString")
        expect(error.message).toContain("Closest match at line 1")
        expect(error.message).toContain("const total = compute(items)")
        expect(yield* load(filepath)).toBe(original)
      }),
    )
  })

  describe("match strategy", () => {
    const fuzzyFile = "  const a = 1\n  const b = 2\n"
    const fuzzyOld = "const a = 1\nconst b = 2"

    it.instance("a fuzzy match is applied silently but recorded in the metadata", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "fuzzy.ts")
        yield* put(filepath, fuzzyFile)

        const result = yield* run({ filePath: filepath, oldString: fuzzyOld, newString: "const c = 3" })

        expect(yield* load(filepath)).toBe("const c = 3\n")
        expect(result.output).toContain("Edit applied successfully.")
        expect(result.metadata).toMatchObject({ matchStrategy: "line_trimmed", corrections: ["fuzzy_match"] })
      }),
    )

    it.instance("a fuzzy match is on the running call as soon as the text is on disk", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "running.ts")
        yield* put(filepath, fuzzyFile)
        const updates: Array<{ metadata?: Record<string, unknown> }> = []
        const recording: Tool.Context = {
          ...ctx,
          metadata: (update) =>
            Effect.sync(() => {
              updates.push(update)
            }),
        }

        yield* run({ filePath: filepath, oldString: fuzzyOld, newString: "const c = 3" }, recording)

        // The mark comes first, before the call reports the diff, and the diff update keeps it.
        expect(updates.map((update) => update.metadata?.corrections)).toEqual([["fuzzy_match"], ["fuzzy_match"]])
        expect(updates[0].metadata).toEqual({ corrections: ["fuzzy_match"] })
        expect(updates[1].metadata).toMatchObject({ diff: expect.any(String), corrections: ["fuzzy_match"] })
      }),
    )

    it.instance("an exact edit reports its running metadata without any correction", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "running-exact.ts")
        yield* put(filepath, "const a = 1\n")
        const updates: Array<{ metadata?: Record<string, unknown> }> = []
        const recording: Tool.Context = {
          ...ctx,
          metadata: (update) =>
            Effect.sync(() => {
              updates.push(update)
            }),
        }

        yield* run({ filePath: filepath, oldString: "const a = 1", newString: "const a = 2" }, recording)

        expect(updates).toHaveLength(1)
        expect(updates[0].metadata).not.toHaveProperty("corrections")
      }),
    )

    it.instance("an exact match records neither a strategy nor a correction", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "exact.ts")
        yield* put(filepath, "const a = 1\n")

        const result = yield* run({ filePath: filepath, oldString: "const a = 1", newString: "const a = 2" })

        expect(result.metadata).not.toHaveProperty("matchStrategy")
        expect(result.metadata).not.toHaveProperty("corrections")
      }),
    )

    it.instance("a fuzzy match found after an argument repair carries both corrections", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "both.ts")
        yield* put(filepath, fuzzyFile)

        const result = yield* runRaw({ file_path: filepath, old_string: fuzzyOld, new_string: "const c = 3" })

        expect(result.metadata).toMatchObject({
          matchStrategy: "line_trimmed",
          corrections: ["fuzzy_match", "args_repaired"],
        })
      }),
    )

    it.instance("creating a file and a failed edit leave no strategy behind", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const created = yield* run({
          filePath: path.join(test.directory, "created.ts"),
          oldString: "",
          newString: "export {}\n",
        })
        expect(created.metadata).not.toHaveProperty("matchStrategy")
        expect(created.metadata).not.toHaveProperty("corrections")
      }),
    )
  })

  describe("argument repair", () => {
    it.instance("accepts legacy oldText/newText keys", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "old content here")

        yield* runRaw({ filePath: filepath, oldText: "old content", newText: "new content" })

        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("rejects top-level strings combined with multiple edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        const original = "alpha beta"
        yield* put(filepath, original)

        const error = yield* failRaw({
          filePath: filepath,
          oldString: "alpha",
          newString: "gamma",
          edits: [
            { oldString: "alpha", newString: "gamma" },
            { oldString: "beta", newString: "delta" },
          ],
        })

        expect(error.message).toContain("split multiple edits")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("rejects top-level strings combined with a single edits entry", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        const original = "alpha beta"
        yield* put(filepath, original)

        const error = yield* failRaw({
          filePath: filepath,
          oldString: "alpha",
          newString: "gamma",
          edits: [{ oldString: "beta", newString: "delta" }],
        })

        expect(error.message).toContain("split multiple edits")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("rejects edits and edit supplied together", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        const original = "alpha beta"
        yield* put(filepath, original)

        const error = yield* failRaw({
          filePath: filepath,
          edits: { oldString: "alpha", newString: "gamma" },
          edit: { oldString: "beta", newString: "delta" },
        })

        expect(error.message).toContain("edit call was rejected")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("accepts snake_case keys", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "old content here")

        yield* runRaw({ file_path: filepath, old_string: "old content", new_string: "new content" })

        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("keeps JSON-shaped string values when snake_case keys are repaired", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.json")
        yield* put(filepath, '{"a":1}')

        yield* runRaw({ file_path: filepath, old_string: '{"a":1}', new_string: '{"a":2}' })

        expect(yield* load(filepath)).toBe('{"a":2}')
      }),
    )

    it.instance("accepts a single edit object under edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "old content here")

        yield* runRaw({ filePath: filepath, edits: { oldText: "old content", newText: "new content" } })

        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("accepts the file path inside a single edit entry", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "old content here")

        yield* runRaw({
          edits: [{ filePath: filepath, oldText: "old content", newText: "new content" }],
        })

        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("accepts a JSON-encoded edits array", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "old content here")

        yield* runRaw({
          filePath: filepath,
          edits: JSON.stringify([{ oldText: "old content", newText: "new content" }]),
        })

        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("accepts a string replaceAll flag", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "foo bar foo")

        yield* runRaw({ filePath: filepath, oldString: "foo", newString: "qux", replaceAll: "true" })

        expect(yield* load(filepath)).toBe("qux bar qux")
      }),
    )

    it.instance("rejects multiple edits instead of choosing one", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "alpha beta")

        const error = yield* failRaw({
          filePath: filepath,
          edits: [
            { oldText: "alpha", newText: "ALPHA" },
            { oldText: "beta", newText: "BETA" },
          ],
        })

        expect(error.message).toContain("one replacement per call")
        expect(yield* load(filepath)).toBe("alpha beta")
      }),
    )
  })
})

describe("replace()", () => {
  test("an exact match reports its line and replaces once", () => {
    expect(replace("a\nfoo\nb", "foo", "bar")).toEqual({ content: "a\nbar\nb", strategy: "exact", line: 2, count: 1 })
  })

  test("replaceAll replaces every exact match and counts them", () => {
    expect(replace("foo\nx\nfoo\nfoo", "foo", "bar", true)).toEqual({
      content: "bar\nx\nbar\nbar",
      strategy: "exact",
      line: 1,
      count: 3,
    })
    expect(replace("x\nfoo\ny", "foo", "bar", true)).toMatchObject({ strategy: "exact", line: 2, count: 1 })
  })

  test("a repeated exact match is still ambiguous without replaceAll", () => {
    expect(() => replace("foo\nfoo", "foo", "bar")).toThrow("Found 2 matches")
  })

  test("line_trimmed finds lines that differ only in indentation", () => {
    expect(replace("keep\n  const a = 1\n  const b = 2\n", "const a = 1\nconst b = 2", "x")).toEqual({
      content: "keep\nx\n",
      strategy: "line_trimmed",
      line: 2,
      count: 1,
    })
  })

  test("block_anchor finds a block by its first and last lines", () => {
    const content = "function f() {\n  const value = compute(1)\n  return value\n}\n"
    const old = "function f() {\n  const value = compute(2)\n  return value\n}"
    expect(replace(content, old, "x")).toEqual({ content: "x\n", strategy: "block_anchor", line: 1, count: 1 })
  })

  test("whitespace_normalized finds text that differs in runs of whitespace", () => {
    expect(replace("start\nfoo   bar  baz\n", "foo bar baz", "x")).toEqual({
      content: "start\nx\n",
      strategy: "whitespace_normalized",
      line: 2,
      count: 1,
    })
  })

  test("escape_normalized finds text written with escaped quotes", () => {
    expect(replace('say "hi"\n', 'say \\"hi\\"', "x")).toMatchObject({
      strategy: "escape_normalized",
      line: 1,
      count: 1,
    })
  })

  test("a fuzzy match replaces once even with replaceAll", () => {
    expect(replace("  foo   bar\n", "foo bar", "x", true)).toMatchObject({
      strategy: "whitespace_normalized",
      count: 1,
    })
  })

  test("a missing match still fails", () => {
    expect(() => replace("alpha", "omega", "x")).toThrow("Could not find oldString")
  })
})
