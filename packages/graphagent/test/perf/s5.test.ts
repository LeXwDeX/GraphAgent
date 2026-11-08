import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { s5Scenario } from "./scenarios/s5"

const scenario = s5Scenario()
const it = testEffect(scenario.layer)

const WORKERS = 8
const WORKFLOWS = 3
const BACKGROUND = 4

// SQL/byte/lock counters drift with 15-way concurrency and the loop's 30s
// paused sweep; the event counts and message conversion do not. S4 set the
// precedent for declaring the drifting keys volatile rather than asserting
// them away. `snapshot.lockWaits` counts overlapping snapshot service calls,
// not git semaphore waits, so coalesced track batches leave it a scheduling
// artifact; `git.spawns` below is the coalescing gate.
const VOLATILE = new Set<keyof Counters>([
  "sql.read",
  "sql.write",
  "commits",
  "json.parseBytes",
  "json.encodeBytes",
  "sha256Bytes",
  "snapshot.lockWaits",
  // Track coalescing batches depend on scheduling, so the exact number of
  // batches (and their git spawns) differs between passes; the per-run bound
  // below is the coalescing gate.
  "git.spawns",
])
const stable = (counts: Counters) =>
  Object.fromEntries(Object.entries(counts).filter(([key]) => !VOLATILE.has(key as keyof Counters)))

describe("S5 DAG concurrency with background tasks", () => {
  it.instance(
    "three ten-node workflows and four background tasks complete deterministically",
    () =>
      Effect.gen(function* () {
        const result = yield* scenario.run

        expect(result.warmupWorkflows).toBe(WORKFLOWS)

        for (const run of [result.first, result.second]) {
          expect(run.workflows).toHaveLength(WORKFLOWS)
          for (const workflow of run.workflows) {
            expect(workflow.status).toBe("completed")
            expect(workflow.wakeReported).toBe(false)
            expect(workflow.nodes).toHaveLength(WORKERS + 2)
            expect(workflow.nodes.every((node) => node.status === "completed")).toBe(true)
            expect(workflow.nodes.every((node) => node.childSessionId !== null)).toBe(true)
            expect(new Set(workflow.nodes.map((node) => node.childSessionId)).size).toBe(WORKERS + 2)
            expect(workflow.nodes.every((node) => node.wakeReported === false)).toBe(true)
          }
          expect(run.waited.every((wait) => !wait.timedOut && wait.status === "completed")).toBe(true)
          expect(run.requests.length).toBeGreaterThan(0)
          expect(run.requests.every((request) => request.purpose === "conversation")).toBe(true)
          // #1014: resolve applies the subagent role-default denies, so the
          // workflow child sessions (which derive `todowrite: deny`) advertise
          // one tool less than the background sessions. Both sets are
          // legitimate, and the run must not fragment beyond them.
          const shapes = new Map<string, number>()
          for (const request of run.requests) shapes.set(request.toolsHash, (shapes.get(request.toolsHash) ?? 0) + 1)
          expect(shapes.size).toBe(2)
          expect([...shapes.values()].sort((left, right) => left - right)).toEqual([
            BACKGROUND,
            WORKFLOWS * (WORKERS + 2),
          ])
          // H3's structural proof: the parent session never ran a turn, so no
          // transcript materialization happened for it.
          expect(run.parentMessages).toBe(0)
          expect(run.parentStatus).toBe("busy")

          expect(run.counts["events.durable"]).toBeGreaterThan(0)
          expect(run.counts["events.ephemeral"]).toBeGreaterThan(0)
          expect(run.counts["convert.messages"]).toBeGreaterThan(0)
          // Concurrent tracks in one worktree coalesce into running + next
          // batches. Measured 208 against the 408 unbatched baseline; the bound
          // leaves room for scheduling-dependent batch boundaries while still
          // rejecting a return to one run per request.
          expect(run.counts["git.spawns"]).toBeGreaterThan(0)
          expect(run.counts["git.spawns"]).toBeLessThanOrEqual(224)
          expect(run.counts["sql.write"]).toBeGreaterThan(0)
          expect(run.counts.commits).toBeGreaterThan(0)
        }

        expect(stable(result.second.counts)).toEqual(stable(result.first.counts))
        // Two passes use independent sessions, so the recorded system/prefix
        // hashes differ by session identity. The request shape — what the engine
        // asked the provider for — must match as a multiset: the two tool sets
        // above can interleave in scheduling-dependent order.
        const shape = (request: (typeof result.second.requests)[number]) =>
          [request.purpose, request.messageCount, request.toolsHash, request.toolChoice].join("|")
        const shapesOf = (requests: (typeof result.second.requests)) => requests.map(shape).sort()
        expect(shapesOf(result.second.requests)).toEqual(shapesOf(result.first.requests))
      }),
    scenario.instance,
    { timeout: scenario.timeout },
  )
})
