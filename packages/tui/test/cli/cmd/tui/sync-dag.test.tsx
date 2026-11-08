/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, mount, wait, json } from "./sync-fixture"
import { produce } from "solid-js/store"
import type { GlobalEvent } from "@graphagent/sdk/v2"
import type { DagWorkflowSummary } from "@graphagent/sdk/v2"

const sid = "ses_dag_1"

function summaryEvent(summaries: DagWorkflowSummary[], sessionID = sid, workspace?: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    ...(workspace ? { workspace } : {}),
    payload: {
      id: `evt_dag_summary_${Date.now()}_${Math.random()}`,
      type: "dag.workflow.summary.updated",
      properties: { sessionID, summaries },
    },
  }
}

function summary(completed: number, total: number, running = 0, failed = 0): DagWorkflowSummary {
  return {
    id: "wf-1",
    title: "Test workflow",
    status: "running",
    graphRev: 1,
    nodeCount: total,
    completedNodes: completed,
    runningNodes: running,
    failedNodes: failed,
    skippedNodes: 0,
    abortedNodes: 0,
    queuedNodes: 0,
    escalatedNodes: 0,
  }
}

describe("tui sync dag slice", () => {
  test("dag.workflow.summary.updated event writes into store.dag[sessionID]", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.dag[sid] ?? []).toEqual([])

      emit(summaryEvent([summary(2, 5, 1, 0)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) > 0)

      const stored = sync.data.dag[sid]
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ id: "wf-1", graphRev: 1, completedNodes: 2, nodeCount: 5, runningNodes: 1 })
    } finally {
      app.renderer.destroy()
    }
  })

  test("subsequent summary events replace the slice rather than accumulate", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      emit(summaryEvent([summary(1, 3)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) === 1)
      expect(sync.data.dag[sid][0].completedNodes).toBe(1)

      emit(summaryEvent([summary(3, 3)]))
      await wait(() => sync.data.dag[sid]?.[0]?.completedNodes === 3)

      expect(sync.data.dag[sid]).toHaveLength(1)
      expect(sync.data.dag[sid][0].completedNodes).toBe(3)
    } finally {
      app.renderer.destroy()
    }
  })

  test("ignores summary events routed to another workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      project.workspace.set("wrk-current")
      emit(summaryEvent([summary(1, 2)], sid, "wrk-foreign"))
      await Bun.sleep(50)
      expect(sync.data.dag[sid] ?? []).toEqual([])

      emit(summaryEvent([summary(2, 2)], sid, "wrk-current"))
      await wait(() => sync.data.dag[sid]?.[0]?.completedNodes === 2)
    } finally {
      app.renderer.destroy()
    }
  })

  test("bootstrap fetches GET /dag/session/:sid/summary as the baseline safety net", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const fetched: string[] = []
    const sessionRow = {
      id: sid,
      slug: "dag-test",
      projectID: "proj_test",
      directory,
      version: "test",
      time: { created: 0, updated: 0 },
    }
    const { app, sync } = await mount((url) => {
      // Make the session visible so bootstrap treats it as eligible for the summary fetch.
      if (url.pathname === "/session") return json([sessionRow])
      if (url.pathname === `/dag/session/${sid}/summary`) {
        fetched.push(url.pathname)
        return json([summary(4, 6, 1, 1)])
      }
      return undefined
    }, tmp.path)

    try {
      await wait(() => (sync.data.dag[sid]?.length ?? 0) > 0)
      expect(fetched).toContain(`/dag/session/${sid}/summary`)
      expect(sync.data.dag[sid][0]).toMatchObject({ completedNodes: 4, failedNodes: 1 })
    } finally {
      app.renderer.destroy()
    }
  })

  test("SSE reconnect re-fetches every session already in store.dag", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sid1 = "ses_reconnect_1"
    const sid2 = "ses_reconnect_2"
    // A session that is VISIBLE in the session list but NOT in store.dag —
    // reconnect compensation must NOT fetch it.
    const sidVisibleUntracked = "ses_visible_untracked"
    const summaryFetches: string[] = []
    let reconnectCallCount = 0

    const visibleSessionRow = {
      id: sidVisibleUntracked,
      slug: "visible-untracked",
      projectID: "proj_test",
      directory,
      version: "test",
      time: { created: 0, updated: 0 },
    }

    const { app, emit, reconnect, sync } = await mount((url) => {
      // Expose one visible session that bootstrap will add to store.session.
      // Its summary endpoint is intentionally NOT mocked so bootstrap's fetch
      // throws (swallowed by .catch), keeping it OUT of store.dag — proving
      // reconnect's recovery set is store.dag keys, not the visible-session query.
      if (url.pathname === "/session") return json([visibleSessionRow])
      if (url.pathname === `/dag/session/${sidVisibleUntracked}/summary`) {
        summaryFetches.push(sidVisibleUntracked)
        return json([])
      }
      if (url.pathname === `/dag/session/${sid1}/summary`) {
        summaryFetches.push(sid1)
        return json([summary(reconnectCallCount > 0 ? 9 : 1, 10)])
      }
      if (url.pathname === `/dag/session/${sid2}/summary`) {
        summaryFetches.push(sid2)
        return json([summary(reconnectCallCount > 0 ? 5 : 1, 6)])
      }
      return undefined
    }, tmp.path)

    try {
      // Confirm the visible session is in store.session and bootstrap created
      // an empty store.dag entry for it.
      await wait(() => sync.data.session.some((s) => s.id === sidVisibleUntracked))
      await wait(() => sidVisibleUntracked in sync.data.dag)

      // Remove the visible session's empty store.dag entry so it is genuinely
      // NOT tracked at reconnect time — simulating a session with no workflows
      // that the user never opened a DAG view for.
      sync.set("dag", produce((draft) => { delete draft[sidVisibleUntracked] }))
      expect(sync.data.dag[sidVisibleUntracked]).toBeUndefined()

      // Populate store.dag with two sessions via summary events.
      emit(summaryEvent([summary(1, 10)], sid1))
      emit(summaryEvent([summary(1, 6)], sid2))
      await wait(() => !!sync.data.dag[sid1]?.length && !!sync.data.dag[sid2]?.length)

      // Snapshot which sessions were fetched BEFORE reconnect so we can
      // isolate the reconnect-triggered fetches.
      const fetchedBefore = [...summaryFetches]

      // Trigger reconnect — should re-fetch BOTH tracked sessions only.
      reconnectCallCount += 1
      reconnect()
      await wait(() => sync.data.dag[sid1]?.[0]?.completedNodes === 9)
      await wait(() => sync.data.dag[sid2]?.[0]?.completedNodes === 5)

      const fetchedOnReconnect = summaryFetches.filter((s) => !fetchedBefore.includes(s))
      expect(fetchedOnReconnect).toContain(sid1)
      expect(fetchedOnReconnect).toContain(sid2)
      // The visible-but-untracked session must NOT be fetched on reconnect —
      // the recovery set is store.dag, not the visible-session query.
      expect(fetchedOnReconnect).not.toContain(sidVisibleUntracked)
    } finally {
      app.renderer.destroy()
    }
  })
})
