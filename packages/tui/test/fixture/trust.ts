// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ProjectTrustEntry } from "@graphagent/sdk"
import { json, type FetchHandler } from "./tui-sdk"

/** A project command as the server lists it; `change` is left out of the body when there is none. */
export function trustEntry(
  id: string,
  state: ProjectTrustEntry["state"],
  change?: ProjectTrustEntry["change"],
): ProjectTrustEntry {
  return {
    id,
    category: "hook",
    fp: `fp-${id}`,
    state,
    ...(change === undefined ? {} : { change }),
    source: { file: ".agents/hooks.json", line: 3 },
    when: "PreToolUse",
    command: `bun run ${id}`,
    risks: [],
  }
}

/**
 * The server's list of project commands (`GET /project/trust`), changed by hand: the sync layer re-reads it after a
 * `project.trust.updated` event, as it does in the app.
 */
export function trusting(initial: readonly ProjectTrustEntry[]) {
  let entries = initial
  const handler: FetchHandler = (url) => (url.pathname === "/project/trust" ? json({ entries }) : undefined)
  return {
    handler,
    set(next: readonly ProjectTrustEntry[]) {
      entries = next
    },
  }
}
