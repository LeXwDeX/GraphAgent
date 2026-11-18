// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// Launch log of the process-tree fixture (#503). server-stdio.ts appends one
// "<server pid> <child pid>" line per launch to the file named by
// MCP_FIXTURE_CHILD_PID_FILE. One connect launches that server more than once:
// the SDK negotiates the protocol era on a disposable sibling before it starts
// the real session, and the sibling's child is known to nobody but this log.
// The probe and the test read it to reap every child the fixture started.
import fs from "fs/promises"

export type Launch = { server: number; child: number }

export async function readLaunches(file: string): Promise<Launch[]> {
  const text = await fs.readFile(file, "utf8").catch(() => "")
  // The last segment is empty or an unterminated (still being written) line.
  return text
    .split("\n")
    .slice(0, -1)
    .flatMap((line) => {
      const [server, child] = line.trim().split(/\s+/).map(Number)
      return Number.isInteger(server) && server > 1 && Number.isInteger(child) && child > 1 ? [{ server, child }] : []
    })
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
