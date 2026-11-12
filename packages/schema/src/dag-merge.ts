// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagMerge from "./dag-merge"

import type { NodeView } from "./dag-summary"

/** One `dag.workflow.nodes.updated` payload, minus the session routing field. */
export type NodesPatch = {
  readonly workflowID: string
  readonly graphRev: number
  readonly seq: number
  readonly nodes: ReadonlyArray<NodeView>
  readonly removed: ReadonlyArray<string>
  readonly resync?: boolean
}

/** Full node table plus the push versions it reflects. */
export type Snapshot = {
  readonly workflowID: string
  readonly graphRev: number
  readonly seq: number
  readonly nodes: ReadonlyArray<NodeView>
}

/**
 * Client-side node feed. `empty` means no full-table load has started;
 * `loading` holds pushes that arrived while the table was in flight (and the
 * push that invalidated an already-loaded view); `ready` is a mergeable view.
 */
export type Feed =
  | { readonly status: "empty" }
  | { readonly status: "loading"; readonly buffered: ReadonlyArray<NodesPatch> }
  | { readonly status: "ready"; readonly view: Snapshot }

// A view change far exceeds this only when the consumer stopped draining; the
// cap keeps a stalled feed from growing without bound. The next receive()
// replays what survived, and a resync patch clears the rest.
const MAX_BUFFERED = 256

export const empty: Feed = { status: "empty" }

export const loading = (): Feed => ({ status: "loading", buffered: [] })

/** True when the consumer should fetch the full node table. */
export function needsFetch(feed: Feed): boolean {
  return feed.status !== "ready"
}

export function snapshotOf(feed: Feed): Snapshot | undefined {
  return feed.status === "ready" ? feed.view : undefined
}

/**
 * Merge a patch into a snapshot. Returns undefined for a stale or duplicate
 * push (same or older `seq`, different workflow/graphRev) — callers decide
 * whether that means "keep the view" or "refetch".
 */
export function merge(view: Snapshot, patch: NodesPatch): Snapshot | undefined {
  if (patch.workflowID !== view.workflowID) return undefined
  if (patch.graphRev !== view.graphRev) return undefined
  if (patch.seq <= view.seq) return undefined
  const changed = new Map(patch.nodes.map((node) => [node.id, node]))
  const removed = new Set(patch.removed)
  const nodes: NodeView[] = []
  const seen = new Set<string>()
  for (const node of view.nodes) {
    if (removed.has(node.id)) continue
    nodes.push(changed.get(node.id) ?? node)
    seen.add(node.id)
  }
  // A node the client has not seen yet (for example created between the
  // initial fetch and this push) still belongs in the view.
  for (const node of patch.nodes) {
    if (!seen.has(node.id)) nodes.push(node)
  }
  return { ...view, seq: patch.seq, nodes }
}

/**
 * Apply one pushed patch. A push before the first load buffers; a push that
 * invalidates the loaded view (different workflow or graphRev, or an explicit
 * resync) returns to `loading` and buffers itself, so the consumer refetches
 * and receive() replays it against the fresh table.
 */
export function push(feed: Feed, patch: NodesPatch): Feed {
  if (patch.resync) return { status: "loading", buffered: [patch] }
  if (feed.status === "empty") return { status: "loading", buffered: [patch] }
  if (feed.status === "loading") {
    const buffered = [...feed.buffered, patch]
    return { status: "loading", buffered: buffered.slice(-MAX_BUFFERED) }
  }
  if (patch.workflowID !== feed.view.workflowID || patch.graphRev !== feed.view.graphRev) {
    return { status: "loading", buffered: [patch] }
  }
  const view = merge(feed.view, patch)
  return view ? { status: "ready", view } : feed
}

/**
 * Complete a full-table fetch. Buffered pushes for the same workflow/graphRev
 * are replayed in sequence order; resync patches only requested the fetch and
 * carry no rows, so they are dropped.
 */
export function receive(feed: Feed, snapshot: Snapshot): Feed {
  if (feed.status !== "loading") return { status: "ready", view: snapshot }
  let view = snapshot
  const buffered = [...feed.buffered].sort((a, b) => a.seq - b.seq)
  for (const patch of buffered) {
    if (patch.resync) continue
    view = merge(view, patch) ?? view
  }
  return { status: "ready", view }
}
