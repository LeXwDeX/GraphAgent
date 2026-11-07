import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

// Local to this branch: the era helper from #450 is not available here.
const MODERN_VERSION = "2026-07-28"
const LEGACY_VERSION = "2025-11-25"
const PROBE_TIMEOUT_MS = 10_000

const children: Array<Bun.Subprocess<"ignore", "pipe", "inherit">> = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

function withTimeout<T>(promise: Promise<T>, message: string, ms = PROBE_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

// The probe drives the real v2 client in a fresh process: sibling files in
// test/mcp mock.module the client SDK in the shared bun test process.
async function runProbe(mode: "stdio-auto" | "stdio-legacy" | "http-auto") {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "interop-probe.ts"), mode], {
    cwd: path.join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "inherit",
  })
  children.push(child)
  const [code, stdout] = await withTimeout(
    Promise.all([child.exited, Bun.readableStreamToText(child.stdout)]),
    `interop probe ${mode} timed out`,
  )
  return { code, result: JSON.parse(stdout) as { era?: string; version?: string; echo?: string } }
}

describe("mcp dual-era interop", () => {
  test("stdio auto negotiates 2026-07-28 and round-trips a tool call", async () => {
    const { code, result } = await runProbe("stdio-auto")
    expect(code, JSON.stringify(result)).toBe(0)
    expect(result.era).toBe("modern")
    expect(result.version).toBe(MODERN_VERSION)
    expect(result.echo).toBe("echo:hello")
  })

  test("stdio legacy pin negotiates 2025-11-25 against the same fixture", async () => {
    const { code, result } = await runProbe("stdio-legacy")
    expect(code, JSON.stringify(result)).toBe(0)
    expect(result.era).toBe("legacy")
    expect(result.version).toBe(LEGACY_VERSION)
    expect(result.echo).toBe("echo:legacy")
  })

  test("streamable http auto negotiates 2026-07-28 and round-trips a tool call", async () => {
    const { code, result } = await runProbe("http-auto")
    expect(code, JSON.stringify(result)).toBe(0)
    expect(result.era).toBe("modern")
    expect(result.version).toBe(MODERN_VERSION)
    expect(result.echo).toBe("echo-http:http")
  })
})
