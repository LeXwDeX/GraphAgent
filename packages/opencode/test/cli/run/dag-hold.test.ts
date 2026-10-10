// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- The SDK mock exposes only the two read endpoints used by this consumer.
// Unit tests for the consumer-only DAG hold decision rule (issue 614).
// Table-driven over the busy/idle event orderings the run loop feeds the
// wrapper: each row is one CLI run's poll sequence with the expected idle
// decisions. Real-CLI lifecycle coverage lives in run-dag-hold-process.test.ts.
import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { reportIdentity } from "@/dag/report-identity"
import { DagHold } from "../../../src/cli/cmd/run/dag-hold"

type Snapshot = readonly DagHold.DagWorkflowSnapshot[]

type Step =
  | { readonly event: "busy"; readonly snapshot?: Snapshot; readonly fail?: "reject" | "undefined" }
  | {
      readonly event: "idle"
      readonly snapshot?: Snapshot
      readonly fail?: "reject" | "undefined"
      readonly expect: DagHold.DagHoldDecision
    }

function drive(steps: readonly Step[]): Promise<DagHold.DagHoldDecision[]> {
  let cursor = 0
  const poll = (): Promise<Snapshot | undefined> => {
    const step = steps[cursor]
    cursor += 1
    if (!step || step.fail === "reject") return Promise.reject(new Error("poll boom"))
    if (step.fail === "undefined") return Promise.resolve(undefined)
    return Promise.resolve(step.snapshot ?? [])
  }
  const hold = DagHold.createDagHold(poll)
  const decisions: DagHold.DagHoldDecision[] = []
  return (async () => {
    for (const step of steps) {
      if (step.event === "busy") {
        await hold.onBusy()
        continue
      }
      decisions.push(await hold.onIdle())
    }
    return decisions
  })()
}

const wf = (id: string, status: string, awaitingReport = false): DagHold.DagWorkflowSnapshot => ({
  id,
  status,
  awaitingReport,
})

describe("dag hold decision rule (issue 614)", () => {
  test("table: every busy/idle ordering resolves to the adjudicated hold/break sequence", async () => {
    const table: ReadonlyArray<{ readonly name: string; readonly steps: readonly Step[] }> = [
      {
        // Plain prompt, no workflow ever: exit at the first idle, unchanged.
        name: "no-workflow breaks immediately",
        steps: [{ event: "idle", snapshot: [], expect: "break" }],
      },
      {
        // Workflow created in turn one, still active at the first idle.
        name: "running holds, breaks after the wake turn",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "running")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "break" },
        ],
      },
      {
        // Workflow completes during the busy phase after being observed active:
        // the wake is still owed, so the quiescent idle must hold.
        name: "active-then-quiescent within one turn holds for the owed wake",
        steps: [
          { event: "busy", snapshot: [wf("W1", "running")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "break" },
        ],
      },
      {
        // A session turn re-emits busy at every model step. The workflow is
        // observed running at one step and terminal at the next; the repeated
        // in-turn busy must NOT reset the latch (regression: the reset-on-every-
        // busy variant broke at the idle and lost the wake).
        name: "repeated in-turn busy events keep the active latch",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "busy", snapshot: [wf("W1", "running")] },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "break" },
        ],
      },
      {
        // A workflow adopted as paused and resumed mid-turn (paused → running
        // → completed between two polls of the SAME turn): the running
        // observation latches busyActive and the idle holds for the wake.
        name: "resumed adoption within one turn latches on the running step",
        steps: [
          { event: "busy", snapshot: [wf("W1", "paused")] },
          { event: "busy", snapshot: [wf("W1", "running")] },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "break" },
        ],
      },
      {
        // Workflow terminalizes inside turn one before any poll saw it: the
        // first-seen id keeps the loop alive for its wake turn.
        name: "terminal within turn one holds once, then breaks",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "failed")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "failed")] },
          { event: "idle", snapshot: [wf("W1", "failed")], expect: "break" },
        ],
      },
      {
        // --continue adoption: the session already has a live workflow when
        // the run starts; discovered at the busy transition, held through
        // completion.
        name: "adopted running workflow holds to completion",
        steps: [
          { event: "busy", snapshot: [wf("W1", "running")] },
          { event: "idle", snapshot: [wf("W1", "running")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "break" },
        ],
      },
      {
        // Chained DAG: a second workflow started during the wake turn is a
        // first-seen id at that turn's idle and holds for its own wake.
        name: "chained DAG during a wake turn holds through the chain",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "running")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed"), wf("W2", "running")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed"), wf("W2", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed"), wf("W2", "completed")], expect: "break" },
        ],
      },
      {
        // One delivered report does not discharge a second completed workflow.
        name: "two completed workflows wait for both answer receipts",
        steps: [
          { event: "busy", snapshot: [wf("W1", "completed", true), wf("W2", "completed", true)] },
          { event: "idle", snapshot: [wf("W1", "completed", true), wf("W2", "completed", true)], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed"), wf("W2", "completed", true)] },
          { event: "idle", snapshot: [wf("W1", "completed"), wf("W2", "completed", true)], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed"), wf("W2", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed"), wf("W2", "completed")], expect: "break" },
        ],
      },
      {
        // Paused work is actionable but not active; it must not mask an owed
        // answer from another completed final-response workflow.
        name: "completed report remains held beside paused actionable work",
        steps: [
          { event: "busy", snapshot: [wf("done", "completed", true), wf("paused", "paused")] },
          { event: "idle", snapshot: [wf("done", "completed", true), wf("paused", "paused")], expect: "hold" },
          { event: "busy", snapshot: [wf("done", "completed"), wf("paused", "paused")] },
          { event: "idle", snapshot: [wf("done", "completed"), wf("paused", "paused")], expect: "break" },
        ],
      },
      {
        name: "new completion waits after an older report is already delivered",
        steps: [
          { event: "busy", snapshot: [wf("old", "completed"), wf("new", "running")] },
          { event: "idle", snapshot: [wf("old", "completed"), wf("new", "running")], expect: "hold" },
          { event: "busy", snapshot: [wf("old", "completed"), wf("new", "completed", true)] },
          { event: "idle", snapshot: [wf("old", "completed"), wf("new", "completed", true)], expect: "hold" },
          { event: "busy", snapshot: [wf("old", "completed"), wf("new", "completed")] },
          { event: "idle", snapshot: [wf("old", "completed"), wf("new", "completed")], expect: "break" },
        ],
      },
      {
        // Paused workflows are not active: after the pause wake turn the loop
        // exits as it did before the hold existed.
        name: "paused holds once for the pause wake, then breaks as today",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "paused")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "paused")] },
          { event: "idle", snapshot: [wf("W1", "paused")], expect: "break" },
        ],
      },
      {
        name: "stepping breaks once known",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "stepping")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "stepping")] },
          { event: "idle", snapshot: [wf("W1", "stepping")], expect: "break" },
        ],
      },
      {
        // Every terminal status behaves like completed.
        name: "cancelled and archived hold once when first seen, then break",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "cancelled"), wf("W2", "archived")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "cancelled"), wf("W2", "archived")] },
          { event: "idle", snapshot: [wf("W1", "cancelled"), wf("W2", "archived")], expect: "break" },
        ],
      },
      {
        // A pending workflow (queued children, not yet running) is active.
        name: "pending holds",
        steps: [
          { event: "busy", snapshot: [] },
          { event: "idle", snapshot: [wf("W1", "pending")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "running")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "hold" },
          { event: "busy", snapshot: [wf("W1", "completed")] },
          { event: "idle", snapshot: [wf("W1", "completed")], expect: "break" },
        ],
      },
    ]

    for (const row of table) {
      const decisions = await drive(row.steps)
      const expected = row.steps.flatMap((step) => (step.event === "idle" ? [step.expect] : []))
      expect(decisions).toEqual(expected)
    }
  })

  test("poll failure at idle breaks silently (rejected poll)", async () => {
    const decisions = await drive([{ event: "idle", fail: "reject", expect: "break" }])
    expect(decisions).toEqual(["break"])
  })

  test("poll failure at idle breaks silently (undefined poll result)", async () => {
    const decisions = await drive([{ event: "idle", fail: "undefined", expect: "break" }])
    expect(decisions).toEqual(["break"])
  })

  test("poll failure while busy leaves state untouched and the run still exits cleanly", async () => {
    const decisions = await drive([
      { event: "busy", fail: "reject" },
      { event: "idle", snapshot: [], expect: "break" },
    ])
    expect(decisions).toEqual(["break"])
  })

  test("queued pre-prompt idle cannot end the run before its exact user message is observed", async () => {
    const hold = DagHold.createDagHold(async () => [], undefined, "msg_current")
    await hold.onBusy()
    expect(await hold.onIdle()).toBe("hold")
    hold.onUserMessage("msg_older")
    expect(await hold.onIdle()).toBe("hold")
    hold.onUserMessage("msg_current")
    expect(await hold.onIdle()).toBe("break")
  })

  test("pure helpers: active statuses, turn reset, and first-seen id evaluation order", () => {
    expect(DagHold.isDagActiveStatus("pending")).toBe(true)
    expect(DagHold.isDagActiveStatus("running")).toBe(true)
    for (const status of ["paused", "stepping", "completed", "failed", "cancelled", "archived"]) {
      expect(DagHold.isDagActiveStatus(status)).toBe(false)
    }

    const state = DagHold.initialDagHoldState()
    expect(DagHold.applyDagHoldSnapshot(state, [wf("W1", "completed")])).toBe("hold")
    expect(state.busyIds.has("W1")).toBe(true)
    // The id folded by the previous snapshot is now known, so the same
    // quiescent snapshot breaks — evaluation happens against the pre-update
    // set, not the post-fold one.
    expect(DagHold.applyDagHoldSnapshot(state, [wf("W1", "completed")])).toBe("break")
    // Active observation latches busyActive across a whole turn...
    DagHold.observeDagHoldBusy(state, [wf("W2", "running")])
    expect(state.busyActive).toBe(true)
    // ...repeated in-turn busies keep the latch (only an idle ends the turn)...
    DagHold.observeDagHoldBusy(state, [wf("W2", "completed")])
    expect(state.busyActive).toBe(true)
    DagHold.observeDagHoldBusy(state, [wf("W2", "completed")])
    expect(state.busyActive).toBe(true)
    // ...so the quiescent idle still holds for the owed wake.
    expect(DagHold.applyDagHoldSnapshot(state, [wf("W2", "completed")])).toBe("hold")
    // The next turn's first busy is the idle→busy boundary and does reset it.
    DagHold.observeDagHoldBusy(state, [wf("W1", "completed"), wf("W2", "completed")])
    expect(state.busyActive).toBe(false)
    expect(DagHold.applyDagHoldSnapshot(state, [wf("W1", "completed"), wf("W2", "completed")])).toBe("break")
  })
})

describe("final-response answer receipt polling", () => {
  const completed = (id: string, seq: number) => ({
    id,
    status: "completed",
    config: JSON.stringify({ result_protocol: "final_response" }),
    seq,
    completed_at: 1000 + seq,
    time_updated: 1000 + seq,
  })
  type Row = ReturnType<typeof completed>
  const identity = (row: Row) =>
    reportIdentity({
      sessionId: "parent",
      id: row.id,
      seq: row.seq,
      completedAt: row.completed_at,
      timeUpdated: row.time_updated,
    })
  const answer = (row: Row) => {
    const ids = identity(row)
    return {
      data: {
        info: { id: ids.messageID },
        parts: [
          {
            id: ids.answerID,
            sessionID: "parent",
            messageID: ids.messageID,
            type: "text",
            text: "report",
            metadata: { dag_delivery: { workflow_id: row.id, completion_seq: row.seq, kind: "answer" } },
          },
        ],
      },
    }
  }

  test("two completed workflows wait for both receipts and memoize only verified episodes", async () => {
    const first = completed("first", 4)
    const second = completed("second", 8)
    const received = new Set<string>([identity(first).messageID])
    const reads: string[] = []
    const client = {
      dag: { bySession: async () => ({ data: [first, second] }) },
      session: {
        message: async ({ messageID }: { messageID: string }) => {
          reads.push(messageID)
          return received.has(messageID)
            ? answer(messageID === identity(first).messageID ? first : second)
            : { error: "missing" }
        },
      },
    } as unknown as OpencodeClient
    const poll = DagHold.makeDagWorkflowPoll(client, "parent")
    const firstPoll = await poll()
    expect(firstPoll?.map((row) => row.awaitingReport)).toEqual([false, true])
    const secondPoll = await poll()
    expect(secondPoll?.map((row) => row.awaitingReport)).toEqual([false, true])
    expect(reads).toEqual([identity(first).messageID, identity(second).messageID, identity(second).messageID])
    received.add(identity(second).messageID)
    expect((await poll())?.every((row) => row.awaitingReport !== true)).toBe(true)
    expect(reads.at(-1)).toBe(identity(second).messageID)
    expect((await poll())?.every((row) => row.awaitingReport !== true)).toBe(true)
    expect(reads).toHaveLength(4)
  })

  test("a new completion seq invalidates the old receipt cache", async () => {
    let row = completed("same", 10)
    const reads: string[] = []
    const client = {
      dag: { bySession: async () => ({ data: [row] }) },
      session: {
        message: async ({ messageID }: { messageID: string }) => {
          reads.push(messageID)
          return answer(row)
        },
      },
    } as unknown as OpencodeClient
    const poll = DagHold.makeDagWorkflowPoll(client, "parent")
    expect((await poll())?.[0]?.awaitingReport).toBe(false)
    row = completed("same", 11)
    expect((await poll())?.[0]?.awaitingReport).toBe(false)
    expect(reads).toEqual([identity(completed("same", 10)).messageID, identity(row).messageID])
  })

  test("missing, mismatched, and failed receipt reads remain pending while legacy rows stay quiescent", async () => {
    const row = completed("needs-answer", 12)
    const legacy = { ...completed("legacy", 1), config: "{}" }
    const paused = { ...completed("paused", 2), status: "paused" }
    let mode: "throw" | "wrong-kind" | "valid" = "throw"
    let reads = 0
    const client = {
      dag: { bySession: async () => ({ data: [row, legacy, paused] }) },
      session: {
        message: async () => {
          reads++
          if (mode === "throw") throw new Error("temporary read failure")
          const receipt = answer(row)
          if (mode === "wrong-kind") receipt.data.parts[0].metadata.dag_delivery.kind = "source"
          return receipt
        },
      },
    } as unknown as OpencodeClient
    const poll = DagHold.makeDagWorkflowPoll(client, "parent")
    expect((await poll())?.map((item) => item.awaitingReport)).toEqual([true, undefined, undefined])
    mode = "wrong-kind"
    expect((await poll())?.[0]?.awaitingReport).toBe(true)
    mode = "valid"
    expect((await poll())?.[0]?.awaitingReport).toBe(false)
    expect(reads).toBe(3)
  })

  test("startup retries a failed workflow list before freezing the receipt baseline", async () => {
    const old = completed("old-list", 13)
    let listReads = 0
    const client = {
      dag: {
        bySession: async () => {
          listReads++
          if (listReads === 1) return { error: { name: "InternalServerError", data: { message: "temporary" } } }
          return { data: [old] }
        },
      },
      session: { message: async () => answer(old) },
    } as unknown as OpencodeClient

    const hold = await DagHold.createDagRunHold(client, "parent")
    expect(listReads).toBe(2)
    await hold.onBusy()
    expect(await hold.onIdle()).toBe("break")
  })

  test("startup retries an unknown receipt read and does not require the historical answer event", async () => {
    const old = completed("old-receipt", 14)
    let listReads = 0
    let receiptReads = 0
    const client = {
      dag: {
        bySession: async () => {
          listReads++
          return { data: [old] }
        },
      },
      session: {
        message: async () => {
          receiptReads++
          if (receiptReads === 1) throw new Error("temporary receipt read failure")
          return answer(old)
        },
      },
    } as unknown as OpencodeClient

    const hold = await DagHold.createDagRunHold(client, "parent")
    expect(listReads).toBe(2)
    expect(receiptReads).toBe(2)
    await hold.onBusy()
    expect(await hold.onIdle()).toBe("break")
  })

  for (const missing of [
    {
      name: "NotFoundError",
      response: () => ({
        error: { name: "NotFoundError", data: { message: "Message not found" } },
        response: { status: 404 },
      }),
    },
    {
      name: "successful lookup without a matching answer part",
      response: (row: Row) => ({ data: { info: { id: identity(row).messageID }, parts: [] } }),
    },
  ]) {
    test(`startup accepts a confirmed missing receipt from ${missing.name} and still requires a later emission`, async () => {
      const old = completed("old-missing", 15)
      const next = completed("new-after-missing", 16)
      let row = old
      const reads: string[] = []
      const client = {
        dag: { bySession: async () => ({ data: [row] }) },
        session: {
          message: async ({ messageID }: { messageID: string }) => {
            reads.push(messageID)
            return messageID === identity(old).messageID ? missing.response(old) : answer(next)
          },
        },
      } as unknown as OpencodeClient

      const hold = await DagHold.createDagRunHold(client, "parent")
      expect(reads).toEqual([identity(old).messageID])
      row = next
      await hold.onBusy()
      expect(await hold.onIdle()).toBe("hold")
      hold.onText(answer(next).data.parts[0])
      expect(await hold.onIdle()).toBe("break")
      expect(reads).toEqual([identity(old).messageID, identity(next).messageID])
    })
  }

  test("startup fails clearly after bounded retries when the workflow list stays unavailable", async () => {
    let listReads = 0
    const client = {
      dag: {
        bySession: async () => {
          listReads++
          return { error: { name: "InternalServerError", data: { message: "still unavailable" } } }
        },
      },
      session: { message: async () => ({ data: {} }) },
    } as unknown as OpencodeClient

    await expect(DagHold.createDagRunHold(client, "parent")).rejects.toThrow(
      "Unable to establish the DAG startup baseline after 5 attempts",
    )
    expect(listReads).toBe(5)
  })

  test("startup fails clearly after bounded retries when a receipt state stays unknown", async () => {
    const old = completed("unknown-receipt", 17)
    let receiptReads = 0
    const client = {
      dag: { bySession: async () => ({ data: [old] }) },
      session: {
        message: async () => {
          receiptReads++
          throw new Error("receipt endpoint unavailable")
        },
      },
    } as unknown as OpencodeClient

    await expect(DagHold.createDagRunHold(client, "parent")).rejects.toThrow(
      "Unable to establish the DAG startup baseline after 5 attempts",
    )
    expect(receiptReads).toBe(5)
  })

  test("an idle poll cannot exit before an already-persisted second answer is emitted", async () => {
    const old = completed("old", 20)
    const next = completed("next", 21)
    let rows = [old]
    const client = {
      dag: { bySession: async () => ({ data: rows }) },
      session: {
        message: async ({ messageID }: { messageID: string }) =>
          answer(messageID === identity(old).messageID ? old : next),
      },
    } as unknown as OpencodeClient
    // Startup happens before the prompt. The old answer is historical and
    // does not need replay; the second answer appears after this baseline.
    const hold = await DagHold.createDagRunHold(client, "parent")
    rows = [old, next]
    await hold.onBusy()
    expect(await hold.onIdle()).toBe("hold")
    // The SDK poll sees both durable receipts, but the stream has not yet
    // delivered next's text event to the output branch.
    expect(await hold.onIdle()).toBe("hold")
    // The plain renderer intentionally skips whitespace, but still consumes
    // the completed part event and must release the hold.
    hold.onText({ ...answer(next).data.parts[0], text: " \n" })
    expect(await hold.onIdle()).toBe("break")
  })

  test("only the exact new answer part and metadata discharge a new completion seq", async () => {
    const prior = completed("same", 30)
    const current = completed("same", 31)
    let row = prior
    const client = {
      dag: { bySession: async () => ({ data: [row] }) },
      session: { message: async () => answer(row) },
    } as unknown as OpencodeClient
    const hold = await DagHold.createDagRunHold(client, "parent")
    row = current
    await hold.onBusy()
    expect(await hold.onIdle()).toBe("hold")
    hold.onText(answer(prior).data.parts[0])
    expect(await hold.onIdle()).toBe("hold")
    const wrongKind = answer(current).data.parts[0]
    wrongKind.metadata.dag_delivery.kind = "source"
    hold.onText(wrongKind)
    expect(await hold.onIdle()).toBe("hold")
    hold.onText({ ...answer(current).data.parts[0], id: "prt_wrong" })
    expect(await hold.onIdle()).toBe("hold")
    hold.onText({ ...answer(current).data.parts[0], messageID: "msg_wrong" })
    expect(await hold.onIdle()).toBe("hold")
    hold.onText({ ...answer(current).data.parts[0], sessionID: "other" })
    expect(await hold.onIdle()).toBe("hold")
    hold.onText(answer(current).data.parts[0])
    expect(await hold.onIdle()).toBe("break")
  })

  test("an emitted answer still waits through a receipt read failure", async () => {
    const row = completed("later", 40)
    let rows: Row[] = []
    let fails = true
    const client = {
      dag: { bySession: async () => ({ data: rows }) },
      session: {
        message: async () => {
          if (fails) throw new Error("receipt temporarily unavailable")
          return answer(row)
        },
      },
    } as unknown as OpencodeClient
    const hold = await DagHold.createDagRunHold(client, "parent")
    rows = [row]
    await hold.onBusy()
    hold.onText(answer(row).data.parts[0])
    expect(await hold.onIdle()).toBe("hold")
    fails = false
    expect(await hold.onIdle()).toBe("break")
  })
})
