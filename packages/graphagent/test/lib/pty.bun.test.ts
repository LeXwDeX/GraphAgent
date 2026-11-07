import { expect, test } from "bun:test"
import { spawn } from "bun-pty"

const ptyTest = process.platform === "win32" ? test.skip : test

ptyTest("replays a real fast exit once to late listeners and honors disposal", async () => {
  const proc = spawn("/usr/bin/env", ["sh", "-c", "exit 4"], { name: "xterm" })
  try {
    // This listener also catches an exit emitted inside the Terminal constructor.
    const early: number[] = []
    const firstExit = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PTY did not exit")), 5_000)
      proc.onExit((event) => {
        early.push(event.exitCode)
        clearTimeout(timer)
        resolve(event.exitCode)
      })
    })
    expect(firstExit).toBe(4)

    // The process has exited; both registrations now exercise late subscription.
    const exits: number[] = []
    const disposed: number[] = []
    const activeListener = proc.onExit((event) => exits.push(event.exitCode))
    const removedListener = proc.onExit((event) => disposed.push(event.exitCode))
    removedListener.dispose()
    await Promise.resolve()

    expect(early).toEqual([4])
    expect(exits).toEqual([4])
    expect(disposed).toEqual([])

    proc.kill()
    await Promise.resolve()
    expect(early).toEqual([4])
    expect(exits).toEqual([4])
    activeListener.dispose()
  } finally {
    proc.kill()
  }
})
