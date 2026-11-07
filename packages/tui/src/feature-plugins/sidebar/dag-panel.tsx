// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/tui/plugin-api"
import type { DagNode, DagWorkflowSummary } from "@opencode-ai/sdk/v2"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { Spinner } from "../../component/spinner"
import {
  computeWaves,
  dagEscalationLabel,
  dagNodeGlyph,
  dagStatusColor,
  formatDagProgress,
} from "../system/dag-inspector-utils"

const id = "internal:sidebar-dag-panel"

const ACTIVE_STATUSES = new Set(["running", "paused", "stepping"])
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"])

function WorkflowRow(props: {
  api: TuiPluginApi
  summary: DagWorkflowSummary
  expanded: boolean
  onToggle: () => void
}) {
  const theme = () => props.api.theme.current
  const [nodes, setNodes] = createSignal<DagNode[]>([])
  // The API returns nodes in reverse insertion order (desc seq); flatten the
  // topological waves so the list reads top-down in execution order, matching
  // the DAG inspector.
  const orderedNodes = createMemo(() => computeWaves(nodes()).flat())

  const total = () => Number(props.summary.nodeCount)
  const completed = () => Number(props.summary.completedNodes)
  const running = () => Number(props.summary.runningNodes)
  const failed = () => Number(props.summary.failedNodes)
  const queued = () => Number(props.summary.queuedNodes)

  // graphRev (topology revision) participates so an equal-count replan still
  // changes the signature and triggers exactly one authoritative re-fetch.
  const signature = () =>
    `${total()}:${completed()}:${running()}:${failed()}:${queued()}:${props.summary.skippedNodes}:${props.summary.abortedNodes ?? 0}:${props.summary.graphRev}`

  const fetchNodes = async (dagID: string, sig: string) => {
    try {
      const res = await props.api.client.dag.nodes({ dagID })
      // Stale guard: discard if the summary signature changed (or the row was
      // collapsed) between fetch-start and fetch-resolve.
      if (!props.expanded || signature() !== sig) return
      setNodes((res.data ?? []) as DagNode[])
    } catch {
      if (!props.expanded || signature() !== sig) return
      setNodes([])
    }
  }

  // Signature-triggered fetch: the signature memo only changes value when a
  // node count or the topology revision (graphRev) actually changes, so this
  // effect re-runs (and re-fetches) only on real state changes — never on a
  // no-op summary event. No polling.
  createEffect(() => {
    const sig = signature()
    if (!props.expanded) {
      setNodes([])
      return
    }
    void fetchNodes(props.summary.id, sig)
  })

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={props.onToggle}>
        <text flexShrink={0} style={{ fg: dagStatusColor(theme(), props.summary.status) }}>
          •
        </text>
        <text fg={theme().text} wrapMode="word">
          {props.summary.title}{" "}
          <span style={{ fg: theme().textMuted }}>
            ({formatDagProgress(props.summary)}
            {running() > 0 ? `, ${running()} running` : ""}
            {queued() > 0 ? `, ${queued()} queued` : ""}
            {failed() > 0 ? `, ${failed()} failed` : ""}
            {dagEscalationLabel(props.summary) ? `, ${dagEscalationLabel(props.summary)}` : ""})
          </span>
        </text>
      </box>
      <Show when={props.expanded}>
        <box flexDirection="column" paddingLeft={2}>
          <For each={orderedNodes()}>
            {(node) => (
              <box flexDirection="row" gap={1}>
                <Show when={node.status !== "running"} fallback={<Spinner color={theme().textMuted} />}>
                  <text flexShrink={0} style={{ fg: dagStatusColor(theme(), node.status) }}>
                    {dagNodeGlyph(node.status)}
                  </text>
                </Show>
                <text fg={theme().textMuted} wrapMode="word">
                  {node.name}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

function DagPanel(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const dags = createMemo(() => props.api.state.session.dag(props.session_id))
  const active = createMemo(() => dags().filter((d) => ACTIVE_STATUSES.has(d.status)))
  const terminal = createMemo(() => dags().filter((d) => TERMINAL_STATUSES.has(d.status)))

  const [expandedIDs, setExpandedIDs] = createSignal<Set<string>>(new Set())
  const [showTerminal, setShowTerminal] = createSignal(false)

  // Default-expand the first active workflow so the user immediately sees
  // node-level progress for the workflow that is currently doing work.
  createEffect(() => {
    const list = active()
    if (list.length === 0) return
    setExpandedIDs((prev) => {
      if (prev.size > 0) return prev
      return new Set([list[0]!.id])
    })
  })

  const isExpanded = (wfID: string) => expandedIDs().has(wfID)
  const toggle = (wfID: string) =>
    setExpandedIDs((prev) => {
      const next = new Set(prev)
      if (next.has(wfID)) next.delete(wfID)
      else next.add(wfID)
      return next
    })

  return (
    <Show when={dags().length > 0}>
      <box>
        {/* Always collapsible (unlike MCP's >2 threshold): an expanded workflow
            renders a node list, so even a single DAG is tall enough to hide.
            The chevron also keeps the header aligned with MCP's "▼ MCP". */}
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          <text fg={theme().text}>
            <b>DAG</b>
            <Show when={!open()}>
              <span style={{ fg: theme().textMuted }}>
                {" "}
                ({active().length} active{terminal().length > 0 ? `, ${terminal().length} done` : ""})
              </span>
            </Show>
          </text>
        </box>
        <Show when={open()}>
          <For each={active()}>
            {(summary) => (
              <WorkflowRow
                api={props.api}
                summary={summary}
                expanded={isExpanded(summary.id)}
                onToggle={() => toggle(summary.id)}
              />
            )}
          </For>
          <Show when={terminal().length > 0}>
            <box flexDirection="column">
              <box flexDirection="row" gap={1} onMouseDown={() => setShowTerminal((x) => !x)}>
                <text fg={theme().textMuted}>
                  {showTerminal() ? "▼" : "▶"} done ({terminal().length})
                </text>
              </box>
              <Show when={showTerminal()}>
                <For each={terminal()}>
                  {(summary) => (
                    <WorkflowRow
                      api={props.api}
                      summary={summary}
                      expanded={isExpanded(summary.id)}
                      onToggle={() => toggle(summary.id)}
                    />
                  )}
                </For>
              </Show>
            </box>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 460,
    slots: {
      sidebar_content(_ctx, props) {
        return <DagPanel api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
