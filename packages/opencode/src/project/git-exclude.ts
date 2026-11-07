import { execFile } from "node:child_process"
import { appendFile, mkdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { FSUtil } from "@opencode-ai/core/fs-util"

export interface RepoLayout {
  root: string
  commonDir: string
  /** Repository-relative execution directory, git's `--show-prefix` (trailing slash). */
  prefix: string
}

const execFileAsync = promisify(execFile)

export async function repoLayout(directory: string): Promise<RepoLayout | undefined> {
  const base = path.resolve(directory)
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", base, "rev-parse", "--show-toplevel", "--git-common-dir", "--show-prefix"],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    )
    // Three values plus the trailing newline. A path containing a newline
    // shifts these fields, so refuse the layout instead of acting on it.
    const lines = stdout.split(/\r?\n/)
    if (lines.length !== 4 || lines[3] !== "") return undefined
    const [root, common, prefix = ""] = lines
    if (!root || !common) return undefined
    const commonDir = path.resolve(base, common)
    const [rootInfo, commonInfo] = await Promise.all([
      stat(root).catch(() => undefined),
      stat(commonDir).catch(() => undefined),
    ])
    if (!rootInfo?.isDirectory() || !commonInfo?.isDirectory()) return undefined
    return { root, commonDir, prefix }
  } catch {
    return undefined
  }
}

/** Resolve symlinks (macOS `/var` → `/private/var`) and dot segments without
 * requiring the leaf to exist; walk up to the nearest real ancestor and append
 * the missing segments. */
export async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value)
  const missing: string[] = []
  let current = resolved
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return FSUtil.normalizePath(resolved)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * Git ignore patterns trim trailing spaces and treat `#`/`!` at the start,
 * plus `*`, `?`, `[`, `\` anywhere, as pattern syntax. The report area is a
 * literal directory path, so escape those characters; otherwise an adversarial
 * checkout name would ignore unrelated files.
 */
export function escapeGitIgnorePath(value: string): string {
  const trailingSpaces = value.length - value.replace(/ +$/, "").length
  const body = value.slice(0, value.length - trailingSpaces)
  let escaped = ""
  for (let index = 0; index < body.length; index++) {
    const char = body.charAt(index)
    if (char === "\\" || char === "*" || char === "?" || char === "[") escaped += `\\${char}`
    else if (index === 0 && (char === "#" || char === "!")) escaped += `\\${char}`
    else escaped += char
  }
  return `${escaped}${"\\ ".repeat(trailingSpaces)}`
}

// Serialize appends per exclude file so concurrent captures in one process do
// not interleave a read/append pair and duplicate the entry.
const excludeWrites = new Map<string, Promise<void>>()

export function appendExcludeEntries(file: string, entries: string[]) {
  const previous = excludeWrites.get(file) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const existing = await readFile(file, "utf8").catch(() => "")
      const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()))
      const missing = entries.filter((entry) => !lines.has(entry) && !lines.has(entry.replace(/\/$/, "")))
      if (missing.length === 0) return
      await mkdir(path.dirname(file), { recursive: true })
      const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
      await appendFile(file, `${separator}${missing.join("\n")}\n`)
    })
  excludeWrites.set(file, next)
  return next.finally(() => {
    if (excludeWrites.get(file) === next) excludeWrites.delete(file)
  })
}

/**
 * Product-owned local files under the project root. They are written inside the
 * checkout but must never appear as parent-repository changes, so the shared
 * `info/exclude` of the git common dir (not `.gitignore`) lists them. Anchored
 * to the project root, which may sit below the git toplevel.
 */
export const LOCAL_GIT_EXCLUDES = [
  ".agents/worktree/",
  ".agents/plans/",
  ".agents/settings.local.json",
  ".agents/hooks.local.json",
] as const

/** Idempotently ensure the project's local-file excludes. Non-git directories are skipped. */
export async function ensureLocalExcludes(input: { root: string; directory?: string }): Promise<void> {
  const layout = await repoLayout(input.directory ?? input.root)
  if (!layout) return
  const [toplevel, root] = await Promise.all([canonicalPath(layout.root), canonicalPath(input.root)])
  const relative = path.relative(toplevel, root)
  const prefix =
    relative === "" || relative.startsWith("..") || path.isAbsolute(relative)
      ? ""
      : `${relative.split(path.sep).join("/")}/`
  const entries = LOCAL_GIT_EXCLUDES.map((entry) => `/${prefix}${entry}`)
  await appendExcludeEntries(path.join(layout.commonDir, "info", "exclude"), entries)
}
