import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { createHash } from "node:crypto"
import fs from "fs/promises"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import * as PlatformError from "effect/PlatformError"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@graphagent/core/fs-util"
import { Format } from "../../src/format"
import { FileState } from "@/session/file-state"
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
  FileState.defaultLayer,
)

const it = testEffect(layer)

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")

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

    // #1452 B2: the lock used to stay held while a permission question waited for its answer.
    it.instance("a permission question nobody has answered does not hold the file for other edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\nmiddle = keep\nbottom = 0\n")
        const asked = yield* Deferred.make<void>()
        const answer = yield* Deferred.make<void>()
        const waiting = {
          ...ctx,
          ask: () => Deferred.succeed(asked, undefined).pipe(Effect.andThen(Deferred.await(answer))),
        }

        const first = yield* run({ filePath: filepath, oldString: "top = 0", newString: "top = 1" }, waiting).pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(asked)
        const second = yield* run({ filePath: filepath, oldString: "bottom = 0", newString: "bottom = 2" }).pipe(
          Effect.forkScoped,
        )

        const finished = yield* Fiber.await(second).pipe(Effect.timeoutOption("2 seconds"))
        expect(Option.isSome(finished)).toBe(true)
        expect(yield* load(filepath)).toBe("top = 0\nmiddle = keep\nbottom = 2\n")

        // The first edit is answered at last and lands on the second edit's result.
        yield* Deferred.succeed(answer, undefined)
        yield* Fiber.join(first)
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

describe("tool.edit file state (#1452)", () => {
  const recorded = Effect.fn("EditToolTest.recorded")(function* (filepath: string) {
    return yield* (yield* FileState.Service).get(ctx.sessionID, filepath)
  })

  it.instance("records the edited file under the edit source", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "alpha beta\n")

      yield* run({ filePath: filepath, oldString: "alpha", newString: "ALPHA" })

      const entry = yield* recorded(filepath)
      expect(entry?.source).toBe("edit")
      expect(entry?.hash).toBe(sha256("ALPHA beta\n"))
      expect(entry?.size).toBe(11)
    }),
  )

  it.instance("records a file created through an empty oldString", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "fresh.txt")

      yield* run({ filePath: filepath, oldString: "", newString: "created\n" })

      const entry = yield* recorded(filepath)
      expect(entry?.source).toBe("edit")
      expect(entry?.hash).toBe(sha256("created\n"))
    }),
  )

  it.instance("records the BOM and CRLF bytes the file ended up with", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "windows.cs")
      const bom = String.fromCharCode(0xfeff)
      yield* put(filepath, `${bom}one\r\ntwo\r\n`)

      yield* run({ filePath: filepath, oldString: "one", newString: "uno" })

      const onDisk = yield* Effect.promise(() => fs.readFile(filepath))
      expect(onDisk.toString("utf8")).toBe(`${bom}uno\r\ntwo\r\n`)
      expect((yield* recorded(filepath))?.hash).toBe(sha256(onDisk))
    }),
  )

  it.instance(
    "records the state the formatter left, in both branches",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const existing = path.join(test.directory, "existing.ts")
        const fresh = path.join(test.directory, "fresh.ts")
        yield* put(existing, "const a = 1\n")

        yield* run({ filePath: existing, oldString: "a = 1", newString: "a = 2" })
        yield* run({ filePath: fresh, oldString: "", newString: "const b = 1\n" })

        for (const filepath of [existing, fresh]) {
          const onDisk = yield* Effect.promise(() => fs.readFile(filepath))
          expect(onDisk.toString("utf8")).toContain("// formatted line")
          const entry = yield* recorded(filepath)
          expect(entry?.hash).toBe(sha256(onDisk))
          expect(entry?.size).toBe(onDisk.byteLength)
        }
      }),
    {
      config: {
        formatter: {
          expand: {
            extensions: [".ts"],
            command: [
              "node",
              "-e",
              "const fs = require('fs'); const file = process.argv[1]; const text = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, text + '// formatted line\\n'.repeat(3), 'utf8')",
              "$FILE",
            ],
          },
        },
      },
    },
  )

  it.instance("does not record a failed edit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "alpha")

      yield* fail({ filePath: filepath, oldString: "missing", newString: "x" })

      expect(yield* recorded(filepath)).toBeUndefined()
    }),
  )
})

describe("tool.edit size limit (#1452)", () => {
  it.instance("rejects an existing file above 10 MiB and leaves it alone", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "big.txt")
      const size = FileState.MAX_EDITABLE_BYTES + 1
      yield* Effect.promise(() => fs.writeFile(filepath, Buffer.alloc(size, 97)))

      const error = yield* fail({ filePath: filepath, oldString: "aaa", newString: "bbb" })

      expect(error.message).toBe(FileState.tooLargeMessage(filepath))
      expect(error.message).toContain("10 MiB")
      expect((yield* Effect.promise(() => fs.stat(filepath))).size).toBe(size)
    }),
  )

  it.instance("accepts a file of exactly 10 MiB", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "limit.txt")
      const content = "needle" + "a".repeat(FileState.MAX_EDITABLE_BYTES - "needle".length)
      yield* Effect.promise(() => fs.writeFile(filepath, content))

      yield* run({ filePath: filepath, oldString: "needle", newString: "NEEDLE" })

      expect((yield* load(filepath)).startsWith("NEEDLE")).toBe(true)
    }),
  )

  it.instance("does not need a prior read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "unread.txt")
      yield* put(filepath, "never read\n")

      yield* run({ filePath: filepath, oldString: "never", newString: "still" })

      expect(yield* load(filepath)).toBe("still read\n")
    }),
  )
})

describe("tool.edit write-point checks (#1452)", () => {
  const recorded = Effect.fn("EditToolTest.recordedState")(function* (filepath: string) {
    return yield* (yield* FileState.Service).get(ctx.sessionID, filepath)
  })
  const markRead = Effect.fn("EditToolTest.markRead")(function* (filepath: string) {
    yield* (yield* FileState.Service).record(ctx.sessionID, filepath, "read")
  })
  /** A context whose permission question runs `action` before it is answered. */
  const askThen = (action: Effect.Effect<void>) => ({ ...ctx, ask: () => action })
  const rewrite = (filepath: string, content: string) => Effect.promise(() => fs.writeFile(filepath, content))
  const patchTool = Effect.fn("EditToolTest.patchTool")(function* (patchText: string) {
    const tool = yield* (yield* ApplyPatchTool).init()
    return yield* tool.execute({ patchText }, ctx)
  })
  const writeTool = Effect.fn("EditToolTest.writeTool")(function* (filePath: string, content: string) {
    const tool = yield* (yield* WriteTool).init()
    return yield* tool.execute({ filePath, content }, ctx)
  })

  describe("the shared path lock", () => {
    // Holds the lock of `held` while `call` starts; reports whether it was still waiting shortly afterwards, then
    // lets the lock go and waits for the call to finish.
    const heldBack = <A, E, R>(held: string, call: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const holder = yield* FileState.withLocks([held])(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        const fiber = yield* call.pipe(Effect.forkScoped)
        const early = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("150 millis"))
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holder)
        yield* Fiber.join(fiber)
        return Option.isNone(early)
      })

    it.instance("holds an edit on that path back until the lock is free", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const held = path.join(test.directory, "held.txt")
        yield* put(held, "held = 0\n")

        const waited = yield* heldBack(held, run({ filePath: held, oldString: "held = 0", newString: "held = 1" }))

        expect(waited).toBe(true)
        expect(yield* load(held)).toBe("held = 1\n")
      }),
    )

    it.instance("holds a write on that path back until the lock is free", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const held = path.join(test.directory, "held.txt")
        yield* put(held, "held = 0\n")
        yield* markRead(held)

        const waited = yield* heldBack(held, writeTool(held, "written\n"))

        expect(waited).toBe(true)
        expect(yield* load(held)).toBe("written\n")
      }),
    )

    it.instance("holds an apply_patch on that path back until the lock is free", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const held = path.join(test.directory, "held.txt")
        yield* put(held, "held = 0\n")

        const waited = yield* heldBack(
          held,
          patchTool("*** Begin Patch\n*** Update File: held.txt\n@@\n-held = 0\n+held = patched\n*** End Patch"),
        )

        expect(waited).toBe(true)
        expect(yield* load(held)).toBe("held = patched\n")
      }),
    )

    it.instance("holds an apply_patch back when only its move target is locked", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const source = path.join(test.directory, "source.txt")
        const target = path.join(test.directory, "target.txt")
        yield* put(source, "move me\n")

        const waited = yield* heldBack(
          target,
          patchTool(
            "*** Begin Patch\n*** Update File: source.txt\n*** Move to: target.txt\n@@\n-move me\n+moved\n*** End Patch",
          ),
        )

        expect(waited).toBe(true)
        expect(yield* load(target)).toBe("moved\n")
      }),
    )

    it.instance("does not hold back calls on any other path", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const held = path.join(test.directory, "held.txt")
        const free = path.join(test.directory, "free.txt")
        yield* put(free, "free = 0\n")
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const holder = yield* FileState.withLocks([held])(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)

        const finished = yield* Effect.all([
          run({ filePath: free, oldString: "free = 0", newString: "free = 1" }),
          writeTool(path.join(test.directory, "other.txt"), "other\n"),
          patchTool("*** Begin Patch\n*** Add File: added.txt\n+added\n*** End Patch"),
        ]).pipe(Effect.timeoutOption("2 seconds"))

        expect(Option.isSome(finished)).toBe(true)
        expect(yield* load(free)).toBe("free = 1\n")
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holder)
      }),
    )
  })

  describe("a file that changed while the question was open", () => {
    it.instance("is edited around when the change is elsewhere, and the receipt says so", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\nmiddle = keep\nbottom = 0\n")
        yield* markRead(filepath)
        const next = askThen(rewrite(filepath, "top = 0\nmiddle = changed elsewhere\nbottom = 0\n"))

        const result = yield* run({ filePath: filepath, oldString: "top = 0", newString: "top = 1" }, next)

        expect(yield* load(filepath)).toBe("top = 1\nmiddle = changed elsewhere\nbottom = 0\n")
        const lines = result.output.split("\n")
        expect(lines[0]).toBe("Edit applied successfully.")
        expect(lines[1]).toBe(FileState.changedOutsideNote(result.title))
        expect(result.output).toContain("\nNote: this file changed outside this session after your last read: ")
      }),
    )

    it.instance("reports the original error when the change removed the text to replace", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\nbottom = 0\n")
        yield* markRead(filepath)
        const next = askThen(rewrite(filepath, "something else entirely\n"))

        const exit = yield* run({ filePath: filepath, oldString: "top = 0", newString: "top = 1" }, next).pipe(
          Effect.exit,
        )

        expect(Exit.isFailure(exit)).toBe(true)
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(error instanceof Error ? error.message : "").toContain("Could not find oldString in the file")
        expect(yield* load(filepath)).toBe("something else entirely\n")
      }),
    )

    it.instance("reports a file that disappeared as not found", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\n")
        const next = askThen(Effect.promise(() => fs.rm(filepath)))

        const exit = yield* run({ filePath: filepath, oldString: "top = 0", newString: "top = 1" }, next).pipe(
          Effect.exit,
        )

        expect(Exit.isFailure(exit)).toBe(true)
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(error instanceof Error ? error.message : "").toBe(
          `File ${filepath} not found. Check the path with glob.`,
        )
      }),
    )

    it.instance("rejects creating a file that someone else created first", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "fresh.txt")
        const next = askThen(rewrite(filepath, "created elsewhere\n"))

        const exit = yield* run({ filePath: filepath, oldString: "", newString: "mine\n" }, next).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(error instanceof Error ? error.message : "").toBe(FileState.changedWhileAskingMessage(filepath))
        expect(yield* load(filepath)).toBe("created elsewhere\n")
      }),
    )

    it.instance("adds no note for a file the session never read", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\n")

        const result = yield* run({ filePath: filepath, oldString: "top = 0", newString: "top = 1" })

        expect(result.output).toBe("Edit applied successfully.")
      }),
    )

    it.instance("adds a note when the file changed after the last read, even without a question in between", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\nbottom = 0\n")
        yield* markRead(filepath)
        yield* put(filepath, "top = 0\nbottom = formatted elsewhere\n")

        const result = yield* run({ filePath: filepath, oldString: "top = 0", newString: "top = 1" })

        expect(result.output).toBe(`Edit applied successfully.\n${FileState.changedOutsideNote(result.title)}`)
        expect(yield* load(filepath)).toBe("top = 1\nbottom = formatted elsewhere\n")
      }),
    )
  })

  describe("edits that follow this session's own writes", () => {
    it.instance("add no note after write", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")

        yield* writeTool(filepath, "top = 0\n")
        const result = yield* run({ filePath: filepath, oldString: "top = 0", newString: "top = 1" })

        expect(result.output).toBe("Edit applied successfully.")
      }),
    )

    it.instance("add no note after apply_patch", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")

        yield* patchTool("*** Begin Patch\n*** Add File: file.txt\n+top = 0\n*** End Patch")
        const result = yield* run({ filePath: filepath, oldString: "top = 0", newString: "top = 1" })

        expect(result.output).toBe("Edit applied successfully.")
      }),
    )

    it.instance(
      "add no note for consecutive edits, also when a formatter rewrites the file each time",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const filepath = path.join(test.directory, "file.ts")
          yield* put(filepath, "const a = 1\nconst b = 1\n")
          yield* markRead(filepath)

          const first = yield* run({ filePath: filepath, oldString: "a = 1", newString: "a = 2" })
          const second = yield* run({ filePath: filepath, oldString: "b = 1", newString: "b = 2" })
          const third = yield* run({ filePath: filepath, oldString: "a = 2", newString: "a = 3" })

          for (const result of [first, second, third]) expect(result.output).toBe("Edit applied successfully.")
          const final = yield* load(filepath)
          expect(final).toContain("const a = 3")
          expect(final).toContain("const b = 2")
          expect((yield* recorded(filepath))?.hash).toBe(sha256(final))
        }),
      {
        config: {
          formatter: {
            expand: {
              extensions: [".ts"],
              command: [
                "node",
                "-e",
                "const fs = require('fs'); const file = process.argv[1]; const text = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, text + '// formatted line\\n', 'utf8')",
                "$FILE",
              ],
            },
          },
        },
      },
    )
  })
})
