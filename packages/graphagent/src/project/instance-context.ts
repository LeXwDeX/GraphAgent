import { LocalContext } from "@/util/local-context"
import { FSUtil } from "@graphagent/core/fs-util"
import path from "path"
import { PROJECT_DIR } from "@graphagent/core/brand"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  /** Project root: nearest directory at or above `directory` (bounded by the git toplevel) holding `.agents/`. */
  root: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  // Product-created worktrees live under the project root but are independent
  // checkouts with their own instances. Keep the parent instance's boundary
  // out of them so touching one still asks for external_directory. Test
  // harnesses may provide a partial context without `root`; such a context has
  // no known project layer, so only the directory/worktree boundary applies.
  if (ctx.root && FSUtil.contains(path.join(ctx.root, PROJECT_DIR, "worktree"), filepath)) return false
  if (FSUtil.contains(ctx.directory, filepath)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return FSUtil.contains(ctx.worktree, filepath)
}
