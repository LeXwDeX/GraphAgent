/** Repository CI monitoring only: no merge, push, credential changes, or shell evaluation. */
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const record = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined)

export function prURL(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash)
      return undefined
    if (url.hostname !== (process.env.GH_HOST ?? "github.com")) return undefined
    if (!/^\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(url.pathname)) return undefined
    return url.href
  } catch {
    return undefined
  }
}

export function requestedPR(
  input: unknown,
): { url: string; scratchpad: string; cwd: string; session: string } | undefined {
  const hook = record(input)
  const tool = record(hook?.tool_input)
  const response = record(hook?.tool_response)
  if (hook?.hook_event_name !== "PostToolUse" || !["bash", "Bash"].includes(String(hook.tool_name))) return undefined
  if (
    typeof hook.scratchpad_dir !== "string" ||
    !path.isAbsolute(hook.scratchpad_dir) ||
    typeof hook.session_id !== "string" ||
    typeof hook.cwd !== "string"
  )
    return undefined
  if (
    response &&
    [response.exit, response.exitCode, response.exit_code, record(response.metadata)?.exit].some(
      (code) => typeof code === "number" && code !== 0,
    )
  )
    return undefined
  const output = typeof hook.tool_response === "string" ? hook.tool_response : (response?.output ?? response?.stdout)
  if (typeof output !== "string") return undefined
  // Recognize a direct gh invocation or the explicit request helper's output.
  // Never evaluate, interpolate, or replay the tool's command or its arguments.
  const direct = typeof tool?.command === "string" && /^\s*gh\s+pr\s+create(?:\s|$)/.test(tool.command)
  for (const line of output.split("\n")) {
    const explicit = line.startsWith("OPENCODE_CI_WATCH ")
    const url = prURL(explicit ? line.slice("OPENCODE_CI_WATCH ".length) : line)
    if (url && (direct || explicit))
      return { url, scratchpad: hook.scratchpad_dir, cwd: hook.cwd, session: hook.session_id }
  }
  return undefined
}

export type CommandResult = { code: number; stdout: string }
export type Run = (args: string[], signal: AbortSignal) => Promise<CommandResult>

export function ghRunner(cwd: string, executable = "gh", commandTimeoutMs = 10_000): Run {
  return (args, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("cancelled"))
      const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "ignore"], shell: false })
      let stdout = ""
      let stopped = false
      const stop = () => {
        stopped = true
        child.kill("SIGKILL")
      }
      const timer = setTimeout(stop, commandTimeoutMs)
      signal.addEventListener("abort", stop, { once: true })
      child.stdout.on("data", (chunk) => {
        if (stdout.length + chunk.length > 1_048_576) stop()
        else stdout += chunk.toString()
      })
      const clean = () => {
        clearTimeout(timer)
        signal.removeEventListener("abort", stop)
      }
      child.on("error", () => {
        clean()
        reject(new Error("GitHub CLI unavailable"))
      })
      child.on("close", (code) => {
        clean()
        stopped ? reject(new Error("GitHub query interrupted")) : resolve({ code: code ?? 1, stdout })
      })
    })
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })

export async function watch(input: {
  url: string
  scratchpad: string
  session: string
  run: Run
  signal: AbortSignal
  intervalMs?: number
  timeoutMs?: number
}): Promise<string | undefined> {
  const { url, run, signal } = input
  const interval = input.intervalMs ?? 45_000
  const deadline = Date.now() + (input.timeoutMs ?? 45 * 60_000)
  const view = async () => {
    const response = await run(["pr", "view", url, "--json", "number,headRefOid,url"], signal)
    const data = response.code === 0 ? record(JSON.parse(response.stdout)) : undefined
    if (
      !data ||
      data.url !== url ||
      typeof data.number !== "number" ||
      typeof data.headRefOid !== "string" ||
      !/^[a-f0-9]{40,64}$/i.test(data.headRefOid)
    )
      throw new Error("PR identity unavailable")
    return { number: data.number, head: data.headRefOid }
  }
  let identity: Awaited<ReturnType<typeof view>>
  try {
    identity = await view()
  } catch {
    return signal.aborted ? undefined : `CI watcher: ${url}: unable to resolve PR/head; run /watch-ci to retry.`
  }
  if (signal.aborted) return undefined
  const key = createHash("sha256").update(`${url}\n${identity.head}`).digest("hex")
  const directory = path.join(input.scratchpad, "pr-ci-watch")
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const lock = path.join(directory, `${key}.lock`)
  const receipt = path.join(directory, `${key}.json`)
  if (
    await fs.stat(receipt).then(
      () => true,
      () => false,
    )
  )
    return undefined
  const token = randomUUID()
  try {
    await fs.mkdir(lock)
  } catch (error) {
    if (record(error)?.code !== "EEXIST") throw error
    // Serialize stale-owner reclamation and re-read after acquiring the reaper.
    // A live/initializing owner is never stolen, including during concurrent retries.
    const reaper = `${lock}.reap`
    try {
      await fs.mkdir(reaper)
    } catch {
      return undefined
    }
    try {
      const owner = await fs
        .readFile(path.join(lock, "owner.json"), "utf8")
        .then((text) => record(JSON.parse(text)))
        .catch(() => undefined)
      const stat = await fs.stat(lock).catch(() => undefined)
      if (owner && typeof owner.pid === "number" ? alive(owner.pid) : stat && Date.now() - stat.mtimeMs < 10_000)
        return undefined
      await fs.rm(lock, { recursive: true, force: true })
      try {
        await fs.mkdir(lock)
      } catch {
        return undefined
      }
    } finally {
      await fs.rmdir(reaper)
    }
  }
  await fs.writeFile(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, token, session: input.session }),
    { mode: 0o600 },
  )
  const conclusion = async (result: string) => {
    if (signal.aborted) return undefined
    const message = `CI watcher: PR #${identity.number}, head ${identity.head}, ${result}. ${url}`
    if (result.startsWith("success") || result.startsWith("failure"))
      await fs.writeFile(receipt, JSON.stringify({ pr: url, head: identity.head, conclusion: result }), { mode: 0o600 })
    return message
  }
  try {
    if (
      await fs.stat(receipt).then(
        () => true,
        () => false,
      )
    )
      return undefined
    let queryErrors = 0
    while (!signal.aborted) {
      if (Date.now() >= deadline) return await conclusion("timeout; checks did not settle before the deadline")
      try {
        if ((await view()).head !== identity.head)
          return await conclusion("superseded; head changed, start /watch-ci for the new head")
        const checks = await run(["pr", "checks", url, "--json", "bucket"], signal)
        const rows: unknown = JSON.parse(checks.stdout)
        if (
          ![0, 1, 8].includes(checks.code) ||
          !Array.isArray(rows) ||
          rows.some((row) => !["pass", "fail", "pending", "skipping", "cancel"].includes(String(record(row)?.bucket)))
        )
          throw new Error("Checks unavailable")
        queryErrors = 0
        if (rows.length > 0 && rows.every((row) => record(row)?.bucket !== "pending")) {
          // Close the view/checks race: never report success for a different head.
          if ((await view()).head !== identity.head)
            return await conclusion("superseded; head changed, start /watch-ci for the new head")
          const failed = rows.filter((row) => ["fail", "cancel"].includes(String(record(row)?.bucket))).length
          return await conclusion(
            failed
              ? `failure (${failed}/${rows.length} checks failed or cancelled)`
              : `success (${rows.length} checks settled)`,
          )
        }
      } catch {
        if (signal.aborted) return undefined
        if (++queryErrors >= 3)
          return await conclusion(
            "unavailable; three GitHub queries failed, inspect authentication/connectivity and retry",
          )
      }
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), signal)
    }
  } finally {
    const owner = await fs
      .readFile(path.join(lock, "owner.json"), "utf8")
      .then((text) => record(JSON.parse(text)))
      .catch(() => undefined)
    if (owner?.token === token) await fs.rm(lock, { recursive: true, force: true })
  }
  return undefined
}

export async function main(
  args = process.argv.slice(2),
  options: { intervalMs?: number; timeoutMs?: number; commandTimeoutMs?: number; parentCheckMs?: number } = {},
) {
  if (args[0] === "guidance") {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            "Repository CI watcher is installed: a successful direct gh pr create starts background checks for its PR/head. Keep working; completion returns to this session. For an existing PR, a compound command, or a changed head use /watch-ci [PR]. Do not start gh pr checks --watch in the foreground or merge until required current-head checks pass.",
        },
      }),
    )
    return 0
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once("SIGTERM", cancel)
  process.once("SIGINT", cancel)
  // The installed template uses args (shell:false), so the direct parent is the host.
  const parent = process.ppid
  const supervisor = setInterval(() => {
    if (process.ppid !== parent || !alive(parent)) cancel()
  }, options.parentCheckMs ?? 1000)
  try {
    const run = ghRunner(process.cwd())
    if (args[0] === "request") {
      const target = args[1]
      if (target && !/^[1-9]\d*$/.test(target) && !prURL(target))
        throw new Error("Use a PR number or configured-host HTTPS PR URL")
      const result = await run(["pr", "view", ...(target ? [target] : []), "--json", "url"], controller.signal)
      const url = result.code === 0 && prURL(record(JSON.parse(result.stdout))?.url)
      if (!url) throw new Error("PR URL unavailable")
      console.log(`OPENCODE_CI_WATCH ${url}`)
      return 0
    }
    const input = requestedPR(JSON.parse(await Bun.stdin.text()))
    if (!input) return 0
    const message = await watch({
      ...input,
      run: ghRunner(input.cwd, "gh", options.commandTimeoutMs),
      signal: controller.signal,
      intervalMs: options.intervalMs,
      timeoutMs: options.timeoutMs,
    })
    if (!message || controller.signal.aborted) return 0
    console.error(message)
    return 2 // asyncRewake wakes the originating session only on exit 2.
  } catch {
    if (controller.signal.aborted) return 0
    console.error("CI watcher could not start; inspect the local setup and use /watch-ci to retry.")
    return 2
  } finally {
    clearInterval(supervisor)
    process.removeListener("SIGTERM", cancel)
    process.removeListener("SIGINT", cancel)
  }
}

if (import.meta.main) process.exitCode = await main()
