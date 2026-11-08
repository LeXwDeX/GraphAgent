/**
 * Hook command expansion and process execution.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 */
import path from "path"
import os from "os"
import { existsSync, statSync } from "fs"
import { spawn } from "child_process"
import { createHash } from "crypto"
import { Global } from "@graphagent/core/global"
import * as Log from "@/util/log"
import { Process } from "@/util/process"
import type { HookCommand, HookEvent, HookEffort } from "../types"

const log = Log.create({ service: "hook.settings" })

/**
 * Per-plugin data directory layout (CC plugin contract):
 *   <Global.Path.data>/hooks/<parentBasename>-<basename>-<sha256(sourceDir).slice(0,6)>
 *
 * Hash suffix disambiguates two plugins whose paths happen to share the same
 * `<parent>/<basename>` tail (e.g. installed under different roots).
 */
function computeDataDir(sourceDir: string): string {
  const hash = createHash("sha256").update(sourceDir).digest("hex").slice(0, 6)
  const parent = path.basename(path.dirname(sourceDir))
  const base = path.basename(sourceDir)
  return path.join(Global.Path.data, "hooks", `${parent}-${base}-${hash}`)
}

/**
 * Expand CC-compatible template variables in `entry.command`.
 *
 *   ${CLAUDE_PLUGIN_ROOT}  → entry.__sourceDir
 *   ${CLAUDE_PLUGIN_DATA}  → computeDataDir(entry.__sourceDir)
 *   ${user_config.<key>}   → entry.options?.[key] (string passthrough; non-string → JSON.stringify)
 *
 * Unknown / unresolvable templates are left verbatim so the shell's own env
 * expansion (or the user's escape strategy) still has a chance to handle them.
 * Read-only: never mutates `entry`.
 */
function expandTemplate(
  entry: HookCommand,
  text: string,
  execForm: boolean,
  options: { cwd?: string; powershell?: boolean } = {},
): string {
  return text.replace(/\$\{([^}]+)\}/g, (full, key) => {
    // PowerShell resolves exported variables after parsing, so a path with spaces
    // or quotes stays one value. Rewrite to its `${env:NAME}` form (reference 4176).
    if (
      options.powershell &&
      !execForm &&
      (key === "CLAUDE_PROJECT_DIR" || key === "CLAUDE_PLUGIN_ROOT" || key === "CLAUDE_PLUGIN_DATA")
    )
      return "${env:" + key + "}"
    if (key === "CLAUDE_PROJECT_DIR" && execForm && options.cwd !== undefined) return options.cwd
    if (key === "CLAUDE_PLUGIN_ROOT" && entry.__sourceDir) return entry.__sourceDir
    if (key === "CLAUDE_PLUGIN_DATA" && entry.__sourceDir) return computeDataDir(entry.__sourceDir)
    if (execForm && key.startsWith("user_config.")) {
      const optKey = key.slice("user_config.".length)
      const v = entry.options?.[optKey]
      if (v !== undefined) return typeof v === "string" ? v : JSON.stringify(v)
    }
    return full
  })
}

/** Exported for unit testing: placeholder expansion exactly as the spawn path applies it. */
export function expandHookCommand(entry: HookCommand, options: { cwd?: string; powershell?: boolean } = {}): string {
  return expandCommand(entry, options)
}

export function expandCommand(entry: HookCommand, options: { cwd?: string; powershell?: boolean } = {}): string {
  return expandTemplate(entry, commandText(entry), entry.args !== undefined, options)
}

export interface ShellProbe {
  readonly platform: NodeJS.Platform
  readonly env: Record<string, string | undefined>
  readonly exists: (file: string) => boolean
}

export interface ResolvedShell {
  readonly kind: "sh" | "bash" | "powershell"
  readonly file: string
}

const defaultShellProbe = (): ShellProbe => ({ platform: process.platform, env: process.env, exists: existsSync })

/**
 * Resolve the interpreter for a shell-form command hook. Windows defaults to Git Bash
 * when it is actually installed and falls back to PowerShell otherwise (reference 460/471).
 * Exported for unit testing; the probe lets tests describe a Windows host.
 */
export function resolveHookShell(
  entry: Pick<HookCommand, "shell">,
  probe: ShellProbe = defaultShellProbe(),
): ResolvedShell {
  const windows = probe.platform === "win32"
  // oxlint-disable-next-line typescript-eslint/unbound-method
  const join = windows ? path.win32.join : path.join
  const pathDirs = (probe.env.PATH ?? probe.env.Path ?? "").split(windows ? ";" : ":").filter(Boolean)
  const findOnPath = (names: string[]) => {
    for (const dir of pathDirs) for (const name of names) if (probe.exists(join(dir, name))) return join(dir, name)
    return undefined
  }
  const powershell = (): ResolvedShell => {
    if (!windows) return { kind: "powershell", file: "pwsh" }
    return { kind: "powershell", file: findOnPath(["pwsh.exe"]) ?? "powershell.exe" }
  }
  const gitBash = (): string | undefined => {
    if (!windows) return undefined
    const roots = [probe.env.ProgramFiles, probe.env["ProgramFiles(x86)"], probe.env.ProgramW6432].filter(
      (value): value is string => !!value,
    )
    const candidates = [
      probe.env.CLAUDE_CODE_GIT_BASH_PATH,
      ...roots.map((root) => join(root, "Git", "bin", "bash.exe")),
      probe.env.LOCALAPPDATA ? join(probe.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe") : undefined,
    ]
    for (const candidate of candidates) if (candidate && probe.exists(candidate)) return candidate
    const git = findOnPath(["git.exe"])
    if (git) {
      const base = path.win32.dirname(path.win32.dirname(git))
      for (const candidate of [join(base, "bin", "bash.exe"), join(path.win32.dirname(base), "bin", "bash.exe")])
        if (probe.exists(candidate)) return candidate
    }
    return undefined
  }
  if (entry.shell === "powershell") return powershell()
  if (!windows) return entry.shell === "bash" ? { kind: "bash", file: "/bin/bash" } : { kind: "sh", file: "/bin/sh" }
  const bash = gitBash()
  if (bash) return { kind: "bash", file: bash }
  // An explicit bash request keeps its PATH lookup; the default has no usable bash at all.
  return entry.shell === "bash" ? { kind: "bash", file: "bash.exe" } : powershell()
}

export function commandText(entry: HookCommand): string {
  return entry.command ?? ""
}

export function httpUrl(entry: HookCommand): string {
  return entry.url ?? entry.command ?? ""
}

export function promptText(entry: HookCommand): string {
  return entry.prompt ?? entry.command ?? ""
}

// ── Shell command runner ────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 600_000
export function timeoutFor(entry: HookCommand, event: HookEvent): number {
  if (entry.timeout !== undefined) return entry.timeout * 1000
  if (entry.type === "prompt") return 30_000
  if (entry.type === "agent") return 60_000
  if (event === "SessionEnd") {
    const override = Number(process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS)
    return Number.isFinite(override) && override > 0 ? override : 1_500
  }
  if (event === "MessageDisplay") return 10_000
  if (["UserPromptSubmit", "PreModelSwitch", "PostModelSwitch"].includes(event)) return 30_000
  return DEFAULT_TIMEOUT_MS
}

// #500: after the child exits (or the spawn timeout SIGTERMs it), stdio EOF is
// given this grace before the whole process group is SIGKILLed; DRAIN_MS is
// the post-kill window for final buffered output before resolving partial.
const KILL_GRACE_MS = 2_000
const DRAIN_MS = 500

/**
 * A deleted working directory must not disable hooks for the rest of the
 * session: the reference falls back to the session-start directory, the
 * project root, home, then temp. The instance directory (`cwd`) is already
 * the first candidate; the stable project root survives its deletion.
 */
export function resolveHookCwd(candidates: readonly (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // Missing or unreadable: try the next fallback.
    }
  }
  return os.tmpdir()
}

export function execShell(
  entry: HookCommand,
  stdinJSON: string,
  cwd: string,
  signal: AbortSignal,
  event: HookEvent,
  environmentFile?: string,
  environment?: Record<string, string | undefined>,
  effort?: HookEffort,
  /** Stable project root; `cwd` above stays the working directory of the child. */
  projectDir?: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; spawnError?: string; suspect?: boolean }> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ exitCode: null, stdout: "", stderr: "" })
      return
    }
    // CLAUDE_PROJECT_DIR names the project, not the (possibly nested) working
    // directory, so both the exported variable and its placeholder use it.
    const hookProjectDir = projectDir ?? cwd
    const timeoutMs = timeoutFor(entry, event)
    const shell = resolveHookShell(entry)
    const expandedCommand = expandCommand(entry, { cwd: hookProjectDir, powershell: shell.kind === "powershell" })

    const command = commandText(entry)
    log.debug("hook spawn", { command: command.slice(0, 200), cwd, timeoutMs })

    // WP-6C: plugin-directory liveness pre-check.
    // When __sourceDir is stamped but the directory has since been GC'd
    // (plugin uninstalled, repo cleaned, etc.) the expanded command would
    // either fail at exec time with exit-127 or — worse — silently run a
    // partial template. Treat the missing dir as "plugin no longer available"
    // and silent-allow rather than letting the shell turn it into a misleading
    // exit-2 deny. spawnError stays undefined so the trigger reducer keeps
    // the same allow path it already uses for spawnError-set entries.
    if (entry.__sourceDir && !existsSync(entry.__sourceDir)) {
      log.warn("hook plugin sourceDir missing — silent allow", {
        command,
        sourceDir: entry.__sourceDir,
      })
      resolve({ exitCode: 0, stdout: "", stderr: "" })
      return
    }

    const extraEnv: Record<string, string> = { CLAUDE_PROJECT_DIR: hookProjectDir }
    if (effort) extraEnv.CLAUDE_EFFORT = effort
    if (entry.__sourceDir) {
      extraEnv.CLAUDE_PLUGIN_ROOT = entry.__sourceDir
      extraEnv.CLAUDE_PLUGIN_DATA = computeDataDir(entry.__sourceDir)
    }
    if (entry.options) {
      for (const [k, v] of Object.entries(entry.options)) {
        const key = "CLAUDE_PLUGIN_OPTION_" + k.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()
        extraEnv[key] = JSON.stringify(v)
      }
    }

    // POSIX: run the child as a process-group leader so a hung grandchild
    // holding the stdio pipes can be signaled as a group (#500). Windows
    // relies on `taskkill /T` tree kill instead.
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...environment,
      ...extraEnv,
      ...(environmentFile &&
      ["SessionStart", "Setup", "CwdChanged", "FileChanged"].includes(event) &&
      shell.kind !== "powershell"
        ? { CLAUDE_ENV_FILE: environmentFile }
        : {}),
    }
    // SessionStart may unset an inherited variable. Spawner APIs can stringify
    // undefined, so remove it explicitly before creating the child.
    for (const [name, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[name]
    const child = spawn(
      expandedCommand,
      entry.args?.map((arg) => expandTemplate(entry, arg, true, { cwd: hookProjectDir })) ?? [],
      {
        cwd,
        shell: entry.args === undefined ? shell.file : false,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    )

    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d: string) => (stdout += d))
    child.stderr.on("data", (d: string) => (stderr += d))

    // EPIPE on stdin must not crash the host process (fork commit 0f3017f33a)
    child.stdin.on("error", (err) => {
      log.warn("hook stdin error", { command, error: err.message })
    })

    try {
      child.stdin.write(stdinJSON + "\n", "utf8")
      child.stdin.end()
    } catch (err) {
      log.warn("hook stdin write failed", { command, error: String(err) })
    }

    // #500: `close` only fires after BOTH exit and stdio EOF; a grandchild
    // that inherits the pipes and outlives the shell blocks EOF forever, so
    // the old `close` waiter never resolved. Exit and stream EOF are now
    // awaited as independent conditions, with a process-group SIGKILL as the
    // fallback that guarantees resolution.
    let exitCode: number | null = null
    let timedOut = false
    let settled = false
    let streamsClosed = false
    let suspect = false
    const timers = new Set<NodeJS.Timeout>()
    const arm = (fire: () => void, ms: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!settled) fire()
      }, ms)
      timers.add(timer)
    }
    const exited = new Promise<void>((resolveExit) => {
      child.on("exit", (code) => {
        exitCode = code
        resolveExit()
      })
    })
    // `end` alone is not enough: on spawn failure the streams can close or
    // error without ever reaching EOF.
    const streamSettled = (stream: NodeJS.ReadableStream) =>
      new Promise<void>((resolveStream) => {
        stream.on("end", resolveStream)
        stream.on("close", resolveStream)
        stream.on("error", resolveStream)
      })
    const streamsDone = Promise.all([streamSettled(child.stdout), streamSettled(child.stderr)]).then(() => {
      streamsClosed = true
    })
    const finish = (spawnError?: string) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", afterKill)
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      child.stdout.destroy()
      child.stderr.destroy()
      log.debug("hook close", {
        command: command.slice(0, 80),
        exitCode,
        stdoutLen: stdout.length,
        stderrLen: stderr.length,
      })
      const code = timedOut || signal.aborted ? null : exitCode
      resolve({
        exitCode: code,
        stdout,
        stderr,
        ...(spawnError === undefined ? {} : { spawnError }),
        ...(suspect ? { suspect: true } : {}),
      })
    }

    child.on("error", (err) => {
      log.error("hook command failed to spawn", { command, error: err.message })
      finish(err.message)
    })

    let killSent = false
    const killGroup = () => {
      if (killSent || child.pid === undefined) return
      killSent = true
      void Process.killGroupPid(child.pid, "SIGKILL").catch((err) => {
        log.warn("hook process-group kill failed", { command, error: String(err) })
      })
    }
    const afterKill = () => {
      killGroup()
      const drained = new Promise<void>((resolveDrain) => arm(resolveDrain, DRAIN_MS))
      void Promise.all([exited, Promise.race([streamsDone, drained])]).then(() => finish())
    }

    signal.addEventListener("abort", afterKill, { once: true })
    if (signal.aborted) afterKill()

    void Promise.all([exited, streamsDone]).then(() => finish())

    // Child exited but pipes are still open (grandchild holds them): kill the
    // group after the EOF grace, then resolve with whatever was captured.
    // A synchronous hook whose own process exited but whose pipes stay open has a
    // grandchild still able to write; its capture cannot be trusted (reference 885).
    void exited.then(() =>
      arm(() => {
        if (!streamsClosed && !timedOut && !signal.aborted && !(entry.async || entry.asyncRewake)) suspect = true
        afterKill()
      }, KILL_GRACE_MS),
    )

    // Child ignored the spawn-timeout SIGTERM and never exited: kill the group
    // at the absolute deadline, wait for the reap, then resolve.
    if (!(entry.async && !entry.asyncRewake))
      arm(() => {
        timedOut = true
        if (child.pid !== undefined)
          void Process.killGroupPid(child.pid, "SIGTERM").catch((error) => {
            log.warn("hook process-group termination failed", { error: String(error) })
          })
        arm(afterKill, KILL_GRACE_MS)
      }, timeoutMs)
  })
}
