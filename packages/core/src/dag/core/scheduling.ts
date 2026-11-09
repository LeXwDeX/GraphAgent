// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { DependencyGraph } from "./graph"

export type SchedulingNodeStatus = "pending" | "running" | "satisfied" | "unsatisfied" | "skipped"

export interface SchedulingNode {
  readonly id: string
  readonly dependsOn: readonly string[]
  readonly status: SchedulingNodeStatus
  readonly required: boolean
}

/** Durable node statuses that count as output-producing success for scheduling. */
const SATISFIED_TERMINAL = new Set(["completed"])

/**
 * Map durable read-model node rows into scheduling states. Shared by the live
 * loop, crash recovery, and Dag.step so every ready-set computation uses the
 * same mapping. `skipped` is deliberately NOT folded into `satisfied`: a
 * skipped dependency still unlocks mixed fan-ins, but descendants that depend
 * on skipped nodes only must cascade-skip instead of running on placeholder
 * inputs (D13 — condition gates). `queued` maps to `pending`: a queued node
 * never reached the provider (no child session before the permit, P0-2), so
 * rebuilding after a crash simply re-admits it — no ownership is lost.
 */
export function toSchedulingNodes(
  nodes: readonly { id: string; status: string; dependsOn: readonly string[]; required: boolean }[],
): SchedulingNode[] {
  return nodes.map((n) => ({
    id: n.id,
    dependsOn: n.dependsOn,
    required: n.required,
    status: SATISFIED_TERMINAL.has(n.status)
      ? ("satisfied" as const)
      : n.status === "skipped" || n.status === "aborted"
        ? ("skipped" as const)
        : n.status === "failed"
          ? ("unsatisfied" as const)
          : n.status === "running"
            ? ("running" as const)
            : ("pending" as const),
  }))
}

export function buildGraph(nodes: SchedulingNode[]): DependencyGraph {
  const graph = new DependencyGraph()
  nodes.forEach((node) => graph.addNode(node.id))
  nodes.forEach((node) =>
    node.dependsOn.forEach((dep) => {
      if (graph.hasNode(dep)) graph.addEdge(node.id, dep)
    }),
  )
  return graph
}

export class WorkflowRuntime {
  private graph: DependencyGraph
  private readonly satisfied: Set<string> = new Set()
  private readonly unsatisfied: Set<string> = new Set()
  private readonly skipped: Set<string> = new Set()
  private readonly running: Set<string> = new Set()
  private readonly required: Set<string>
  private paused = false
  private stepMode = false
  readonly maxConcurrency: number

  constructor(nodes: SchedulingNode[], maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency
    this.graph = buildGraph(nodes)
    this.required = new Set(nodes.filter((n) => n.required).map((n) => n.id))
    this.seed(nodes)
  }

  private seed(nodes: readonly SchedulingNode[]): void {
    const unsatisfiedIDs = nodes.filter((n) => n.status === "unsatisfied").map((n) => n.id)
    nodes.forEach((node) => {
      if (node.status === "satisfied") this.satisfied.add(node.id)
      else if (node.status === "unsatisfied") this.unsatisfied.add(node.id)
      else if (node.status === "skipped") this.skipped.add(node.id)
      else if (node.status === "running") this.running.add(node.id)
    })
    unsatisfiedIDs.filter((id) => this.required.has(id)).forEach((id) => this.cascadeUnsatisfied(id))
  }

  markSatisfied(nodeID: string): void {
    this.satisfied.add(nodeID)
    this.running.delete(nodeID)
    this.unsatisfied.delete(nodeID)
    this.skipped.delete(nodeID)
  }

  markUnsatisfied(nodeID: string): void {
    this.unsatisfied.add(nodeID)
    this.running.delete(nodeID)
    this.satisfied.delete(nodeID)
    this.skipped.delete(nodeID)
    if (this.required.has(nodeID)) this.cascadeUnsatisfied(nodeID)
  }

  /** Terminal no-output state (D13): unlocks mixed fan-ins like satisfied, but
   * descendants that depend on skipped nodes only are cascade-skipped. */
  markSkipped(nodeID: string): void {
    this.skipped.add(nodeID)
    this.running.delete(nodeID)
    this.satisfied.delete(nodeID)
    this.unsatisfied.delete(nodeID)
  }

  private cascadeUnsatisfied(nodeID: string): void {
    const queue = [nodeID]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const dependent of this.graph.getDependents(current)) {
        if (!this.unsatisfied.has(dependent) && !this.satisfied.has(dependent)) {
          this.unsatisfied.add(dependent)
          this.running.delete(dependent)
          queue.push(dependent)
        }
      }
    }
  }

  markRunning(nodeID: string): void {
    this.running.add(nodeID)
  }

  /** Synchronous check: does the runtime track any running node? */
  hasRunning(): boolean {
    return this.running.size > 0
  }

  /** Check if any running node matches the predicate (e.g. has an active fiber). */
  hasRunningMatching(pred: (nodeID: string) => boolean): boolean {
    for (const id of this.running) {
      if (pred(id)) return true
    }
    return false
  }

  /** Returns true when the current runtime graph contains the node. */
  containsNode(nodeID: string): boolean {
    return this.graph.hasNode(nodeID)
  }

  /** Returns true if the node is in running or pending (not yet terminal) state. */
  isActive(nodeID: string): boolean {
    return (
      this.running.has(nodeID)
      || (!this.satisfied.has(nodeID) && !this.unsatisfied.has(nodeID) && !this.skipped.has(nodeID))
    )
  }

  getReadyNodes(): string[] {
    if (this.paused) return []
    const ready = this.graph
      .getExecutableNodes(new Set([
        ...this.satisfied,
        ...this.skipped,
        ...[...this.unsatisfied].filter((id) => !this.required.has(id)),
      ]))
      .filter((id) =>
        !this.satisfied.has(id)
        && !this.unsatisfied.has(id)
        && !this.skipped.has(id)
        && !this.running.has(id)
        && !this.dependsOnSkippedOnly(id),
      )
    if (this.stepMode && ready.length > 0) return [ready.slice().sort()[0]]
    return ready
  }

  /**
   * Pending nodes whose dependencies are ALL skipped: they can never receive a
   * real input, so they must cascade-skip instead of spawning (D13). Returns
   * one wave per call — callers loop to a fixpoint, publishing a durable
   * NodeSkipped(orphan_cascade) per node so the cascade is crash-recoverable.
   * Nodes with at least one satisfied (or degradable failed-optional)
   * dependency are NOT cascaded — mixed fan-ins keep running with placeholder
   * inputs. Respects pause like getReadyNodes: skip is terminal and must not
   * fire while a paused workflow may still be replanned.
   */
  getCascadeSkipNodes(): string[] {
    if (this.paused) return []
    return this.graph
      .getAllNodes()
      .filter((id) =>
        !this.satisfied.has(id)
        && !this.unsatisfied.has(id)
        && !this.skipped.has(id)
        && !this.running.has(id)
        && this.dependsOnSkippedOnly(id),
      )
      .sort()
  }

  private dependsOnSkippedOnly(nodeID: string): boolean {
    const deps = this.graph.getDependencies(nodeID)
    return deps.length > 0 && deps.every((dep) => this.skipped.has(dep))
  }

  isComplete(): boolean {
    return this.graph
      .getAllNodes()
      .every((id) => this.satisfied.has(id) || this.unsatisfied.has(id) || this.skipped.has(id))
  }

  hasRequiredFailure(): boolean {
    for (const id of this.unsatisfied) {
      if (this.required.has(id)) return true
    }
    return false
  }

  /** Required nodes currently unsatisfied — used to attribute a workflow
   * failure to the specific nodes that caused it. */
  getRequiredFailures(): string[] {
    return [...this.unsatisfied].filter((id) => this.required.has(id)).sort()
  }

  rebuildGraph(nodes: SchedulingNode[]): void {
    this.graph = buildGraph(nodes)
    this.satisfied.clear()
    this.unsatisfied.clear()
    this.skipped.clear()
    this.running.clear()
    this.required.clear()
    nodes.filter((n) => n.required).forEach((n) => this.required.add(n.id))
    this.seed(nodes)
  }

  isPaused(): boolean {
    return this.paused
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  isStepMode(): boolean {
    return this.stepMode
  }

  setStepMode(stepMode: boolean): void {
    this.stepMode = stepMode
  }
}
