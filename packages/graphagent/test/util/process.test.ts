import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Process } from "@/util/process"
import { tmpdir } from "../fixture/fixture"

function node(script: string) {
  return [process.execPath, "-e", script]
}

describe("util.process", () => {
  test("captures stdout and stderr", async () => {
    const out = await Process.run(node('process.stdout.write("out");process.stderr.write("err")'))
    expect(out.code).toBe(0)
    expect(out.stdout.toString()).toBe("out")
    expect(out.stderr.toString()).toBe("err")
  })

  test("returns code when nothrow is enabled", async () => {
    const out = await Process.run(node("process.exit(7)"), { nothrow: true })
    expect(out.code).toBe(7)
  })

  test("throws RunFailedError on non-zero exit", async () => {
    const err = await Process.run(node('process.stderr.write("bad");process.exit(3)')).catch((error) => error)
    expect(err).toBeInstanceOf(Process.RunFailedError)
    if (!(err instanceof Process.RunFailedError)) throw err
    expect(err.code).toBe(3)
    expect(err.stderr.toString()).toBe("bad")
  })

  test("aborts a running process", async () => {
    const abort = new AbortController()
    const started = Date.now()
    setTimeout(() => abort.abort(), 25)

    const out = await Process.run(node("setInterval(() => {}, 1000)"), {
      abort: abort.signal,
      nothrow: true,
    })

    expect(out.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 3000)

  test("kills after timeout when process ignores terminate signal", async () => {
    if (process.platform === "win32") return

    const abort = new AbortController()
    const started = Date.now()
    setTimeout(() => abort.abort(), 25)

    const out = await Process.run(node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'), {
      abort: abort.signal,
      nothrow: true,
      timeout: 25,
    })

    expect(out.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 3000)

  test("uses cwd when spawning commands", async () => {
    await using tmp = await tmpdir()
    const out = await Process.run(node("process.stdout.write(process.cwd())"), {
      cwd: tmp.path,
    })
    expect(out.stdout.toString()).toBe(tmp.path)
  })

  test("merges environment overrides", async () => {
    const out = await Process.run(node('process.stdout.write(process.env.GRAPHAGENT_TEST ?? "")'), {
      env: {
        GRAPHAGENT_TEST: "set",
      },
    })
    expect(out.stdout.toString()).toBe("set")
  })

  test("uses shell in run on Windows", async () => {
    if (process.platform !== "win32") return

    const out = await Process.run(["set", "GRAPHAGENT_TEST_SHELL"], {
      shell: true,
      env: {
        GRAPHAGENT_TEST_SHELL: "ok",
      },
    })

    expect(out.code).toBe(0)
    expect(out.stdout.toString()).toContain("GRAPHAGENT_TEST_SHELL=ok")
  })

  test("runs cmd scripts with spaces on Windows without shell", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "with space")
    const file = path.join(dir, "echo cmd.cmd")

    await fs.mkdir(dir, { recursive: true })
    await Bun.write(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n")

    const proc = Process.spawn([file, "--stdio"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await proc.exited).toBe(0)
  })

  test("rejects missing commands without leaking unhandled errors", async () => {
    await using tmp = await tmpdir()
    const cmd = path.join(tmp.path, "missing" + (process.platform === "win32" ? ".cmd" : ""))
    const err = await Process.spawn([cmd], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }).exited.catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err).toMatchObject({
      code: "ENOENT",
    })
  })
})

describe("util.process stop", () => {
  test("fast path: awaits exit when the child honors SIGTERM", async () => {
    if (process.platform === "win32") return

    const proc = Process.spawn(node("setInterval(() => {}, 1000)"))
    const started = Date.now()
    await Process.stop(proc)
    await proc.exited

    expect(Date.now() - started).toBeLessThan(1500)
  }, 3000)

  test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    if (process.platform === "win32") return

    const proc = Process.spawn(
      // Trap BEFORE the ready write: the parent stops as soon as it sees
      // "ready", and under CI load the child can be preempted between the two
      // statements, taking the first SIGTERM with the default handler still
      // installed (exits SIGTERM instead of escalating to SIGKILL).
      node('process.on("SIGTERM", () => {});process.stdout.write("ready\\n");setInterval(() => {}, 1000)'),
      { stdout: "pipe" },
    )
    await new Promise<void>((resolve) => proc.stdout!.once("data", resolve))

    const started = Date.now()
    await Process.stop(proc)
    await proc.exited

    expect(proc.signalCode).toBe("SIGKILL")
    expect(Date.now() - started).toBeLessThan(6000)
  }, 10000)

  test("is a no-op for an already-exited child", async () => {
    const proc = Process.spawn(node("process.exit(0)"))
    await proc.exited

    const started = Date.now()
    await Process.stop(proc)

    expect(Date.now() - started).toBeLessThan(100)
  })
})

describe("util.process stopTree", () => {
  test("terminates a spawned process tree", async () => {
    if (process.platform === "win32") return

    const pids = await spawnTree("echo $$; sleep 300 & echo $!; sleep 300 & echo $!; wait", 3)
    const started = Date.now()
    await Process.stopTree(pids)

    for (const pid of pids) expect(treeAlive(pid)).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
  }, 5000)

  test("escalates to SIGKILL when tree members ignore SIGTERM", async () => {
    if (process.platform === "win32") return

    const pids = await spawnTree('echo $$; trap "" TERM; sleep 300 & echo $!; wait', 2)
    const started = Date.now()
    await Process.stopTree(pids, { termGraceMs: 250, killGraceMs: 2000 })

    for (const pid of pids) expect(treeAlive(pid)).toBe(false)
    expect(Date.now() - started).toBeLessThan(3000)
  }, 5000)

  test("returns immediately for an empty pid list", async () => {
    await Process.stopTree([])
  })
})

function treeAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Spawns `sh -c <script>` (the script announces pids on stdout) and resolves
// once `expected` pids have been announced.
function spawnTree(script: string, expected: number) {
  const proc = Process.spawn(["sh", "-c", script], { stdout: "pipe" })
  return new Promise<number[]>((resolve, reject) => {
    let text = ""
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${expected} pids, got: ${text.trim()}`)), 5000)
    proc.stdout!.on("data", (chunk) => {
      text += chunk.toString()
      const lines = text.split("\n").filter(Boolean)
      if (lines.length >= expected) {
        clearTimeout(timer)
        resolve(lines.slice(0, expected).map(Number))
      }
    })
    proc.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
