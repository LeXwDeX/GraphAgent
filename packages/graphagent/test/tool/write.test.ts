import { afterEach, describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { LSP } from "@/lsp/lsp"
import type { Diagnostic } from "@/lsp/client"
import { FSUtil } from "@graphagent/core/fs-util"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { EngineProcess } from "@/session/engine-process"
import { FileState } from "@/session/file-state"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-write-session"),
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

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    FSUtil.defaultLayer,
    EventV2Bridge.defaultLayer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    FileState.defaultLayer,
  ),
)

let mockedDiagnostics: Record<string, Diagnostic[]> = {}
const itWithDiagnostics = testEffect(
  Layer.mergeAll(
    Layer.mock(LSP.Service, {
      touchFile: () => Effect.sync(() => mockedStatus),
      diagnostics: () => Effect.succeed(mockedDiagnostics),
    }),
    FSUtil.defaultLayer,
    EventV2Bridge.defaultLayer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    FileState.defaultLayer,
  ),
)

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")

// An existing file must have been read in this session before write replaces it.
const markRead = Effect.fn("WriteToolTest.markRead")(function* (filepath: string, sessionID = ctx.sessionID) {
  yield* (yield* FileState.Service).record(sessionID, filepath, "read")
})

const init = Effect.fn("WriteToolTest.init")(function* () {
  const info = yield* WriteTool
  return yield* info.init()
})

const run = Effect.fn("WriteToolTest.run")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("WriteToolTest.fail")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected write to fail")
})

const runEdit = Effect.fn("WriteToolTest.runEdit")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const tool = yield* (yield* EditTool).init()
  return yield* tool.execute(args, ctx)
})

const runPatch = Effect.fn("WriteToolTest.runPatch")(function* (patchText: string) {
  const tool = yield* (yield* ApplyPatchTool).init()
  return yield* tool.execute({ patchText }, ctx)
})

describe("tool.write", () => {
  describe("new file creation", () => {
    it.instance("writes content to new file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, content: "Hello, World!" })

        expect(result.output).toContain("Wrote file successfully")
        expect(result.metadata.exists).toBe(false)

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("Hello, World!")
      }),
    )

    it.instance("creates parent directories if needed", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "deep", "file.txt")
        yield* run({ filePath: filepath, content: "nested content" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("nested content")
      }),
    )

    it.instance("handles relative paths by resolving to instance directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* run({ filePath: "relative.txt", content: "relative content" })

        const content = yield* Effect.promise(() => fs.readFile(path.join(test.directory, "relative.txt"), "utf-8"))
        expect(content).toBe("relative content")
      }),
    )
  })

  describe("existing file overwrite", () => {
    it.instance("overwrites existing file content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "old content", "utf-8"))
        yield* markRead(filepath)
        const result = yield* run({ filePath: filepath, content: "new content" })

        expect(result.output).toContain("Wrote file successfully")
        expect(result.metadata.exists).toBe(true)

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("new content")
      }),
    )

    it.instance("preserves BOM when overwriting existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* Effect.promise(() => fs.writeFile(filepath, `${bom}using System;\n`, "utf-8"))
        yield* markRead(filepath)

        yield* run({ filePath: filepath, content: "using Up;\n" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\n")
      }),
    )

    it.instance(
      "restores BOM after formatter strips it",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const filepath = path.join(test.directory, "formatted.cs")
          const bom = String.fromCharCode(0xfeff)
          yield* Effect.promise(() => fs.writeFile(filepath, `${bom}using System;\n`, "utf-8"))
          yield* markRead(filepath)

          yield* run({ filePath: filepath, content: "using Up;\n" })

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content.charCodeAt(0)).toBe(0xfeff)
          expect(content.slice(1)).toBe("using Up;\n")
        }),
      {
        config: {
          formatter: {
            stripbom: {
              extensions: [".cs"],
              command: [
                "node",
                "-e",
                "const fs = require('fs'); const file = process.argv[1]; let text = fs.readFileSync(file, 'utf8'); if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); fs.writeFileSync(file, text, 'utf8')",
                "$FILE",
              ],
            },
          },
        },
      },
    )

    itWithDiagnostics.instance(
      "keeps diagnostics on lines the formatter moved",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const filepath = path.join(test.directory, "expanded.ts")
          mockedDiagnostics = {
            [FSUtil.normalizePath(filepath)]: [
              {
                severity: 1,
                message: "formatted line error",
                range: { start: { line: 19, character: 0 }, end: { line: 19, character: 1 } },
              },
            ],
          }

          const result = yield* run({ filePath: filepath, content: "const x = 1\n" })

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content.split("\n").length).toBeGreaterThan(20)
          expect(result.output).toContain("ERROR [20:1] formatted line error")
        }),
      {
        config: {
          formatter: {
            expand: {
              extensions: [".ts"],
              command: [
                "node",
                "-e",
                "const fs = require('fs'); const file = process.argv[1]; const text = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, text + '// formatted line\\n'.repeat(30), 'utf8')",
                "$FILE",
              ],
            },
          },
        },
      },
    )

    it.instance("returns diff in metadata for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "old", "utf-8"))
        yield* markRead(filepath)
        const result = yield* run({ filePath: filepath, content: "new" })

        expect(result.metadata).toHaveProperty("filepath", filepath)
        expect(result.metadata).toHaveProperty("exists", true)
      }),
    )
  })

  describe("file permissions", () => {
    it.instance("sets file permissions when writing sensitive data", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "sensitive.json")
        yield* run({ filePath: filepath, content: JSON.stringify({ secret: "data" }) })

        if (process.platform !== "win32") {
          const stats = yield* Effect.promise(() => fs.stat(filepath))
          expect(stats.mode & 0o777).toBe(0o644)
        }
      }),
    )
  })

  describe("content types", () => {
    it.instance("writes JSON content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "data.json")
        const data = { key: "value", nested: { array: [1, 2, 3] } }
        yield* run({ filePath: filepath, content: JSON.stringify(data, null, 2) })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(JSON.parse(content)).toEqual(data)
      }),
    )

    it.instance("writes binary-safe content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "binary.bin")
        const content = "Hello\x00World\x01\x02\x03"
        yield* run({ filePath: filepath, content })

        const buf = yield* Effect.promise(() => fs.readFile(filepath))
        expect(buf.toString()).toBe(content)
      }),
    )

    it.instance("writes empty content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "empty.txt")
        yield* run({ filePath: filepath, content: "" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("")

        const stats = yield* Effect.promise(() => fs.stat(filepath))
        expect(stats.size).toBe(0)
      }),
    )

    it.instance("writes multi-line content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "multiline.txt")
        const lines = ["Line 1", "Line 2", "Line 3", ""].join("\n")
        yield* run({ filePath: filepath, content: lines })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe(lines)
      }),
    )

    it.instance("handles different line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "crlf.txt")
        const content = "Line 1\r\nLine 2\r\nLine 3"
        yield* run({ filePath: filepath, content })

        const buf = yield* Effect.promise(() => fs.readFile(filepath))
        expect(buf.toString()).toBe(content)
      }),
    )
  })

  describe("error handling", () => {
    it.instance("throws error when OS denies write access", () =>
      Effect.gen(function* () {
        if (process.getuid?.() === 0) return // skip when running as root
        const test = yield* TestInstance
        const readonlyPath = path.join(test.directory, "readonly.txt")
        yield* Effect.promise(() => fs.writeFile(readonlyPath, "test", "utf-8"))
        yield* Effect.promise(() => fs.chmod(readonlyPath, 0o444))
        yield* markRead(readonlyPath)
        const exit = yield* run({ filePath: readonlyPath, content: "new content" }).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    )
  })

  describe("title generation", () => {
    it.instance("returns relative path as title", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "src", "components", "Button.tsx")
        yield* Effect.promise(() => fs.mkdir(path.dirname(filepath), { recursive: true }))

        const result = yield* run({ filePath: filepath, content: "export const Button = () => {}" })
        expect(result.title).toEndWith(path.join("src", "components", "Button.tsx"))
      }),
    )
  })
})

describe("tool.write file state (#1452)", () => {
  const recorded = Effect.fn("WriteToolTest.recorded")(function* (filepath: string) {
    return yield* (yield* FileState.Service).get(ctx.sessionID, filepath)
  })

  it.instance("records the written file under the write source", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "recorded.txt")

      yield* run({ filePath: filepath, content: "Hello, World!\n" })

      const entry = yield* recorded(filepath)
      expect(entry?.source).toBe("write")
      expect(entry?.hash).toBe(sha256("Hello, World!\n"))
      expect(entry?.size).toBe(14)
    }),
  )

  it.instance("records nothing for the other sessions", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "recorded.txt")

      yield* run({ filePath: filepath, content: "mine" })

      const state = yield* FileState.Service
      expect(yield* state.get(SessionID.make("ses_test-other-session"), filepath)).toBeUndefined()
    }),
  )

  it.instance(
    "records the disk bytes after the formatter stripped the BOM and it was restored",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "formatted.cs")
        const bom = String.fromCharCode(0xfeff)

        yield* run({ filePath: filepath, content: `${bom}using Up;\n` })

        const onDisk = yield* Effect.promise(() => fs.readFile(filepath))
        expect(onDisk.toString("utf8")).toBe(`${bom}using Up;\n`)
        const entry = yield* recorded(filepath)
        expect(entry?.hash).toBe(sha256(onDisk))
        expect(entry?.size).toBe(onDisk.byteLength)
      }),
    {
      config: {
        formatter: {
          stripbom: {
            extensions: [".cs"],
            command: [
              "node",
              "-e",
              "const fs = require('fs'); const file = process.argv[1]; let text = fs.readFileSync(file, 'utf8'); if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); fs.writeFileSync(file, text, 'utf8')",
              "$FILE",
            ],
          },
        },
      },
    },
  )

  it.instance(
    "records the state the formatter left, not the requested content",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "expanded.ts")

        yield* run({ filePath: filepath, content: "const x = 1\n" })

        const onDisk = yield* Effect.promise(() => fs.readFile(filepath))
        expect(onDisk.toString("utf8")).not.toBe("const x = 1\n")
        const entry = yield* recorded(filepath)
        expect(entry?.hash).toBe(sha256(onDisk))
        expect(entry?.size).toBe(onDisk.byteLength)
      }),
    {
      config: {
        formatter: {
          expand: {
            extensions: [".ts"],
            command: [
              "node",
              "-e",
              "const fs = require('fs'); const file = process.argv[1]; const text = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, text + '// formatted line\\n'.repeat(30), 'utf8')",
              "$FILE",
            ],
          },
        },
      },
    },
  )
})

describe("tool.write overwrite contract (#1452)", () => {
  const readBytes = (filepath: string) => Effect.promise(() => fs.readFile(filepath))
  const put = (filepath: string, content: string | Uint8Array) => Effect.promise(() => fs.writeFile(filepath, content))
  const asked = () => {
    const counter = { count: 0 }
    return { counter, next: { ...ctx, ask: () => Effect.sync(() => void counter.count++) } }
  }

  describe("what an overwrite requires", () => {
    it.instance("rejects replacing an existing file the session has not read", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "precious")
        const { counter, next } = asked()

        const error = yield* fail({ filePath: filepath, content: "clobbered" }, next)

        expect(error.message).toBe(FileState.notReadMessage(filepath))
        expect(error.message).toContain("was not read in this session")
        expect((yield* readBytes(filepath)).toString()).toBe("precious")
        expect(counter.count).toBe(0)
      }),
    )

    it.instance("rejects replacing a file that changed after it was read", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "what the model saw")
        yield* markRead(filepath)
        yield* put(filepath, "what someone else wrote")
        const { counter, next } = asked()

        const error = yield* fail({ filePath: filepath, content: "clobbered" }, next)

        expect(error.message).toBe(FileState.changedSinceReadMessage(filepath))
        expect(error.message).toContain("changed after it was last read")
        expect((yield* readBytes(filepath)).toString()).toBe("what someone else wrote")
        expect(counter.count).toBe(0)
      }),
    )

    it.instance("rejects a file another session read, not this one", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "shared")
        yield* markRead(filepath, SessionID.make("ses_test-other-session"))

        const error = yield* fail({ filePath: filepath, content: "clobbered" })

        expect(error.message).toContain("was not read in this session")
      }),
    )

    it.instance("accepts a file whose mtime moved but whose content did not", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "same bytes")
        yield* markRead(filepath)
        const later = new Date(Date.now() + 60_000)
        yield* Effect.promise(() => fs.utimes(filepath, later, later))

        yield* run({ filePath: filepath, content: "replaced" })

        expect((yield* readBytes(filepath)).toString()).toBe("replaced")
      }),
    )

    it.instance("creating a new file needs no read", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "new", "file.txt")

        yield* run({ filePath: filepath, content: "fresh" })

        expect((yield* readBytes(filepath)).toString()).toBe("fresh")
      }),
    )

    it.instance("rejects a directory target", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const directory = path.join(test.directory, "dir")
        yield* Effect.promise(() => fs.mkdir(directory))
        yield* markRead(directory)

        const error = yield* fail({ filePath: directory, content: "nope" })

        expect(error.message).toBe(`Path is a directory, not a file: ${directory}`)
      }),
    )

    it.instance("rejects an existing file that is not UTF-8 text, even after a read", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "latin1.txt")
        const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x80])
        yield* put(filepath, bytes)
        yield* markRead(filepath)

        const error = yield* fail({ filePath: filepath, content: "text" })

        expect(error.message).toContain("is not valid UTF-8 text")
        expect(yield* readBytes(filepath)).toEqual(bytes)
      }),
    )

    it.instance("rejects an existing file above the size limit before anything else", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "big.txt")
        const size = FileState.MAX_EDITABLE_BYTES + 1
        yield* put(filepath, Buffer.alloc(size, 97))
        const { counter, next } = asked()

        const unread = yield* fail({ filePath: filepath, content: "small" }, next)
        yield* markRead(filepath)
        const read = yield* fail({ filePath: filepath, content: "small" }, next)

        for (const error of [unread, read]) {
          expect(error.message).toBe(FileState.tooLargeMessage(filepath))
          expect(error.message).toContain("10 MiB")
        }
        expect((yield* Effect.promise(() => fs.stat(filepath))).size).toBe(size)
        expect(counter.count).toBe(0)
      }),
    )
  })

  describe("sequences that must keep working", () => {
    it.instance("write, then write again", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "again.txt")

        yield* run({ filePath: filepath, content: "one" })
        yield* run({ filePath: filepath, content: "two" })

        expect((yield* readBytes(filepath)).toString()).toBe("two")
      }),
    )

    it.instance("edit, then write", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "edited.txt")
        yield* put(filepath, "alpha beta\n")

        yield* runEdit({ filePath: filepath, oldString: "alpha", newString: "ALPHA" })
        yield* run({ filePath: filepath, content: "after edit\n" })

        expect((yield* readBytes(filepath)).toString()).toBe("after edit\n")
      }),
    )

    it.instance(
      "edit, then write, when a formatter rewrote the edited file",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const filepath = path.join(test.directory, "formatted.ts")
          yield* put(filepath, "const a = 1\n")

          yield* runEdit({ filePath: filepath, oldString: "a = 1", newString: "a = 2" })
          expect((yield* readBytes(filepath)).toString()).toContain("// formatted line")
          yield* run({ filePath: filepath, content: "const b = 1\n" })

          expect((yield* readBytes(filepath)).toString()).toStartWith("const b = 1\n")
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

    it.instance("apply_patch add, then write", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "patched.txt")

        yield* runPatch("*** Begin Patch\n*** Add File: patched.txt\n+one\n*** End Patch")
        yield* run({ filePath: filepath, content: "two\n" })

        expect((yield* readBytes(filepath)).toString()).toBe("two\n")
      }),
    )
  })

  describe("encoding is kept", () => {
    it.instance("a CRLF file stays CRLF, without doubling the carriage return", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "windows.txt")
        yield* put(filepath, "one\r\ntwo\r\n")
        yield* markRead(filepath)

        yield* run({ filePath: filepath, content: "alpha\nbeta\r\ngamma\n" })

        const text = (yield* readBytes(filepath)).toString()
        expect(text).toBe("alpha\r\nbeta\r\ngamma\r\n")
        expect(text).not.toContain("\r\r\n")
      }),
    )

    it.instance("an LF file does not pick up carriage returns", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "unix.txt")
        yield* put(filepath, "one\ntwo\n")
        yield* markRead(filepath)

        yield* run({ filePath: filepath, content: "alpha\r\nbeta\r\n" })

        expect((yield* readBytes(filepath)).toString()).toBe("alpha\nbeta\n")
      }),
    )

    it.instance("a BOM and CRLF are both kept", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "bom.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}using A;\r\nusing B;\r\n`)
        yield* markRead(filepath)

        yield* run({ filePath: filepath, content: "using C;\nusing D;\n" })

        expect((yield* readBytes(filepath)).toString()).toBe(`${bom}using C;\r\nusing D;\r\n`)
      }),
    )

    it.instance("a new file keeps the content exactly as given", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "mixed.txt")

        yield* run({ filePath: filepath, content: "one\r\ntwo\nthree\r\n" })

        expect((yield* readBytes(filepath)).toString()).toBe("one\r\ntwo\nthree\r\n")
      }),
    )

    it.instance("the permission diff shows the line changes, not every line", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "windows.txt")
        yield* put(filepath, "one\r\ntwo\r\nthree\r\n")
        yield* markRead(filepath)
        const diffs: string[] = []
        const next = {
          ...ctx,
          ask: (request: { metadata?: { diff?: string } }) =>
            Effect.sync(() => void diffs.push(request.metadata?.diff ?? "")),
        }

        yield* run({ filePath: filepath, content: "one\nTWO\nthree\n" }, next)

        expect(diffs).toHaveLength(1)
        expect(diffs[0]).toContain("-two")
        expect(diffs[0]).toContain("+TWO")
        expect(diffs[0]).not.toContain("-one")
        expect(diffs[0]).not.toContain("-three")
      }),
    )
  })
})

describe("tool.write write-point checks (#1452)", () => {
  const rewrite = (filepath: string, content: string) => Effect.promise(() => fs.writeFile(filepath, content))
  const text = (filepath: string) => Effect.promise(() => fs.readFile(filepath, "utf8"))
  /** A context whose permission question runs `action` before it is answered. */
  const askThen = (action: Effect.Effect<void>) => ({ ...ctx, ask: () => action })

  it.instance("does not overwrite a file that was rewritten while the question was open", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "existing.txt")
      yield* rewrite(filepath, "what the model read")
      yield* markRead(filepath)

      const error = yield* fail(
        { filePath: filepath, content: "clobbered" },
        askThen(rewrite(filepath, "what someone wrote meanwhile")),
      )

      expect(error.message).toBe(FileState.changedWhileAskingMessage(filepath))
      expect(error.message).toContain("changed while this call waited for permission")
      expect(yield* text(filepath)).toBe("what someone wrote meanwhile")
    }),
  )

  it.instance("does not recreate a file that was deleted while the question was open", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "existing.txt")
      yield* rewrite(filepath, "what the model read")
      yield* markRead(filepath)

      const error = yield* fail(
        { filePath: filepath, content: "clobbered" },
        askThen(Effect.promise(() => fs.rm(filepath))),
      )

      expect(error.message).toBe(FileState.changedWhileAskingMessage(filepath))
      expect(
        yield* Effect.promise(() =>
          fs.access(filepath).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  )

  it.instance("does not overwrite a new file that someone else created while the question was open", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "fresh.txt")

      const error = yield* fail(
        { filePath: filepath, content: "mine" },
        askThen(rewrite(filepath, "created by someone else")),
      )

      expect(error.message).toBe(FileState.changedWhileAskingMessage(filepath))
      expect(yield* text(filepath)).toBe("created by someone else")
    }),
  )

  it.instance("writes when the file is still what the session read after the question", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "existing.txt")
      yield* rewrite(filepath, "what the model read")
      yield* markRead(filepath)

      yield* run({ filePath: filepath, content: "replaced" }, askThen(Effect.void))

      expect(yield* text(filepath)).toBe("replaced")
    }),
  )

  it.instance("asks for permission without holding the path lock", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "existing.txt")
      yield* rewrite(filepath, "what the model read")
      yield* markRead(filepath)
      const held: number[] = []
      const next = {
        ...ctx,
        ask: () =>
          Effect.gen(function* () {
            held.push(yield* EngineProcess.fileLocks.size)
          }),
      }

      yield* run({ filePath: filepath, content: "replaced" }, next)

      expect(held).toEqual([0])
      expect(yield* EngineProcess.fileLocks.size).toBe(0)
    }),
  )

  it.instance("releases the lock when the write is refused", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "existing.txt")
      yield* rewrite(filepath, "what the model read")
      yield* markRead(filepath)

      yield* fail({ filePath: filepath, content: "clobbered" }, askThen(rewrite(filepath, "changed")))

      expect(yield* EngineProcess.fileLocks.size).toBe(0)
    }),
  )
})

// #1452 review finding: a call's check under the path lock used the session's record, which another call of the
// same session replaces while this call's permission question is open. Each call now keeps its own baseline.
describe("tool.write call-local baseline (#1452)", () => {
  const original = "what the model read\n"
  const text = (filepath: string) => Effect.promise(() => fs.readFile(filepath, "utf8"))
  const sessionRecord = (filepath: string) =>
    Effect.gen(function* () {
      return yield* (yield* FileState.Service).get(ctx.sessionID, filepath)
    })

  // What another call of the same session does to the file while the first write's question is open.
  const others = {
    write: {
      run: (filepath: string) => run({ filePath: filepath, content: "replaced by write\n" }),
      result: "replaced by write\n",
    },
    edit: {
      run: (filepath: string) =>
        runEdit({ filePath: filepath, oldString: "what the model read", newString: "replaced by edit" }),
      result: "replaced by edit\n",
    },
    apply_patch: {
      run: (filepath: string) =>
        runPatch(
          `*** Begin Patch\n*** Update File: ${path.basename(filepath)}\n@@\n-what the model read\n+replaced by apply_patch\n*** End Patch`,
        ),
      result: "replaced by apply_patch\n",
    },
  } as const

  for (const name of ["write", "edit", "apply_patch"] as const) {
    const other = others[name]
    it.instance(
      `refuses an overwrite whose file ${name} of the same session replaced while its question was open`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const filepath = path.join(test.directory, "existing.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, original))
          yield* markRead(filepath)
          const asked = yield* Deferred.make<void>()
          const answer = yield* Deferred.make<void>()
          const waiting = {
            ...ctx,
            ask: () => Deferred.succeed(asked, undefined).pipe(Effect.andThen(Deferred.await(answer))),
          }
          const second = yield* fail({ filePath: filepath, content: "second writer\n" }, waiting).pipe(
            Effect.forkScoped,
          )
          yield* Deferred.await(asked)

          yield* other.run(filepath)
          // The session's record now describes what is on disk: the check that used it would pass.
          yield* (yield* FileState.Service).requireSame(ctx.sessionID, filepath)
          yield* Deferred.succeed(answer, undefined)
          const error = yield* Fiber.join(second)

          expect(error.message).toBe(FileState.changedWhileAskingMessage(filepath))
          expect(yield* text(filepath)).toBe(other.result)
          const recorded = yield* sessionRecord(filepath)
          expect(recorded?.hash).toBe(sha256(other.result))
          expect(recorded?.source).toBe(name)
          expect(yield* EngineProcess.fileLocks.size).toBe(0)
        }),
    )
  }

  it.instance("still overwrites when nothing replaced the file while the question was open", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "existing.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, original))
      yield* markRead(filepath)
      const asked = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<void>()
      const waiting = {
        ...ctx,
        ask: () => Deferred.succeed(asked, undefined).pipe(Effect.andThen(Deferred.await(answer))),
      }
      const second = yield* run({ filePath: filepath, content: "second writer\n" }, waiting).pipe(Effect.forkScoped)
      yield* Deferred.await(asked)

      yield* Deferred.succeed(answer, undefined)
      yield* Fiber.join(second)

      expect(yield* text(filepath)).toBe("second writer\n")
    }),
  )

  it.instance("takes its baseline from the bytes it planned against, not from a later look at the disk", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "existing.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, original))
      yield* markRead(filepath)
      const asked = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<void>()
      const waiting = {
        ...ctx,
        ask: () => Deferred.succeed(asked, undefined).pipe(Effect.andThen(Deferred.await(answer))),
      }
      const second = yield* fail({ filePath: filepath, content: "second writer\n" }, waiting).pipe(Effect.forkScoped)
      yield* Deferred.await(asked)

      // Another process changes the file, and the session reads the new version before the question is answered:
      // the session's record is current again, but this call still holds the old plan.
      yield* Effect.promise(() => fs.writeFile(filepath, "changed elsewhere\n"))
      yield* (yield* FileState.Service).record(ctx.sessionID, filepath, "read")
      yield* Deferred.succeed(answer, undefined)
      const error = yield* Fiber.join(second)

      expect(error.message).toBe(FileState.changedWhileAskingMessage(filepath))
      expect(yield* text(filepath)).toBe("changed elsewhere\n")
    }),
  )
})

// #1451: after a write the result says whether the language server checked the file. A check that did not run is
// not the same as one that found nothing.
describe("tool.write LSP check state (#1451)", () => {
  const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`)
  const diagnostic = (line: number, severity: Diagnostic["severity"] = 1, message = "boom"): Diagnostic => ({
    severity,
    message,
    range: { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 1 } },
  })

  it.instance("says the check did not run when LSP is disabled, which is the default", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const result = yield* run({ filePath: path.join(test.directory, "new.txt"), content: "hello\n" })

      expect(result.output).toBe("Wrote file successfully.\n\nnot checked: LSP disabled")
    }),
  )

  const unchecked: [LSP.Diagnostic.CheckStatus, string][] = [
    ["disabled", "not checked: LSP disabled"],
    ["no_server", "not checked: no language server"],
    ["timed_out", "not checked: timed out"],
  ]
  for (const [status, line] of unchecked) {
    itWithDiagnostics.instance(`words the ${status} status as "${line}"`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        mockedStatus = status
        mockedDiagnostics = {}

        const result = yield* run({ filePath: path.join(test.directory, "new.txt"), content: "hello\n" })

        expect(result.output).toBe(`Wrote file successfully.\n\n${line}`)
      }),
    )
  }

  itWithDiagnostics.instance("does not turn diagnostics left over from before into a verdict when nothing ran", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "stale.ts")
      mockedStatus = "timed_out"
      mockedDiagnostics = { [FSUtil.normalizePath(filepath)]: [diagnostic(1)] }

      const result = yield* run({ filePath: filepath, content: "const x = 1\n" })

      // The block keeps its wording and its condition; the status line says the check did not finish.
      expect(result.output).toBe(
        [
          "Wrote file successfully.",
          "",
          "not checked: timed out",
          "",
          "LSP errors detected in this file, please fix:",
          `<diagnostics file="${filepath}">`,
          "ERROR [1:1] boom",
          "</diagnostics>",
        ].join("\n"),
      )
    }),
  )

  itWithDiagnostics.instance("is clean when the check ran and found nothing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      mockedDiagnostics = {}

      const result = yield* run({ filePath: path.join(test.directory, "new.ts"), content: "const x = 1\n" })

      expect(result.output).toBe("Wrote file successfully.\n\nchecked: clean")
    }),
  )

  itWithDiagnostics.instance("counts an error near the written lines and still reports it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "broken.ts")
      mockedDiagnostics = { [FSUtil.normalizePath(filepath)]: [diagnostic(1)] }

      const result = yield* run({ filePath: filepath, content: "const x: number = 'a'\n" })

      expect(result.output).toBe(
        [
          "Wrote file successfully.",
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

  itWithDiagnostics.instance("counts every error of the written lines", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "broken.ts")
      mockedDiagnostics = { [FSUtil.normalizePath(filepath)]: [diagnostic(1), diagnostic(2, 1, "again")] }

      const result = yield* run({ filePath: filepath, content: "const x: number = 'a'\nconst y: string = 1\n" })

      expect(result.output).toContain("\n\nchecked: 2 errors\n\nLSP errors detected in this file, please fix:\n")
    }),
  )

  itWithDiagnostics.instance("leaves errors elsewhere in the file and warnings out of the count", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "long.ts")
      yield* Effect.promise(() => fs.writeFile(filepath, lines(30).join("\n") + "\n"))
      yield* markRead(filepath)
      // Only line 1 changes. The error on line 25 predates the write; the warning on line 1 is below error severity.
      mockedDiagnostics = { [FSUtil.normalizePath(filepath)]: [diagnostic(25), diagnostic(1, 2, "careful")] }

      const result = yield* run({ filePath: filepath, content: ["changed", ...lines(30).slice(1)].join("\n") + "\n" })

      expect(result.output).toBe("Wrote file successfully.\n\nchecked: clean")
    }),
  )

  itWithDiagnostics.instance(
    "keeps the status line out of the title",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        mockedStatus = "timed_out"

        const result = yield* run({ filePath: path.join(test.directory, "new.txt"), content: "hello\n" })

        expect(result.title).toBe("new.txt")
      }),
    { git: true },
  )
})
