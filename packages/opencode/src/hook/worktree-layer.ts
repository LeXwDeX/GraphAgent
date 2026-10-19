import path from "node:path"

/**
 * Whether a worktree layer exists for this project. A global non-VCS project
 * reports `worktree = "/"` (the drive root on Windows); treating that as a
 * layer would read `/.opencode/hooks.json` — a file shared by every session on
 * the machine rather than owned by the workspace. Distinct roots are the only
 * valid worktree layers.
 */
export function hasWorktreeLayer(directory: string, worktree: string | undefined): worktree is string {
  if (!worktree || worktree === directory) return false
  const resolved = path.resolve(worktree)
  return path.dirname(resolved) !== resolved
}
