// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, createResource, onCleanup, type Accessor } from "solid-js"
import { useRoute } from "../../context/route"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import type { DagIndicatorState } from "../../shell/dag-indicator"
import { TuiLog } from "../../util/log"

/**
 * Footer DAG indicator state for the current route (#886 3.9).
 *
 * Only a root session on the session route has a mode switch; home, the diff
 * route and sub-agent views return `undefined`. The mode itself comes from
 * `Session.dagMode` (kept current by `session.updated`), so the TUI holds no
 * mode state of its own. Availability is only meaningful while the mode is on:
 * it is read from `GET /session/:id/dag-mode` when the mode turns on, when the
 * session, its agent or its model changes, and after a reconnect. Nothing polls.
 */
export function useDagIndicator(): Accessor<DagIndicatorState | undefined> {
  const route = useRoute()
  const sdk = useSDK()
  const sync = useSync()

  const session = createMemo(() => {
    if (route.data.type !== "session") return undefined
    const info = sync.session.get(route.data.sessionID)
    return info && !info.parentID ? info : undefined
  })

  const [availability, { refetch }] = createResource(
    () => {
      const info = session()
      if (!info || info.dagMode !== "on") return undefined
      return {
        sessionID: info.id,
        agent: info.agent,
        model: info.model ? `${info.model.providerID}/${info.model.id}` : undefined,
      }
    },
    async (key) => {
      // A failed lookup leaves the indicator on its plain `on` state; the
      // mode switch itself never depends on this read.
      const result = await sdk.client.session.dagMode({ sessionID: key.sessionID }).catch((error) => {
        TuiLog.write("warn", "DAG mode availability lookup failed", error)
        return undefined
      })
      const status = result?.data
      return status ? { sessionID: key.sessionID, unavailable: status.availability === "unavailable" } : undefined
    },
  )
  onCleanup(sync.onResync(() => void refetch()))

  return createMemo(() => {
    const info = session()
    if (!info) return undefined
    if (info.dagMode !== "on") return "off"
    const known = availability()
    return known?.sessionID === info.id && known.unavailable ? "unavailable" : "on"
  })
}
