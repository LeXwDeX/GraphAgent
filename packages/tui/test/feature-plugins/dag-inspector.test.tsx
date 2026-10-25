/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { TuiPluginApi, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import type { DagNode, DagWorkflow, DagWorkflowSummary } from "@opencode-ai/sdk/v2"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider } from "../../src/keymap"
import { createSignal } from "solid-js"
import dagInspectorPlugin from "../../src/feature-plugins/system/dag-inspector"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"

const SESSION_ID = "ses_1"

const wfSummary = (overrides: Partial<DagWorkflowSummary> = {}): DagWorkflowSummary => ({
  id: "wf-1",
  title: "Test workflow",
  status: "running",
  graphRev: 1,
  nodeCount: 2,
  completedNodes: 0,
  runningNodes: 0,
  failedNodes: 0,
  skippedNodes: 0,
  queuedNodes: 0,
  escalatedNodes: 0,
  ...overrides,
})

type RenderOpts = {
  workflows?: DagWorkflowSummary[]
  serverWorkflows?: DagWorkflowSummary[]
  projectWorkflows?: DagWorkflow[]
  nodes?: DagNode[]
  initialRoute?: TuiRouteCurrent
  summary?: (sessionID: string) => Promise<{ data: DagWorkflowSummary[] }>
  fetchNodes?: (dagID: string, call: number) => Promise<{ data: DagNode[] }> | undefined
  fetchTimeoutMs?: number
  width?: number
}

const projectWorkflow = (overrides: Partial<DagWorkflow> & { id: string; session_id: string }): DagWorkflow => ({
  project_id: "proj_1",
  title: `Workflow ${overrides.id}`,
  status: "running",
  config: "{}",
  seq: 1,
  time_created: 0,
  time_updated: 0,
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

async function renderDagInspector(opts: RenderOpts = {}) {
  const commands = new Map<
    string,
    NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
  >()
  const [current, setCurrent] = createSignal<TuiRouteCurrent>(
    opts.initialRoute ?? { name: "dag", params: { sessionID: SESSION_ID } },
  )
  let renderInspector: TuiRouteDefinition["render"] | undefined

  // Updatable workflow state for change detection.
  let workflowsState = opts.workflows ?? []
  // Updatable node state so a replan can serve a fresh node set.
  let nodesState = opts.nodes ?? []

  // Trackable spies
  const nodesCalls: string[] = []
  const summaryCalls: string[] = []
  let listCalls = 0
  const controlCalls: { dagID: string; operation: string }[] = []
  const commandCalls: unknown[] = []
  const navigations: { name: string; params?: Record<string, unknown> }[] = []
  const toasts: { variant?: string; message: string }[] = []
  const eventHandlers = new Map<string, (event: never) => void>()

  const config = createTuiResolvedConfig()

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const registerLayer = keymap.registerLayer.bind(keymap)
    keymap.registerLayer = (layer) => {
      layer.commands?.forEach((command) => commands.set(command.name, command))
      return registerLayer(layer)
    }
    const base = createTuiPluginApi({
      keymap,
      client: {
        dag: {
          list: async () => {
            listCalls += 1
            return { data: opts.projectWorkflows ?? [] }
          },
          summary: async (input: { sessionID: string }) => {
            summaryCalls.push(input.sessionID)
            return opts.summary?.(input.sessionID) ?? { data: opts.serverWorkflows ?? workflowsState }
          },
          nodes: async (input: { dagID: string }) => {
            nodesCalls.push(input.dagID)
            return opts.fetchNodes?.(input.dagID, nodesCalls.length) ?? { data: nodesState }
          },
          control: async (input: { dagID: string; operation: string }) => {
            controlCalls.push(input)
            return { data: undefined }
          },
        },
        session: {
          command: async (input: unknown) => {
            commandCalls.push(input)
            return { data: undefined }
          },
        },
      } as unknown as TuiPluginApi["client"],
      state: {
        session: {
          dag: () => workflowsState,
        },
      },
      event: {
        on: ((type: string, handler: (event: never) => void) => {
          eventHandlers.set(type, handler)
          return () => eventHandlers.delete(type)
        }) as unknown as TuiPluginApi["event"]["on"],
      } as TuiPluginApi["event"],
    })
    const api = {
      ...base,
      ...(opts.fetchTimeoutMs !== undefined
        ? { tuiConfig: { ...base.tuiConfig, dag_fetch_timeout_ms: opts.fetchTimeoutMs } }
        : {}),
      route: {
        register(routes) {
          renderInspector = routes.find((route) => route.name === "dag")?.render
          return () => {}
        },
        navigate(name, params) {
          navigations.push({ name, params })
          setCurrent(params ? { name, params } : { name })
        },
        get current() {
          return current()
        },
      },
      ui: {
        ...base.ui,
        toast: (t: { variant?: string; message: string }) => toasts.push(t),
      },
    } satisfies TuiPluginApi

    void dagInspectorPlugin.tui(api, undefined, undefined as never)

    return (
      <TestTuiContexts>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                {(() => {
                  const route = current()
                  if (route.name !== "dag") return null
                  const params = "params" in route ? route.params : undefined
                  return renderInspector?.({ params })
                })()}
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: opts.width ?? 130, height: 30 })
  await waitForCommand(app, commands, "dag.open")
  if (current().name === "dag") await waitForCommand(app, commands, "dag.close")
  // Give the initial fetchNodes a chance to resolve.
  if (workflowsState.length > 0) await waitForCondition(() => nodesCalls.length > 0)

  return {
    app,
    commands,
    navigations: () => navigations,
    commandCalls: () => commandCalls,
    toasts: () => toasts,
    nodesCalls: () => nodesCalls,
    summaryCalls: () => summaryCalls,
    listCalls: () => listCalls,
    controlCalls: () => controlCalls,
    setWorkflows: (wfs: DagWorkflowSummary[]) => {
      workflowsState = wfs
    },
    setNodes: (nodes: DagNode[]) => {
      nodesState = nodes
    },
    emitSummaryUpdate: (sessionID: string = SESSION_ID) => {
      eventHandlers.get("dag.workflow.summary.updated")?.({
        type: "dag.workflow.summary.updated",
        properties: { sessionID, summaries: workflowsState },
      } as never)
    },
    current: () => current(),
    setRoute: setCurrent,
  }
}

async function waitForCommand(
  app: Awaited<ReturnType<typeof testRender>>,
  commands: Map<string, unknown>,
  name: string,
  timeout = 2000,
) {
  const start = Date.now()
  while (!commands.has(name)) {
    if (Date.now() - start > timeout) throw new Error(`command "${name}" not registered`)
    await app.renderOnce()
    await Bun.sleep(5)
  }
}

async function waitForCondition(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type RegisteredCommands = Map<
  string,
  NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
>

/** Invoke a route command the way a keypress would. The keymap passes a real
 * command context at runtime; tests only exercise the side effects, so the
 * unused context is asserted away once here instead of at every call site. */
function runCommand(commands: RegisteredCommands, name: string) {
  void commands.get(name)!.run?.({} as never)
}

describe("DagInspector", () => {
  test("renders truthful delivery states and refreshes counts without a node status change", async () => {
    const current = dagNode({
      id: "worker",
      name: "Message worker",
      status: "running",
      attempt_id: "attempt-1",
      accepted_input_revision: 3,
      snapshot_revision: 1,
      agent_messages: { queued: 2, delivered: 1, undeliverable: 0 },
    })
    const viewer = await renderDagInspector({ workflows: [wfSummary()], nodes: [current] })
    try {
      await viewer.app.waitForFrame((frame) =>
        frame.includes("attempt attempt-1 · input 3 · snapshot 1") &&
        frame.includes("messages 2 queued · 1 delivered · 0 undeliverable"),
      )
      const initialCalls = viewer.nodesCalls().length
      viewer.setNodes([{ ...current, snapshot_revision: 3, agent_messages: { queued: 0, delivered: 2, undeliverable: 1 } }])
      await waitForCondition(() => viewer.nodesCalls().length > initialCalls, 4_000)
      await viewer.app.waitForFrame((frame) => frame.includes("messages 0 queued · 2 delivered · 1 undeliverable"))
      runCommand(viewer.commands, "dag.close")
      const calls = viewer.nodesCalls().length
      await Bun.sleep(2_100)
      expect(viewer.nodesCalls()).toHaveLength(calls)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("/dag dispatches dag.open locally without submitting a model command", async () => {
    const returnRoute = { name: "session", params: { sessionID: SESSION_ID } }
    const viewer = await renderDagInspector({ initialRoute: returnRoute })
    try {
      expect(viewer.commands.get("dag.open")?.slashName).toBe("dag")
      runCommand(viewer.commands, "dag.open")
      await waitForCommand(viewer.app, viewer.commands, "dag.close")

      expect(viewer.navigations().at(-1)).toEqual({
        name: "dag",
        params: { sessionID: SESSION_ID, returnRoute },
      })
      expect(viewer.commandCalls()).toEqual([])
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("/dag-cancel cancels the only active workflow in the current session", async () => {
    const viewer = await renderDagInspector({
      initialRoute: { name: "session", params: { sessionID: SESSION_ID } },
      serverWorkflows: [
        wfSummary({ id: "wf-running", status: "running" }),
        wfSummary({ id: "wf-complete", status: "completed" }),
      ],
    })
    try {
      expect(viewer.commands.get("dag.cancel.active")?.slashName).toBe("dag-cancel")
      runCommand(viewer.commands, "dag.cancel.active")
      await waitForCondition(() => viewer.controlCalls().length > 0)
      expect(viewer.controlCalls()).toEqual([{ dagID: "wf-running", operation: "cancel" }])
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("/dag-cancel opens the inspector instead of guessing when multiple workflows are active", async () => {
    const returnRoute = { name: "session", params: { sessionID: SESSION_ID } }
    const viewer = await renderDagInspector({
      initialRoute: returnRoute,
      serverWorkflows: [
        wfSummary({ id: "wf-running", status: "running" }),
        wfSummary({ id: "wf-paused", status: "paused" }),
      ],
    })
    try {
      runCommand(viewer.commands, "dag.cancel.active")
      await waitForCondition(() => viewer.navigations().length > 0)
      expect(viewer.controlCalls()).toEqual([])
      expect(viewer.navigations().at(-1)).toEqual({
        name: "dag",
        params: { sessionID: SESSION_ID, returnRoute },
      })
      expect(viewer.toasts().at(-1)?.message).toContain("Multiple active workflows")
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("opening dag refreshes workflows from the server when sync state is empty", async () => {
    const viewer = await renderDagInspector({
      serverWorkflows: [wfSummary({ id: "wf-server", title: "Live server workflow", nodeCount: 1 })],
      nodes: [dagNode({ id: "n-1", workflow_id: "wf-server", name: "build", status: "running" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("Live server workflow"))
      expect(viewer.nodesCalls()).toContain("wf-server")
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("opening dag without visible workflows renders an explanatory empty state", async () => {
    const viewer = await renderDagInspector()
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("No workflows"))
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("switching sessions clears the previous server snapshot before the new fetch resolves", async () => {
    let resolveSecond: ((value: { data: DagWorkflowSummary[] }) => void) | undefined
    const second = new Promise<{ data: DagWorkflowSummary[] }>((resolve) => {
      resolveSecond = resolve
    })
    const viewer = await renderDagInspector({
      summary: (sessionID) =>
        sessionID === SESSION_ID
          ? Promise.resolve({ data: [wfSummary({ title: "Previous session workflow" })] })
          : second,
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("Previous session workflow"))
      viewer.setRoute({ name: "dag", params: { sessionID: "ses_2" } })
      await viewer.app.waitForFrame(
        (frame) => frame.includes("Loading workflows...") && !frame.includes("Previous session workflow"),
      )
    } finally {
      resolveSecond?.({ data: [] })
      viewer.app.renderer.destroy()
    }
  })

  test("mounting fetches nodes for the auto-selected workflow", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", nodeCount: 1 })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "pending" })],
    })
    try {
      expect(viewer.nodesCalls()).toContain("wf-1")
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("changed summary for the open session triggers a node re-fetch", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", completedNodes: 0 })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running" })],
    })
    try {
      const before = viewer.nodesCalls().length
      // Update the workflow summary to show a change in completedNodes.
      viewer.setWorkflows([wfSummary({ id: "wf-1", completedNodes: 1 })])
      viewer.emitSummaryUpdate()
      await waitForCondition(() => viewer.nodesCalls().length > before)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("equal-count replan bumps graphRev alone and refetches exactly once with the replanned node set", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", nodeCount: 2, completedNodes: 0, graphRev: 1 })],
      nodes: [dagNode({ id: "n-1", name: "build-old", status: "running" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("build-old"))
      const before = viewer.nodesCalls().length
      // Equal-count replan: identical counts/status, only the topology
      // revision moved. The server now serves the replanned node set.
      viewer.setNodes([dagNode({ id: "n-2", name: "build-new", status: "pending" })])
      viewer.setWorkflows([wfSummary({ id: "wf-1", nodeCount: 2, completedNodes: 0, graphRev: 2 })])
      viewer.emitSummaryUpdate()
      await waitForCondition(() => viewer.nodesCalls().length === before + 1)
      await Bun.sleep(50)
      expect(viewer.nodesCalls().length).toBe(before + 1)
      await viewer.app.waitForFrame((frame) => frame.includes("build-new") && !frame.includes("build-old"))
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("summary for another session does not trigger a re-fetch", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", completedNodes: 0 })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running" })],
    })
    try {
      const before = viewer.nodesCalls().length
      viewer.setWorkflows([wfSummary({ id: "wf-1", completedNodes: 1 })])
      // Emit for a different session — should be filtered out.
      viewer.emitSummaryUpdate("other_session")
      await Bun.sleep(50)
      expect(viewer.nodesCalls().length).toBe(before)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("unchanged summary does not trigger a re-fetch", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", completedNodes: 0, graphRev: 1 })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running" })],
    })
    try {
      const before = viewer.nodesCalls().length
      // Re-emit the exact same aggregates AND the same graphRev — a no-op
      // summary event (server re-broadcasts identical state). Neither emit
      // may refetch nodes.
      viewer.setWorkflows([wfSummary({ id: "wf-1", completedNodes: 0, graphRev: 1 })])
      viewer.emitSummaryUpdate()
      await Bun.sleep(50)
      expect(viewer.nodesCalls().length).toBe(before)
      viewer.emitSummaryUpdate()
      await Bun.sleep(50)
      expect(viewer.nodesCalls().length).toBe(before)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("closing the inspector prevents further fetches", async () => {
    const viewer = await renderDagInspector({
      initialRoute: {
        name: "dag",
        params: { sessionID: SESSION_ID, returnRoute: { name: "session", params: { sessionID: SESSION_ID } } },
      },
      workflows: [wfSummary({ id: "wf-1" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "pending" })],
    })
    try {
      // Close the inspector — navigates away, unmounts the component.
      runCommand(viewer.commands, "dag.close")
      await Bun.sleep(20)

      const before = viewer.nodesCalls().length
      // After close, summary changes should NOT trigger fetches.
      viewer.setWorkflows([wfSummary({ id: "wf-1", completedNodes: 5 })])
      viewer.emitSummaryUpdate()
      await Bun.sleep(50)
      expect(viewer.nodesCalls().length).toBe(before)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("dag.enter navigates into the selected node's child session", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running", child_session_id: "child_ses_1" })],
    })
    try {
      runCommand(viewer.commands, "dag.enter")
      expect(viewer.navigations()).toContainEqual(
        expect.objectContaining({ name: "session", params: expect.objectContaining({ sessionID: "child_ses_1" }) }),
      )
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("pressing Enter navigates into the selected node's child session", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running", child_session_id: "child_ses_1" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("build"))
      viewer.app.mockInput.pressEnter()
      await waitForCondition(() => viewer.navigations().some((item) => item.name === "session"))
      expect(viewer.navigations()).toContainEqual(
        expect.objectContaining({ name: "session", params: expect.objectContaining({ sessionID: "child_ses_1" }) }),
      )
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("dag.pause pauses a running workflow", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", status: "running" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("build"))
      runCommand(viewer.commands, "dag.pause")
      await waitForCondition(() => viewer.controlCalls().length > 0)
      expect(viewer.controlCalls()).toContainEqual({ dagID: "wf-1", operation: "pause" })
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("dag.pause pauses a stepping workflow", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", status: "stepping" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("build"))
      runCommand(viewer.commands, "dag.pause")
      await waitForCondition(() => viewer.controlCalls().length > 0)
      expect(viewer.controlCalls()).toContainEqual({ dagID: "wf-1", operation: "pause" })
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("dag.pause on a terminal workflow explains why pause is unavailable", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", status: "completed", completedNodes: 2 })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "completed" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("build"))
      runCommand(viewer.commands, "dag.pause")
      await waitForCondition(() => viewer.toasts().length > 0)
      expect(viewer.controlCalls()).toEqual([])
      expect(viewer.toasts().at(-1)?.message).toMatch(/completed.*cannot be paused/i)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("control operations stay reachable through the command palette", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", status: "running" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("build"))
      // Unbound by default, so the palette namespace is the only way in.
      for (const name of ["dag.pause", "dag.resume", "dag.step", "dag.cancel"]) {
        expect(viewer.commands.get(name)?.namespace).toBe("palette")
      }
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("the inspector leaves a blank outer row below its footer", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => {
        const rows = frame.split("\n")
        const footer = rows.findIndex((row) => row.includes("open session"))
        return footer >= 0 && rows.slice(footer + 1).some((row) => row.trim() === "")
      })
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("dag.enter toasts when the node has no child session yet", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "pending" })],
    })
    try {
      runCommand(viewer.commands, "dag.enter")
      expect(viewer.toasts().some((t) => /no session/i.test(t.message))).toBe(true)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("dag.close navigates back to the return route", async () => {
    const returnRoute = { name: "session", params: { sessionID: SESSION_ID } }
    const viewer = await renderDagInspector({
      initialRoute: { name: "dag", params: { sessionID: SESSION_ID, returnRoute } },
      workflows: [wfSummary({ id: "wf-1" })],
    })
    try {
      runCommand(viewer.commands, "dag.close")
      expect(viewer.navigations().at(-1)).toEqual(
        expect.objectContaining({ name: "session", params: { sessionID: SESSION_ID } }),
      )
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("changing workflow replaces subscriptions so only the new selection refreshes", async () => {
    const viewer = await renderDagInspector({
      workflows: [
        wfSummary({ id: "wf-1", completedNodes: 0, nodeCount: 2 }),
        wfSummary({ id: "wf-2", completedNodes: 0, nodeCount: 2 }),
      ],
      nodes: [dagNode({ id: "n-1", workflow_id: "wf-1", name: "build", status: "running" })],
    })
    try {
      // Auto-selection picks wf-1; its initial fetch has resolved.
      await waitForCondition(() => viewer.nodesCalls().some((id) => id === "wf-1"))

      // Switch selection wf-1 -> wf-2.
      runCommand(viewer.commands, "dag.next_workflow")
      // The new selection fetches wf-2's nodes.
      await waitForCondition(() => viewer.nodesCalls().some((id) => id === "wf-2"))

      const before = viewer.nodesCalls().length
      // Now change ONLY wf-1's summary (the previously selected workflow).
      // Because the subscription now tracks wf-2's signature, wf-1's change
      // alone must NOT trigger a fetch.
      viewer.setWorkflows([
        wfSummary({ id: "wf-1", completedNodes: 1, nodeCount: 2 }),
        wfSummary({ id: "wf-2", completedNodes: 0, nodeCount: 2 }),
      ])
      viewer.emitSummaryUpdate()
      await Bun.sleep(50)
      expect(viewer.nodesCalls().length).toBe(before)

      // Changing wf-2's summary DOES refresh (the active selection).
      viewer.setWorkflows([
        wfSummary({ id: "wf-1", completedNodes: 1, nodeCount: 2 }),
        wfSummary({ id: "wf-2", completedNodes: 2, nodeCount: 2 }),
      ])
      viewer.emitSummaryUpdate()
      await waitForCondition(() => viewer.nodesCalls().length > before)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("a failed node renders its error_reason in the inspector", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", failedNodes: 1, nodeCount: 1 })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "failed", error_reason: "compile error in main.ts" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("compile error in main.ts"))
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("node rows render the worker type inline next to the name", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", nodeCount: 1 })],
      nodes: [dagNode({ id: "n-1", name: "compile", worker_type: "review", status: "pending" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("compile review"))
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("footer advertises only the cursor affordances, never the control operations", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", status: "paused" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "pending" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => {
        const footer = frame.split("\n").find((row) => row.includes("open session"))
        if (!footer) return false
        // A paused workflow would previously have advertised resume/cancel here.
        return (
          footer.includes("close") &&
          !footer.includes("resume") &&
          !footer.includes("cancel") &&
          !footer.includes("pause") &&
          !footer.includes("step")
        )
      })
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("footer row stays fixed while node selection changes detail content", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", nodeCount: 2, failedNodes: 1 })],
      nodes: [
        dagNode({ id: "a", name: "bare", status: "pending" }),
        dagNode({ id: "b", name: "detailed", status: "failed", depends_on: ["a"], error_reason: "boom" }),
      ],
    })
    try {
      const footerRow = (frame: string) => frame.split("\n").findIndex((row) => row.includes("open session"))
      let before = -1
      // Selection starts on "bare" (header-only detail).
      await viewer.app.waitForFrame((frame) => {
        before = footerRow(frame)
        return before >= 0 && frame.includes("bare")
      })
      // Moving to "detailed" adds dependency and error rows to the detail
      // pane; the fixed-height pane must keep the footer on the same row.
      runCommand(viewer.commands, "dag.down")
      await viewer.app.waitForFrame((frame) => frame.includes("boom") && footerRow(frame) === before)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("the workflow navigation pane survives every terminal width", async () => {
    // Primary navigation must never disappear; it only narrows. A previous
    // revision borrowed the chat sidebar's > 120 gate and lost the list here.
    for (const width of [130, 100, 70]) {
      const viewer = await renderDagInspector({
        width,
        workflows: [
          wfSummary({ id: "wf-1", title: "alpha" }),
          wfSummary({ id: "wf-2", title: "beta", status: "paused" }),
        ],
        nodes: [dagNode({ id: "n-1", name: "collect", status: "running" })],
      })
      try {
        await viewer.app.waitForFrame((frame) => frame.includes("alpha") && frame.includes("beta"))
      } finally {
        viewer.app.renderer.destroy()
      }
    }
  })

  test("shows one completed and seven skipped nodes in narrow workflow navigation", async () => {
    const viewer = await renderDagInspector({
      width: 70,
      workflows: [wfSummary({ id: "wf-1", title: "Gated workflow", status: "completed", nodeCount: 8,
        completedNodes: 1, skippedNodes: 7 })],
      nodes: [dagNode({ id: "gate", name: "gate", status: "completed" })],
    })
    try {
      await viewer.app.waitForFrame((frame) =>
        frame.includes("Gated workflow") && frame.includes("8/8") && frame.includes("✓1") && frame.includes("⊘7"))
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("lists project workflows when the route has no session context", async () => {
    const viewer = await renderDagInspector({
      initialRoute: { name: "dag" },
      projectWorkflows: [
        projectWorkflow({ id: "wf-p1", session_id: "ses_a", title: "Orphan discovery", status: "running" }),
        projectWorkflow({ id: "wf-p2", session_id: "ses_b", title: "Other session", status: "completed" }),
      ],
      summary: (sessionID) =>
        Promise.resolve({
          data:
            sessionID === "ses_a"
              ? [wfSummary({ id: "wf-p1", title: "Orphan discovery", status: "running" })]
              : [],
        }),
    })
    try {
      // Discovery renders workflows from any session when the route carries
      // no sessionID — the zero-request empty state is gone.
      await viewer.app.waitForFrame((frame) => frame.includes("Orphan discovery"))
      // Workflows group by owning session for the session-scoped summary; a
      // dead session resolves empty without failing the whole discovery.
      expect(viewer.summaryCalls()).toEqual(["ses_a", "ses_b"])
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("falls back to project discovery when the routed session has no workflows", async () => {
    const viewer = await renderDagInspector({
      projectWorkflows: [projectWorkflow({ id: "wf-p1", session_id: "ses_other" })],
      summary: (sessionID) =>
        Promise.resolve({
          data:
            sessionID === SESSION_ID
              ? []
              : [wfSummary({ id: "wf-p1", title: "Discovered elsewhere", status: "running" })],
        }),
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("Discovered elsewhere"))
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("without session context the empty state stays honest about what was consulted", async () => {
    const viewer = await renderDagInspector({ initialRoute: { name: "dag" } })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("No DAG workflows"))
      // The project list is the discovery source that does not depend on the
      // route's sessionID chain — it is consulted even without a session,
      // while session summaries never run (an empty list has no sessions).
      expect(viewer.listCalls()).toBe(1)
      expect(viewer.summaryCalls()).toEqual([])
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("a stalled node fetch does not wedge the refresh poll", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ nodeCount: 1 })],
      nodes: [dagNode({ id: "n-1", name: "recovered node" })],
      // The mount fetch and the first poll never settle; later polls succeed.
      fetchNodes: (_dagID, call) => (call <= 2 ? new Promise(() => {}) : undefined),
      fetchTimeoutMs: 60,
    })
    try {
      await waitForCondition(() => viewer.nodesCalls().length >= 3, 8_000)
      await viewer.app.waitForFrame((frame) => frame.includes("recovered node"))
    } finally {
      viewer.app.renderer.destroy()
    }
  }, 10_000)

  test("a failed refresh keeps the last rendered nodes", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ nodeCount: 1 })],
      nodes: [dagNode({ id: "n-1", name: "kept node" })],
      fetchNodes: (_dagID, call) => (call === 1 ? undefined : Promise.reject(new Error("server busy"))),
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("kept node"))
      await waitForCondition(() => viewer.nodesCalls().length >= 2, 4_000)
      await Bun.sleep(50)
      const frame = viewer.app.captureCharFrame()
      expect(frame).toContain("kept node")
      expect(frame).toContain("1 node")
    } finally {
      viewer.app.renderer.destroy()
    }
  }, 10_000)

  test("does not claim zero nodes before the first node fetch settles", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ nodeCount: 2 })],
      fetchNodes: () => new Promise(() => {}),
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("Test workflow") && frame.includes("running"))
      const frame = viewer.app.captureCharFrame()
      expect(frame).not.toContain("0 nodes")
      expect(frame).toContain("loading nodes")
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("retries when the initial summary fetch stalls", async () => {
    const viewer = await renderDagInspector({
      initialRoute: { name: "dag", params: { sessionID: SESSION_ID } },
      summary: () => new Promise(() => {}),
      fetchTimeoutMs: 60,
    })
    try {
      // A stalled fetch must not leave the inspector stuck on its first
      // attempt forever; the component re-attempts after its timeout.
      await waitForCondition(() => viewer.summaryCalls().length >= 2, 3000)
    } finally {
      viewer.app.renderer.destroy()
    }
  })
})
