// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The sessions a non-interactive `run` answers permission requests for (#1324).
 *
 * A DAG node or a task agent asks as a session of its own, below the one the run
 * drives, so the run has to tell which sessions descend from it. The relation is
 * read through `parentOf` (the session's `parentID`) and remembered once it is
 * settled. A failed lookup is not an answer: nothing is remembered for the
 * session nor for any session whose chain ran through it, and it is asked
 * about again the next time.
 */

/** The parent of a session, undefined for a top-level one; rejects when the lookup fails. */
export type ParentLookup = (sessionID: string) => Promise<string | undefined>

/** A chain longer than this is a cycle or a broken tree, not a workflow. */
const MAX_DEPTH = 32

export function sessionTree(rootSessionID: string, parentOf: ParentLookup) {
  const settled = new Map<string, boolean>([[rootSessionID, true]])

  /** True or false once the whole chain is known, undefined while some link could not be read. */
  async function resolve(sessionID: string, depth: number): Promise<boolean | undefined> {
    const known = settled.get(sessionID)
    if (known !== undefined) return known
    if (depth >= MAX_DEPTH) return undefined
    const parent = await parentOf(sessionID).then(
      (value) => ({ value }),
      () => undefined,
    )
    if (!parent) return undefined
    const inTree = parent.value === undefined ? false : await resolve(parent.value, depth + 1)
    if (inTree !== undefined) settled.set(sessionID, inTree)
    return inTree
  }

  return {
    /** Whether the session is the one the run drives or descends from it. */
    has: async (sessionID: string) => (await resolve(sessionID, 0)) === true,
  }
}
