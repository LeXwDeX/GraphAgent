import { type ChildProcess } from "child_process"
import type { Stream } from "node:stream"
import launch from "cross-spawn"
import { buffer } from "node:stream/consumers"
import { errorMessage } from "./error"

export type Stdio = "inherit" | "pipe" | "ignore" | number | Stream
export type Shell = boolean | string

export interface Options {
  cwd?: string
  env?: NodeJS.ProcessEnv | null
  stdin?: Stdio
  stdout?: Stdio
  stderr?: Stdio
  shell?: Shell
  abort?: AbortSignal
  kill?: NodeJS.Signals | number
  timeout?: number
}

export interface RunOptions extends Omit<Options, "stdout" | "stderr"> {
  nothrow?: boolean
}

export interface Result {
  code: number
  stdout: Buffer
  stderr: Buffer
}

export interface TextResult extends Result {
  text: string
}

export class RunFailedError extends Error {
  readonly cmd: string[]
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: Buffer

  constructor(cmd: string[], code: number, stdout: Buffer, stderr: Buffer) {
    const text = stderr.toString().trim()
    super(
      text
        ? `Command failed with code ${code}: ${cmd.join(" ")}\n${text}`
        : `Command failed with code ${code}: ${cmd.join(" ")}`,
    )
    this.name = "ProcessRunFailedError"
    this.cmd = [...cmd]
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

export type Child = ChildProcess & { exited: Promise<number> }

export function spawn(cmd: string[], opts: Options = {}): Child {
  if (cmd.length === 0) throw new Error("Command is required")
  opts.abort?.throwIfAborted()

  const proc = launch(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    shell: opts.shell,
    env: opts.env === null ? {} : opts.env ? { ...process.env, ...opts.env } : undefined,
    stdio: [opts.stdin ?? "ignore", opts.stdout ?? "ignore", opts.stderr ?? "ignore"],
    windowsHide: process.platform === "win32",
  })

  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const abort = () => {
    if (closed) return
    if (proc.exitCode !== null || proc.signalCode !== null) return
    closed = true

    proc.kill(opts.kill ?? "SIGTERM")

    const ms = opts.timeout ?? 5_000
    if (ms <= 0) return
    timer = setTimeout(() => proc.kill("SIGKILL"), ms)
  }

  const exited = new Promise<number>((resolve, reject) => {
    const done = () => {
      opts.abort?.removeEventListener("abort", abort)
      if (timer) clearTimeout(timer)
    }

    proc.once("exit", (code, signal) => {
      done()
      resolve(code ?? (signal ? 1 : 0))
    })

    proc.once("error", (error) => {
      done()
      reject(error)
    })
  })
  void exited.catch(() => undefined)

  if (opts.abort) {
    opts.abort.addEventListener("abort", abort, { once: true })
    if (opts.abort.aborted) abort()
  }

  const child = proc as Child
  child.exited = exited
  return child
}

export async function run(cmd: string[], opts: RunOptions = {}): Promise<Result> {
  const proc = spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin,
    shell: opts.shell,
    abort: opts.abort,
    kill: opts.kill,
    timeout: opts.timeout,
    stdout: "pipe",
    stderr: "pipe",
  })

  if (!proc.stdout || !proc.stderr) throw new Error("Process output not available")

  const out = await Promise.all([proc.exited, buffer(proc.stdout), buffer(proc.stderr)])
    .then(([code, stdout, stderr]) => ({
      code,
      stdout,
      stderr,
    }))
    .catch((err: unknown) => {
      if (!opts.nothrow) throw err
      return {
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(errorMessage(err)),
      }
    })
  if (out.code === 0 || opts.nothrow) return out
  throw new RunFailedError(cmd, out.code, out.stdout, out.stderr)
}

// Bounded-stop escalation constants, shared by stop() and stopTree(): time
// allowed for exit after SIGTERM before escalating to SIGKILL, and the bounded
// wait for exit after SIGKILL.
export const STOP_TERM_GRACE_MS = 3_000
export const STOP_KILL_GRACE_MS = 2_000

// Platform group-kill primitive: POSIX signals the process group led by `pid`
// (the child must be a detached group leader); win32 has no group semantics,
// so `taskkill /T /F` tree-kills instead and `signal` is ignored. Resolves
// once the kill is delivered — on win32 that means awaiting the taskkill exit
// code — and throws when delivery fails, leaving fallback and logging to the
// caller.
export async function killGroupPid(pid: number, signal: NodeJS.Signals = "SIGKILL") {
  if (process.platform !== "win32") {
    process.kill(-pid, signal)
    return
  }
  await run(["taskkill", "/pid", String(pid), "/T", "/F"])
}

// Duplicated in `packages/sdk/js/src/process.ts` because the SDK cannot import
// `opencode` without creating a cycle. Keep both copies in sync.
export async function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return

  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    if (await exitedWithin(proc, STOP_TERM_GRACE_MS)) return
    proc.kill("SIGKILL")
    await exitedWithin(proc, STOP_KILL_GRACE_MS)
    return
  }

  try {
    await killGroupPid(proc.pid)
  } catch {
    proc.kill()
  }
}

function exitedWithin(proc: ChildProcess, timeoutMs: number) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      proc.off("exit", done)
      proc.off("error", done)
      resolve(proc.exitCode !== null || proc.signalCode !== null)
    }, timeoutMs)
    proc.once("exit", done)
    proc.once("error", done)
  })
}

export interface StopTreeOptions {
  termGraceMs?: number
  killGraceMs?: number
}

// Kill every pid in the list: SIGTERM round, bounded wait, SIGKILL round,
// bounded wait. The pids may belong to processes we did not spawn
// (grandchildren), so liveness is polled with signal 0 instead of exit events.
export async function stopTree(pids: number[], opts: StopTreeOptions = {}) {
  const targets = pids.filter((pid) => pid > 1)
  if (targets.length === 0) return
  signalTree(targets, "SIGTERM")
  if (await treeExitedWithin(targets, opts.termGraceMs ?? STOP_TERM_GRACE_MS)) return
  signalTree(targets, "SIGKILL")
  await treeExitedWithin(targets, opts.killGraceMs ?? STOP_KILL_GRACE_MS)
}

function signalTree(pids: number[], signal: NodeJS.Signals) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {}
  }
}

function treeExitedWithin(pids: number[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  return new Promise<boolean>((resolve) => {
    const tick = () => {
      if (pids.every((pid) => !alive(pid))) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(tick, 50)
    }
    tick()
  })
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export async function text(cmd: string[], opts: RunOptions = {}): Promise<TextResult> {
  const out = await run(cmd, opts)
  return {
    ...out,
    text: out.stdout.toString(),
  }
}

export async function lines(cmd: string[], opts: RunOptions = {}): Promise<string[]> {
  return (await text(cmd, opts)).text.split(/\r?\n/).filter(Boolean)
}

export * as Process from "./process"
