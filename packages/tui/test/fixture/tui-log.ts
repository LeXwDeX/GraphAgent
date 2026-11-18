// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs"
import { TuiLog } from "../../src/util/log"

/**
 * The lines of the TUI log that contain `needle`: what a failure path writes (`TuiLog.write`) and a test can wait for
 * instead of sleeping. The append is not awaited by `write`, so a test polls for the line it expects with a bounded
 * wait. The log is one file for the whole test process (`test/preload.ts` gives it a temporary home), so a test
 * names its failure by a session id of its own, or counts the lines before and after.
 */
export function loggedLines(needle: string): string[] {
  try {
    return fs
      .readFileSync(TuiLog.logFilePath(), "utf8")
      .split("\n")
      .filter((line) => line.includes(needle))
  } catch {
    // No line has been written yet.
    return []
  }
}
