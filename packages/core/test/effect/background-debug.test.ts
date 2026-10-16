import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

async function run(level: string, printLogs: string, mode = "normal") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-background-debug-"))
  try {
    const child = Bun.spawn(
      [process.execPath, "run", fileURLToPath(new URL("./fixtures/background-debug.ts", import.meta.url))],
      {
        env: {
          ...process.env,
          OPENCODE_LOG_LEVEL: level,
          OPENCODE_PRINT_LOGS: printLogs,
          DIAGNOSTIC_TEST_MODE: mode,
          OPENCODE_TEST_HOME: root,
          XDG_DATA_HOME: root,
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const log = await fs.readFile(path.join(root, "opencode", "log", "opencode.log"), "utf8").catch(() => "")
    return {
      code,
      stdout,
      stderr,
      log,
      ...(mode.startsWith("open-")
        ? {
            released: await fs.readFile(path.join(root, "released"), "utf8"),
            interrupted: await fs.readFile(path.join(root, "interrupted"), "utf8").catch(() => ""),
          }
        : {}),
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

for (const printLogs of ["0", "1"]) {
  for (const level of ["DEBUG", "INFO"]) {
    test(`background diagnostics stay file-only with ${level} and PRINT_LOGS=${printLogs}`, async () => {
      const result = await run(level, printLogs)
      expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      })
      if (level === "DEBUG") {
        expect(result.log).toContain("background-debug-marker")
        expect(result.log).toContain("background-second-marker")
        expect(result.log).toContain("source=fixture sessionID=session-fixture attempt=1")
        expect(result.log.match(/level=DEBUG/g)).toHaveLength(2)
        expect(result.log.match(/run=[0-9a-f]{8}/g)).toHaveLength(2)
      } else expect(result.log).not.toContain("background-")
    })
  }
}

test("a bare Effect runtime without a registered file writer stays silent", async () => {
  const result = await run("DEBUG", "1", "bare")
  expect(result).toEqual({ code: 0, stdout: "", stderr: "", log: "" })
})

test("a diagnostic logger defect never escapes into console or the caller", async () => {
  const result = await run("DEBUG", "1", "throw")
  expect(result).toEqual({ code: 0, stdout: "", stderr: "", log: "" })
})

for (const mode of ["write-typed", "write-defect", "close-defect"]) {
  test(`diagnostic ${mode} stays silent across file scope finalization`, async () => {
    const result = await run("DEBUG", "1", mode)
    expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    })
  })
}

for (const mode of ["open-typed", "open-defect", "open-interrupt"]) {
  test(`${mode} releases partial acquisition and preserves interruption`, async () => {
    const result = await run("DEBUG", "1", mode)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
    expect(result.released).toBe("yes")
    expect(result.interrupted).toBe(mode === "open-interrupt" ? "yes" : "")
    expect(result.log).not.toContain("background-")
  })
}

test("a failed periodic flush leaves the same writer able to flush later diagnostics", async () => {
  const result = await run("DEBUG", "1", "write-defect-once")
  expect(result.code).toBe(0)
  expect(result.stdout).toBe("")
  expect(result.stderr).toBe("")
  expect(result.log).not.toContain("background-debug-marker")
  expect(result.log).toContain("background-second-marker")
})
