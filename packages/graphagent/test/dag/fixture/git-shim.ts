// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * A `git` in front of the real one on PATH, for tests that need to slow git
 * down, hold it at a gate, or make one subcommand fail. `before` is bash that
 * runs ahead of the real git, with `$REAL_GIT` and `$SUB` (the subcommand, past
 * the `-C <directory>` the DAG location code always passes) in scope; whatever
 * it does not `exit` on falls through to the real git. The shim also covers
 * every git the test itself starts while it is installed, so install it after
 * the repository is set up and dispose it before the next step that needs git.
 * POSIX only: the script is bash.
 */
export interface GitShim {
  readonly directory: string
  readonly dispose: () => Promise<void>
}

export async function installGitShim(before: string): Promise<GitShim> {
  const real = Bun.which("git")
  if (!real) throw new Error("git is not on PATH")
  const directory = await mkdtemp(path.join(os.tmpdir(), "graphagent-git-shim-"))
  const shim = path.join(directory, "git")
  await writeFile(
    shim,
    [
      "#!/bin/bash",
      `REAL_GIT=${JSON.stringify(real)}`,
      'SUB="$1"',
      'if [ "$1" = "-C" ]; then SUB="$3"; fi',
      before,
      'exec "$REAL_GIT" "$@"',
      "",
    ].join("\n"),
  )
  await chmod(shim, 0o755)
  const previous = process.env.PATH ?? ""
  process.env.PATH = `${directory}${path.delimiter}${previous}`
  return {
    directory,
    dispose: async () => {
      process.env.PATH = previous
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/** PATH without any git, for the "git cannot be spawned" fallback. */
export async function withoutGit<A>(body: () => Promise<A>): Promise<A> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graphagent-no-git-"))
  const previous = process.env.PATH ?? ""
  process.env.PATH = directory
  try {
    return await body()
  } finally {
    process.env.PATH = previous
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * A gate the shim parks every git command at until `release()`. `started()`
 * resolves once a git command is parked, so a test can look at the process
 * while the command it is waiting for has not returned yet.
 */
export interface GitGate extends GitShim {
  readonly started: () => Promise<void>
  readonly release: () => Promise<void>
}

export async function installGitGate(): Promise<GitGate> {
  const gateDirectory = await mkdtemp(path.join(os.tmpdir(), "graphagent-git-gate-"))
  const parked = path.join(gateDirectory, "parked")
  const released = path.join(gateDirectory, "released")
  const shim = await installGitShim(
    [
      `if [ ! -e ${JSON.stringify(released)} ]; then`,
      `  echo "$SUB" >> ${JSON.stringify(parked)}`,
      `  while [ ! -e ${JSON.stringify(released)} ]; do sleep 0.02; done`,
      "fi",
    ].join("\n"),
  )
  return {
    directory: shim.directory,
    dispose: async () => {
      // Never leave a parked git behind: the release unblocks it.
      await mkdir(gateDirectory, { recursive: true })
      await writeFile(released, "")
      await shim.dispose()
      await rm(gateDirectory, { recursive: true, force: true })
    },
    started: async () => {
      const deadline = Date.now() + 10_000
      while (!existsSync(parked)) {
        if (Date.now() > deadline) throw new Error("no git command reached the gate")
        await Bun.sleep(10)
      }
    },
    release: async () => {
      await writeFile(released, "")
    },
  }
}
