// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * DAG scheduling core — dependency graph.
 *
 * Pure: zero Effect/DB/I/O imports. Adjacency-list graph with O(V+E) Kahn
 * topological sort, DFS three-color cycle detection, and wavefront layer
 * grouping for parallel-execution planning and α-rendering wave headers.
 *
 * Ported from dag-iron-laws group-manager/DependencyGraph.ts. The graph throws
 * NodeNotFoundError (renamed from the old misnomer GroupNotFoundError) — there
 * are no groups at this layer; groups are a computed topological-depth concept
 * in the runtime, not a first-class graph entity.
 */

export class NodeNotFoundError extends Error {
  constructor(nodeId: string) {
    super(`Node not found: ${nodeId}`)
    this.name = "NodeNotFoundError"
  }
}

export class CycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(" -> ")}`)
    this.name = "CycleError"
  }
}

/** Node color for DFS three-color cycle detection. */
const enum Color {
  White = 0,
  Gray = 1,
  Black = 2,
}

/**
 * Dependency graph: nodes + directed edges (from -> to means "from depends on to").
 *
 * @example
 * ```ts
 * const g = new DependencyGraph()
 * g.addNode("a"); g.addNode("b")
 * g.addEdge("b", "a")  // b depends on a
 * g.getLayers()        // [["a"], ["b"]]  — a runs first, then b
 * ```
 */
export class DependencyGraph {
  /** nodeId → nodes this node depends on. */
  private deps: Map<string, Set<string>> = new Map()
  /** nodeId → nodes that depend on this node (reverse edges). */
  private revDeps: Map<string, Set<string>> = new Map()

  addNode(nodeId: string): void {
    if (!this.deps.has(nodeId)) {
      this.deps.set(nodeId, new Set())
      this.revDeps.set(nodeId, new Set())
    }
  }

  removeNode(nodeId: string): void {
    if (!this.deps.has(nodeId)) throw new NodeNotFoundError(nodeId)
    for (const to of this.deps.get(nodeId)!) this.revDeps.get(to)?.delete(nodeId)
    for (const from of this.revDeps.get(nodeId)!) this.deps.get(from)?.delete(nodeId)
    this.deps.delete(nodeId)
    this.revDeps.delete(nodeId)
  }

  hasNode(nodeId: string): boolean {
    return this.deps.has(nodeId)
  }

  getAllNodes(): string[] {
    return Array.from(this.deps.keys())
  }

  getNodeCount(): number {
    return this.deps.size
  }

  addEdge(from: string, to: string): void {
    if (!this.deps.has(from)) throw new NodeNotFoundError(from)
    if (!this.deps.has(to)) throw new NodeNotFoundError(to)
    if (this.wouldCreateCycle(from, to)) throw new CycleError([from, to])
    this.deps.get(from)!.add(to)
    this.revDeps.get(to)!.add(from)
  }

  removeEdge(from: string, to: string): void {
    if (!this.deps.has(from)) throw new NodeNotFoundError(from)
    this.deps.get(from)?.delete(to)
    this.revDeps.get(to)?.delete(from)
  }

  hasEdge(from: string, to: string): boolean {
    return this.deps.get(from)?.has(to) ?? false
  }

  getEdgeCount(): number {
    let count = 0
    for (const edges of this.deps.values()) count += edges.size
    return count
  }

  /** Direct dependencies of a node (nodes it depends on). */
  getDependencies(nodeId: string): string[] {
    if (!this.deps.has(nodeId)) throw new NodeNotFoundError(nodeId)
    return Array.from(this.deps.get(nodeId)!)
  }

  /** Direct dependents of a node (nodes that depend on it). */
  getDependents(nodeId: string): string[] {
    if (!this.revDeps.has(nodeId)) throw new NodeNotFoundError(nodeId)
    return Array.from(this.revDeps.get(nodeId)!)
  }

  /** All transitive dependencies (closure). */
  getAllDependencies(nodeId: string): string[] {
    if (!this.deps.has(nodeId)) throw new NodeNotFoundError(nodeId)
    const visited = new Set<string>()
    const dfs = (id: string) => {
      for (const dep of this.deps.get(id)!) {
        if (!visited.has(dep)) {
          visited.add(dep)
          dfs(dep)
        }
      }
    }
    dfs(nodeId)
    return Array.from(visited)
  }

  /** All transitive dependents (reverse closure). */
  getAllDependents(nodeId: string): string[] {
    if (!this.revDeps.has(nodeId)) throw new NodeNotFoundError(nodeId)
    const visited = new Set<string>()
    const dfs = (id: string) => {
      for (const dep of this.revDeps.get(id)!) {
        if (!visited.has(dep)) {
          visited.add(dep)
          dfs(dep)
        }
      }
    }
    dfs(nodeId)
    return Array.from(visited)
  }

  /**
   * Kahn topological sort. Deterministic: ties broken lexicographically.
   * @throws CycleError if the graph has a cycle.
   */
  topologicalSort(): string[] {
    if (this.hasCycle()) throw new CycleError(this.findFirstCycle())

    const inDegree = new Map<string, number>()
    for (const [id, edges] of this.deps) inDegree.set(id, edges.size)

    const queue: string[] = []
    for (const [id, deg] of inDegree) if (deg === 0) queue.push(id)
    queue.sort()

    const sorted: string[] = []
    while (queue.length > 0) {
      const node = queue.shift()!
      sorted.push(node)
      const nextCandidates: string[] = []
      for (const dep of this.revDeps.get(node)!) {
        const newDeg = (inDegree.get(dep) ?? 1) - 1
        inDegree.set(dep, newDeg)
        if (newDeg === 0) nextCandidates.push(dep)
      }
      nextCandidates.sort()
      queue.push(...nextCandidates)
    }
    return sorted
  }

  /** Nodes whose dependencies are all in `completed`. */
  getExecutableNodes(completed: Set<string>): string[] {
    const result: string[] = []
    for (const [id, edges] of this.deps) {
      if (completed.has(id)) continue
      let allDepsCompleted = true
      for (const dep of edges) {
        if (!completed.has(dep)) {
          allDepsCompleted = false
          break
        }
      }
      if (allDepsCompleted) result.push(id)
    }
    return result
  }

  /**
   * Wavefront layers: nodes grouped by parallel-execution depth.
   *
   * Each layer contains nodes whose dependencies are all in earlier layers.
   * A node joins the earliest layer its dependencies allow (wavefront / Kahn BFS
   * semantics). Used for both scheduling (a layer is a parallel batch) and the
   * α-rendering `═══` wave headers (same layer = same topological depth).
   *
   * NOTE: this is wavefront layering (earliest possible layer), NOT longest-path
   * rank (latest possible layer). They differ only for diamond-with-bypass shapes;
   * for the scatter-gather patterns this engine targets they coincide. If
   * longest-path rank is later needed, add a separate method — do not overload.
   *
   * @throws CycleError if the graph has a cycle.
   */
  getLayers(): string[][] {
    if (this.hasCycle()) throw new CycleError(this.findFirstCycle())

    const remaining = new Set(this.deps.keys())
    const completed = new Set<string>()
    const layers: string[][] = []

    while (remaining.size > 0) {
      const layer: string[] = []
      for (const id of remaining) {
        let allDepsDone = true
        for (const dep of this.deps.get(id)!) {
          if (!completed.has(dep)) {
            allDepsDone = false
            break
          }
        }
        if (allDepsDone) layer.push(id)
      }
      if (layer.length === 0) break
      layer.sort()
      layers.push(layer)
      for (const id of layer) {
        completed.add(id)
        remaining.delete(id)
      }
    }
    return layers
  }

  hasCycle(): boolean {
    const color = new Map<string, Color>()
    for (const id of this.deps.keys()) color.set(id, Color.White)
    for (const id of this.deps.keys()) {
      if (color.get(id) === Color.White && this.dfsHasCycle(id, color)) return true
    }
    return false
  }

  findCycles(): string[][] {
    if (!this.hasCycle()) return []
    return [this.findFirstCycle()]
  }

  validate(): true | string[] {
    if (this.hasCycle()) return ["Graph contains cycle(s)"]
    return true
  }

  getStats(): {
    nodeCount: number
    edgeCount: number
    averageDegree: number
    maxDepth: number
    hasCycle: boolean
  } {
    const nodeCount = this.getNodeCount()
    const edgeCount = this.getEdgeCount()
    const cycle = this.hasCycle()
    return {
      nodeCount,
      edgeCount,
      averageDegree: nodeCount > 0 ? edgeCount / nodeCount : 0,
      maxDepth: cycle ? -1 : this.computeMaxDepth(),
      hasCycle: cycle,
    }
  }

  toJSON(): { nodes: string[]; edges: { from: string; to: string }[] } {
    const nodes = Array.from(this.deps.keys())
    const edges: { from: string; to: string }[] = []
    for (const [from, tos] of this.deps) {
      for (const to of tos) edges.push({ from, to })
    }
    return { nodes, edges }
  }

  static fromJSON(data: { nodes: string[]; edges: { from: string; to: string }[] }): DependencyGraph {
    const graph = new DependencyGraph()
    for (const node of data.nodes) graph.addNode(node)
    for (const edge of data.edges) {
      if (graph.hasNode(edge.from) && graph.hasNode(edge.to)) {
        graph.deps.get(edge.from)!.add(edge.to)
        graph.revDeps.get(edge.to)!.add(edge.from)
      }
    }
    return graph
  }

  clone(): DependencyGraph {
    return DependencyGraph.fromJSON(this.toJSON())
  }

  clear(): void {
    this.deps.clear()
    this.revDeps.clear()
  }

  // --------------------------------------------------------------------------

  private dfsHasCycle(node: string, color: Map<string, Color>): boolean {
    color.set(node, Color.Gray)
    for (const dep of this.deps.get(node)!) {
      const c = color.get(dep)
      if (c === Color.Gray) return true
      if (c === Color.White && this.dfsHasCycle(dep, color)) return true
    }
    color.set(node, Color.Black)
    return false
  }

  private wouldCreateCycle(from: string, to: string): boolean {
    if (from === to) return true
    // Adding from->to creates a cycle iff to can already reach from.
    const visited = new Set<string>()
    const dfs = (current: string): boolean => {
      if (current === from) return true
      if (visited.has(current)) return false
      visited.add(current)
      for (const dep of this.deps.get(current) ?? []) {
        if (dfs(dep)) return true
      }
      return false
    }
    return dfs(to)
  }

  private findFirstCycle(): string[] {
    const color = new Map<string, Color>()
    for (const id of this.deps.keys()) color.set(id, Color.White)
    for (const start of this.deps.keys()) {
      if (color.get(start) !== Color.White) continue
      const cycle = this.findCycleFrom(start, color, [])
      if (cycle) return cycle
    }
    return []
  }

  private findCycleFrom(node: string, color: Map<string, Color>, path: string[]): string[] | null {
    color.set(node, Color.Gray)
    path.push(node)
    for (const dep of this.deps.get(node)!) {
      if (color.get(dep) === Color.Gray) {
        const cycleStart = path.indexOf(dep)
        return path.slice(cycleStart)
      }
      if (color.get(dep) === Color.White) {
        const result = this.findCycleFrom(dep, color, path)
        if (result) return result
      }
    }
    path.pop()
    color.set(node, Color.Black)
    return null
  }

  private computeMaxDepth(): number {
    const memo = new Map<string, number>()
    const dfs = (id: string): number => {
      if (memo.has(id)) return memo.get(id)!
      let maxChild = 0
      for (const dep of this.revDeps.get(id)!) maxChild = Math.max(maxChild, dfs(dep) + 1)
      memo.set(id, maxChild)
      return maxChild
    }
    let maxDepth = 0
    for (const id of this.deps.keys()) maxDepth = Math.max(maxDepth, dfs(id))
    return maxDepth
  }
}
