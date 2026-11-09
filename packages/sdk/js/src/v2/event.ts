// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Event } from "./gen/types.gen.js"

/**
 * Envelope for routed events forwarded from the server's GlobalBus to the TUI
 * worker over the `global.events` RPC frame.
 *
 * `/global/event` was removed with the remote-workspace transport (#1013 C1
 * PR6), so this type is no longer generated from an HTTP route. It stays in the
 * SDK because the TUI and its tests consume the envelope as their event-source
 * contract: a location plus the event payload, including the durable `sync`
 * frames and the hot-read `config.updated` notice.
 */
export type GlobalEvent = {
  directory: string
  project?: string
  workspace?: string
  payload: Event | ConfigUpdated | SyncEvent
}

/** Hot-read global config notice; kept typed even without an HTTP route. */
export type ConfigUpdated = {
  id: string
  type: "config.updated"
  properties: {
    keys: string[]
  }
}

/** Durable replay frame; the TUI ignores it, the wire shape stays typed. */
export type SyncEvent = {
  type: "sync"
  id: string
  syncEvent: {
    id: string
    type: string
    seq: number
    aggregateID: string
    data: unknown
  }
}
