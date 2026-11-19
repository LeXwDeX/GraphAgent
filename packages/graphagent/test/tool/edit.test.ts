import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { createHash } from "node:crypto"
import fs from "fs/promises"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { logLines } from "effect/testing/TestConsole"
import * as PlatformError from "effect/PlatformError"
import { EditTool, looksLikeReadPrefix, replace } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import type { Diagnostic } from "@/lsp/client"
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

// What the mocked LSP reports about the check; afterEach puts it back.
let mockedStatus: LSP.Diagnostic.CheckStatus = "checked"

afterEach(async () => {
  mockedStatus = "checked"
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

let mockedDiagnostics: Record<string, Diagnostic[]> = {}
const itWithLsp = testEffect(
  Layer.mergeAll(
    Layer.mock(LSP.Service, {
      touchFile: () => Effect.sync(() => mockedStatus),
      diagnostics: () => Effect.succeed(mockedDiagnostics),
    }),
    FSUtil.defaultLayer,
    Format.defaultLayer,
    EventV2Bridge.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    FileState.defaultLayer,
  ),
)

// The start of the result of an edit that replaced one line (#1451): the first sentence, a blank line instead of a
// note, and the line that says where the change landed.
const onlyReceipt = [
  "Edit applied successfully.",
  "",
  "Lines 1-1 changed. Replacements: 1. Additions: 1. Deletions: 1.",
]

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

        expect(result.output.split("\n").slice(0, 3)).toEqual(onlyReceipt)
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

        expect(result.output.split("\n").slice(0, 4)).toEqual([
          "Edit applied successfully.",
          FileState.changedOutsideNote(result.title),
          "",
          "Lines 1-1 changed. Replacements: 1. Additions: 1. Deletions: 1.",
        ])
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

        expect(result.output.split("\n").slice(0, 3)).toEqual(onlyReceipt)
      }),
    )

    it.instance("add no note after apply_patch", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")

        yield* patchTool("*** Begin Patch\n*** Add File: file.txt\n+top = 0\n*** End Patch")
        const result = yield* run({ filePath: filepath, oldString: "top = 0", newString: "top = 1" })

        expect(result.output.split("\n").slice(0, 3)).toEqual(onlyReceipt)
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

          // No note after the first sentence, whatever the formatter did to the file in between.
          for (const result of [first, second, third]) {
            expect(result.output.split("\n").slice(0, 2)).toEqual(["Edit applied successfully.", ""])
          }
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

// #1451: after an edit the result says whether the language server checked the file. A check that did not run is
// not the same as one that found nothing.
describe("tool.edit LSP check state (#1451)", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`)
  // What the receipt says about replacing the one line of a file, ahead of the status line these tests are about.
  const receipt = (before: string, after: string) =>
    [
      "Lines 1-1 changed. Replacements: 1. Additions: 1. Deletions: 1.",
      "@@ -1,1 +1,1 @@",
      `-${before}`,
      `+${after}`,
    ].join("\n")
  const diagnostic = (line: number, severity: Diagnostic["severity"] = 1, message = "boom"): Diagnostic => ({
    severity,
    message,
    range: { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 1 } },
  })

  it.instance("says the check did not run when LSP is disabled, which is the default", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "alpha beta\n")

      const result = yield* run({ filePath: filepath, oldString: "alpha", newString: "ALPHA" })

      expect(result.output).toBe(
        `Edit applied successfully.\n\n${receipt("alpha beta", "ALPHA beta")}\n\nnot checked: LSP disabled`,
      )
    }),
  )

  const unchecked: [LSP.Diagnostic.CheckStatus, string][] = [
    ["disabled", "not checked: LSP disabled"],
    ["no_server", "not checked: no language server"],
    ["timed_out", "not checked: timed out"],
  ]
  for (const [status, line] of unchecked) {
    itWithLsp.instance(`words the ${status} status as "${line}"`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "alpha beta\n")
        mockedStatus = status
        mockedDiagnostics = {}

        const result = yield* run({ filePath: filepath, oldString: "alpha", newString: "ALPHA" })

        expect(result.output).toBe(`Edit applied successfully.\n\n${receipt("alpha beta", "ALPHA beta")}\n\n${line}`)
      }),
    )
  }

  itWithLsp.instance("is clean when the check ran and found nothing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.ts")
      yield* put(filepath, "const a = 1\n")
      mockedDiagnostics = {}

      const result = yield* run({ filePath: filepath, oldString: "a = 1", newString: "a = 2" })

      expect(result.output).toBe(
        `Edit applied successfully.\n\n${receipt("const a = 1", "const a = 2")}\n\nchecked: clean`,
      )
    }),
  )

  itWithLsp.instance("counts an error on the edited line and still reports it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.ts")
      yield* put(filepath, "const a = 1\n")
      mockedDiagnostics = { [FSUtil.normalizePath(filepath)]: [diagnostic(1)] }

      const result = yield* run({ filePath: filepath, oldString: "a = 1", newString: "a: string = 1" })

      expect(result.output).toBe(
        [
          "Edit applied successfully.",
          "",
          receipt("const a = 1", "const a: string = 1"),
          "",
          "checked: 1 error",
          "",
          "LSP errors detected in this file, please fix:",
          `<diagnostics file="${filepath}">`,
          "ERROR [1:1] boom",
          "</diagnostics>",
        ].join("\n"),
      )
    }),
  )

  itWithLsp.instance("counts every error near the edit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.ts")
      yield* put(filepath, "const a = 1\nconst b = 2\n")
      mockedDiagnostics = { [FSUtil.normalizePath(filepath)]: [diagnostic(1), diagnostic(2, 1, "again")] }

      const result = yield* run({ filePath: filepath, oldString: "a = 1", newString: "a: string = 1" })

      expect(result.output).toContain("\n\nchecked: 2 errors\n\nLSP errors detected in this file, please fix:\n")
    }),
  )

  itWithLsp.instance("leaves errors elsewhere in the file and warnings out of the count", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "long.ts")
      yield* put(filepath, lines(30).join("\n") + "\n")
      // Only line 1 changes. The error on line 25 predates the edit; the warning on line 1 is below error severity.
      mockedDiagnostics = { [FSUtil.normalizePath(filepath)]: [diagnostic(25), diagnostic(1, 2, "careful")] }

      const result = yield* run({ filePath: filepath, oldString: "line 1\n", newString: "changed\n" })

      // The receipt shows the change with three lines of context, the status line says the error on line 25 is not its.
      expect(result.output.split("\n").slice(-2)).toEqual(["", "checked: clean"])
      expect(result.output).toContain("Lines 1-1 changed. Replacements: 1. Additions: 1. Deletions: 1.")
      expect(result.output).not.toContain("LSP errors detected")
    }),
  )

  itWithLsp.instance("does not turn diagnostics left over from before into a verdict when nothing ran", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.ts")
      yield* put(filepath, "const a = 1\n")
      mockedStatus = "timed_out"
      mockedDiagnostics = { [FSUtil.normalizePath(filepath)]: [diagnostic(1)] }

      const result = yield* run({ filePath: filepath, oldString: "a = 1", newString: "a = 2" })

      expect(result.output).toContain("\n\nnot checked: timed out\n\nLSP errors detected in this file, please fix:\n")
      expect(result.output).not.toContain("checked: 1 error")
    }),
  )

  itWithLsp.instance("puts the status line after the note about a file that changed outside the session", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "top = 0\nbottom = 0\n")
      yield* (yield* FileState.Service).record(ctx.sessionID, filepath, "read")
      yield* put(filepath, "top = 0\nbottom = formatted elsewhere\n")
      mockedDiagnostics = {}

      const result = yield* run({ filePath: filepath, oldString: "top = 0", newString: "top = 1" })

      expect(result.output).toBe(
        [
          "Edit applied successfully.",
          FileState.changedOutsideNote(result.title),
          "",
          "Lines 1-1 changed. Replacements: 1. Additions: 1. Deletions: 1.",
          "@@ -1,2 +1,2 @@",
          "-top = 0",
          "+top = 1",
          " bottom = formatted elsewhere",
          "",
          "checked: clean",
        ].join("\n"),
      )
    }),
  )

  itWithLsp.instance("reports the state of a file created through an empty oldString", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "fresh.ts")
      mockedStatus = "no_server"

      const result = yield* run({ filePath: filepath, oldString: "", newString: "const a = 1\n" })

      expect(result.output).toBe(
        "Edit applied successfully.\n\nLines 1-1 changed. Additions: 1. Deletions: 0.\n\nnot checked: no language server",
      )
    }),
  )

  itWithLsp.instance(
    "keeps the status line out of the title",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "alpha beta\n")
        mockedStatus = "timed_out"

        const result = yield* run({ filePath: filepath, oldString: "alpha", newString: "ALPHA" })

        expect(result.title).toBe("file.txt")
      }),
    { git: true },
  )
})

// #1451: after an edit the result says where it landed and how much changed, how the text was found when the match was
// not exact, whether the formatter rewrote the file, and what the diff is.
describe("tool.edit write receipt (#1451)", () => {
  const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`)
  const expand = {
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
  }
  // A formatter that runs and leaves the text as it found it.
  const untouched = {
    formatter: { noop: { extensions: [".ts"], command: ["node", "-e", "process.exit(0)", "$FILE"] } },
  }

  it.instance(
    "tells where an exact edit landed, how much it changed, and shows the diff",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "alpha\nbeta\ngamma\n")

        const result = yield* run({ filePath: filepath, oldString: "beta", newString: "BETA" })

        expect(result.output).toBe(
          [
            "Edit applied successfully.",
            "",
            "Lines 2-2 changed. Replacements: 1. Additions: 1. Deletions: 1.",
            "@@ -1,3 +1,3 @@",
            " alpha",
            "-beta",
            "+BETA",
            " gamma",
            "",
            "not checked: LSP disabled",
          ].join("\n"),
        )
        expect(result.title).toBe("file.txt")
        expect(result.metadata).not.toHaveProperty("corrections")
      }),
    { git: true },
  )

  it.instance("says a fuzzy match was not exact, and keeps the strategy in the metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "fuzzy.ts")
      yield* put(filepath, "  const a = 1\n  const b = 2\n")

      const result = yield* run({ filePath: filepath, oldString: "const a = 1\nconst b = 2", newString: "const c = 3" })

      expect(result.output).toBe(
        [
          "Edit applied successfully.",
          "",
          "Lines 1-1 changed. Replacements: 1. Additions: 1. Deletions: 2.",
          "Matched by fuzzy strategy line_trimmed at line 1 (not an exact match); check the diff below.",
          "@@ -1,2 +1,1 @@",
          "-  const a = 1",
          "-  const b = 2",
          "+const c = 3",
          "",
          "not checked: LSP disabled",
        ].join("\n"),
      )
      expect(result.metadata).toMatchObject({ matchStrategy: "line_trimmed", corrections: ["fuzzy_match"] })
    }),
  )

  it.instance("names the line a fuzzy match started at", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "later.ts")
      yield* put(filepath, "head\nhead\n  const a = 1\n  const b = 2\n")

      const result = yield* run({ filePath: filepath, oldString: "const a = 1\nconst b = 2", newString: "const c = 3" })

      expect(result.output).toContain("Matched by fuzzy strategy line_trimmed at line 3 (not an exact match)")
    }),
  )

  it.instance("counts the replacements of replaceAll and lists every place it landed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "many.txt")
      yield* put(filepath, "x = 1\ny\nx = 1\nz\nx = 1\n")

      const result = yield* run({ filePath: filepath, oldString: "x = 1", newString: "x = 2", replaceAll: true })

      expect(result.output).toContain(
        [
          "Lines 1-1, 3-3, 5-5 changed. Replacements: 3. Additions: 3. Deletions: 3.",
          "@@ -1,5 +1,5 @@",
          "-x = 1",
          "+x = 2",
          " y",
          "-x = 1",
          "+x = 2",
          " z",
          "-x = 1",
          "+x = 2",
        ].join("\n"),
      )
      expect(result.output).not.toContain("fuzzy")
    }),
  )

  it.instance("shows the lines of a CRLF file and of a file with a BOM without their line endings or BOM", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const crlf = path.join(test.directory, "crlf.txt")
      const bom = path.join(test.directory, "bom.txt")
      yield* put(crlf, "a\r\nb\r\nc\r\n")
      yield* put(bom, `${String.fromCharCode(0xfeff)}a\nb\nc\n`)

      const first = yield* run({ filePath: crlf, oldString: "b", newString: "B" })
      const second = yield* run({ filePath: bom, oldString: "b", newString: "B" })

      for (const result of [first, second]) {
        expect(result.output).toContain(
          "Lines 2-2 changed. Replacements: 1. Additions: 1. Deletions: 1.\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c",
        )
        expect(result.output).not.toContain("\r")
        expect(result.output).not.toContain(String.fromCharCode(0xfeff))
      }
      expect(yield* loadRaw(crlf)).toBe("a\r\nB\r\nc\r\n")
    }),
  )

  it.instance("writes a new file without a diff and without a replacement count", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "fresh.txt")

      const result = yield* run({ filePath: filepath, oldString: "", newString: "one\ntwo\nthree\n" })

      expect(result.output).toBe(
        "Edit applied successfully.\n\nLines 1-3 changed. Additions: 3. Deletions: 0.\n\nnot checked: LSP disabled",
      )
    }),
  )

  it.instance("cuts the diff of a large change at 40 lines and says where to read on", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "large.txt")
      yield* put(filepath, lines(100).join("\n") + "\n")
      const old = lines(60).map((_, i) => `line ${i + 21}`)

      const result = yield* run({
        filePath: filepath,
        oldString: old.join("\n"),
        newString: lines(60, "changed").join("\n"),
      })

      const out = result.output.split("\n")
      const diff = out.slice(out.indexOf("@@ -18,66 +18,66 @@"))
      // The header and 39 more lines of the diff, then the sentence; the status line follows after a blank line.
      expect(diff.slice(0, 40)).toHaveLength(40)
      expect(diff[40]).toBe(`[diff cut at 40 of 127 lines; read ${filepath} from line 18 to see the rest.]`)
      expect(diff.slice(41)).toEqual(["", "not checked: LSP disabled"])
      expect(result.output).toContain("Lines 21-80 changed. Replacements: 1. Additions: 60. Deletions: 60.")
    }),
  )

  it.instance(
    "says the formatter rewrote the file, records it, and describes the file as it is on disk",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        yield* put(filepath, "const a = 1\nconst b = 1\n")

        const result = yield* run({ filePath: filepath, oldString: "a = 1", newString: "a = 2" })

        expect(result.output).toBe(
          [
            "Edit applied successfully.",
            "",
            "Lines 1-1, 3-3 changed. Replacements: 1. Additions: 2. Deletions: 1.",
            "File was reformatted by the formatter after this write.",
            "@@ -1,2 +1,3 @@",
            "-const a = 1",
            "+const a = 2",
            " const b = 1",
            "+// formatted line",
            "",
            "not checked: LSP disabled",
          ].join("\n"),
        )
        expect(result.metadata).toMatchObject({ corrections: ["formatted"] })
        const logged = JSON.stringify(yield* logLines)
        expect(logged).toContain("tool call corrected")
        expect(logged).toContain('"tool.name":"edit"')
        expect(logged).toContain('"correction.kind":"formatted"')
      }),
    { config: expand },
  )

  it.instance(
    "says the formatter rewrote a file that the edit created",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "fresh.ts")

        const result = yield* run({ filePath: filepath, oldString: "", newString: "const a = 1\n" })

        expect(result.output).toBe(
          [
            "Edit applied successfully.",
            "",
            "Lines 1-2 changed. Additions: 2. Deletions: 0.",
            "File was reformatted by the formatter after this write.",
            "",
            "not checked: LSP disabled",
          ].join("\n"),
        )
        expect(result.metadata).toMatchObject({ corrections: ["formatted"] })
      }),
    { config: expand },
  )

  it.instance(
    "says nothing about a formatter that ran and left the text alone",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        yield* put(filepath, "const a = 1\n")

        const result = yield* run({ filePath: filepath, oldString: "a = 1", newString: "a = 2" })

        expect(result.output).not.toContain("reformatted")
        expect(result.metadata).not.toHaveProperty("corrections")
        expect(JSON.stringify(yield* logLines)).not.toContain("tool call corrected")
      }),
    { config: untouched },
  )

  it.instance(
    "marks the running call as formatted as soon as the text is on disk, next to a fuzzy match",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "running.ts")
        yield* put(filepath, "  const a = 1\n  const b = 2\n")
        const updates: Array<{ metadata?: Record<string, unknown> }> = []
        const recording: Tool.Context = {
          ...ctx,
          metadata: (update) =>
            Effect.sync(() => {
              updates.push(update)
            }),
        }

        const result = yield* run(
          { filePath: filepath, oldString: "const a = 1\nconst b = 2", newString: "const c = 3" },
          recording,
        )

        // Both marks are on the call before it reports its own diff, and the diff update keeps them.
        expect(updates.map((update) => update.metadata?.corrections)).toEqual([
          ["formatted"],
          ["fuzzy_match", "formatted"],
          ["fuzzy_match", "formatted"],
        ])
        expect(result.metadata).toMatchObject({ corrections: ["fuzzy_match", "formatted"] })
      }),
    { config: expand },
  )

  it.instance("puts the receipt after the note about a file that changed outside the session", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "top = 0\nbottom = 0\n")
      yield* (yield* FileState.Service).record(ctx.sessionID, filepath, "read")
      yield* put(filepath, "top = 0\nbottom = formatted elsewhere\n")

      const result = yield* run({ filePath: filepath, oldString: "top = 0", newString: "top = 1" })

      const out = result.output.split("\n")
      expect(out.slice(0, 4)).toEqual([
        "Edit applied successfully.",
        FileState.changedOutsideNote(result.title),
        "",
        "Lines 1-1 changed. Replacements: 1. Additions: 1. Deletions: 1.",
      ])
      expect(out.slice(-2)).toEqual(["", "not checked: LSP disabled"])
    }),
  )

  itWithLsp.instance("puts the receipt ahead of the status line and the error block", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.ts")
      yield* put(filepath, "const a = 1\n")
      mockedDiagnostics = {
        [FSUtil.normalizePath(filepath)]: [
          { severity: 1, message: "boom", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        ],
      }

      const result = yield* run({ filePath: filepath, oldString: "a = 1", newString: "a: string = 1" })

      expect(result.output.split("\n")).toEqual([
        "Edit applied successfully.",
        "",
        "Lines 1-1 changed. Replacements: 1. Additions: 1. Deletions: 1.",
        "@@ -1,1 +1,1 @@",
        "-const a = 1",
        "+const a: string = 1",
        "",
        "checked: 1 error",
        "",
        "LSP errors detected in this file, please fix:",
        `<diagnostics file="${filepath}">`,
        "ERROR [1:1] boom",
        "</diagnostics>",
      ])
    }),
  )
})

// #1451: a missing oldString says how long the file is, how much of it was looked at, and when oldString carries the
// line numbers of a read result.
describe("tool.edit miss diagnosis (#1451)", () => {
  const first =
    "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings."
  const message = (content: string, oldString: string) => {
    try {
      replace(content, oldString, "replacement")
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error("expected replace to fail")
  }

  test("says how many lines the file has", () => {
    expect(message("a\nb\nc\n", "zzzzzzzz")).toBe(`${first} The file has 3 lines.`)
  })

  test("counts the lines the way read does, without the empty line a final newline leaves", () => {
    expect(message("a\nb\nc", "zzzzzzzz")).toBe(`${first} The file has 3 lines.`)
    expect(message("a\nb\nc\n\n", "zzzzzzzz")).toBe(`${first} The file has 4 lines.`)
    expect(message("", "zzzzzzzz")).toBe(`${first} The file has 0 lines.`)
  })

  test("finds the closest line beyond the first 2000 lines of a file", () => {
    const content = Array.from({ length: 2500 }, (_, i) =>
      i === 2299 ? "const marker = computeMarker(alpha, beta)" : `filler row ${i + 1} of the generated fixture`,
    ).join("\n")

    const error = message(content, "const marker = computeMarker(alpha)")

    expect(error).toContain("The file has 2500 lines.")
    expect(error).toContain("Closest match at line 2300:\n")
    expect(error).toContain("const marker = computeMarker(alpha, beta)")
    expect(error).not.toContain("Only the first")
  })

  test("says how far the comparison got when the work budget runs out", () => {
    const content = Array.from({ length: 4000 }, () => "x".repeat(150)).join("\n")

    const error = message(content, "y".repeat(150))

    expect(error).toContain("The file has 4000 lines.")
    const compared = Number(/ Only the first (\d+) of 4000 lines were compared\./.exec(error)?.[1])
    // Each line costs 120 x 120 cells of a budget of 30 million, so a little over 2000 lines are compared.
    expect(compared).toBeGreaterThan(2000)
    expect(compared).toBeLessThan(2200)
  })

  test("still names the closest line among those it compared when the budget runs out", () => {
    // Line 11 is the one that looks like what is searched for; the rest are as far from it as can be.
    const content = Array.from({ length: 4000 }, (_, i) => (i === 10 ? "y".repeat(140) : "x".repeat(150))).join("\n")

    const error = message(content, "y".repeat(150))

    expect(error).toMatch(/Only the first \d+ of 4000 lines were compared\./)
    expect(error).toContain("Closest match at line 11:")
  })

  test("says nothing about the comparison when it covered the whole file", () => {
    expect(message("alpha\nbeta\n", "zzzzzzzz")).not.toContain("Only the first")
  })

  test("says that oldString carries the line numbers of read, between the first sentence and the closest line", () => {
    const error = message("const a = 1\nconst b = 2\n", "12: const a = 1\n13: const b = 2")

    expect(error.split("\n").slice(0, 3)).toEqual([
      `${first} The file has 2 lines.`,
      'oldString seems to include the "N: " line-number prefixes from read. Remove them and send only the file text.',
      "Closest match at line 1:",
    ])
  })

  test("does not mention line-number prefixes for an ordinary miss", () => {
    expect(message("const a = 1\n", "const totl = 1")).not.toContain("line-number prefixes")
  })

  test("the hint comes even when no line is close enough to suggest", () => {
    const error = message("alpha\n", "12: zzzzzzzzzzzzzzzzzzzzzzzzzzzz")

    expect(error).toBe(
      `${first} The file has 1 lines.\noldString seems to include the "N: " line-number prefixes from read. Remove them and send only the file text.`,
    )
  })

  it.instance("a miss through the tool carries the diagnosis and leaves the file alone", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.ts")
      const original = "const a = 1\nconst b = 2\n"
      yield* put(filepath, original)

      const error = yield* fail({
        filePath: filepath,
        oldString: "12: const a = 1\n13: const b = 2",
        newString: "const c = 3",
      })

      expect(error.message.split("\n").slice(0, 3)).toEqual([
        `${first} The file has 2 lines.`,
        'oldString seems to include the "N: " line-number prefixes from read. Remove them and send only the file text.',
        "Closest match at line 1:",
      ])
      expect(yield* load(filepath)).toBe(original)
    }),
  )
})

describe("looksLikeReadPrefix (#1451)", () => {
  test("is true when every line starts with a line number and a colon", () => {
    expect(looksLikeReadPrefix("12: const a = 1\n13: const b = 2")).toBe(true)
    expect(looksLikeReadPrefix("7: only line")).toBe(true)
  })

  test("allows leading whitespace before the number", () => {
    expect(looksLikeReadPrefix("   7: indented\n   8: also")).toBe(true)
  })

  test("is true when half of the lines that have text start that way, false below half", () => {
    expect(looksLikeReadPrefix("12: foo\nbar")).toBe(true)
    expect(looksLikeReadPrefix("12: foo\nbar\nbaz")).toBe(false)
    expect(looksLikeReadPrefix("12: foo\n13: bar\nbaz")).toBe(true)
  })

  test("does not count blank lines", () => {
    expect(looksLikeReadPrefix("12: foo\n\n13: bar\n  \n")).toBe(true)
    expect(looksLikeReadPrefix("12: foo\n\n\n\nbar\n\nbaz")).toBe(false)
  })

  test("needs at least one line with text", () => {
    expect(looksLikeReadPrefix("")).toBe(false)
    expect(looksLikeReadPrefix("\n  \n\t\n")).toBe(false)
  })

  test("needs the colon and the space that read writes after the number", () => {
    expect(looksLikeReadPrefix("12:foo")).toBe(false)
    expect(looksLikeReadPrefix("foo: bar")).toBe(false)
    expect(looksLikeReadPrefix("version 12: foo")).toBe(false)
    expect(looksLikeReadPrefix("a12: foo")).toBe(false)
  })
})
