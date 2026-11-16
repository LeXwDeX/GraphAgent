// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** Pure wave computation for DAG node lists. No rendering or SDK access. */

/** The node fields wave placement reads; the SDK node and the stored row both fit. */
export interface DagWaveNode {
  readonly id: string
  readonly name: string
  readonly depends_on: readonly string[]
}

export interface DagWaves<T extends DagWaveNode> {
  /** Topological waves, each sorted by name. */
  readonly waves: T[][]
  /**
   * Nodes no wave can take: members of a dependency cycle and every node that
   * (transitively) depends on one. Authoring rejects cycles, but a restored
   * workflow can still hold one and the display must not lose its nodes.
   * Sorted by name like a wave.
   */
  readonly unplaced: T[]
}

/**
 * Group nodes into topological "waves": wave N contains every node whose
 * dependencies are all satisfied by waves 0..N-1. A wave is a rendering
 * grouping (same topological depth), NOT an execution barrier.
 *
 * Nodes inside a wave are sorted by name for stable rendering. A dependency on
 * a node that is not in the list counts as satisfied (a replan removed it), so
 * that node is still placed. Nodes in a dependency cycle can never be
 * satisfied: the loop stops at the first empty wave rather than spinning
 * forever, and whatever is left comes back as `unplaced`.
 */
export function computeWaves<T extends DagWaveNode>(nodes: readonly T[]): DagWaves<T> {
  if (nodes.length === 0) return { waves: [], unplaced: [] }
  const done = new Set<string>()
  const remaining = new Set(nodes.map((n) => n.id))
  const deps = new Map(nodes.map((n) => [n.id, n.depends_on]))
  const byID = new Map(nodes.map((n) => [n.id, n]))
  const waves: T[][] = []
  while (remaining.size > 0) {
    const wave: T[] = []
    for (const id of remaining) {
      const d = deps.get(id) ?? []
      if (d.every((dep) => done.has(dep) || !byID.has(dep))) {
        const node = byID.get(id)
        if (node) wave.push(node)
      }
    }
    if (wave.length === 0) break
    wave.sort((a, b) => a.name.localeCompare(b.name))
    waves.push(wave)
    for (const n of wave) {
      done.add(n.id)
      remaining.delete(n.id)
    }
  }
  const unplaced: T[] = []
  for (const id of remaining) {
    const node = byID.get(id)
    if (node) unplaced.push(node)
  }
  unplaced.sort((a, b) => a.name.localeCompare(b.name))
  return { waves, unplaced }
}
