import { spawn } from "bun"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Out-of-process progress watchdog for the exerciser.
//
// Scenario timeouts and the bounded() cleanup guards are all timer-based —
// they only fire while the JS event loop runs. A native hang (instance
// dispose / tree-sitter / sqlite teardown) can freeze the loop so completely
// that every in-process guard dies with it: the runner then emits nothing
// until the CI step timeout (2026-08-05: 13 minutes of silence after
// "worktree.create: shared use done"). A separate process is the only guard
// that survives a frozen event loop.
//
// The runner heartbeats a file on every scenario/phase transition; the child
// polls it, and if it goes stale the child prints the last recorded activity
// and SIGKILLs the runner — turning a silent 15-minute freeze into a 2-minute
// attributed failure.

const WATCHDOG_SCRIPT = `
const fs = require("node:fs")
const pid = Number(process.env.WATCHDOG_PID)
const file = process.env.WATCHDOG_FILE
const timeoutMs = Number(process.env.WATCHDOG_TIMEOUT_MS)
const pollMs = Number(process.env.WATCHDOG_POLL_MS)
// A missing heartbeat file is treated as stalled (tracked via missingSince),
// never as healthy: CI runners can reclaim tmpdir files, and silently
// standing down when the file disappears is what let the 2026-08-17
// teardown hang burn the full 15m step timeout without a kill.
let missingSince = 0
setInterval(() => {
  let alive = true
  try {
    process.kill(pid, 0)
  } catch {
    alive = false
  }
  if (!alive) process.exit(0)
  let mtime = 0
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {}
  if (mtime) {
    missingSince = 0
    if (Date.now() - mtime <= timeoutMs) return
  } else {
    if (!missingSince) missingSince = Date.now()
    if (Date.now() - missingSince <= timeoutMs) return
  }
  let last = "<none>"
  try {
    last = fs.readFileSync(file, "utf8")
  } catch {}
  console.error("[watchdog] no progress for " + Math.round((Date.now() - (mtime || missingSince)) / 1000) + "s; last activity: " + last + " — killing pid " + pid)
  try {
    process.kill(pid, "SIGKILL")
  } catch {}
  process.exit(1)
}, pollMs)
`

export function startProgressWatchdog(timeoutMs = 120_000, pollMs = 5_000): (label: string) => void {
  const heartbeat = path.join(os.tmpdir(), `httpapi-exercise-heartbeat-${process.pid}`)
  fs.writeFileSync(heartbeat, "startup")
  const child = spawn(["bun", "-e", WATCHDOG_SCRIPT], {
    env: {
      ...process.env,
      WATCHDOG_PID: String(process.pid),
      WATCHDOG_FILE: heartbeat,
      WATCHDOG_TIMEOUT_MS: String(timeoutMs),
      WATCHDOG_POLL_MS: String(pollMs),
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  child.unref()
  // F6: unlink the heartbeat file on exit so repeated runs do not leak temp
  // files in tmpdir. The child exits on its own when the parent pid dies, but
  // the heartbeat file was never cleaned up.
  const cleanup = () => {
    try {
      fs.unlinkSync(heartbeat)
    } catch {
      // Already gone or never created.
    }
  }
  process.on("exit", cleanup)
  return (label: string) => {
    try {
      fs.writeFileSync(heartbeat, label)
    } catch {
      // A missed heartbeat only shortens the watchdog's patience margin.
    }
  }
}
