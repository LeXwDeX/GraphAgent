// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import path from "path"

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
  const toplevel = input.toplevel ? path.resolve(input.toplevel) : undefined
  const fsRoot = path.parse(start).root
  const upper = toplevel ?? (isWithin(start, home) ? home : fsRoot)

  let current = start
  while (true) {
    if (current !== home && current !== fsRoot && input.isDirectory(path.join(current, ".agents"))) return current
    if (current === upper) break
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

export const HOME_ROOT_ERROR =
  "Refusing to write project files because the project root resolves to $HOME. Start from a project directory that contains a .agents/ directory."

/** True when the resolved project root carries a project layer (it is not `$HOME`). */
export function hasProjectLayer(root: string, home: string) {
  return path.resolve(root) !== path.resolve(home)
}

/** Project-layer writes are rejected when the project root is `$HOME`. */
export function assertProjectRootWritable(root: string, home: string) {
  if (!hasProjectLayer(root, home)) throw new Error(HOME_ROOT_ERROR)
}
