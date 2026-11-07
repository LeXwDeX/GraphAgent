import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { s5Scenario } from "./scenarios/s5"

const scenario = s5Scenario()
const it = testEffect(scenario.layer)

const WORKERS = 8
const WORKFLOWS = 3

// SQL/byte/lock counters drift with 15-way concurrency and the loop's 30s
// paused sweep; the event counts and message conversion do not. S4 set the
// precedent for declaring the drifting keys volatile rather than asserting
// them away.
const VOLATILE = new Set<keyof Counters>([
  "sql.read",
  "sql.write",
  "commits",
  "json.parseBytes",
  "json.encodeBytes",
  "sha256Bytes",
  "snapshot.lockWaits",
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
          expect(new Set(run.requests.map((request) => request.toolsHash)).size).toBe(1)
          // H3's structural proof: the parent session never ran a turn, so no
          // transcript materialization happened for it.
          expect(run.parentMessages).toBe(0)
          expect(run.parentStatus).toBe("busy")

          expect(run.counts["events.durable"]).toBeGreaterThan(0)
          expect(run.counts["events.ephemeral"]).toBeGreaterThan(0)
          expect(run.counts["convert.messages"]).toBeGreaterThan(0)
          expect(run.counts["git.spawns"]).toBeGreaterThan(0)
          expect(run.counts["snapshot.lockWaits"]).toBeGreaterThan(0)
          expect(run.counts["sql.write"]).toBeGreaterThan(0)
          expect(run.counts.commits).toBeGreaterThan(0)
        }

        expect(stable(result.second.counts)).toEqual(stable(result.first.counts))
        // Two passes use independent sessions, so the recorded system/prefix
        // hashes differ by session identity. The request shape — what the engine
        // asked the provider for — must match.
        const shape = (request: (typeof result.second.requests)[number]) => ({
          purpose: request.purpose,
          messageCount: request.messageCount,
          toolsHash: request.toolsHash,
          toolChoice: request.toolChoice,
        })
        expect(result.second.requests.map(shape)).toEqual(result.first.requests.map(shape))
      }),
    scenario.instance,
    { timeout: scenario.timeout },
  )
})
