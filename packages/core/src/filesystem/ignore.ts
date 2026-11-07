import { Glob } from "../util/glob"
import { PROJECT_DIR } from "../brand"

const FOLDERS = new Set([
  "node_modules",
  "bower_components",
  ".pnpm-store",
  "vendor",
  ".npm",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "bin",
  "obj",
  ".git",
  ".svn",
  ".hg",
  ".vscode",
  ".idea",
  ".turbo",
  ".output",
  "desktop",
  ".sst",
  ".cache",
  ".webkit-cache",
  "__pycache__",
  ".pytest_cache",
  "mypy_cache",
  ".history",
  ".gradle",
])

const FILES = [
  "**/*.swp",
  "**/*.swo",
  "**/*.pyc",
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/logs/**",
  "**/tmp/**",
  "**/temp/**",
  "**/*.log",
  "**/coverage/**",
  "**/.nyc_output/**",
  // Product-created worktrees are nested checkouts. Their files belong to the
  // worktree's own instance, not to the parent checkout's watcher or index.
  `**/${PROJECT_DIR}/worktree/**`,
]

export const PATTERNS = [...FILES, ...FOLDERS]

export function match(filepath: string, opts?: { extra?: string[]; whitelist?: string[] }) {
  for (const pattern of opts?.whitelist || []) {
    if (Glob.match(pattern, filepath)) return false
  }

  const parts = filepath.split(/[/\\]/)
  for (const part of parts) {
    if (FOLDERS.has(part)) return true
  }

  for (const pattern of [...FILES, ...(opts?.extra || [])]) {
    if (Glob.match(pattern, filepath)) return true
  }

  return false
}

/**
 * True when a relative path names a product-created worktree or anything under
 * it. Worktrees are independent checkouts owned by their own instance; the
 * parent checkout's file tree, search results and watchers must not expose
 * them.
 */
export function isWorktreePath(filepath: string): boolean {
  const parts = filepath.split(/[/\\]/)
  for (let index = 0; index + 1 < parts.length; index++) {
    if (parts[index] === PROJECT_DIR && parts[index + 1] === "worktree") return true
  }
  return false
}

export * as Ignore from "./ignore"
