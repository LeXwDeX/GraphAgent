import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as Log from "../../src/util/log"

let restore: (() => void) | undefined
const originalLevel = process.env.GRAPHAGENT_LOG_LEVEL

afterEach(async () => {
  await Log.flush()
  restore?.()
  restore = undefined
  if (originalLevel === undefined) delete process.env.GRAPHAGENT_LOG_LEVEL
  else process.env.GRAPHAGENT_LOG_LEVEL = originalLevel
})

const capture = () => {
  const entries: Log.Entry[] = []
  restore = Log.setSink((entry) => entries.push(entry))
  return entries
}

describe("util.log", () => {
  test("writes info, warn and error by default and hides debug", async () => {
    const entries = capture()
    const log = Log.create({ service: "test.service" })
    log.debug("hidden")
    log.info("visible", { sessionID: "s1" })
    log.warn("warned")
    log.error("failed")
    // The sink is fed by the async drain, not synchronously by emit.
    expect(entries).toHaveLength(0)
    await Log.flush()

    expect(entries.map((entry) => entry.level)).toEqual(["info", "warn", "error"])
    expect(entries[0]).toMatchObject({
      service: "test.service",
      message: "visible",
      meta: "sessionID=s1",
    })
  })

  test("writes debug when GRAPHAGENT_LOG_LEVEL=DEBUG", async () => {
    process.env.GRAPHAGENT_LOG_LEVEL = "DEBUG"
    const entries = capture()
    Log.create({ service: "test.service" }).debug("visible", { sessionID: "s1" })
    await Log.flush()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).toBe("visible")
  })

  test("flattens newlines and bounds untrusted fields", async () => {
    const entries = capture()
    Log.create({ service: "test.service" }).info("line\nbreak", { stderr: "x".repeat(500) })
    await Log.flush()
    expect(entries[0]?.message).toBe("line break")
    expect(entries[0]?.meta?.length).toBeLessThan(300)
  })

  test("records duration when the timing logger is enabled", async () => {
    process.env.GRAPHAGENT_LOG_LEVEL = "DEBUG"
    const entries = capture()
    const label = Log.create({ service: "test.service" }).time("query")
    label[Symbol.dispose]()
    await Log.flush()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).toBe("query completed")
    expect(entries[0]?.meta).toContain("duration_ms=")
  })

  test("redacts credentials from commands, URLs and output", async () => {
    const entries = capture()
    Log.create({ service: "test.service" }).warn("hook command exited non-zero", {
      command: 'curl -H "Authorization: Bearer abc123" https://hooks.example.com/run?token=secret-value',
      url: "https://user:pass@hooks.example.com/run?token=secret-value#frag",
      stderr: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrst",
    })
    await Log.flush()

    const meta = entries[0]?.meta ?? ""
    expect(meta).not.toContain("abc123")
    expect(meta).not.toContain("secret-value")
    expect(meta).not.toContain("user:pass")
    expect(meta).not.toContain("ghp_abcdefghijklmnopqrst")
    expect(meta).toContain("[redacted]")
  })

  test("defers formatting and sink delivery off the synchronous hot path", async () => {
    const entries = capture()
    const log = Log.create({ service: "test.service" })
    const started = performance.now()
    for (let index = 0; index < 10_000; index++) log.info("hot-path message", { index, url: "https://example.com" })
    const elapsed = performance.now() - started
    // Nothing is formatted, written, or delivered while emitting.
    expect(entries).toHaveLength(0)
    // Synchronous cost stays far below a synchronous append per record.
    expect(elapsed).toBeLessThan(200)
    await Log.flush()
    expect(entries).toHaveLength(10_000)
    expect(entries[9_999]?.meta).toContain("index=9999")
  })

  test("bounds the queue and reports dropped entries", async () => {
    const entries = capture()
    const log = Log.create({ service: "test.service" })
    for (let index = 0; index < 10_010; index++) log.info("fill", { index })
    // The synchronous loop never yields, so nothing was drained yet.
    expect(Log.droppedEntries()).toBe(10)
    await Log.flush()
    expect(entries.length).toBe(10_001)
    expect(entries[0]?.message).toContain("queue limit")
    expect(Log.droppedEntries()).toBe(0)
  })

  test("flushes the buffer before an abrupt process.exit", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "graphagent-log-exit-"))
    const logPath = path.resolve(import.meta.dir, "../../src/util/log.ts")
    const script = [
      `import * as Log from ${JSON.stringify(logPath)}`,
      `Log.create({ service: "exit-test" }).info("exit-flush-marker")`,
      `process.exit(0)`,
    ].join("\n")
    try {
      const child = Bun.spawn({
        cmd: [process.execPath, "-e", script],
        env: { ...process.env, XDG_DATA_HOME: dataDir },
        stdout: "ignore",
        stderr: "inherit",
      })
      expect(await child.exited).toBe(0)
      const log = await fs.readFile(path.join(dataDir, "graphagent", "log", "graphagent.log"), "utf8")
      expect(log).toContain("exit-flush-marker")
      expect(log).toContain("service=exit-test")
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})