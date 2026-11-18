import { describe, expect } from "bun:test"
import path from "path"
import { createHash } from "node:crypto"
import * as fs from "fs/promises"
import { Cause, Effect, Exit, Layer } from "effect"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { LSP } from "@/lsp/lsp"
import type { Diagnostic } from "@/lsp/client"
import { FSUtil } from "@graphagent/core/fs-util"
import { Format } from "../../src/format"
import { EngineProcess } from "@/session/engine-process"
import { FileState } from "@/session/file-state"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    FSUtil.defaultLayer,
    Format.defaultLayer,
    EventV2Bridge.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    FileState.defaultLayer,
  ),
)

let mockedDiagnostics: Record<string, Diagnostic[]> = {}
const itWithDiagnostics = testEffect(
  Layer.mergeAll(
    Layer.mock(LSP.Service, {
      touchFile: () => Effect.void,
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

const baseCtx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: {
    diff: string
    filepath: string
    files: Array<{
      filePath: string
      relativePath: string
      type: "add" | "update" | "delete" | "move"
      patch: string
      additions: number
      deletions: number
      movePath?: string
    }>
  }
}

type ToolCtx = typeof baseCtx & {
  ask: (input: AskInput) => Effect.Effect<void>
}

const execute = Effect.fn("ApplyPatchToolTest.execute")(function* (params: { patchText: string }, ctx: ToolCtx) {
  const info = yield* ApplyPatchTool
  const tool = yield* info.init()
  return yield* tool.execute(params, ctx)
})

const makeCtx = () => {
  const calls: AskInput[] = []
  const ctx: ToolCtx = {
    ...baseCtx,
    ask: (input) =>
      Effect.sync(() => {
        calls.push(input)
      }),
  }

  return { ctx, calls }
}

// An existing Add File or Move target must have been read in this session before apply_patch replaces it.
const markRead = (filepath: string, sessionID = baseCtx.sessionID) =>
  Effect.gen(function* () {
    yield* (yield* FileState.Service).record(sessionID, filepath, "read")
  })

const readText = (filepath: string) => Effect.promise(() => fs.readFile(filepath, "utf-8"))
const writeText = (filepath: string, content: string) => Effect.promise(() => fs.writeFile(filepath, content, "utf-8"))
const makeDir = (dir: string) => Effect.promise(() => fs.mkdir(dir, { recursive: true }))

const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, message?: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && message) expect(Cause.pretty(exit.cause)).toContain(message)
  })

const expectReadFailure = (filepath: string) => expectFailure(readText(filepath))

describe("tool.apply_patch freeform", () => {
  it.live("requires patchText", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "" }, ctx), "patchText is required")
    }),
  )

  it.live("rejects invalid patch format", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "invalid patch" }, ctx), "apply_patch verification failed")
    }),
  )

  it.live("rejects empty patch", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "*** Begin Patch\n*** End Patch" }, ctx), "patch rejected: empty patch")
    }),
  )

  it.instance(
    "applies add/update/delete in one patch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { ctx, calls } = makeCtx()
        const modifyPath = path.join(test.directory, "modify.txt")
        const deletePath = path.join(test.directory, "delete.txt")
        yield* writeText(modifyPath, "line1\nline2\n")
        yield* writeText(deletePath, "obsolete\n")

        const patchText =
          "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Delete File: delete.txt\n*** Update File: modify.txt\n@@\n-line2\n+changed\n*** End Patch"

        const result = yield* execute({ patchText }, ctx)

        expect(result.title).toContain("Success. Updated the following files")
        expect(result.output).toContain("Success. Updated the following files")
        // Strict formatting assertions for slashes
        expect(result.output).toMatch(/A nested\/new\.txt/)
        expect(result.output).toMatch(/D delete\.txt/)
        expect(result.output).toMatch(/M modify\.txt/)
        if (process.platform === "win32") {
          expect(result.output).not.toContain("\\")
        }
        expect(result.metadata.diff).toContain("Index:")
        expect(calls.length).toBe(1)

        // Verify permission metadata includes files array for UI rendering
        const permissionCall = calls[0]
        expect(permissionCall.metadata.files).toHaveLength(3)
        expect(permissionCall.metadata.files.map((f) => f.type).sort()).toEqual(["add", "delete", "update"])

        const addFile = permissionCall.metadata.files.find((f) => f.type === "add")
        expect(addFile?.relativePath).toBe("nested/new.txt")
        expect(addFile?.patch).toContain("+created")

        const updateFile = permissionCall.metadata.files.find((f) => f.type === "update")
        expect(updateFile?.patch).toContain("-line2")
        expect(updateFile?.patch).toContain("+changed")

        expect(yield* readText(path.join(test.directory, "nested", "new.txt"))).toBe("created\n")
        expect(yield* readText(modifyPath)).toBe("line1\nchanged\n")
        yield* expectReadFailure(deletePath)
      }),
    { git: true },
  )

  it.instance(
    "permission metadata includes move file info",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { ctx, calls } = makeCtx()
        const original = path.join(test.directory, "old", "name.txt")
        yield* makeDir(path.dirname(original))
        yield* writeText(original, "old content\n")

        const patchText =
          "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch"

        yield* execute({ patchText }, ctx)

        expect(calls.length).toBe(1)
        const permissionCall = calls[0]
        expect(permissionCall.metadata.files).toHaveLength(1)

        const moveFile = permissionCall.metadata.files[0]
        expect(moveFile.type).toBe("move")
        expect(moveFile.relativePath).toBe("renamed/dir/name.txt")
        expect(moveFile.movePath).toBe(path.join(test.directory, "renamed/dir/name.txt"))
        expect(moveFile.patch).toContain("-old content")
        expect(moveFile.patch).toContain("+new content")
      }),
    { git: true },
  )

  it.instance("applies multiple hunks to one file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "multi.txt")
      yield* writeText(target, "line1\nline2\nline3\nline4\n")

      const patchText =
        "*** Begin Patch\n*** Update File: multi.txt\n@@\n-line2\n+changed2\n@@\n-line4\n+changed4\n*** End Patch"

      yield* execute({ patchText }, ctx)

      expect(yield* readText(target)).toBe("line1\nchanged2\nline3\nchanged4\n")
    }),
  )

  it.instance("does not invent a first-line diff for BOM files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      const bom = String.fromCharCode(0xfeff)
      const target = path.join(test.directory, "example.cs")
      yield* writeText(target, `${bom}using System;\n\nclass Test {}\n`)

      const patchText =
        "*** Begin Patch\n*** Update File: example.cs\n@@\n class Test {}\n+class Next {}\n*** End Patch"

      yield* execute({ patchText }, ctx)

      expect(calls.length).toBe(1)
      const shown = calls[0].metadata.files[0]?.patch ?? ""
      expect(shown).not.toContain(bom)
      expect(shown).not.toContain("-using System;")
      expect(shown).not.toContain("+using System;")

      const content = yield* readText(target)
      expect(content.charCodeAt(0)).toBe(0xfeff)
      expect(content.slice(1)).toBe("using System;\n\nclass Test {}\nclass Next {}\n")
    }),
  )

  itWithDiagnostics.instance(
    "keeps diagnostics on lines the formatter moved",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { ctx } = makeCtx()
        const target = path.join(test.directory, "expanded.txt")
        yield* writeText(target, "alpha\n")
        mockedDiagnostics = {
          [FSUtil.normalizePath(target)]: [
            {
              severity: 1,
              message: "formatted line error",
              range: { start: { line: 19, character: 0 }, end: { line: 19, character: 1 } },
            },
          ],
        }
        const patchText = "*** Begin Patch\n*** Update File: expanded.txt\n@@\n-alpha\n+beta\n*** End Patch"

        const result = yield* execute({ patchText }, ctx)

        const content = yield* readText(target)
        expect(content.split("\n").length).toBeGreaterThan(20)
        expect(result.output).toContain("ERROR [20:1] formatted line error")
      }),
    {
      config: {
        formatter: {
          expand: {
            extensions: [".txt"],
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

  it.instance("inserts lines with insert-only hunk", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "insert_only.txt")
      yield* writeText(target, "alpha\nomega\n")

      const patchText = "*** Begin Patch\n*** Update File: insert_only.txt\n@@\n alpha\n+beta\n omega\n*** End Patch"

      yield* execute({ patchText }, ctx)

      expect(yield* readText(target)).toBe("alpha\nbeta\nomega\n")
    }),
  )

  it.instance("appends trailing newline on update", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "no_newline.txt")
      yield* writeText(target, "no newline at end")

      const patchText =
        "*** Begin Patch\n*** Update File: no_newline.txt\n@@\n-no newline at end\n+first line\n+second line\n*** End Patch"

      yield* execute({ patchText }, ctx)

      const contents = yield* readText(target)
      expect(contents.endsWith("\n")).toBe(true)
      expect(contents).toBe("first line\nsecond line\n")
    }),
  )

  it.instance("moves file to a new directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const original = path.join(test.directory, "old", "name.txt")
      yield* makeDir(path.dirname(original))
      yield* writeText(original, "old content\n")

      const patchText =
        "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch"

      yield* execute({ patchText }, ctx)

      const moved = path.join(test.directory, "renamed", "dir", "name.txt")
      yield* expectReadFailure(original)
      expect(yield* readText(moved)).toBe("new content\n")
    }),
  )

  it.instance("refuses to update a non-UTF-8 file and leaves its bytes intact", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "gbk.txt")
      // "你好\nA\n" encoded as GBK.
      const original = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0x41, 0x0a])
      yield* Effect.promise(() => fs.writeFile(target, original))

      yield* expectFailure(
        execute({ patchText: "*** Begin Patch\n*** Update File: gbk.txt\n@@\n-A\n+B\n*** End Patch" }, ctx),
        "not valid UTF-8",
      )
      expect(Buffer.compare(yield* Effect.promise(() => fs.readFile(target)), original)).toBe(0)
    }),
  )

  it.instance("move onto the same path updates in place instead of deleting", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const original = path.join(test.directory, "same.txt")
      yield* writeText(original, "old content\n")

      const patchText =
        "*** Begin Patch\n*** Update File: same.txt\n*** Move to: ./same.txt\n@@\n-old content\n+new content\n*** End Patch"

      yield* execute({ patchText }, ctx)

      expect(yield* readText(original)).toBe("new content\n")
    }),
  )

  it.instance("moves file overwriting existing destination", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const original = path.join(test.directory, "old", "name.txt")
      const destination = path.join(test.directory, "renamed", "dir", "name.txt")
      yield* makeDir(path.dirname(original))
      yield* makeDir(path.dirname(destination))
      yield* writeText(original, "from\n")
      yield* writeText(destination, "existing\n")
      yield* markRead(destination)

      const patchText =
        "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-from\n+new\n*** End Patch"

      yield* execute({ patchText }, ctx)

      yield* expectReadFailure(original)
      expect(yield* readText(destination)).toBe("new\n")
    }),
  )

  it.instance("adds file overwriting existing file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "duplicate.txt")
      yield* writeText(target, "old content\n")
      yield* markRead(target)

      const patchText = "*** Begin Patch\n*** Add File: duplicate.txt\n+new content\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("new content\n")
    }),
  )

  it.instance("rejects update when target file is missing", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const patchText = "*** Begin Patch\n*** Update File: missing.txt\n@@\n-nope\n+better\n*** End Patch"

      yield* expectFailure(
        execute({ patchText }, ctx),
        "apply_patch verification failed: Failed to read file to update",
      )
      yield* expectFailure(execute({ patchText }, ctx), "missing.txt. Check the path with glob.")
    }),
  )

  it.instance("reports a stat failure other than a missing file instead of a failed read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      yield* writeText(path.join(test.directory, "regular.txt"), "content\n")
      // A regular file in the middle of the path makes stat fail with ENOTDIR, not NotFound.
      const patchText = "*** Begin Patch\n*** Update File: regular.txt/child.txt\n@@\n-nope\n+better\n*** End Patch"

      const exit = yield* Effect.exit(execute({ patchText }, ctx))
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const text = Cause.pretty(exit.cause)
      expect(text).toContain("ENOTDIR")
      expect(text).not.toContain("Failed to read file to update")
      expect(text).not.toContain("Check the path with glob")
    }),
  )

  it.instance("rejects delete when file is missing", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const patchText = "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
    }),
  )

  it.instance("rejects delete when target is a directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const dirPath = path.join(test.directory, "dir")
      yield* makeDir(dirPath)

      const patchText = "*** Begin Patch\n*** Delete File: dir\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
    }),
  )

  it.instance("rejects invalid hunk header", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const patchText = "*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), "apply_patch verification failed")
    }),
  )

  it.instance("rejects update with missing context", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "modify.txt")
      yield* writeText(target, "line1\nline2\n")

      const patchText = "*** Begin Patch\n*** Update File: modify.txt\n@@\n-missing\n+changed\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), "apply_patch verification failed")
      expect(yield* readText(target)).toBe("line1\nline2\n")
    }),
  )

  it.instance("verification failure leaves no side effects", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const patchText =
        "*** Begin Patch\n*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
      yield* expectReadFailure(path.join(test.directory, "created.txt"))
    }),
  )

  it.instance("supports end of file anchor", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "tail.txt")
      yield* writeText(target, "alpha\nlast\n")

      const patchText = "*** Begin Patch\n*** Update File: tail.txt\n@@\n-last\n+end\n*** End of File\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("alpha\nend\n")
    }),
  )

  it.instance("rejects missing second chunk context", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "two_chunks.txt")
      yield* writeText(target, "a\nb\nc\nd\n")

      const patchText = "*** Begin Patch\n*** Update File: two_chunks.txt\n@@\n-b\n+B\n\n-d\n+D\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
      expect(yield* readText(target)).toBe("a\nb\nc\nd\n")
    }),
  )

  it.instance("disambiguates change context with @@ header", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "multi_ctx.txt")
      yield* writeText(target, "fn a\nx=10\ny=2\nfn b\nx=10\ny=20\n")

      const patchText = "*** Begin Patch\n*** Update File: multi_ctx.txt\n@@ fn b\n-x=10\n+x=11\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("fn a\nx=10\ny=2\nfn b\nx=11\ny=20\n")
    }),
  )

  it.instance("EOF anchor matches from end of file first", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "eof_anchor.txt")
      // File has duplicate "marker" lines - one in middle, one at end
      yield* writeText(target, "start\nmarker\nmiddle\nmarker\nend\n")

      // With EOF anchor, should match the LAST "marker" line, not the first
      const patchText =
        "*** Begin Patch\n*** Update File: eof_anchor.txt\n@@\n-marker\n-end\n+marker-changed\n+end\n*** End of File\n*** End Patch"

      yield* execute({ patchText }, ctx)
      // First marker unchanged, second marker changed
      expect(yield* readText(target)).toBe("start\nmarker\nmiddle\nmarker-changed\nend\n")
    }),
  )

  it.instance("parses heredoc-wrapped patch", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const patchText = `cat <<'EOF'
*** Begin Patch
*** Add File: heredoc_test.txt
+heredoc content
*** End Patch
EOF`

      yield* execute({ patchText }, ctx)
      expect(yield* readText(path.join(test.directory, "heredoc_test.txt"))).toBe("heredoc content\n")
    }),
  )

  it.instance("parses heredoc-wrapped patch without cat", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const patchText = `<<EOF
*** Begin Patch
*** Add File: heredoc_no_cat.txt
+no cat prefix
*** End Patch
EOF`

      yield* execute({ patchText }, ctx)
      expect(yield* readText(path.join(test.directory, "heredoc_no_cat.txt"))).toBe("no cat prefix\n")
    }),
  )

  it.instance("matches with trailing whitespace differences", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "trailing_ws.txt")
      // File has trailing spaces on some lines
      yield* writeText(target, "line1  \nline2\nline3   \n")

      // Patch doesn't have trailing spaces - should still match via rstrip pass
      const patchText = "*** Begin Patch\n*** Update File: trailing_ws.txt\n@@\n-line2\n+changed\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("line1  \nchanged\nline3   \n")
    }),
  )

  it.instance("matches with leading whitespace differences", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "leading_ws.txt")
      // File has leading spaces
      yield* writeText(target, "  line1\nline2\n  line3\n")

      // Patch without leading spaces - should match via trim pass
      const patchText = "*** Begin Patch\n*** Update File: leading_ws.txt\n@@\n-line2\n+changed\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("  line1\nchanged\n  line3\n")
    }),
  )

  it.instance("matches with Unicode punctuation differences", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "unicode.txt")
      // File has fancy Unicode quotes (U+201C, U+201D) and em-dash (U+2014)
      const leftQuote = "\u201C"
      const rightQuote = "\u201D"
      const emDash = "\u2014"
      yield* writeText(target, `He said ${leftQuote}hello${rightQuote}\nsome${emDash}dash\nend\n`)

      // Patch uses ASCII equivalents - should match via normalized pass
      // The replacement uses ASCII quotes from the patch (not preserving Unicode)
      const patchText =
        '*** Begin Patch\n*** Update File: unicode.txt\n@@\n-He said "hello"\n+He said "hi"\n*** End Patch'

      yield* execute({ patchText }, ctx)
      // Result has ASCII quotes because that's what the patch specifies
      expect(yield* readText(target)).toBe(`He said "hi"\nsome${emDash}dash\nend\n`)
    }),
  )
})

describe("tool.apply_patch diagnostics", () => {
  let active = 0
  let peak = 0
  const touched: string[] = []
  const slowLsp = Layer.succeed(
    LSP.Service,
    LSP.Service.of({
      init: () => Effect.void,
      status: () => Effect.succeed([]),
      hasClients: () => Effect.succeed(false),
      touchFile: (file) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            active++
            peak = Math.max(peak, active)
          }),
          () => Effect.sleep("50 millis").pipe(Effect.andThen(Effect.sync(() => touched.push(file)))),
          () => Effect.sync(() => active--),
        ),
      diagnostics: () => Effect.succeed({}),
      hover: () => Effect.succeed(undefined),
      definition: () => Effect.succeed([]),
      references: () => Effect.succeed([]),
      implementation: () => Effect.succeed([]),
      documentSymbol: () => Effect.succeed([]),
      workspaceSymbol: () => Effect.succeed([]),
      prepareCallHierarchy: () => Effect.succeed([]),
      incomingCalls: () => Effect.succeed([]),
      outgoingCalls: () => Effect.succeed([]),
    }),
  )
  const slow = testEffect(
    Layer.mergeAll(
      slowLsp,
      FSUtil.defaultLayer,
      Format.defaultLayer,
      EventV2Bridge.defaultLayer,
      Truncate.defaultLayer,
      Agent.defaultLayer,
      FileState.defaultLayer,
    ),
  )

  slow.instance(
    "waits for every edited file's diagnostics concurrently",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { ctx } = makeCtx()
        const names = ["a.txt", "b.txt", "c.txt", "d.txt"]
        yield* writeText(path.join(test.directory, "gone.txt"), "gone\n")
        const patchText = [
          "*** Begin Patch",
          ...names.flatMap((name) => [`*** Add File: ${name}`, `+${name}`]),
          "*** Delete File: gone.txt",
          "*** End Patch",
        ].join("\n")

        yield* execute({ patchText }, ctx)

        expect(touched.map((file) => path.basename(file)).sort()).toEqual(names)
        expect(peak).toBeGreaterThan(1)
      }),
    { git: true },
  )
})

describe("tool.apply_patch file state (#1452)", () => {
  const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")
  const recorded = Effect.fn("ApplyPatchToolTest.recorded")(function* (filepath: string) {
    return yield* (yield* FileState.Service).get(baseCtx.sessionID, filepath)
  })

  it.instance("records an added file under the apply_patch source", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()

      yield* execute({ patchText: "*** Begin Patch\n*** Add File: added.txt\n+fresh\n*** End Patch" }, ctx)

      const entry = yield* recorded(path.join(test.directory, "added.txt"))
      expect(entry?.source).toBe("apply_patch")
      expect(entry?.hash).toBe(sha256("fresh\n"))
      expect(entry?.size).toBe(6)
    }),
  )

  it.instance("records an updated file with the bytes it ended up with", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "update.txt")
      const bom = String.fromCharCode(0xfeff)
      yield* writeText(target, `${bom}one\ntwo\n`)

      yield* execute({ patchText: "*** Begin Patch\n*** Update File: update.txt\n@@\n-one\n+uno\n*** End Patch" }, ctx)

      const onDisk = yield* Effect.promise(() => fs.readFile(target))
      expect(onDisk.toString("utf8")).toBe(`${bom}uno\ntwo\n`)
      const entry = yield* recorded(target)
      expect(entry?.source).toBe("apply_patch")
      expect(entry?.hash).toBe(sha256(onDisk))
    }),
  )

  it.instance("records the destination of a move and not the removed source", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const source = path.join(test.directory, "from.txt")
      const destination = path.join(test.directory, "moved", "to.txt")
      yield* writeText(source, "keep\nold\n")

      yield* execute(
        {
          patchText:
            "*** Begin Patch\n*** Update File: from.txt\n*** Move to: moved/to.txt\n@@\n keep\n-old\n+new\n*** End Patch",
        },
        ctx,
      )

      expect((yield* recorded(destination))?.hash).toBe(sha256("keep\nnew\n"))
      expect(yield* recorded(source)).toBeUndefined()
    }),
  )

  it.instance("does not record a deleted file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "gone.txt")
      yield* writeText(target, "bye\n")

      yield* execute({ patchText: "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch" }, ctx)

      expect(yield* recorded(target)).toBeUndefined()
    }),
  )

  it.instance(
    "records the state the formatter left for every edited file",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { ctx } = makeCtx()
        const existing = path.join(test.directory, "existing.ts")
        yield* writeText(existing, "const a = 1\n")

        yield* execute(
          {
            patchText:
              "*** Begin Patch\n*** Add File: added.ts\n+const b = 1\n*** Update File: existing.ts\n@@\n-const a = 1\n+const a = 2\n*** End Patch",
          },
          ctx,
        )

        for (const filepath of [existing, path.join(test.directory, "added.ts")]) {
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
})

describe("tool.apply_patch overwrite contract (#1452)", () => {
  const prefix = "apply_patch verification failed: "
  const asks = () => {
    const { ctx, calls } = makeCtx()
    return { ctx, calls }
  }

  it.instance("Add File over an existing file the session has not read is rejected before anything is written", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = asks()
      const target = path.join(test.directory, "duplicate.txt")
      const bystander = path.join(test.directory, "bystander.txt")
      yield* writeText(target, "old content\n")
      yield* writeText(bystander, "before\n")

      yield* expectFailure(
        execute(
          {
            patchText:
              "*** Begin Patch\n*** Update File: bystander.txt\n@@\n-before\n+after\n*** Add File: duplicate.txt\n+new content\n*** End Patch",
          },
          ctx,
        ),
        `${prefix}${FileState.notReadMessage(target)}`,
      )

      expect(yield* readText(target)).toBe("old content\n")
      expect(yield* readText(bystander)).toBe("before\n")
      expect(calls).toHaveLength(0)
    }),
  )

  it.instance("Add File over an existing file succeeds once the session has read it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = asks()
      const target = path.join(test.directory, "duplicate.txt")
      yield* writeText(target, "old content\n")
      yield* markRead(target)

      yield* execute({ patchText: "*** Begin Patch\n*** Add File: duplicate.txt\n+new content\n*** End Patch" }, ctx)

      expect(yield* readText(target)).toBe("new content\n")
    }),
  )

  it.instance("Add File over a file that changed after it was read is rejected", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = asks()
      const target = path.join(test.directory, "duplicate.txt")
      yield* writeText(target, "what the model saw\n")
      yield* markRead(target)
      yield* writeText(target, "what someone else wrote\n")

      yield* expectFailure(
        execute({ patchText: "*** Begin Patch\n*** Add File: duplicate.txt\n+new content\n*** End Patch" }, ctx),
        `${prefix}${FileState.changedSinceReadMessage(target)}`,
      )

      expect(yield* readText(target)).toBe("what someone else wrote\n")
    }),
  )

  it.instance("Add File over a directory is rejected", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = asks()
      const directory = path.join(test.directory, "dir")
      yield* makeDir(directory)

      yield* expectFailure(
        execute({ patchText: "*** Begin Patch\n*** Add File: dir\n+x\n*** End Patch" }, ctx),
        `${prefix}Path is a directory, not a file: ${directory}`,
      )
    }),
  )

  it.instance("Move onto an existing destination the session has not read is rejected, and nothing moves", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = asks()
      const source = path.join(test.directory, "from.txt")
      const destination = path.join(test.directory, "to.txt")
      yield* writeText(source, "from\n")
      yield* writeText(destination, "existing\n")

      yield* expectFailure(
        execute(
          {
            patchText:
              "*** Begin Patch\n*** Update File: from.txt\n*** Move to: to.txt\n@@\n-from\n+new\n*** End Patch",
          },
          ctx,
        ),
        `${prefix}${FileState.notReadMessage(destination)}`,
      )

      expect(yield* readText(source)).toBe("from\n")
      expect(yield* readText(destination)).toBe("existing\n")
      expect(calls).toHaveLength(0)
    }),
  )

  it.instance("Move onto an existing destination succeeds once the session has read it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = asks()
      const source = path.join(test.directory, "from.txt")
      const destination = path.join(test.directory, "to.txt")
      yield* writeText(source, "from\n")
      yield* writeText(destination, "existing\n")
      yield* markRead(destination)

      yield* execute(
        {
          patchText: "*** Begin Patch\n*** Update File: from.txt\n*** Move to: to.txt\n@@\n-from\n+new\n*** End Patch",
        },
        ctx,
      )

      yield* expectReadFailure(source)
      expect(yield* readText(destination)).toBe("new\n")
    }),
  )

  it.instance("Move to a destination that does not exist needs no read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = asks()
      const source = path.join(test.directory, "from.txt")
      yield* writeText(source, "from\n")

      yield* execute(
        {
          patchText:
            "*** Begin Patch\n*** Update File: from.txt\n*** Move to: moved/to.txt\n@@\n-from\n+new\n*** End Patch",
        },
        ctx,
      )

      expect(yield* readText(path.join(test.directory, "moved", "to.txt"))).toBe("new\n")
    }),
  )

  it.instance("Update File and a new Add File need no prior read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = asks()
      const target = path.join(test.directory, "modify.txt")
      yield* writeText(target, "line1\nline2\n")

      yield* execute(
        {
          patchText:
            "*** Begin Patch\n*** Update File: modify.txt\n@@\n-line2\n+changed\n*** Add File: made.txt\n+made\n*** End Patch",
        },
        ctx,
      )

      expect(yield* readText(target)).toBe("line1\nchanged\n")
      expect(yield* readText(path.join(test.directory, "made.txt"))).toBe("made\n")
    }),
  )

  it.instance("an Update File above 10 MiB is not limited", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = asks()
      const target = path.join(test.directory, "big.txt")
      const body = "x".repeat(FileState.MAX_EDITABLE_BYTES + 16)
      yield* writeText(target, `head\n${body}\ntail\n`)

      yield* execute({ patchText: "*** Begin Patch\n*** Update File: big.txt\n@@\n-head\n+HEAD\n*** End Patch" }, ctx)

      expect(yield* readText(target)).toBe(`HEAD\n${body}\ntail\n`)
    }),
  )
})

describe("tool.apply_patch malformed lines (#1452 B3)", () => {
  it.instance("a hunk line without a prefix fails the call and leaves the file alone", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      const target = path.join(test.directory, "modify.txt")
      yield* writeText(target, "keep\nold\n")

      const patchText = "*** Begin Patch\n*** Update File: modify.txt\n@@\n keep\noops\n-old\n+new\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), 'malformed line 5 in the hunk for modify.txt: "oops"')
      expect(yield* readText(target)).toBe("keep\nold\n")
      expect(calls).toHaveLength(0)
    }),
  )

  it.instance("a line before the first @@ fails the call", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "modify.txt")
      yield* writeText(target, "old\n")

      const patchText = "*** Begin Patch\n*** Update File: modify.txt\n-old\n+new\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), 'malformed line 3 in the update for modify.txt: "-old"')
      expect(yield* readText(target)).toBe("old\n")
    }),
  )

  it.instance("an Add File line without + fails the call and creates nothing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()

      const patchText = "*** Begin Patch\n*** Add File: made.txt\n+one\ntwo\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), 'malformed line 4 in the added file made.txt: "two"')
      yield* expectReadFailure(path.join(test.directory, "made.txt"))
    }),
  )

  it.instance("blank lines between hunk lines keep their old meaning", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "gap.txt")
      yield* writeText(target, "a\nb\nc\n")

      const patchText = "*** Begin Patch\n*** Update File: gap.txt\n@@\n a\n\n-b\n+B\n\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("a\nB\nc\n")
    }),
  )
})

describe("tool.apply_patch write-point checks (#1452)", () => {
  const prefix = "apply_patch verification failed: "
  const rewrite = (filepath: string, content: string) => writeText(filepath, content)
  /** A context whose permission question runs `action` before it is answered. */
  const askThen = (action: Effect.Effect<void>): ToolCtx => ({ ...baseCtx, ask: () => action })
  const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n")

  describe("a source that changed after the last read", () => {
    it.instance(
      "is patched as it is now, with a note after the summary line",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const { ctx } = makeCtx()
          const target = path.join(test.directory, "update.txt")
          yield* writeText(target, "one\ntwo\n")
          yield* markRead(target)
          yield* writeText(target, "one\ntwo\nadded elsewhere\n")

          const result = yield* execute({ patchText: patch("*** Update File: update.txt", "@@", "-one", "+uno") }, ctx)

          expect(yield* readText(target)).toBe("uno\ntwo\nadded elsewhere\n")
          expect(result.output.split("\n").slice(0, 3)).toEqual([
            "Success. Updated the following files:",
            "M update.txt",
            FileState.changedOutsideNote("update.txt"),
          ])
        }),
      { git: true },
    )

    it.instance(
      "is named by its destination in the note when the patch moves it",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const { ctx } = makeCtx()
          const source = path.join(test.directory, "from.txt")
          yield* writeText(source, "keep\nold\n")
          yield* markRead(source)
          yield* writeText(source, "keep\nold\nadded elsewhere\n")

          const result = yield* execute(
            {
              patchText: patch("*** Update File: from.txt", "*** Move to: moved/to.txt", "@@", " keep", "-old", "+new"),
            },
            ctx,
          )

          expect(yield* readText(path.join(test.directory, "moved", "to.txt"))).toBe("keep\nnew\nadded elsewhere\n")
          expect(result.output.split("\n").slice(0, 3)).toEqual([
            "Success. Updated the following files:",
            "M moved/to.txt",
            FileState.changedOutsideNote("moved/to.txt"),
          ])
        }),
      { git: true },
    )

    it.instance(
      "gets one note per changed file, after all the summary lines",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const { ctx } = makeCtx()
          const changed = path.join(test.directory, "changed.txt")
          const same = path.join(test.directory, "same.txt")
          yield* writeText(changed, "a\n")
          yield* writeText(same, "b\n")
          yield* markRead(changed)
          yield* markRead(same)
          yield* writeText(changed, "a\nx\n")

          const result = yield* execute(
            {
              patchText: patch(
                "*** Update File: changed.txt",
                "@@",
                "-a",
                "+A",
                "*** Update File: same.txt",
                "@@",
                "-b",
                "+B",
              ),
            },
            ctx,
          )

          expect(result.output.split("\n")).toEqual([
            "Success. Updated the following files:",
            "M changed.txt",
            "M same.txt",
            FileState.changedOutsideNote("changed.txt"),
          ])
        }),
      { git: true },
    )

    it.instance(
      "gets no note when the session never read it, or after its own earlier patch",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const { ctx } = makeCtx()
          const target = path.join(test.directory, "update.txt")
          yield* writeText(target, "one\ntwo\nthree\n")

          const first = yield* execute({ patchText: patch("*** Update File: update.txt", "@@", "-one", "+uno") }, ctx)
          const second = yield* execute({ patchText: patch("*** Update File: update.txt", "@@", "-two", "+dos") }, ctx)

          expect(first.output).toBe("Success. Updated the following files:\nM update.txt")
          expect(second.output).toBe("Success. Updated the following files:\nM update.txt")
        }),
      { git: true },
    )
  })

  describe("a file that changed while the question was open", () => {
    it.instance("fails an Update on a changed source and writes none of the other files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const source = path.join(test.directory, "source.txt")
        const other = path.join(test.directory, "other.txt")
        yield* writeText(source, "one\n")
        yield* writeText(other, "before\n")

        yield* expectFailure(
          execute(
            {
              patchText: patch(
                "*** Update File: other.txt",
                "@@",
                "-before",
                "+after",
                "*** Update File: source.txt",
                "@@",
                "-one",
                "+uno",
                "*** Add File: made.txt",
                "+made",
              ),
            },
            askThen(rewrite(source, "one, edited elsewhere\n")),
          ),
          `${prefix}${FileState.changedWhileAskingMessage(source)}`,
        )

        expect(yield* readText(source)).toBe("one, edited elsewhere\n")
        expect(yield* readText(other)).toBe("before\n")
        yield* expectReadFailure(path.join(test.directory, "made.txt"))
      }),
    )

    it.instance("fails an Add File over a file that changed, and one over a file that appeared", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const existing = path.join(test.directory, "existing.txt")
        const appearing = path.join(test.directory, "appearing.txt")
        const bystander = path.join(test.directory, "bystander.txt")
        yield* writeText(existing, "what the model read\n")
        yield* writeText(bystander, "before\n")
        yield* markRead(existing)

        yield* expectFailure(
          execute(
            {
              patchText: patch(
                "*** Update File: bystander.txt",
                "@@",
                "-before",
                "+after",
                "*** Add File: existing.txt",
                "+clobbered",
              ),
            },
            askThen(rewrite(existing, "someone else\n")),
          ),
          `${prefix}${FileState.changedWhileAskingMessage(existing)}`,
        )
        yield* expectFailure(
          execute(
            { patchText: patch("*** Add File: appearing.txt", "+mine") },
            askThen(rewrite(appearing, "created elsewhere\n")),
          ),
          `${prefix}${FileState.changedWhileAskingMessage(appearing)}`,
        )

        expect(yield* readText(existing)).toBe("someone else\n")
        expect(yield* readText(appearing)).toBe("created elsewhere\n")
        expect(yield* readText(bystander)).toBe("before\n")
      }),
    )

    it.instance("fails a Delete of a file that changed, and a file that vanished", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const changed = path.join(test.directory, "changed.txt")
        const vanishing = path.join(test.directory, "vanishing.txt")
        yield* writeText(changed, "what the model saw\n")
        yield* writeText(vanishing, "soon gone\n")

        yield* expectFailure(
          execute(
            { patchText: patch("*** Delete File: changed.txt") },
            askThen(rewrite(changed, "edited elsewhere\n")),
          ),
          `${prefix}${FileState.changedWhileAskingMessage(changed)}`,
        )
        yield* expectFailure(
          execute(
            { patchText: patch("*** Delete File: vanishing.txt") },
            askThen(Effect.promise(() => fs.rm(vanishing))),
          ),
          `${prefix}${FileState.changedWhileAskingMessage(vanishing)}`,
        )

        expect(yield* readText(changed)).toBe("edited elsewhere\n")
      }),
    )

    it.instance("fails a Move whose destination changed, leaving the source in place", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const source = path.join(test.directory, "from.txt")
        const destination = path.join(test.directory, "to.txt")
        yield* writeText(source, "from\n")
        yield* writeText(destination, "what the model read\n")
        yield* markRead(destination)

        yield* expectFailure(
          execute(
            { patchText: patch("*** Update File: from.txt", "*** Move to: to.txt", "@@", "-from", "+new") },
            askThen(rewrite(destination, "someone else\n")),
          ),
          `${prefix}${FileState.changedWhileAskingMessage(destination)}`,
        )

        expect(yield* readText(source)).toBe("from\n")
        expect(yield* readText(destination)).toBe("someone else\n")
      }),
    )

    it.instance("fails a Move to a destination that appeared", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const source = path.join(test.directory, "from.txt")
        const destination = path.join(test.directory, "to.txt")
        yield* writeText(source, "from\n")

        yield* expectFailure(
          execute(
            { patchText: patch("*** Update File: from.txt", "*** Move to: to.txt", "@@", "-from", "+new") },
            askThen(rewrite(destination, "created elsewhere\n")),
          ),
          `${prefix}${FileState.changedWhileAskingMessage(destination)}`,
        )

        expect(yield* readText(source)).toBe("from\n")
        expect(yield* readText(destination)).toBe("created elsewhere\n")
      }),
    )

    it.instance("applies the patch when nothing changed in between", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "update.txt")
        yield* writeText(target, "one\n")

        yield* execute({ patchText: patch("*** Update File: update.txt", "@@", "-one", "+uno") }, askThen(Effect.void))

        expect(yield* readText(target)).toBe("uno\n")
      }),
    )
  })

  describe("the path locks", () => {
    it.instance("are not held while the question is open, and are free afterwards", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "update.txt")
        yield* writeText(target, "one\n")
        const held: number[] = []
        const next: ToolCtx = {
          ...baseCtx,
          ask: () =>
            Effect.gen(function* () {
              held.push(yield* EngineProcess.fileLocks.size)
            }),
        }

        yield* execute({ patchText: patch("*** Update File: update.txt", "@@", "-one", "+uno") }, next)

        expect(held).toEqual([0])
        expect(yield* EngineProcess.fileLocks.size).toBe(0)
      }),
    )

    it.instance("are released when a check fails", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "update.txt")
        yield* writeText(target, "one\n")

        yield* expectFailure(
          execute(
            { patchText: patch("*** Update File: update.txt", "@@", "-one", "+uno") },
            askThen(rewrite(target, "changed\n")),
          ),
        )

        expect(yield* EngineProcess.fileLocks.size).toBe(0)
      }),
    )
  })
})
