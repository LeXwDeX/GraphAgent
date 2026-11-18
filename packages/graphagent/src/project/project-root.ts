// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import path from "path"
import { realpathSync } from "fs"

export interface ProjectRootInput {
  home: string
  /** Git toplevel for the instance directory, absent outside a git repository. */
  toplevel?: string
  /** Directory probe used to find `.agents/` markers. Injected to keep resolution pure. */
  isDirectory: (candidate: string) => boolean
}

/**
 * Resolve the project root for an instance directory.
 *
 * The project root is the nearest directory at or above the instance directory
 * (within its upper bound) that contains a `.agents/` directory. `$HOME` never
 * becomes a project root: `~/.agents` is the user-level shared skills directory,
 * not a project marker. Without a marker, git repositories fall back to the
 * toplevel and everything else to the instance directory.
 */
export function resolveProjectRoot(directory: string, input: ProjectRootInput): string {
  const start = path.resolve(directory)
  const home = path.resolve(input.home)
  const realHome = canonicalize(home)
  const toplevel = input.toplevel ? path.resolve(input.toplevel) : undefined
  const fsRoot = path.parse(start).root
  // `upper` and every `current` are compared in canonical form: a walk that
  // starts from a symlinked spelling of a directory below `$HOME` never meets
  // the canonical home by string, so it would otherwise climb past it.
  const upper = canonicalize(toplevel ?? (isWithin(canonicalize(start), realHome) ? realHome : fsRoot))

  let current = start
  while (true) {
    const canonical = canonicalize(current)
    if (canonical !== realHome && current !== fsRoot && input.isDirectory(path.join(current, ".agents"))) return current
    if (canonical === upper) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return toplevel ?? start
}

/** True when `candidate` is `parent` or lives below it. */
function isWithin(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Resolve `p` to its realpath, falling back to `path.resolve` when the path
 * doesn't exist yet or otherwise can't be resolved.
 *
 * `$HOME` (an environment variable) and `process.cwd()`-derived paths can
 * disagree on whether a symlink along the way has been followed — macOS in
 * particular hands back a resolved cwd while `$HOME` can still carry a
 * symlinked prefix. Comparing the raw strings lets a symlinked home
 * directory slip past the `$HOME` checks below, so every such comparison
 * goes through this first.
 */
function canonicalize(p: string): string {
  const resolved = path.resolve(p)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

export const HOME_ROOT_ERROR =
  "Refusing to write project files because the project root resolves to $HOME. Start from a project directory that contains a .agents/ directory."

/** True when the resolved project root carries a project layer (it is not `$HOME`). */
export function hasProjectLayer(root: string, home: string) {
  return canonicalize(root) !== canonicalize(home)
}

/** Project-layer writes are rejected when the project root is `$HOME`. */
export function assertProjectRootWritable(root: string, home: string) {
  if (!hasProjectLayer(root, home)) throw new Error(HOME_ROOT_ERROR)
}
