import { describe, test, expect } from "bun:test"
import { ConfigV1 } from "@graphagent/core/v1/config/config"
import { NodeFileSystem } from "@effect/platform-node"
import { FSUtil } from "@graphagent/core/fs-util"
import { Cause, Effect, Exit, FileSystem, Layer } from "effect"
import { Truncate } from "@/tool/truncate"
import { ModelContext } from "@/tool/model-context"
import type { Agent } from "@/agent/agent"
import { Identifier } from "../../src/id/id"
import { Process } from "@/util/process"
import path from "path"
import { testEffect } from "../lib/effect"
import { writeFileStringScoped } from "../lib/filesystem"
import { truncateFailingWith, unwritableTruncate } from "../lib/truncate"
import { TestConfig } from "../fixture/config"
import { ProviderTest } from "../fake/provider"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")
const ROOT = path.resolve(import.meta.dir, "..", "..")

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, NodeFileSystem.layer, FSUtil.defaultLayer))
const unwritableIt = testEffect(unwritableTruncate)

const configuredLayer = (cfg: ConfigV1.Info) =>
  Layer.mergeAll(
    Truncate.defaultLayer,
    NodeFileSystem.layer,
    FSUtil.defaultLayer,
    TestConfig.layer({ get: () => Effect.succeed(cfg) }),
  )
const configuredIt = (cfg: ConfigV1.Info) => testEffect(configuredLayer(cfg))

describe("Truncate", () => {
  describe("output", () => {
    it.live("truncates large json file by bytes", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* FSUtil.Service
        const content = yield* fsys.readFileString(path.join(FIXTURES_DIR, "models-api.json"))
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("[truncated:")
        if (result.truncated) expect(result.outputPath).toBeDefined()
      }),
    )

    it.live("returns content unchanged when under limits", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "line1\nline2\nline3"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        expect(result.content).toBe(content)
      }),
    )

    it.live("truncates by line count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("showing lines 1-10 of 100.")
        expect(result.content).toContain("90 lines omitted after this range.")
      }),
    )

    it.live("truncates by byte count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "a".repeat(1000)
        const result = yield* svc.output(content, { maxBytes: 100 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("showing the first 100 B of line 1 (line is 1000 B; 1000 B total output)")
      }),
    )

    it.live("truncates from head by default", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 3 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line0")
        expect(result.content).toContain("line1")
        expect(result.content).toContain("line2")
        expect(result.content).not.toContain("line9")
      }),
    )

    it.live("truncates from tail when direction is tail", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 3, direction: "tail" })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line7")
        expect(result.content).toContain("line8")
        expect(result.content).toContain("line9")
        expect(result.content).not.toContain("line0")
        expect(result.content).toContain("7 lines omitted before this range.")
        expect(result.content).toContain("Continue: read filePath=")
        expect(result.content).toContain("offset=1")
      }),
    )

    test("uses default MAX_LINES and MAX_BYTES", () => {
      expect(Truncate.MAX_LINES).toBe(2000)
      expect(Truncate.MAX_BYTES).toBe(50 * 1024)
    })

    it.live("limits() falls back to MAX_LINES/MAX_BYTES when Config is not provided", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const resolved = yield* svc.limits()
        expect(resolved.maxLines).toBe(Truncate.MAX_LINES)
        expect(resolved.maxBytes).toBe(Truncate.MAX_BYTES)
      }),
    )

    describe("with tool_output config", () => {
      const limitsIt = configuredIt({ tool_output: { max_lines: 123, max_bytes: 456 } })
      limitsIt.live("limits() reflects config overrides", () =>
        Effect.gen(function* () {
          const resolved = yield* (yield* Truncate.Service).limits()
          expect(resolved.maxLines).toBe(123)
          expect(resolved.maxBytes).toBe(456)
        }),
      )

      // Huge byte budget isolates line truncation. 100 lines against max_lines: 10
      // proves the configured line limit is what `output()` enforces.
      const lineIt = configuredIt({ tool_output: { max_lines: 10, max_bytes: 1024 * 1024 } })
      lineIt.live("output() truncates to configured max_lines", () =>
        Effect.gen(function* () {
          const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
          const result = yield* (yield* Truncate.Service).output(content)
          expect(result.truncated).toBe(true)
          expect(result.content).toContain("90 lines omitted after this range.")
        }),
      )

      // Huge line budget isolates byte truncation.
      const byteIt = configuredIt({ tool_output: { max_lines: 1_000_000, max_bytes: 100 } })
      byteIt.live("output() truncates to configured max_bytes", () =>
        Effect.gen(function* () {
          const content = "a".repeat(1000)
          const result = yield* (yield* Truncate.Service).output(content)
          expect(result.truncated).toBe(true)
          expect(result.content).toContain("showing the first 100 B of line 1")
        }),
      )

      const overrideIt = configuredIt({ tool_output: { max_lines: 10, max_bytes: 100 } })
      overrideIt.live("per-call options still override config", () =>
        Effect.gen(function* () {
          const content = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")
          const result = yield* (yield* Truncate.Service).output(content, {
            maxLines: 1000,
            maxBytes: 1024 * 1024,
          })
          expect(result.truncated).toBe(false)
        }),
      )
    })

    it.live("large json file reports the byte-limited line range", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* FSUtil.Service
        const content = yield* fsys.readFileString(path.join(FIXTURES_DIR, "models-api.json"))
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("[truncated: showing lines 1-")
        expect(result.content).toContain("(50.0 KB limit)")
        expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(Truncate.MAX_BYTES)
      }),
    )

    it.live("writes full output to file when truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).not.toContain("The tool call succeeded")
        if (!result.truncated) throw new Error("expected truncated")
        if (result.outputPath === undefined) throw new Error("expected a saved file")
        expect(result.content).toContain(
          `[truncated: showing lines 1-10 of 100. 90 lines omitted after this range. Full output: ${result.outputPath}]`,
        )
        expect(result.content).toContain(`Continue: read filePath="${result.outputPath}" offset=11`)
        expect(result.outputPath).toBeDefined()
        expect(result.outputPath).toContain("tool_")

        const fsys = yield* FSUtil.Service
        const written = yield* fsys.readFileString(result.outputPath)
        expect(written).toBe(lines)
      }),
    )

    it.live("does not add delegation hints to the truncation notice", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const agent: Agent.Info = {
          name: "fixture",
          mode: "subagent",
          options: {},
          permission: [{ permission: "task", pattern: "*", action: "deny" }],
        }
        const result = yield* svc.output(lines, { maxLines: 10 }, agent)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain(`Continue: read filePath=`)
        expect(result.content).not.toContain("Task tool")
      }),
    )

    it.live("points at the saved file with the read parameters that continue it", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "first\nsecond\nthird"
        const agent: Agent.Info = {
          name: "fixture",
          mode: "subagent",
          options: {},
          permission: [{ permission: "task", pattern: "*", action: "allow" }],
        }
        const result = yield* svc.output(content, { maxLines: 1 }, agent)

        if (!result.truncated) throw new Error("expected truncated")
        if (result.outputPath === undefined) throw new Error("expected a saved file")
        expect(result.content).toContain(`Continue: read filePath="${result.outputPath}" offset=2`)
        expect(result.content).not.toContain("Task tool")
        expect(result.content).not.toContain("Do NOT read")
        expect(yield* (yield* FSUtil.Service).readFileString(result.outputPath)).toBe(content)
      }),
    )

    it.live("save returns the path of a file that holds the text", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const saved = yield* svc.save("kept text")

        if (!("path" in saved)) throw new Error(`expected a saved file, got: ${saved.failed}`)
        expect(path.dirname(saved.path)).toBe(Truncate.DIR)
        expect(path.basename(saved.path).startsWith("tool_")).toBe(true)
        expect(yield* (yield* FSUtil.Service).readFileString(saved.path)).toBe("kept text")
      }),
    )

    unwritableIt.live("save reports the reason a write failed instead of dying", () =>
      Effect.gen(function* () {
        const saved = yield* (yield* Truncate.Service).save("lost text")

        expect(saved).toEqual({ failed: "disk full" })
      }),
    )

    testEffect(truncateFailingWith(`${"x".repeat(300)}\nsecond line`)).live(
      "save keeps the first line of the reason, at most 200 characters",
      () =>
        Effect.gen(function* () {
          const saved = yield* (yield* Truncate.Service).save("lost text")

          expect(saved).toEqual({ failed: "x".repeat(200) })
        }),
    )

    test("states the reason a result could not be saved and what to do about it", () => {
      expect(Truncate.unsavedNote("disk full")).toBe(
        "Full output could not be saved: disk full. The omitted part cannot be read back; repeat the call with a narrower scope.",
      )
    })

    unwritableIt.live("output keeps a bounded preview and says the full text could not be saved", () =>
      Effect.gen(function* () {
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* (yield* Truncate.Service).output(lines, { maxLines: 10 })

        if (!result.truncated) throw new Error("expected truncated")
        expect(result.outputPath).toBeUndefined()
        expect("unsaved" in result && result.unsaved).toBe("disk full")
        expect(result.content.startsWith("line0\n")).toBe(true)
        expect(result.content).toContain("line9")
        expect(result.content).not.toContain("line10")
        expect(result.content.endsWith(`\n\n[truncated: ${Truncate.unsavedNote("disk full")}]`)).toBe(true)
        expect(result.content).not.toContain("Continue:")
      }),
    )

    unwritableIt.live("output puts the unsaved note before a tail preview", () =>
      Effect.gen(function* () {
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* (yield* Truncate.Service).output(lines, { maxLines: 10, direction: "tail" })

        if (!result.truncated) throw new Error("expected truncated")
        expect(result.outputPath).toBeUndefined()
        expect(result.content.startsWith(`[truncated: ${Truncate.unsavedNote("disk full")}]\n\n`)).toBe(true)
        expect(result.content.endsWith("line99")).toBe(true)
      }),
    )

    unwritableIt.live("output still returns an untruncated text as it was", () =>
      Effect.gen(function* () {
        const result = yield* (yield* Truncate.Service).output("short")

        expect(result).toEqual({ content: "short", truncated: false })
      }),
    )

    it.live("does not write file when not truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "short content"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        if (result.truncated) throw new Error("expected not truncated")
        expect("outputPath" in result).toBe(false)
      }),
    )

    test("loads truncate effect in a fresh process", async () => {
      const out = await Process.run([process.execPath, "run", path.join(ROOT, "src", "tool", "truncate.ts")], {
        cwd: ROOT,
      })

      expect(out.code).toBe(0)
    }, 20000)
  })

  describe("writeBytes (#1454)", () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x80])

    it.live("writes the bytes to a tool_ file that keeps the extension, beside the saved outputs", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fs = yield* FileSystem.FileSystem
        const file = yield* svc.writeBytes(bytes, ".pdf")
        yield* Effect.addFinalizer(() => fs.remove(file, { force: true }).pipe(Effect.ignore))

        expect(path.dirname(file)).toBe(Truncate.DIR)
        expect(path.basename(file).startsWith("tool_")).toBe(true)
        expect(path.extname(file)).toBe(".pdf")
        expect(new Uint8Array(yield* fs.readFile(file))).toEqual(bytes)
      }),
    )

    it.live("gives each write a file of its own", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fs = yield* FileSystem.FileSystem
        const first = yield* svc.writeBytes(bytes, ".pdf")
        const second = yield* svc.writeBytes(bytes, ".pdf")
        yield* Effect.addFinalizer(() =>
          Effect.all([fs.remove(first, { force: true }), fs.remove(second, { force: true })]).pipe(Effect.ignore),
        )

        expect(first).not.toBe(second)
      }),
    )

    it.live("is cleaned up after 7 days like any saved output", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fs = yield* FileSystem.FileSystem
        const file = yield* svc.writeBytes(bytes, ".pdf")
        yield* Effect.addFinalizer(() => fs.remove(file, { force: true }).pipe(Effect.ignore))
        const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
        yield* fs.utimes(file, old, old)
        yield* svc.cleanup()

        expect(yield* fs.exists(file)).toBe(false)
      }),
    )

    unwritableIt.live("dies when the disk refuses the write, as write does", () =>
      Effect.gen(function* () {
        const exit = yield* (yield* Truncate.Service).writeBytes(bytes, ".pdf").pipe(Effect.exit)

        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      }),
    )
  })

  describe("output budget (#1448)", () => {
    test("budgetFor scales with the window and stops at the constants", () => {
      const table: Array<[number, number, number]> = [
        [8_000, 4_096, 200],
        [32_000, 6_400, 250],
        [128_000, 25_600, 1_000],
        [200_000, 40_000, 1_562],
        [1_000_000, 51_200, 2_000],
      ]
      for (const [context, maxBytes, maxLines] of table) {
        expect(Truncate.budgetFor(context)).toEqual({ maxLines, maxBytes })
      }
      // From 256_000 tokens on the budget is the full constants.
      expect(Truncate.budgetFor(255_999)).toEqual({ maxLines: 1_999, maxBytes: 51_199 })
      expect(Truncate.budgetFor(256_000)).toEqual({ maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES })
      // A tiny window still gets a usable page.
      expect(Truncate.budgetFor(1_000)).toEqual({ maxLines: Truncate.MIN_LINES, maxBytes: Truncate.MIN_BYTES })
      expect(Truncate.MIN_BYTES).toBe(4_096)
      expect(Truncate.MIN_LINES).toBe(200)
    })

    test("fitItems counts each item with its separator and keeps at least one", () => {
      expect(Truncate.fitItems(["aaaa", "bbbb", "cccc"], 10)).toBe(2)
      expect(Truncate.fitItems(["aaaa", "bbbb"], 4)).toBe(1)
      expect(Truncate.fitItems([], 10)).toBe(0)
      expect(Truncate.fitItems(["aaaa", "bbbb"], 100)).toBe(2)
      // Bytes, not characters: each of these items is 6 bytes plus its separator.
      expect(Truncate.fitItems(["漢漢", "漢漢"], 7)).toBe(1)
      expect(Truncate.fitItems(["漢漢", "漢漢"], 14)).toBe(2)
    })

    it.live("limits() derives the budget from the window and has no window by default", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        expect(yield* svc.limits({ context: 32_000 })).toEqual({ maxLines: 250, maxBytes: 6_400 })
        expect(yield* svc.limits({ context: 1_000_000 })).toEqual({
          maxLines: Truncate.MAX_LINES,
          maxBytes: Truncate.MAX_BYTES,
        })
        expect(yield* svc.limits({})).toEqual({ maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES })
        expect(yield* svc.limits()).toEqual({ maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES })
      }),
    )

    // Configuration is an override, per value: a limit it does not name keeps following the window.
    const bytesOnly = configuredIt({ tool_output: { max_bytes: 123 } })
    bytesOnly.live("a configured max_bytes replaces only the byte budget", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        expect(yield* svc.limits({ context: 32_000 })).toEqual({ maxLines: 250, maxBytes: 123 })
        expect(yield* svc.limits()).toEqual({ maxLines: Truncate.MAX_LINES, maxBytes: 123 })
      }),
    )

    const linesOnly = configuredIt({ tool_output: { max_lines: 77 } })
    linesOnly.live("a configured max_lines replaces only the line limit", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        expect(yield* svc.limits({ context: 32_000 })).toEqual({ maxLines: 77, maxBytes: 6_400 })
      }),
    )

    const both = configuredIt({ tool_output: { max_lines: 123, max_bytes: 456 } })
    both.live("configured limits win over the window", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        expect(yield* svc.limits({ context: 32_000 })).toEqual({ maxLines: 123, maxBytes: 456 })
        expect(yield* svc.limits({ context: 1_000_000 })).toEqual({ maxLines: 123, maxBytes: 456 })
      }),
    )

    it.live("output() cuts at the budget of the window the call names", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const text = "a".repeat(10_000)

        const scaled = yield* svc.output(text, { context: 32_000 })
        if (!scaled.truncated) throw new Error("expected the 32K window to cut a 10 KB line")
        expect(scaled.details.maxBytes).toBe(6_400)

        expect((yield* svc.output(text, { context: 1_000_000 })).truncated).toBe(false)
        expect((yield* svc.output(text)).truncated).toBe(false)

        // A byte budget in the call itself still wins over the window.
        const explicit = yield* svc.output(text, { context: 32_000, maxBytes: 9_000 })
        if (!explicit.truncated) throw new Error("expected a cut at the explicit budget")
        expect(explicit.details.maxBytes).toBe(9_000)
      }),
    )
  })

  describe("ModelContext (#1448)", () => {
    const model = (context: number) => ProviderTest.model({ limit: { context, output: 4_096 } })

    test("contextOfModel reads the window through the model profile", () => {
      expect(ModelContext.contextOfModel(model(32_000))).toBe(32_000)
      // A window no source declares is the default window, not 0.
      expect(ModelContext.contextOfModel(model(0))).toBe(128_000)
      expect(ModelContext.contextOfModel(undefined)).toBeUndefined()
    })

    test("contextOf reads the model from the extra of a call", () => {
      expect(ModelContext.contextOf({ model: model(32_000) })).toBe(32_000)
      expect(ModelContext.contextOf({ model: model(0) })).toBe(128_000)
      expect(ModelContext.contextOf(undefined)).toBeUndefined()
      expect(ModelContext.contextOf({})).toBeUndefined()
      expect(ModelContext.contextOf({ model: "gpt-5.2" })).toBeUndefined()
    })
  })

  describe("cleanup", () => {
    const DAY_MS = 24 * 60 * 60 * 1000

    it.live("deletes files older than 7 days and preserves recent files", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fs = yield* FileSystem.FileSystem

        yield* fs.makeDirectory(Truncate.DIR, { recursive: true })

        const old = path.join(Truncate.DIR, Identifier.create("tool", "ascending", Date.now() - 10 * DAY_MS))
        const recent = path.join(Truncate.DIR, Identifier.create("tool", "ascending", Date.now() - 3 * DAY_MS))

        yield* writeFileStringScoped(old, "old content")
        yield* writeFileStringScoped(recent, "recent content")
        const oldMtime = new Date(Date.now() - 10 * DAY_MS)
        const recentMtime = new Date(Date.now() - 3 * DAY_MS)
        yield* fs.utimes(old, oldMtime, oldMtime)
        yield* fs.utimes(recent, recentMtime, recentMtime)
        yield* svc.cleanup()

        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
      }),
    )
  })
})
