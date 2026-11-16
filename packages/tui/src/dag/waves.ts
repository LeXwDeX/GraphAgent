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

/** Why a node is outside every wave. */
export type DagUnplacedReason =
  /** The node is part of a dependency cycle; a node that depends on itself is a cycle of one. */
  | { readonly kind: "cycle" }
  /** Not in a cycle itself, but waits (directly or through other nodes) on one: `via` is the nearest cycle member's id. */
  | { readonly kind: "downstream"; readonly via: string }

/**
 * Explain the nodes `computeWaves` left out. Pass its `unplaced`: every node in
 * it either sits on a dependency cycle or depends, through nodes of the same
 * list, on one, and a dependency on a node that is not in the list never
 * counts. Anything that is neither (a list that is not an `unplaced`) gets no
 * entry.
 *
 * The cycle members are the strongly connected components with more than one
 * node or a self-dependency. A node downstream of a cycle is tied to the
 * nearest member, walking dependents outwards from all of them at once; equally
 * near members are told apart by name, so the answer does not depend on the
 * order the nodes come in. Both walks are iterative and linear in nodes and
 * dependencies: a restored workflow can be long, and a recursion would run out
 * of stack on a long chain.
 */
export function dagUnplacedReasons(unplaced: readonly DagWaveNode[]): ReadonlyMap<string, DagUnplacedReason> {
  const nodes = unplaced.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const count = nodes.length
  const position = new Map(nodes.map((node, index) => [node.id, index]))
  // Dependencies inside the list, as positions: ascending, so also in name order.
  const deps = nodes.map((node) => {
    const inside = new Set<number>()
    for (const dep of node.depends_on) {
      const at = position.get(dep)
      if (at !== undefined) inside.add(at)
    }
    return [...inside].toSorted((a, b) => a - b)
  })

  // Tarjan's strongly connected components, with the recursion unrolled into an explicit stack of
  // [node, next dependency to visit].
  const cyclic = Array.from({ length: count }, () => false)
  const discovered = Array.from({ length: count }, () => -1)
  const lowest = Array.from({ length: count }, () => 0)
  const open = Array.from({ length: count }, () => false)
  const stack: number[] = []
  let clock = 0
  for (let start = 0; start < count; start++) {
    if (discovered[start] !== -1) continue
    discovered[start] = lowest[start] = clock++
    stack.push(start)
    open[start] = true
    const walk: Array<[node: number, next: number]> = [[start, 0]]
    while (walk.length > 0) {
      const frame = walk[walk.length - 1]
      const node = frame[0]
      if (frame[1] < deps[node].length) {
        const dep = deps[node][frame[1]++]
        if (discovered[dep] === -1) {
          discovered[dep] = lowest[dep] = clock++
          stack.push(dep)
          open[dep] = true
          walk.push([dep, 0])
        } else if (open[dep]) {
          lowest[node] = Math.min(lowest[node], discovered[dep])
        }
        continue
      }
      walk.pop()
      const parent = walk.at(-1)?.[0]
      if (parent !== undefined) lowest[parent] = Math.min(lowest[parent], lowest[node])
      if (lowest[node] !== discovered[node]) continue
      const members: number[] = []
      let member: number
      do {
        member = stack.pop()!
        open[member] = false
        members.push(member)
      } while (member !== node)
      if (members.length > 1 || deps[node].includes(node)) for (const each of members) cyclic[each] = true
    }
  }

  // Dependents, in name order, to walk outwards from the cycle members.
  const dependents: number[][] = nodes.map(() => [])
  for (let index = 0; index < count; index++) for (const dep of deps[index]) dependents[dep].push(index)
  const via = Array.from({ length: count }, () => -1)
  const queue: number[] = []
  for (let index = 0; index < count; index++) {
    if (!cyclic[index]) continue
    via[index] = index
    queue.push(index)
  }
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]
    for (const dependent of dependents[node]) {
      if (via[dependent] !== -1) continue
      via[dependent] = via[node]
      queue.push(dependent)
    }
  }

  const reasons = new Map<string, DagUnplacedReason>()
  for (const [index, node] of nodes.entries()) {
    if (cyclic[index]) reasons.set(node.id, { kind: "cycle" })
    else if (via[index] !== -1) reasons.set(node.id, { kind: "downstream", via: nodes[via[index]].id })
  }
  return reasons
}
