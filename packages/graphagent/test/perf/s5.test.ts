// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { MAX_CONCURRENCY, s5Scenario } from "./scenarios/s5"

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

          // Issue #1021: the scheduler's occupancy, sampled for the whole pass,
          // never passed a cap. Caps come from the same snapshots (the process
          // scheduler's configured limits), not from constants restated here.
          const { capacity } = run
          // The measured peaks ride along in the CI log, not just a pass/fail.
          process.stderr.write(
            `[s5-capacity] samples=${capacity.samples} streams=${capacity.requests.inflight}/${capacity.requests.cap}` +
              ` provider=${capacity.providers.test?.inflight}/${capacity.providers.test?.cap}` +
              ` children=${capacity.children.running}/${capacity.children.cap}` +
              ` dag=${capacity.children.dagRunning}/${capacity.children.dagCap}` +
              ` workflows=${capacity.workflows.map((workflow) => `${workflow.peak}/${workflow.cap}`).join(",")}\n`,
          )
          expect(capacity.samples).toBeGreaterThan(0)
          // Model streams: every provider request held a permit, and the exact
          // in-flight peak (taken at each grant) stays inside the global cap
          // and the provider's own cap.
          expect(capacity.grants).toBe(run.requests.length)
          expect(capacity.requests.inflight).toBeGreaterThanOrEqual(1)
          expect(capacity.requests.inflight).toBeLessThanOrEqual(capacity.requests.cap)
          expect(Object.keys(capacity.providers)).toEqual(["test"])
          expect(capacity.providers.test.inflight).toBeGreaterThanOrEqual(1)
          expect(capacity.providers.test.inflight).toBeLessThanOrEqual(capacity.providers.test.cap)
          // Child runs: inside the child pool and the DAG-wide layer. Every node
          // request is granted while its node holds a slot, so a zero peak would
          // mean the accounting never ran.
          expect(capacity.children.running).toBeGreaterThanOrEqual(1)
          expect(capacity.children.running).toBeLessThanOrEqual(capacity.children.cap)
          expect(capacity.children.dagRunning).toBeLessThanOrEqual(capacity.children.dagCap)
          expect(capacity.children.dagCap).toBeLessThanOrEqual(capacity.children.cap)
          // Each workflow's active child runs stay within the max_concurrency it
          // asked for (and within the cap the scheduler enforced for it).
          expect(capacity.workflows).toHaveLength(WORKFLOWS)
          for (const workflow of capacity.workflows) {
            expect(workflow.peak).toBeLessThanOrEqual(MAX_CONCURRENCY)
            expect(workflow.peak).toBeLessThanOrEqual(workflow.cap)
            expect(workflow.cap).toBeLessThanOrEqual(MAX_CONCURRENCY)
          }
          expect(Math.max(...capacity.workflows.map((workflow) => workflow.peak))).toBeGreaterThanOrEqual(1)
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
