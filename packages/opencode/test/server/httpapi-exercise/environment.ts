import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect } from "effect"
import { mkdirSync } from "fs"
import path from "path"

const preserveExerciseGlobalRoot = !!process.env.GRAPHAGENT_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot =
  process.env.GRAPHAGENT_HTTPAPI_EXERCISE_GLOBAL ??
  path.join(process.env.TMPDIR ?? "/tmp", `opencode-httpapi-global-${process.pid}`)
process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
export const exerciseConfigDirectory = path.join(exerciseGlobalRoot, "config", "opencode")
export const exerciseDataDirectory = path.join(exerciseGlobalRoot, "data", "opencode")
// Requests without a directory resolve to process.cwd(). Auth probes and global
// scenarios execute real handlers, so they must never resolve to the invoking
// checkout (POST /experimental/worktree would create a worktree and branch there).
export const exerciseWorkingDirectory = path.join(exerciseGlobalRoot, "cwd")
export const invokingDirectory = process.cwd()
mkdirSync(exerciseWorkingDirectory, { recursive: true })

// Called by the exercise entry point only: unit tests import this module too and
// must keep their own working directory.
export const enterExerciseWorkingDirectory = () => process.chdir(exerciseWorkingDirectory)

// Worktrees registered on the invoking checkout; the exercise must leave this set unchanged.
export const invokingWorktrees = () => {
  const result = Bun.spawnSync(["git", "-C", invokingDirectory, "worktree", "list", "--porcelain"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  if (result.exitCode !== 0) return []
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
}

const preserveExerciseDatabase = !!process.env.GRAPHAGENT_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath =
  process.env.GRAPHAGENT_HTTPAPI_EXERCISE_DB ??
  path.join(process.env.TMPDIR ?? "/tmp", `opencode-httpapi-exercise-${process.pid}.db`)
process.env.GRAPHAGENT_DB = exerciseDatabasePath
Flag.GRAPHAGENT_DB = exerciseDatabasePath

export const original = {
  GRAPHAGENT_SERVER_PASSWORD: Flag.GRAPHAGENT_SERVER_PASSWORD,
  GRAPHAGENT_SERVER_USERNAME: Flag.GRAPHAGENT_SERVER_USERNAME,
}

export const cleanupExercisePaths = Effect.promise(async () => {
  const fs = await import("fs/promises")
  if (!preserveExerciseDatabase) {
    await Promise.all(
      [exerciseDatabasePath, `${exerciseDatabasePath}-wal`, `${exerciseDatabasePath}-shm`].map((file) =>
        fs.rm(file, { force: true }).catch(() => undefined),
      ),
    )
  }
  if (!preserveExerciseGlobalRoot) {
    // Never remove the directory the process is running in.
    if (process.cwd() === exerciseWorkingDirectory) process.chdir(invokingDirectory)
    await fs.rm(exerciseGlobalRoot, { recursive: true, force: true }).catch(() => undefined)
  }
})
