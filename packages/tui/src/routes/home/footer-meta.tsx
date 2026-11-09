// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, type Accessor } from "solid-js"
import { InstallationVersion } from "@graphagent/core/installation/version"
import { useSync } from "../../context/sync"
import { useTuiPaths } from "../../context/runtime"
import { abbreviateHome } from "../../runtime"
import type { FooterMeta } from "../../shell/footer"
import { useHomeSessionDestination } from "./session-destination"

/**
 * Home route information rendered in the footer meta row: the destination
 * directory (with the branch of the current directory), the MCP server count
 * and the application version.
 */
export function useHomeFooterMeta(): Accessor<FooterMeta> {
  const sync = useSync()
  const paths = useTuiPaths()
  const destination = useHomeSessionDestination()

  const directory = createMemo(() => {
    const selected = destination?.destination()
    if (!selected || selected.type === "new") return
    const out = abbreviateHome(selected.directory, paths.home)
    const branch = selected.directory === (sync.path.directory || paths.cwd) ? sync.data.vcs?.branch : undefined
    return branch ? `${out}:${branch}` : out
  })

  const mcp = createMemo(() => {
    const list = Object.values(sync.data.mcp)
    if (list.length === 0) return
    return {
      count: list.filter((item) => item.status === "connected").length,
      error: list.some((item) => item.status === "failed"),
    }
  })

  return createMemo(() => ({ directory: directory(), mcp: mcp(), version: InstallationVersion }))
}
