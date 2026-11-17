// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1029, PR4a: the reconciler's pure judgment. One group per row of the
 * truth table in ADR-0008 decision 6, and in each group the places where an
 * earlier row has to win over a later one (the table is first-match). No Effect
 * and no database: `decide` is a function of its observation, and
 * `classifyLease` and `clockJumped` are the two small functions that make the
 * observation's lease and clock-jump fields.
 */

import { describe, expect, test } from "bun:test"
import { DagLease } from "@graphagent/core/dag/lease"
import { ReconcileDecide } from "@/dag/runtime/reconcile-decide"

const { ORPHAN_PENDING_GRACE_MS, decide, classifyLease, clockJumped } = ReconcileDecide

const NOOP: ReconcileDecide.Action = { _tag: "noop" }
const ADOPT: ReconcileDecide.Action = { _tag: "adopt" }
const RENEW: ReconcileDecide.Action = { _tag: "renew" }
const FAIL: ReconcileDecide.Action = { _tag: "fail-unrecoverable" }
const ORPHAN: ReconcileDecide.Action = { _tag: "terminalize-orphan" }
const evict = (reason: ReconcileDecide.EvictReason): ReconcileDecide.Action => ({ _tag: "evict", reason })
const defer = (reason: ReconcileDecide.DeferReason): ReconcileDecide.Action => ({ _tag: "defer", reason })

/** A running workflow that this instance owns and that nobody drives: what row 10 adopts. */
const adoptable: ReconcileDecide.Observation = {
  status: "running",
  allNodesPending: false,
  ageMs: 0,
  owned: true,
  location: "ok",
  lease: "none",
  hasEntry: false,
  entryTokenHeld: false,
  afterClockJump: false,
}

const observe = (changes: Partial<ReconcileDecide.Observation>): ReconcileDecide.Observation => ({
  ...adoptable,
  ...changes,
})

/** An instance that drives the workflow: an entry, and a lease row that still names its token. */
const driving = { hasEntry: true, entryTokenHeld: true, lease: "mine" } as const

/** A `pending` workflow that the create sequence left behind: all its nodes pending, past the grace period. */
const orphan = { status: "pending", allNodesPending: true, ageMs: ORPHAN_PENDING_GRACE_MS } as const

describe("row 1: a workflow that is terminal or gone ends the evaluation", () => {
  for (const status of ["completed", "failed", "cancelled", "gone"])
    test(`${status}: nothing to do`, () => {
      expect(decide(observe({ status }))).toEqual(NOOP)
    })

  test("it wins over every other row, an entry that has lost its lease and another runner's live lease included", () => {
    expect(
      decide(
        observe({
          status: "failed",
          owned: false,
          location: "unusable",
          lease: "other-live",
          hasEntry: true,
          entryTokenHeld: false,
          afterClockJump: true,
        }),
      ),
    ).toEqual(NOOP)
  })
})

describe("row 2: a workflow that this directory does not own", () => {
  test("is evicted when the instance has an entry for it", () => {
    expect(decide(observe({ owned: false, ...driving }))).toEqual(evict("not-owned"))
  })

  test("is nobody's business here when it has no entry", () => {
    expect(decide(observe({ owned: false }))).toEqual(NOOP)
    expect(decide(observe({ owned: false, ...orphan }))).toEqual(NOOP)
  })

  test("wins over a lost lease, an unusable location and another runner's live lease", () => {
    const entryWithoutLease = { hasEntry: true, entryTokenHeld: false } as const
    expect(decide(observe({ owned: false, ...entryWithoutLease, lease: "other-live" }))).toEqual(evict("not-owned"))
    expect(decide(observe({ owned: false, ...entryWithoutLease, location: "unusable" }))).toEqual(evict("not-owned"))
    expect(decide(observe({ owned: false, location: "unusable", lease: "other-expired" }))).toEqual(NOOP)
  })
})

describe("row 3: an entry whose lease row no longer names its token", () => {
  for (const lease of ["none", "other-live", "other-expired"] as const)
    test(`is evicted as lost (the row is: ${lease})`, () => {
      expect(decide(observe({ hasEntry: true, entryTokenHeld: false, lease }))).toEqual(evict("lease-lost"))
    })

  test("wins over an unusable location: the runner stops driving before anything is judged", () => {
    expect(
      decide(observe({ hasEntry: true, entryTokenHeld: false, lease: "other-expired", location: "unusable" })),
    ).toEqual(evict("lease-lost"))
  })

  test("is only a matter of the entry's own token: no entry, no eviction", () => {
    expect(decide(observe({ hasEntry: false, entryTokenHeld: false, lease: "other-live" }))).toEqual(
      defer("other-live"),
    )
  })
})

describe("row 4: an execution location that cannot be used", () => {
  for (const lease of ["none", "mine", "other-expired"] as const)
    test(`is failed durably when no other runner holds a live lease (the row is: ${lease})`, () => {
      expect(decide(observe({ location: "unusable", lease }))).toEqual(FAIL)
    })

  test("is failed even while this instance drives the workflow: the entry is cleaned by the terminal handler", () => {
    expect(decide(observe({ location: "unusable", ...driving }))).toEqual(FAIL)
  })

  test("is left to the runner that holds a live lease (row 5), who judges it itself", () => {
    expect(decide(observe({ location: "unusable", lease: "other-live" }))).toEqual(defer("other-live"))
  })

  test("wins over the clock rule and over the orphan rows", () => {
    expect(decide(observe({ location: "unusable", lease: "other-expired", afterClockJump: true }))).toEqual(FAIL)
    expect(decide(observe({ location: "unusable", ...orphan }))).toEqual(FAIL)
    expect(decide(observe({ location: "unusable", status: "pending" }))).toEqual(FAIL)
  })
})

describe("row 5: another runner holds a live lease", () => {
  for (const status of ["running", "paused", "stepping", "pending"])
    test(`${status}: not claimed and not judged`, () => {
      expect(decide(observe({ status, lease: "other-live" }))).toEqual(defer("other-live"))
    })

  test("wins over the orphan rule: an orphan somebody drives is not terminalized", () => {
    expect(decide(observe({ ...orphan, lease: "other-live" }))).toEqual(defer("other-live"))
  })

  test("is not changed by a clock jump", () => {
    expect(decide(observe({ lease: "other-live", afterClockJump: true }))).toEqual(defer("other-live"))
  })
})

describe("row 6: an entry whose lease is held", () => {
  for (const status of ["running", "paused", "stepping"])
    test(`${status}: renewed (by the tick that ran this round), nothing else to do`, () => {
      expect(decide(observe({ status, ...driving }))).toEqual(RENEW)
    })

  test("is not affected by a clock jump: the owner renews", () => {
    expect(decide(observe({ ...driving, afterClockJump: true }))).toEqual(RENEW)
  })
})

describe("row 7: no preemption right after a clock jump", () => {
  test("another runner's expired lease is left alone this round and the next", () => {
    expect(decide(observe({ lease: "other-expired", afterClockJump: true }))).toEqual(defer("clock-jump"))
    expect(decide(observe({ lease: "other-expired", afterClockJump: false }))).toEqual(ADOPT)
  })

  test("a workflow without a lease row is claimed all the same: that takes nothing from anyone", () => {
    expect(decide(observe({ lease: "none", afterClockJump: true }))).toEqual(ADOPT)
  })

  test("a row that names this runner is adopted too (the entry is what is missing)", () => {
    expect(decide(observe({ lease: "mine", afterClockJump: true }))).toEqual(ADOPT)
  })

  test("wins over the orphan rule", () => {
    expect(decide(observe({ ...orphan, lease: "other-expired", afterClockJump: true }))).toEqual(defer("clock-jump"))
  })
})

describe("row 8: an orphan pending workflow", () => {
  test("is terminalized once every node is pending and the grace period is over", () => {
    expect(decide(observe(orphan))).toEqual(ORPHAN)
    expect(decide(observe({ ...orphan, ageMs: ORPHAN_PENDING_GRACE_MS + 1 }))).toEqual(ORPHAN)
  })

  test("the grace period is 60 seconds", () => {
    expect(ORPHAN_PENDING_GRACE_MS).toBe(60_000)
  })

  test("is terminalized from another runner's expired lease (no jump), or a row that names this runner", () => {
    expect(decide(observe({ ...orphan, lease: "other-expired" }))).toEqual(ORPHAN)
    expect(decide(observe({ ...orphan, lease: "mine" }))).toEqual(ORPHAN)
  })

  test("a workflow that has no node (vacuously all pending) is an orphan too", () => {
    expect(decide(observe({ ...orphan, allNodesPending: true }))).toEqual(ORPHAN)
  })
})

describe("row 9: a pending workflow that is not an orphan", () => {
  test("waits within the grace period: a writer may still be at it", () => {
    expect(decide(observe({ ...orphan, ageMs: ORPHAN_PENDING_GRACE_MS - 1 }))).toEqual(defer("pending"))
    expect(decide(observe({ ...orphan, ageMs: 0 }))).toEqual(defer("pending"))
  })

  test("waits when any node has progressed: it was adopted and is mid-flight", () => {
    expect(decide(observe({ ...orphan, allNodesPending: false }))).toEqual(defer("pending"))
  })

  test("waits for its WorkflowStarted, never adopted before it is running", () => {
    expect(decide(observe({ status: "pending", lease: "none" }))).toEqual(defer("pending"))
  })
})

describe("row 10: the rest is adopted", () => {
  for (const status of ["running", "paused", "stepping"])
    for (const lease of ["none", "other-expired", "mine"] as const)
      test(`${status}, lease row: ${lease}, no entry`, () => {
        expect(decide(observe({ status, lease }))).toEqual(ADOPT)
      })
})

describe("classifyLease", () => {
  const RUNNER = "10:me"
  const lease = (runnerID: string, expiresAt: number) => ({ runnerID, epoch: 3, expiresAt })

  test("no row", () => {
    expect(classifyLease(undefined, RUNNER, 1_000)).toBe("none")
  })

  test("a row that names this runner is mine, expired or not", () => {
    expect(classifyLease(lease(RUNNER, 5_000), RUNNER, 1_000)).toBe("mine")
    expect(classifyLease(lease(RUNNER, 500), RUNNER, 1_000)).toBe("mine")
  })

  test("another runner's row is live until its expiry", () => {
    expect(classifyLease(lease("11:other", 1_001), RUNNER, 1_000)).toBe("other-live")
  })

  test("another runner's row has expired at its expiry, the rule a claim takes over by (`expires_at <= now`)", () => {
    expect(classifyLease(lease("11:other", 1_000), RUNNER, 1_000)).toBe("other-expired")
    expect(classifyLease(lease("11:other", 10), RUNNER, 1_000)).toBe("other-expired")
  })
})

describe("clockJumped", () => {
  const PERIOD = DagLease.RENEWAL_PERIOD_MS

  test("the first reading has no predecessor", () => {
    expect(clockJumped(undefined, 10 * PERIOD, PERIOD)).toBe(false)
  })

  test("a tick every period is not a jump, and neither is a tick that is up to two periods late", () => {
    expect(clockJumped(0, PERIOD, PERIOD)).toBe(false)
    expect(clockJumped(0, 2 * PERIOD, PERIOD)).toBe(false)
  })

  test("more than two periods is", () => {
    expect(clockJumped(0, 2 * PERIOD + 1, PERIOD)).toBe(true)
    expect(clockJumped(PERIOD, 10 * PERIOD, PERIOD)).toBe(true)
  })

  test("a clock that went backwards is not a jump", () => {
    expect(clockJumped(10 * PERIOD, 0, PERIOD)).toBe(false)
  })
})

describe("the table as a whole", () => {
  const all = <T>(values: readonly T[]) => values
  const table = (() => {
    const out: ReconcileDecide.Observation[] = []
    for (const status of all(["running", "paused", "stepping", "pending", "completed", "gone"]))
      for (const owned of all([true, false]))
        for (const location of all(["ok", "unusable"] as const))
          for (const lease of all(["none", "mine", "other-live", "other-expired"] as const))
            for (const hasEntry of all([true, false]))
              for (const entryTokenHeld of all([true, false]))
                for (const afterClockJump of all([true, false]))
                  for (const allNodesPending of all([true, false]))
                    for (const ageMs of all([0, ORPHAN_PENDING_GRACE_MS]))
                      out.push({
                        status,
                        owned,
                        location,
                        lease,
                        hasEntry,
                        entryTokenHeld,
                        afterClockJump,
                        allNodesPending,
                        ageMs,
                      })
    return out
  })()

  test("covers every combination of the observation, and decides each one", () => {
    expect(table.length).toBe(6 * 2 * 2 * 4 * 2 * 2 * 2 * 2 * 2)
    for (const observation of table) expect(decide(observation)._tag).toBeTypeOf("string")
  })

  test("never claims, adopts or terminalizes a workflow while another runner holds a live lease", () => {
    for (const observation of table.filter((o) => o.lease === "other-live"))
      expect(["adopt", "terminalize-orphan"]).not.toContain(decide(observation)._tag)
  })

  test("never takes another runner's expired lease right after a clock jump", () => {
    for (const observation of table.filter((o) => o.lease === "other-expired" && o.afterClockJump && !o.hasEntry))
      expect(["adopt", "terminalize-orphan"]).not.toContain(decide(observation)._tag)
  })

  test("never acts on a workflow that is terminal, gone or not owned, other than by dropping its entry", () => {
    for (const observation of table.filter((o) => ["completed", "gone"].includes(o.status) || !o.owned)) {
      const action = decide(observation)
      expect(action._tag === "noop" || action._tag === "evict").toBe(true)
      if (action._tag === "evict") expect(observation.hasEntry).toBe(true)
    }
  })

  test("evicts as lost exactly when an owned live workflow has an entry that its lease row no longer names", () => {
    for (const observation of table) {
      const action = decide(observation)
      const lost = action._tag === "evict" && action.reason === "lease-lost"
      const expected =
        observation.owned &&
        observation.hasEntry &&
        !observation.entryTokenHeld &&
        observation.status !== "completed" &&
        observation.status !== "gone"
      expect(lost).toBe(expected)
    }
  })

  test("is a function of the observation: the same record always gets the same answer", () => {
    for (const observation of table) expect(decide({ ...observation })).toEqual(decide(observation))
  })
})
