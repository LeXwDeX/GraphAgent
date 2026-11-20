// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, type Accessor } from "solid-js"
import { InstallationVersion } from "@graphagent/core/installation/version"
import { useSync } from "../../context/sync"
import type { FooterMeta } from "../../shell/footer"

/**
 * Home route information rendered in the footer meta row: the MCP server count and the application version. The
 * directory a new session starts in, with its branch, is in the top bar (#1674).
 */
export function useHomeFooterMeta(): Accessor<FooterMeta> {
  const sync = useSync()

  const mcp = createMemo(() => {
    const list = Object.values(sync.data.mcp)
    if (list.length === 0) return
    return {
      count: list.filter((item) => item.status === "connected").length,
      error: list.some((item) => item.status === "failed"),
    }
  })

  const trust = createMemo(() => {
    const pending = sync.data.trust.filter((entry) => entry.state === "pending").length
    return pending > 0 ? pending : undefined
  })

  return createMemo(() => ({ mcp: mcp(), trust: trust(), version: InstallationVersion }))
}
