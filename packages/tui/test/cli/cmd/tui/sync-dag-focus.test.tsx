// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { tmpdir } from "../../../fixture/fixture"
import { directory, mount, wait } from "./sync-fixture"

// What the user did in the /dag panel is kept per session tree, in memory only: the workflow they picked and
// the ones they opened. The status band reads it to follow the panel (#1032 2.5).

async function withMount(run: (ctx: Awaited<ReturnType<typeof mount>>) => Promise<void>) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const ctx = await mount(undefined, tmp.path)
  try {
    await run(ctx)
  } finally {
    ctx.app.renderer.destroy()
  }
}

describe("tui sync dag focus memory", () => {
  test("a session tree starts with no choice and nothing opened", async () => {
    await withMount(async ({ sync }) => {
      expect(sync.dag.focus.chosen("ses_root")).toBeUndefined()
      expect([...sync.dag.focus.acknowledged("ses_root")]).toEqual([])
    })
  })

  test("choosing remembers one workflow per tree, and the last choice wins", async () => {
    await withMount(async ({ sync }) => {
      sync.dag.focus.choose("ses_a", "wf-1")
      sync.dag.focus.choose("ses_b", "wf-9")
      expect(sync.dag.focus.chosen("ses_a")).toBe("wf-1")
      sync.dag.focus.choose("ses_a", "wf-2")
      expect(sync.dag.focus.chosen("ses_a")).toBe("wf-2")
      expect(sync.dag.focus.chosen("ses_b")).toBe("wf-9")
    })
  })

  test("opening a workflow is remembered once, and the trees stay apart", async () => {
    await withMount(async ({ sync }) => {
      sync.dag.focus.acknowledge("ses_a", "wf-1")
      sync.dag.focus.acknowledge("ses_a", "wf-1")
      sync.dag.focus.acknowledge("ses_a", "wf-2")
      sync.dag.focus.acknowledge("ses_b", "wf-1")
      expect([...sync.dag.focus.acknowledged("ses_a")].toSorted()).toEqual(["wf-1", "wf-2"])
      expect([...sync.dag.focus.acknowledged("ses_b")]).toEqual(["wf-1"])
    })
  })

  test("choosing does not count as opening, and opening does not choose", async () => {
    await withMount(async ({ sync }) => {
      sync.dag.focus.choose("ses_a", "wf-1")
      expect([...sync.dag.focus.acknowledged("ses_a")]).toEqual([])
      sync.dag.focus.acknowledge("ses_b", "wf-1")
      expect(sync.dag.focus.chosen("ses_b")).toBeUndefined()
    })
  })

  test("the two settle in either order without losing the other", async () => {
    await withMount(async ({ sync }) => {
      sync.dag.focus.acknowledge("ses_a", "wf-1")
      sync.dag.focus.choose("ses_a", "wf-2")
      sync.dag.focus.acknowledge("ses_a", "wf-2")
      expect(sync.dag.focus.chosen("ses_a")).toBe("wf-2")
      expect([...sync.dag.focus.acknowledged("ses_a")].toSorted()).toEqual(["wf-1", "wf-2"])
    })
  })

  test("readers are told when either changes", async () => {
    await withMount(async ({ sync }) => {
      await createRoot(async (dispose) => {
        const chosen = createMemo(() => sync.dag.focus.chosen("ses_a"))
        const opened = createMemo(() => [...sync.dag.focus.acknowledged("ses_a")].toSorted().join(","))
        expect(chosen()).toBeUndefined()
        expect(opened()).toBe("")
        sync.dag.focus.choose("ses_a", "wf-1")
        sync.dag.focus.acknowledge("ses_a", "wf-3")
        sync.dag.focus.acknowledge("ses_a", "wf-1")
        expect(chosen()).toBe("wf-1")
        expect(opened()).toBe("wf-1,wf-3")
        dispose()
      })
    })
  })

  test("a deleted session forgets what was remembered for its tree", async () => {
    await withMount(async ({ emit, sdk, sync }) => {
      sync.dag.focus.choose("ses_gone", "wf-1")
      sync.dag.focus.acknowledge("ses_gone", "wf-1")
      sync.dag.focus.choose("ses_kept", "wf-2")

      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_dag_focus_deleted",
          type: "session.deleted",
          properties: {
            sessionID: "ses_gone",
            info: {
              id: "ses_gone",
              slug: "ses_gone",
              role: "root",
              title: "ses_gone",
              projectID: "proj_test",
              directory,
              version: "test",
              time: { created: 0, updated: 0 },
            },
          },
        },
      })
      sdk.frameClock.flushNow()
      await wait(() => sync.dag.focus.chosen("ses_gone") === undefined)
      expect([...sync.dag.focus.acknowledged("ses_gone")]).toEqual([])
      expect(sync.dag.focus.chosen("ses_kept")).toBe("wf-2")
    })
  })

  test("a reconnect leaves it alone: it is the user's own state, not something the server holds", async () => {
    await withMount(async ({ reconnect, sync }) => {
      sync.dag.focus.choose("ses_a", "wf-1")
      sync.dag.focus.acknowledge("ses_a", "wf-1")
      reconnect()
      await Bun.sleep(80)
      expect(sync.dag.focus.chosen("ses_a")).toBe("wf-1")
      expect([...sync.dag.focus.acknowledged("ses_a")]).toEqual(["wf-1"])
    })
  })
})
