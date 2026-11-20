// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { DagNode, DagWorkflowSummary, GlobalEvent } from "@graphagent/sdk"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

const sid = "ses_dagn_1"
const wf = "wf-nodes-1"

let sequence = 0
const nextID = () => `evt_dagn_${++sequence}`

/** A node as the server sends it, with the bulky fields the TUI must not keep. */
function wire(id: string, status = "pending", extra: Partial<DagNode> = {}, workflow = wf): DagNode {
  return {
    id,
    workflow_id: workflow,
    name: id,
    worker_type: "task",
    status,
    required: false,
    depends_on: [],
    model_id: "model-x",
    output: { text: "x".repeat(2_000) },
    replan_attempts: 0,
    ...extra,
  }
}

function summary(graphRev = 1, id = wf): DagWorkflowSummary {
  return {
    id,
    title: id,
    status: "running",
    graphRev,
    nodeCount: 2,
    completedNodes: 0,
    runningNodes: 1,
    failedNodes: 0,
    skippedNodes: 0,
    abortedNodes: 0,
    queuedNodes: 1,
    escalatedNodes: 0,
  }
}

function summaryEvent(summaries: DagWorkflowSummary[]): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id: nextID(), type: "dag.workflow.summary.updated", properties: { sessionID: sid, summaries } },
  }
}

interface Push {
  workflowID?: string
  graphRev?: number
  seq: number
  nodes?: DagNode[]
  removed?: string[]
  resync?: boolean
}

function nodesEvent(push: Push, workspace?: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    ...(workspace ? { workspace } : {}),
    payload: {
      id: nextID(),
      type: "dag.workflow.nodes.updated",
      properties: {
        sessionID: sid,
        workflowID: push.workflowID ?? wf,
        graphRev: push.graphRev ?? 1,
        seq: push.seq,
        nodes: push.nodes ?? [],
        removed: push.removed ?? [],
        ...(push.resync ? { resync: true } : {}),
      },
    },
  }
}

function global(payload: GlobalEvent["payload"] | Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return { directory, project: "proj_test", payload } as GlobalEvent
}

/** `GET /dag/:id/nodes`: the tables it serves with the graph revision each belongs to, and a record of every read. */
function tableRoute(tables: Record<string, DagNode[]>) {
  const route = {
    tables,
    /** The revision a table is answered with; 1 unless set. The wire may carry a non-finite sentinel. */
    revs: {} as Record<string, number | string>,
    reads: [] as string[],
    status: 200,
    /** Held until released: the read stays in flight. */
    gate: undefined as Promise<void> | undefined,
    onRead: undefined as ((workflowID: string) => void) | undefined,
    handler: async (url: URL) => {
      const match = url.pathname.match(/^\/dag\/([^/]+)\/nodes$/)
      if (!match) return undefined
      route.reads.push(match[1])
      route.onRead?.(match[1])
      if (route.gate) await route.gate
      if (route.status !== 200) return json({ message: "unavailable" }, { status: route.status })
      return json({ graphRev: route.revs[match[1]] ?? 1, nodes: route.tables[match[1]] ?? [] })
    },
  }
  return route
}

const settle = () => Bun.sleep(80)

async function withMount(
  route: ReturnType<typeof tableRoute>,
  run: (ctx: Awaited<ReturnType<typeof mount>>) => Promise<void>,
) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const ctx = await mount(route.handler, tmp.path)
  try {
    await run(ctx)
  } finally {
    ctx.app.renderer.destroy()
  }
}

const shown = (workflowID = wf, sessionID = sid) => [{ workflowID, sessionID }]

describe("tui sync dag node tables", () => {
  test("watching a workflow registers its owner session first, then reads the table exactly once", async () => {
    const route = tableRoute({ [wf]: [wire("a"), wire("b", "running")] })
    await withMount(route, async ({ interest, sync }) => {
      const registered: boolean[] = []
      route.onRead = () => registered.push(interest.some((full) => full.includes(sid)))

      expect(sync.dag.nodes(wf)).toBeUndefined()
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)
      await settle()

      expect(route.reads).toEqual([wf])
      // The worker had confirmed the session before the read went out.
      expect(registered).toEqual([true])
      expect(interest.at(-1)).toEqual([sid])
      expect(sync.dag.nodes(wf)?.map((row) => [row.id, row.status])).toEqual([
        ["a", "pending"],
        ["b", "running"],
      ])
      expect(sync.data.dagNodes[wf].status).toBe("ready")
    })
  })

  test("rows are stored without the output and the fields no surface shows", async () => {
    const route = tableRoute({
      [wf]: [
        wire("a", "failed", {
          error_reason: "boom",
          error_class: "cancelled",
          child_session_id: "ses_child",
          started_at: 100,
          completed_at: 200,
          deadline_ms: 900,
          replan_attempts: 2,
          agent_messages: { queued: 1, delivered: 2, undeliverable: 0 },
        }),
      ],
    })
    await withMount(route, async ({ sync }) => {
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)
      const row = sync.dag.nodes(wf)?.[0]
      expect(row).toBeDefined()
      expect(row).toMatchObject({
        id: "a",
        status: "failed",
        error_reason: "boom",
        error_class: "cancelled",
        child_session_id: "ses_child",
        started_at: 100,
        completed_at: 200,
        deadline_ms: 900,
        replan_attempts: 2,
        agent_messages: { queued: 1, delivered: 2, undeliverable: 0 },
      })
      expect(row && "output" in row).toBe(false)
      expect(row && "model_id" in row).toBe(false)
    })
  })

  test("the slot an expansion's nodes were generated by reaches the rows, in the table and in a push", async () => {
    const route = tableRoute({ [wf]: [wire("slot"), wire("a", "pending", { expanded_from: "slot" })] })
    await withMount(route, async ({ emit, sync }) => {
      emit(summaryEvent([summary(1)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) === 1)
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)
      const marks = () => Object.fromEntries((sync.dag.nodes(wf) ?? []).map((row) => [row.id, row.expanded_from]))
      expect(marks()).toEqual({ slot: undefined, a: "slot" })
      // A node without a mark has no such key at all, not a key set to undefined.
      expect(sync.dag.nodes(wf)?.map((row) => "expanded_from" in row)).toEqual([false, true])

      emit(
        nodesEvent({
          seq: 1,
          nodes: [wire("b", "running", { expanded_from: "slot" }), wire("a", "completed", { expanded_from: "slot" })],
        }),
      )
      await wait(() => sync.dag.nodes(wf)?.length === 3)
      expect(marks()).toEqual({ slot: undefined, a: "slot", b: "slot" })
      expect(route.reads).toEqual([wf])
    })
  })

  test("a push merges into the table with no further read; stale and duplicate pushes change nothing", async () => {
    const route = tableRoute({ [wf]: [wire("a"), wire("b", "running")] })
    await withMount(route, async ({ emit, sync }) => {
      emit(summaryEvent([summary(1)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) === 1)
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)

      emit(nodesEvent({ seq: 1, nodes: [wire("b", "completed"), wire("c")] }))
      await wait(() => sync.dag.nodes(wf)?.length === 3)
      expect(sync.dag.nodes(wf)?.map((row) => [row.id, row.status])).toEqual([
        ["a", "pending"],
        ["b", "completed"],
        ["c", "pending"],
      ])
      // The pushed rows lose their output too.
      expect(sync.dag.nodes(wf)?.some((row) => "output" in row)).toBe(false)

      // The same seq again, and an older one: neither is applied.
      emit(nodesEvent({ seq: 1, nodes: [wire("b", "failed")] }))
      emit(nodesEvent({ seq: 0, nodes: [wire("a", "failed")] }))
      await settle()
      expect(sync.dag.nodes(wf)?.map((row) => row.status)).toEqual(["pending", "completed", "pending"])

      emit(nodesEvent({ seq: 2, removed: ["a"] }))
      await wait(() => sync.dag.nodes(wf)?.length === 2)
      expect(sync.dag.nodes(wf)?.map((row) => row.id)).toEqual(["b", "c"])
      expect(route.reads).toEqual([wf])
    })
  })

  test("pushes that arrive while the table is being read are buffered and replayed on top of it", async () => {
    const route = tableRoute({ [wf]: [wire("a"), wire("b")] })
    let release!: () => void
    route.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await withMount(route, async ({ emit, sync }) => {
      await sync.dag.watch("band", shown())
      await wait(() => route.reads.length === 1)
      const loading = sync.data.dagNodes[wf]
      expect(loading.status).toBe("loading")
      expect(sync.dag.nodes(wf)).toBeUndefined()

      emit(nodesEvent({ seq: 1, nodes: [wire("late"), wire("a", "running")] }))
      await wait(() => {
        const feed = sync.data.dagNodes[wf]
        return feed.status === "loading" && feed.buffered.length === 1
      })
      expect(sync.dag.nodes(wf)).toBeUndefined()

      release()
      await wait(() => sync.dag.nodes(wf) !== undefined)
      expect(sync.dag.nodes(wf)?.map((row) => [row.id, row.status])).toEqual([
        ["a", "running"],
        ["b", "pending"],
        ["late", "pending"],
      ])

      // The answer named revision 1, the buffered push's, so the push replayed and the next one merges.
      emit(nodesEvent({ seq: 2, nodes: [wire("b", "completed")] }))
      await wait(() => sync.dag.nodes(wf)?.[1].status === "completed")
      await settle()
      expect(route.reads).toEqual([wf])
    })
  })

  test("a resync push reads the table again, exactly once, and the new table replaces the old", async () => {
    const route = tableRoute({ [wf]: [wire("a"), wire("b")] })
    await withMount(route, async ({ emit, sync }) => {
      emit(summaryEvent([summary(1)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) === 1)
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)

      route.tables[wf] = [wire("a", "completed"), wire("b", "running"), wire("d")]
      emit(nodesEvent({ seq: 2, resync: true }))
      await wait(() => sync.dag.nodes(wf)?.length === 3)
      await settle()
      expect(route.reads).toEqual([wf, wf])
      expect(sync.dag.nodes(wf)?.map((row) => [row.id, row.status])).toEqual([
        ["a", "completed"],
        ["b", "running"],
        ["d", "pending"],
      ])

      // The resync carried no rows: what follows merges without another read.
      emit(nodesEvent({ seq: 3, nodes: [wire("d", "running")] }))
      await wait(() => sync.dag.nodes(wf)?.[2].status === "running")
      await settle()
      expect(route.reads).toEqual([wf, wf])
    })
  })

  test("a push from another graph revision reads the table again, once, and stamps it with the revision it answers", async () => {
    const route = tableRoute({ [wf]: [wire("a"), wire("b")] })
    await withMount(route, async ({ emit, sync }) => {
      emit(summaryEvent([summary(1)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) === 1)
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)

      // A replan: the table changes shape, the server is at revision 2 and the push names it.
      route.tables[wf] = [wire("a"), wire("z")]
      route.revs[wf] = 2
      emit(nodesEvent({ graphRev: 2, seq: 5, nodes: [wire("z", "running")] }))
      await wait(() => route.reads.length === 2)
      await wait(() => sync.dag.nodes(wf)?.some((row) => row.id === "z") === true)
      expect(sync.dag.nodes(wf)?.map((row) => [row.id, row.status])).toEqual([
        ["a", "pending"],
        ["z", "running"],
      ])

      // Revision 2 is the table's now, so a push from it merges.
      emit(nodesEvent({ graphRev: 2, seq: 6, nodes: [wire("z", "completed")] }))
      await wait(() => sync.dag.nodes(wf)?.[1].status === "completed")
      await settle()
      expect(route.reads).toEqual([wf, wf])
    })
  })

  test("a workflow nobody watches is never read, and its pushes are ignored", async () => {
    const route = tableRoute({ [wf]: [wire("a")] })
    await withMount(route, async ({ emit, interest, sync }) => {
      emit(summaryEvent([summary(1)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) === 1)
      emit(nodesEvent({ seq: 1, nodes: [wire("a", "completed")] }))
      emit(nodesEvent({ seq: 2, resync: true }))
      await settle()

      expect(route.reads).toEqual([])
      expect(sync.data.dagNodes).toEqual({})
      expect(sync.dag.nodes(wf)).toBeUndefined()
      expect(interest).toEqual([])
    })
  })

  test("a push for another workflow does not touch the loaded one and starts no read", async () => {
    const route = tableRoute({ [wf]: [wire("a")] })
    await withMount(route, async ({ emit, sync }) => {
      emit(summaryEvent([summary(1)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) === 1)
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)

      emit(nodesEvent({ workflowID: "wf-other", seq: 1, nodes: [wire("x", "failed", {}, "wf-other")] }))
      emit(nodesEvent({ workflowID: "wf-other", seq: 2, resync: true }))
      await settle()
      expect(sync.data.dagNodes["wf-other"]).toBeUndefined()
      expect(Object.keys(sync.data.dagNodes)).toEqual([wf])
      expect(sync.dag.nodes(wf)?.map((row) => row.status)).toEqual(["pending"])
      expect(route.reads).toEqual([wf])
    })
  })

  test("once no surface shows the workflow the interest is withdrawn and the table dropped", async () => {
    const route = tableRoute({ [wf]: [wire("a")] })
    await withMount(route, async ({ emit, interest, sync }) => {
      emit(summaryEvent([summary(1)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) === 1)
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)
      expect(interest.at(-1)).toEqual([sid])

      await sync.dag.watch("band", [])
      expect(interest.at(-1)).toEqual([])
      expect(sync.data.dagNodes[wf]).toBeUndefined()
      expect(sync.dag.nodes(wf)).toBeUndefined()

      // Nothing is delivered or merged any more.
      emit(nodesEvent({ seq: 1, nodes: [wire("a", "completed")] }))
      emit(nodesEvent({ seq: 2, resync: true }))
      await settle()
      expect(sync.data.dagNodes[wf]).toBeUndefined()
      expect(route.reads).toEqual([wf])

      // Showing it again is a first need again: register, then read.
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)
      expect(interest.at(-1)).toEqual([sid])
      expect(route.reads).toEqual([wf, wf])
    })
  })

  test("a workflow another surface still shows keeps its table and its interest", async () => {
    const route = tableRoute({ [wf]: [wire("a")] })
    await withMount(route, async ({ interest, sync }) => {
      await Promise.all([sync.dag.watch("band", shown()), sync.dag.watch("panel", shown())])
      await wait(() => sync.dag.nodes(wf) !== undefined)
      await settle()
      // One registration and one read serve both surfaces.
      expect(route.reads).toEqual([wf])
      expect(interest.filter((full) => full.includes(sid))).toHaveLength(1)

      await sync.dag.watch("panel", [])
      expect(sync.dag.nodes(wf)).toBeDefined()
      expect(interest).toHaveLength(1)

      await sync.dag.watch("band", [])
      expect(sync.dag.nodes(wf)).toBeUndefined()
      expect(interest.at(-1)).toEqual([])
    })
  })

  test("declaring the same workflows again does nothing", async () => {
    const route = tableRoute({ [wf]: [wire("a")] })
    await withMount(route, async ({ interest, sync }) => {
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)
      await sync.dag.watch("band", shown())
      await sync.dag.watch("band", [...shown()])
      await settle()
      expect(route.reads).toEqual([wf])
      expect(interest).toHaveLength(1)
      // Ending a surface that never began is not a change either.
      await sync.dag.watch("never-shown", [])
      expect(interest).toHaveLength(1)
    })
  })

  test("the owner sessions of every shown workflow are registered together", async () => {
    const other = "ses_dagn_2"
    const route = tableRoute({ [wf]: [wire("a")], "wf-2": [wire("x", "pending", {}, "wf-2")] })
    await withMount(route, async ({ interest, sync }) => {
      await sync.dag.watch("band", [
        { workflowID: wf, sessionID: sid },
        { workflowID: "wf-2", sessionID: other },
      ])
      await wait(() => sync.dag.nodes(wf) !== undefined && sync.dag.nodes("wf-2") !== undefined)
      expect(interest.at(-1)).toEqual([sid, other])
      expect(route.reads.toSorted()).toEqual(["wf-2", wf])

      // Dropping one workflow withdraws only its session.
      await sync.dag.watch("band", [{ workflowID: wf, sessionID: sid }])
      expect(interest.at(-1)).toEqual([sid])
      expect(sync.dag.nodes("wf-2")).toBeUndefined()
      expect(sync.dag.nodes(wf)).toBeDefined()
    })
  })

  test("a reconnect reads every shown table again, once, and replaces what was loaded", async () => {
    const route = tableRoute({ [wf]: [wire("a")], "wf-2": [wire("x", "pending", {}, "wf-2")] })
    await withMount(route, async ({ reconnect, sync }) => {
      await sync.dag.watch("band", [
        { workflowID: wf, sessionID: sid },
        { workflowID: "wf-2", sessionID: sid },
      ])
      await wait(() => sync.dag.nodes(wf) !== undefined && sync.dag.nodes("wf-2") !== undefined)
      expect(route.reads).toHaveLength(2)

      route.tables[wf] = [wire("a", "completed"), wire("b")]
      route.tables["wf-2"] = [wire("x", "failed", {}, "wf-2")]
      reconnect()
      await wait(() => sync.dag.nodes(wf)?.length === 2)
      await wait(() => sync.dag.nodes("wf-2")?.[0].status === "failed")
      await settle()

      expect(route.reads.slice(2).toSorted()).toEqual(["wf-2", wf])
      expect(sync.dag.nodes(wf)?.map((row) => row.status)).toEqual(["completed", "pending"])
    })
  })

  test("a reconnect with nothing shown reads nothing", async () => {
    const route = tableRoute({ [wf]: [wire("a")] })
    await withMount(route, async ({ reconnect, sync }) => {
      reconnect()
      await settle()
      expect(route.reads).toEqual([])
      expect(sync.data.dagNodes).toEqual({})
    })
  })

  test("a failed read leaves the table loading; pushes do not retry it, a resync does", async () => {
    const route = tableRoute({ [wf]: [wire("a"), wire("b")] })
    route.status = 500
    await withMount(route, async ({ emit, sync }) => {
      emit(summaryEvent([summary(1)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) === 1)
      await sync.dag.watch("band", shown())
      await wait(() => route.reads.length === 1)
      await settle()
      expect(sync.data.dagNodes[wf].status).toBe("loading")
      expect(sync.dag.nodes(wf)).toBeUndefined()

      // Pushes buffer, and no timer or push turns them into reads.
      emit(nodesEvent({ seq: 1, nodes: [wire("a", "running")] }))
      emit(nodesEvent({ seq: 2, nodes: [wire("b", "running")] }))
      await settle()
      expect(route.reads).toHaveLength(1)
      const feed = sync.data.dagNodes[wf]
      expect(feed.status === "loading" && feed.buffered.length).toBe(2)

      route.status = 200
      emit(nodesEvent({ seq: 3, resync: true }))
      await wait(() => sync.dag.nodes(wf) !== undefined)
      expect(route.reads).toHaveLength(2)
      expect(sync.dag.nodes(wf)?.map((row) => row.status)).toEqual(["pending", "pending"])
    })
  })

  test("when the worker never confirms the interest nothing is read, and the next declaration asks again", async () => {
    const route = tableRoute({ [wf]: [wire("a")] })
    await withMount(route, async ({ interest, sdk, sync }) => {
      const submit = sdk.setInterest
      let failing = true
      sdk.setInterest = (full) => (failing ? Promise.reject(new Error("worker gone")) : submit(full))

      await sync.dag.watch("band", shown())
      expect(route.reads).toEqual([])
      expect(sync.data.dagNodes).toEqual({})
      expect(sync.interest.explicit().has(sid)).toBe(false)

      // The worker is back; another surface showing the workflow declares it again.
      failing = false
      await sync.dag.watch("panel", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)
      expect(route.reads).toEqual([wf])
      expect(interest.at(-1)).toEqual([sid])
    })
  })

  test("a watch whose interest the worker never confirmed is registered again on reconnect, then read", async () => {
    const route = tableRoute({ [wf]: [wire("a")] })
    await withMount(route, async ({ interest, reconnect, sdk, sync }) => {
      const submit = sdk.setInterest
      let failing = true
      sdk.setInterest = (full) => (failing ? Promise.reject(new Error("worker gone")) : submit(full))

      await sync.dag.watch("band", shown())
      expect(route.reads).toEqual([])

      // The same surface declaring the same workflow again does nothing by contract.
      await sync.dag.watch("band", shown())
      expect(route.reads).toEqual([])

      // Connectivity returns: the watch is still declared, so it registers and then reads.
      failing = false
      reconnect()
      await wait(() => sync.dag.nodes(wf) !== undefined)
      expect(route.reads).toEqual([wf])
      expect(interest.at(-1)).toEqual([sid])
    })
  })

  test("a deleted owner session ends its watches", async () => {
    const route = tableRoute({ [wf]: [wire("a")] })
    await withMount(route, async ({ emit, interest, sdk, sync }) => {
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)

      emit(
        global({
          id: nextID(),
          type: "session.deleted",
          properties: {
            sessionID: sid,
            info: {
              id: sid,
              slug: sid,
              projectID: "proj_test",
              directory,
              version: "test",
              time: { created: 0, updated: 0 },
            },
          },
        }),
      )
      sdk.frameClock.flushNow()
      await wait(() => sync.data.dagNodes[wf] === undefined)
      await wait(() => JSON.stringify(interest.at(-1)) === "[]")
      expect(route.reads).toEqual([wf])
    })
  })

  test("pushes routed to another workspace are ignored", async () => {
    const route = tableRoute({ [wf]: [wire("a")] })
    await withMount(route, async ({ emit, project, sync }) => {
      project.workspace.set("wrk-current")
      emit(summaryEvent([summary(1)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) === 1)
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)

      emit(nodesEvent({ seq: 1, nodes: [wire("a", "failed")] }, "wrk-foreign"))
      await settle()
      expect(sync.dag.nodes(wf)?.[0].status).toBe("pending")

      emit(nodesEvent({ seq: 1, nodes: [wire("a", "completed")] }, "wrk-current"))
      await wait(() => sync.dag.nodes(wf)?.[0].status === "completed")
    })
  })

  test("the non-finite number sentinels are resolved in fetched and pushed rows alike", async () => {
    const route = tableRoute({
      [wf]: [wire("a", "running", { replan_attempts: "NaN", started_at: "Infinity", deadline_ms: "NaN" })],
    })
    await withMount(route, async ({ emit, sync }) => {
      emit(summaryEvent([summary(1)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) === 1)
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)
      const fetched = sync.dag.nodes(wf)?.[0]
      expect(fetched?.replan_attempts).toBe(0)
      expect(fetched && "started_at" in fetched).toBe(false)
      expect(fetched && "deadline_ms" in fetched).toBe(false)

      emit(nodesEvent({ seq: 1, nodes: [wire("a", "completed", { replan_attempts: 1, completed_at: "-Infinity" })] }))
      await wait(() => sync.dag.nodes(wf)?.[0].status === "completed")
      const pushed = sync.dag.nodes(wf)?.[0]
      expect(pushed?.replan_attempts).toBe(1)
      expect(pushed && "completed_at" in pushed).toBe(false)
    })
  })

  test("a graph revision sentinel on a push is not mistaken for a change", async () => {
    const route = tableRoute({ [wf]: [wire("a")] })
    route.revs[wf] = 0
    await withMount(route, async ({ emit, sync }) => {
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)
      // The wire says "NaN": it counts as revision 0, the table's, and merges.
      emit(
        global({
          id: nextID(),
          type: "dag.workflow.nodes.updated",
          properties: {
            sessionID: sid,
            workflowID: wf,
            graphRev: "NaN",
            seq: 1,
            nodes: [wire("a", "completed")],
            removed: [],
          },
        }),
      )
      await wait(() => sync.dag.nodes(wf)?.[0].status === "completed")
      await settle()
      expect(route.reads).toEqual([wf])
    })
  })

  test("the table is stamped with the revision the answer names, not the summary's", async () => {
    const route = tableRoute({ [wf]: [wire("a"), wire("b")] })
    route.revs[wf] = 2
    await withMount(route, async ({ emit, sync }) => {
      // The summary lags behind: it still names revision 5.
      emit(summaryEvent([summary(5)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) === 1)
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)
      const feed = sync.data.dagNodes[wf]
      expect(feed.status === "ready" && feed.view.graphRev).toBe(2)

      // A push from the answer's revision merges; the summary's would have made it read the table again.
      emit(nodesEvent({ graphRev: 2, seq: 1, nodes: [wire("b", "completed")] }))
      await wait(() => sync.dag.nodes(wf)?.[1].status === "completed")
      await settle()
      expect(route.reads).toEqual([wf])
    })
  })

  test("a graph revision sentinel in the answer counts as revision 0", async () => {
    const route = tableRoute({ [wf]: [wire("a")] })
    route.revs[wf] = "NaN"
    await withMount(route, async ({ emit, sync }) => {
      await sync.dag.watch("band", shown())
      await wait(() => sync.dag.nodes(wf) !== undefined)
      const feed = sync.data.dagNodes[wf]
      expect(feed.status === "ready" && feed.view.graphRev).toBe(0)

      emit(nodesEvent({ graphRev: 0, seq: 1, nodes: [wire("a", "completed")] }))
      await wait(() => sync.dag.nodes(wf)?.[0].status === "completed")
      await settle()
      expect(route.reads).toEqual([wf])
    })
  })
})
