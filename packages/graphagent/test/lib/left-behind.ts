// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import { readFileSync } from "node:fs"
import path from "node:path"
import { pollWithTimeout } from "./effect"

// The id of the shell's process group (its own pid), or undefined while the
// command has not published it or wrote something else. Only a real id may
// reach `process.kill`, where 0, 1 and negative numbers mean something else.
const published = (file: string) => {
  try {
    const group = Number(readFileSync(file, "utf8"))
    return Number.isInteger(group) && group > 1 ? group : undefined
  } catch {
    return undefined
  }
}

// Whether any process is left in the group. The group outlives its leader for
// as long as one member runs, which is what a process killed by a signal leaves.
const running = (group: number) => {
  try {
    process.kill(-group, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A shell command that starts a process of its own and then dies of SIGKILL.
 * The process keeps no stdio open, so the end of the shell is seen at once and
 * only the shell's process group still reaches it. The shell publishes the id
 * of that group to `file`; `$$` is used because it means the same in every way
 * a command is run, while `$!` is expanded too early by the `!cmd` wrapper.
 * The release of the surrounding scope stops the group if a test failed before
 * it was stopped, so it never keeps running for its five minutes.
 */
export const killedShell = Effect.fn("test.killedShell")(function* (directory: string) {
  const file = path.join(directory, "left-behind.group")
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      const group = published(file)
      if (group === undefined) return
      try {
        process.kill(-group, "SIGKILL")
      } catch {
        // It already stopped, which is the expected case.
      }
    }),
  )
  const command = `echo before; sleep 300 </dev/null >/dev/null 2>&1 & echo $$ >"${file}"; kill -KILL $$`
  return { command, file }
})

/** Passes once no process is left in the killed shell's group, and fails if one still runs after 2 seconds. */
export const expectLeftBehindStopped = (file: string) =>
  pollWithTimeout(
    Effect.sync(() => {
      const group = published(file)
      if (group === undefined) throw new Error(`the command never published its process group id: ${file}`)
      return running(group) ? undefined : (true as const)
    }),
    () => `a process the killed shell started is still running (group file ${file})`,
    "2 seconds",
  )
