/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { TuiPluginApi } from "@opencode-ai/tui/plugin-api"
import type { DagNode, DagWorkflowSummary } from "@opencode-ai/sdk/v2"
import dagPanelPlugin from "../../src/feature-plugins/sidebar/dag-panel"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { TestTuiContexts } from "../fixture/tui-environment"

const SESSION_ID = "ses_panel"

const wfSummary = (overrides: Partial<DagWorkflowSummary> = {}): DagWorkflowSummary => ({
  id: "wf-1",
  title: "Panel workflow",
  status: "running",
  graphRev: 1,
  nodeCount: 2,
  completedNodes: 1,
  runningNodes: 1,
  failedNodes: 0,
  skippedNodes: 0,
  queuedNodes: 0,
  escalatedNodes: 0,
  ...overrides,
})

function dagNode(overrides: Partial<DagNode> & { id: string }): DagNode {
  return {
    workflow_id: "wf-1",
    name: overrides.id,
    status: "pending",
    worker_type: "build",
    required: false,
    depends_on: [],
    replan_attempts: 0,
    ...overrides,
  }
}

type RenderOpts = {
  workflows?: DagWorkflowSummary[]
  nodes?: DagNode[]
  width?: number
}

/** Mirrors the production bridge: the plugin-facing dag(sessionID) accessor
 * reads a Solid store slice that summary events replace wholesale. */
async function renderDagPanel(opts: RenderOpts = {}) {
  const nodesCalls: string[] = []
  let nodesState = opts.nodes ?? []
  const [store, setStore] = createStore<{ dag: Record<string, DagWorkflowSummary[]> }>({
    dag: { [SESSION_ID]: opts.workflows ?? [] },
  })

  const base = createTuiPluginApi({
    client: {
      dag: {
        nodes: async (input: { dagID: string }) => {
          nodesCalls.push(input.dagID)
          return { data: nodesState }
        },
      },
    } as unknown as TuiPluginApi["client"],
    state: { session: { dag: (sessionID: string) => store.dag[sessionID] ?? [] } },
  })

  let sidebar: ((props: { session_id: string }) => JSX.Element) | undefined
  const api = {
    ...base,
    slots: {
      register: (def: { slots: { sidebar_content: (ctx: never, props: { session_id: string }) => JSX.Element } }) => {
        sidebar = (props) => def.slots.sidebar_content(undefined as never, props)
      },
    },
  } as unknown as TuiPluginApi

  await dagPanelPlugin.tui(api, undefined, undefined as never)

  const app = await testRender(() => <TestTuiContexts>{sidebar?.({ session_id: SESSION_ID })}</TestTuiContexts>, {
    width: opts.width ?? 80,
    height: 24,
  })
  // The first active workflow auto-expands; let its initial fetch settle.
  await waitForCondition(() => nodesCalls.length > 0)

  return {
    app,
    nodesCalls: () => nodesCalls,
    setNodes: (nodes: DagNode[]) => {
      nodesState = nodes
    },
    setWorkflows: (wfs: DagWorkflowSummary[]) => setStore("dag", SESSION_ID, reconcile(wfs)),
  }
}

async function waitForCondition(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

describe("DagPanel expanded sidebar", () => {
  test("shows completed and skipped counts at narrow width without implying all nodes succeeded", async () => {
    const panel = await renderDagPanel({
      width: 44,
      workflows: [
        wfSummary({
          id: "wf-1",
          title: "Gated workflow",
          status: "paused",
          nodeCount: 8,
          completedNodes: 1,
          skippedNodes: 7,
          runningNodes: 0,
        }),
      ],
      nodes: [],
    })
    try {
      await panel.app.waitForFrame(
        (frame) =>
          frame.includes("Gated workflow") && frame.includes("8/8") && frame.includes("✓1") && frame.includes("⊘7"),
      )
    } finally {
      panel.app.renderer.destroy()
    }
  })

  test("equal-count replan bumps graphRev alone and refetches exactly once with the current node set", async () => {
    const panel = await renderDagPanel({
      workflows: [wfSummary({ id: "wf-1", graphRev: 1 })],
      nodes: [dagNode({ id: "n-1", name: "build-old", status: "pending" })],
    })
    try {
      await panel.app.waitForFrame((frame) => frame.includes("build-old"))
      const before = panel.nodesCalls().length
      // Equal-count replan: identical counts/status, only the topology
      // revision moved. The server now serves the replanned node set.
      panel.setNodes([dagNode({ id: "n-2", name: "build-new", status: "pending" })])
      panel.setWorkflows([wfSummary({ id: "wf-1", graphRev: 2 })])
      await waitForCondition(() => panel.nodesCalls().length === before + 1)
      await Bun.sleep(50)
      expect(panel.nodesCalls().length).toBe(before + 1)
      await panel.app.waitForFrame((frame) => frame.includes("build-new") && !frame.includes("build-old"))
    } finally {
      panel.app.renderer.destroy()
    }
  })

  // R1 regression canary: a no-op summary event must not refetch the expanded
  // row. Identity is preserved end-to-end because every summary writer —
  // bootstrap, reconnect, and the event reducer in context/sync.tsx — uses
  // reconcile(), which setWorkflows mirrors; unchanged same-ID rows keep their
  // store-node identity, so <For> never remounts them.
  test("no-op summary replacement (same graphRev and counts) does not refetch the expanded row", async () => {
    const panel = await renderDagPanel({
      workflows: [wfSummary({ id: "wf-1", graphRev: 1 })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "pending" })],
    })
    try {
      const before = panel.nodesCalls().length
      // A no-op summary event re-broadcasts identical state — same aggregates
      // AND same graphRev. The signature must not move, so no refetch.
      panel.setWorkflows([wfSummary({ id: "wf-1", graphRev: 1 })])
      await Bun.sleep(80)
      expect(panel.nodesCalls().length).toBe(before)
    } finally {
      panel.app.renderer.destroy()
    }
  })
})
