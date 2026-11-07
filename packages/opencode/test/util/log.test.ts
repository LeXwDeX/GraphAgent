import { afterEach, describe, expect, test } from "bun:test"
import * as Log from "../../src/util/log"

let restore: (() => void) | undefined
const originalLevel = process.env.GRAPHAGENT_LOG_LEVEL

afterEach(() => {
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
  test("writes info, warn and error by default and hides debug", () => {
    const entries = capture()
    const log = Log.create({ service: "test.service" })
    log.debug("hidden")
    log.info("visible", { sessionID: "s1" })
    log.warn("warned")
    log.error("failed")

    expect(entries.map((entry) => entry.level)).toEqual(["info", "warn", "error"])
    expect(entries[0]).toMatchObject({
      service: "test.service",
      message: "visible",
      meta: "sessionID=s1",
    })
  })

  test("writes debug when GRAPHAGENT_LOG_LEVEL=DEBUG", () => {
    process.env.GRAPHAGENT_LOG_LEVEL = "DEBUG"
    const entries = capture()
    Log.create({ service: "test.service" }).debug("visible", { sessionID: "s1" })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).toBe("visible")
  })

  test("flattens newlines and bounds untrusted fields", () => {
    const entries = capture()
    Log.create({ service: "test.service" }).info("line\nbreak", { stderr: "x".repeat(500) })
    expect(entries[0]?.message).toBe("line break")
    expect(entries[0]?.meta?.length).toBeLessThan(300)
  })

  test("records duration when the timing logger is enabled", () => {
    process.env.GRAPHAGENT_LOG_LEVEL = "DEBUG"
    const entries = capture()
    const label = Log.create({ service: "test.service" }).time("query")
    label[Symbol.dispose]()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).toBe("query completed")
    expect(entries[0]?.meta).toContain("duration_ms=")
  })

  test("redacts credentials from commands, URLs and output", () => {
    const entries = capture()
    Log.create({ service: "test.service" }).warn("hook command exited non-zero", {
      command: 'curl -H "Authorization: Bearer abc123" https://hooks.example.com/run?token=secret-value',
      url: "https://user:pass@hooks.example.com/run?token=secret-value#frag",
      stderr: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrst",
    })

    const meta = entries[0]?.meta ?? ""
    expect(meta).not.toContain("abc123")
    expect(meta).not.toContain("secret-value")
    expect(meta).not.toContain("user:pass")
    expect(meta).not.toContain("ghp_abcdefghijklmnopqrst")
    expect(meta).toContain("[redacted]")
  })
})
