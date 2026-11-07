import { type ChildProcess, spawnSync } from "node:child_process"

// Duplicated from `packages/graphagent/src/util/process.ts` because the SDK cannot
// import `opencode` without creating a cycle (`opencode` depends on
// `@graphagent/sdk`). Keep both copies in sync, including the grace constant.
const STOP_TERM_GRACE_MS = 3_000

export function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === "win32" && proc.pid) {
    const out = spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true })
    if (!out.error && out.status === 0) return
  }
  proc.kill()
  // Sync adaptation of the async copy's escalation: SIGKILL after a bounded
  // grace when the process ignores SIGTERM. The timer is unref'd and cleared
  // on exit, so it never keeps the event loop alive.
  const timer = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL")
  }, STOP_TERM_GRACE_MS)
  timer.unref()
  proc.once("exit", () => clearTimeout(timer))
  proc.once("error", () => clearTimeout(timer))
}

export function bindAbort(proc: ChildProcess, signal?: AbortSignal, onAbort?: () => void) {
  if (!signal) return () => {}
  const abort = () => {
    clear()
    stop(proc)
    onAbort?.()
  }
  const clear = () => {
    signal.removeEventListener("abort", abort)
    proc.off("exit", clear)
    proc.off("error", clear)
  }
  signal.addEventListener("abort", abort, { once: true })
  proc.on("exit", clear)
  proc.on("error", clear)
  if (signal.aborted) abort()
  return clear
}
