// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * How a non-interactive `run` answers permission requests (#1324).
 *
 * The run answers for its whole session tree, because nobody else could: the
 * session it drives is approved only under `--dangerously-skip-permissions`, every
 * descendant is rejected. A descendant may run in another directory (a DAG node
 * isolated in a worktree, or bound to another one). The server filters the event
 * stream by the client's directory, so the run's own stream never carries those
 * requests; they reach it through the process-wide bus instead, and the answer
 * has to be addressed to the directory that holds the request, as the server only
 * honours the `x-graphagent-directory` and `x-graphagent-workspace` headers. A
 * request can reach the run on both paths; it is answered once.
 */
import { isRecord } from "@/util/record"

/** A permission request, as much of it as the run reads. */
export interface Asked {
  readonly id: string
  readonly sessionID: string
  readonly permission: string
  readonly patterns: readonly string[]
}

/** Where a request is pending, when that is not the directory the client addresses by default. */
export interface Location {
  readonly directory?: string
  readonly workspace?: string
}

/** The request a `permission.asked` event carries, or undefined when the value is not one. */
export function askedPermission(value: unknown): Asked | undefined {
  if (!isRecord(value)) return undefined
  const { id, sessionID, permission, patterns } = value
  if (typeof id !== "string" || typeof sessionID !== "string" || typeof permission !== "string") return undefined
  if (!Array.isArray(patterns)) return undefined
  const list: string[] = []
  for (const pattern of patterns) {
    if (typeof pattern !== "string") return undefined
    list.push(pattern)
  }
  return { id, sessionID, permission, patterns: list }
}

/** The headers that address a request to the directory (and workspace) that holds it. */
export function locationHeaders(location: Location): Record<string, string> {
  const headers: Record<string, string> = {}
  if (location.directory) headers["x-graphagent-directory"] = encodeURIComponent(location.directory)
  if (location.workspace) headers["x-graphagent-workspace"] = location.workspace
  return headers
}

export function permissionAnswerer(input: {
  /** The session the run drives. */
  readonly sessionID: string
  /** Whether a session belongs to the run's tree (see `sessionTree`). */
  readonly tree: { readonly has: (sessionID: string) => Promise<boolean> }
  /** `--dangerously-skip-permissions`: approve the session the run drives. A descendant is never approved. */
  readonly approveOwn: boolean
  /** Send the answer; `location` is where the request is pending, absent for the client's own directory. */
  readonly reply: (requestID: string, reply: "once" | "reject", location?: Location) => Promise<void>
  /** One line for the user: what was asked, and what the run did about it. */
  readonly say: (line: string) => void
}) {
  const answered = new Set<string>()
  return async (request: Asked, location?: Location) => {
    const own = request.sessionID === input.sessionID
    if (!own && !(await input.tree.has(request.sessionID))) return
    // The first path to get here answers; the check and the mark follow the last await.
    if (answered.has(request.id)) return
    answered.add(request.id)
    if (own && input.approveOwn) {
      await input.reply(request.id, "once", location)
      return
    }
    input.say(`permission requested: ${request.permission} (${request.patterns.join(", ")}); auto-rejecting`)
    await input.reply(request.id, "reject", location)
  }
}
