// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type Accessor } from "solid-js"
import { resolveRootSessionID, sessionTree } from "../ask/ask-queue"
import { useKV } from "../context/kv"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { locationHeaders, useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useTicker } from "../context/ticker-context"
import { layoutDagBar } from "../dag/bar"
import {
  DAG_STATE_STYLE,
  dagCurrentWave,
  dagDisplayState,
  dagElapsedMs,
  dagFinite,
  dagStateStyle,
  dagStatusColor,
  dagWorkflowView,
  formatDagDuration,
  formatDagError,
  formatDagOutputPreview,
  selectMainWorkflow,
  type DagNodeRow,
  type DagWorkflowSummary,
  type DagWorkflowView,
} from "../dag/model"
import {
  dagRequestKinds,
  dagRequestLabel,
  dagRequestText,
  type DagRequestContext,
  type DagRequestKind,
} from "../dag/prefill"
import { dagUnplacedReasons } from "../dag/waves"
import { t, type MessageKey } from "../i18n"
import { useBindings } from "../keymap"
import { usePrefillRootPrompt } from "../session/prefill"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { TuiLog } from "../util/log"
import { remoteLine } from "../util/remote-text"
import { DetailPanel, type DetailRow } from "./detail"
import { usePanelHost, type PanelSpec } from "./host"
import { ListPanel, type ListItem } from "./list"
import { PANEL_NARROW_WIDTH, type PanelHint, type PanelTab } from "./shell"

/** The name this panel declares what it shows under; the data layer holds one declaration per surface. */
const SOURCE = "dag-panel"

/** What a node's details say about its output, once the user opened them. */
type NodeOutput =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly text: string | undefined }
  | { readonly status: "failed" }

/**
 * What the panel remembers while it is open. The host mounts only the top panel,
 * so the panel is built again each time the template list above it closes; this
 * lives outside the component so the workflow, the selected node and the opened
 * details are as the user left them.
 */
export interface DagPanelState {
  /** The workflow shown; unset until the panel first finds one. */
  readonly workflow: Accessor<string | undefined>
  setWorkflow(id: string | undefined): void
  /** The node the user moved to; the default applies until then, or while this one is gone. */
  readonly node: Accessor<string | undefined>
  setNode(id: string | undefined): void
  /** Nodes whose details are open, as `nodeKey`s. */
  readonly expanded: Accessor<ReadonlySet<string>>
  toggleExpanded(key: string): void
  /** Outputs read on demand, by `nodeKey`: a node's output is not in its table row. */
  readonly outputs: Accessor<Readonly<Record<string, NodeOutput>>>
  setOutput(key: string, output: NodeOutput): void
  /**
   * What the user had picked and opened before this panel, taken once at its first mount. The panel's
   * own default is worked out from it, so opening a workflow here never moves the default it started on.
   */
  memory: { chosen: string | undefined; seen: ReadonlySet<string> } | undefined
}

export function createDagPanelState(): DagPanelState {
  const [workflow, setWorkflow] = createSignal<string>()
  const [node, setNode] = createSignal<string>()
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [outputs, setOutputs] = createSignal<Readonly<Record<string, NodeOutput>>>({})
  return {
    workflow,
    setWorkflow: (id) => setWorkflow(id),
    node,
    setNode: (id) => setNode(id),
    expanded,
    toggleExpanded: (key) =>
      setExpanded((current) => {
        const next = new Set(current)
        if (!next.delete(key)) next.add(key)
        return next
      }),
    outputs,
    setOutput: (key, output) => setOutputs((current) => ({ ...current, [key]: output })),
    memory: undefined,
  }
}

/** The `/dag` entry for the panel host: the state is made here, when the panel opens, not when it is mounted. */
export function dagPanelSpec(): PanelSpec {
  const state = createDagPanelState()
  return { id: "dag", render: () => <DagPanel state={state} /> }
}

/** A workflow of the session tree and the session that owns it. */
interface Shown {
  readonly summary: DagWorkflowSummary
  readonly sessionID: string
}

const STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  pending: "dagmode.panel.status.pending",
  running: "dagmode.panel.status.running",
  paused: "dagmode.panel.status.paused",
  stepping: "dagmode.panel.status.stepping",
  completed: "dagmode.panel.status.completed",
  failed: "dagmode.panel.status.failed",
  cancelled: "dagmode.panel.status.cancelled",
}

/** Workflow statuses the main agent has not finished with: the time keeps running. */
const ACTIVE = new Set(["running", "stepping", "paused"])

/** Width of the longest tab label before it is cut. */
const TAB_LABEL_CELLS = 16

const nodeKey = (workflowID: string, nodeID: string) => `${workflowID}\u0000${nodeID}`

function statusLabel(status: string) {
  const key: MessageKey | undefined = STATUS_KEYS[status]
  return key ? t(key) : remoteLine(status)
}

function sameStrings(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** A node count off the summary, which may carry the SDK's non-finite sentinels. */
const counted = (value: number | string | undefined) => dagFinite(value) ?? 0

/**
 * Listens to the one-second clock while it is mounted. A workflow that is over shows nothing that
 * moves, so the panel mounts this only while there is something to count.
 */
function SecondTick() {
  const ticker = useTicker()
  onCleanup(ticker.subscribeSecond())
  return null
}

/**
 * `/dag`: the session tree's workflows, read-only. Nodes are grouped by wave under a bar and the counts;
 * what the user can do here is look, open a node's details or its session, and ask the main agent to
 * act, which only fills the main session's input.
 */
export function DagPanel(props: { state?: DagPanelState }) {
  const state = props.state ?? createDagPanelState()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const project = useProject()
  const kv = useKV()
  const { theme } = useTheme()
  const ticker = useTicker()
  const host = usePanelHost()
  const dimensions = useTerminalDimensions()

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const innerWidth = () => Math.max(1, dimensions().width - 4)
  /** The clock's now. Reading it in a computation makes that computation follow the one-second signal. */
  const now = () => {
    ticker.second()
    return ticker.now()
  }

  const rootID = createMemo(() => {
    const id = route.data.type === "session" ? route.data.sessionID : undefined
    return id === undefined ? undefined : resolveRootSessionID(sync.data.session, id)
  })
  const treeIDs = createMemo(
    () => {
      const root = rootID()
      return root === undefined ? [] : sessionTree(sync.data.session, root)
    },
    [],
    { equals: sameStrings },
  )
  /** Every workflow of the root session's tree, the root's first; each session's own are newest first. */
  const workflows = createMemo<Shown[]>(() =>
    treeIDs().flatMap((sessionID) => (sync.data.dag[sessionID] ?? []).map((summary) => ({ summary, sessionID }))),
  )

  /** The workflow the status band would show: what the user picked, a running one, a failed one not yet seen. */
  const fallback = (): Shown | undefined => {
    const list = workflows()
    const memory = state.memory
    const main = selectMainWorkflow(
      list.map((each) => each.summary),
      { chosen: memory?.chosen, acknowledged: memory?.seen },
    ).main
    return list.find((each) => each.summary === main) ?? list[0]
  }

  // The first mount works out where the panel starts and keeps it there. Without the pin, opening a failed
  // workflow here would count it as seen and take it out of the default it was chosen by.
  untrack(() => {
    if (state.memory) return
    const root = rootID()
    state.memory = {
      chosen: root === undefined ? undefined : sync.dag.focus.chosen(root),
      seen: root === undefined ? new Set() : sync.dag.focus.acknowledged(root),
    }
    if (state.workflow() === undefined) state.setWorkflow(fallback()?.summary.id)
  })

  const active = createMemo<Shown | undefined>(() => {
    const picked = state.workflow()
    const list = workflows()
    return (picked === undefined ? undefined : list.find((each) => each.summary.id === picked)) ?? fallback()
  })

  /** The workflow's summary with its nodes (none until the table is loaded) grouped into waves. */
  const view = createMemo<DagWorkflowView | undefined>(() => {
    const shown = active()
    return shown ? dagWorkflowView<DagNodeRow>(shown.summary, sync.dag.nodes(shown.summary.id)) : undefined
  })
  const loaded = () => {
    const shown = active()
    return shown !== undefined && sync.dag.nodes(shown.summary.id) !== undefined
  }
  const nodeList = createMemo<readonly DagNodeRow[]>(() => {
    const current = view()
    return current ? [...current.waves.flat(), ...current.unplaced] : []
  })
  const reasons = createMemo(() => dagUnplacedReasons(view()?.unplaced ?? []))
  const ticking = createMemo(() => {
    const current = view()
    if (!current) return false
    return (
      ACTIVE.has(current.summary.status) ||
      current.nodes.some((node) => dagDisplayState(node.status, node.error_class) === "running")
    )
  })

  // The declaration to the data layer: what is shown here, and from this panel only. The layer registers
  // the owning session's interest and reads the table after the worker confirmed it, and drops both when
  // the declaration changes or ends. The workflow shown also counts as opened by the user.
  const shownKey = createMemo(
    () => {
      const shown = active()
      return shown ? { workflowID: shown.summary.id, sessionID: shown.sessionID } : undefined
    },
    undefined,
    { equals: (a, b) => a?.workflowID === b?.workflowID && a?.sessionID === b?.sessionID },
  )
  const declare = (shown: { workflowID: string; sessionID: string } | undefined) =>
    void sync.dag.watch(SOURCE, shown ? [shown] : []).catch((error) => {
      TuiLog.write("error", "Declaring the shown DAG workflow failed", { error: String(error) })
    })
  createEffect(() => {
    const shown = shownKey()
    const root = rootID()
    untrack(() => {
      declare(shown)
      if (shown && root !== undefined) sync.dag.focus.acknowledge(root, shown.workflowID)
    })
  })
  onCleanup(() => declare(undefined))

  // ── selection ─────────────────────────────────────────────────────────────────────────────────────────
  const selectedID = createMemo(() => {
    const list = nodeList()
    const picked = state.node()
    if (picked !== undefined && list.some((node) => node.id === picked)) return picked
    // Start on what needs a look: a failed node, else a running one, else the first.
    const startOn =
      list.find((node) => dagDisplayState(node.status, node.error_class) === "failed") ??
      list.find((node) => dagDisplayState(node.status, node.error_class) === "running") ??
      list[0]
    return startOn?.id
  })
  const selectedNode = createMemo(() => nodeList().find((node) => node.id === selectedID()))

  function switchWorkflow(id: string) {
    const root = rootID()
    state.setWorkflow(id)
    state.setNode(undefined)
    if (root !== undefined) sync.dag.focus.choose(root, id)
  }

  // ── what a row says ───────────────────────────────────────────────────────────────────────────────────
  function spanOf(node: DagNodeRow) {
    if (node.started_at === undefined) return ""
    if (node.completed_at !== undefined) return formatDagDuration(node.started_at, node.completed_at) ?? ""
    // Only a running node is still counting; one that stopped without a completion time has no span.
    return dagDisplayState(node.status, node.error_class) === "running"
      ? (formatDagDuration(node.started_at, now()) ?? "")
      : ""
  }

  /** One line about the node, shown while its row is selected. */
  function noteOf(node: DagNodeRow, wave: number | undefined) {
    const display = dagDisplayState(node.status, node.error_class)
    const parts: string[] = []
    const reason = reasons().get(node.id)
    if (reason?.kind === "cycle") parts.push(t("dagmode.panel.unplaced.cycle"))
    if (reason?.kind === "downstream") {
      const via = nodeList().find((each) => each.id === reason.via)
      parts.push(t("dagmode.panel.unplaced.downstream", { name: remoteLine(via?.name ?? reason.via) }))
    }
    if (display === "failed" && node.error_reason) parts.push(remoteLine(formatDagError(node.error_reason)))
    if (display === "cancelled") parts.push(t("dagmode.panel.note.cancelled"))
    if (display === "aborted") parts.push(t("dagmode.panel.note.aborted"))
    if (display === "skipped") parts.push(t("dagmode.panel.note.skipped"))
    if (display === "running" && node.deadline_ms !== undefined) {
      const at = now()
      parts.push(
        node.deadline_ms <= at
          ? t("dagmode.panel.note.overdue")
          : t("dagmode.panel.note.deadline", { time: formatDagDuration(at, node.deadline_ms) ?? "" }),
      )
    }
    if ((display === "queued" || display === "pending") && wave !== undefined) {
      parts.push(t("dagmode.panel.note.waiting", { n: wave + 1 }))
    }
    if (node.replan_attempts > 0) parts.push(t("dagmode.panel.note.restarted", { n: node.replan_attempts }))
    return parts.length > 0 ? parts.join(" · ") : undefined
  }

  /** What the details of an opened node add to its row. */
  function detailOf(node: DagNodeRow, workflowID: string) {
    const key = nodeKey(workflowID, node.id)
    if (!state.expanded().has(key)) return undefined
    const output = state.outputs()[key]
    const lines: string[] = []
    if (output === undefined || output.status === "loading") lines.push(t("dagmode.panel.detail.output.loading"))
    else if (output.status === "failed") lines.push(t("dagmode.panel.detail.output.failed"))
    else if (output.text === undefined) lines.push(t("dagmode.panel.detail.output.none"))
    else lines.push(t("dagmode.panel.detail.output", { text: output.text }))
    if (node.agent_messages) lines.push(t("dagmode.panel.detail.messages", { ...node.agent_messages }))
    if (node.attempt_id) {
      lines.push(
        t("dagmode.panel.detail.attempt", {
          attempt: remoteLine(node.attempt_id),
          input: node.accepted_input_revision ?? 0,
          snapshot: node.snapshot_revision ?? 0,
        }),
      )
    }
    if (node.directory) lines.push(t("dagmode.panel.detail.directory", { path: remoteLine(node.directory) }))
    if (node.head) lines.push(t("dagmode.panel.detail.head", { head: remoteLine(node.head) }))
    return lines.join("\n")
  }

  /** A node's output is not in its table row: read it once, the first time its details open. */
  async function loadOutput(workflowID: string, nodeID: string) {
    const key = nodeKey(workflowID, nodeID)
    if (state.outputs()[key] !== undefined) return
    state.setOutput(key, { status: "loading" })
    try {
      const response = await sdk.client.dag.nodes(
        { dagID: workflowID },
        { headers: locationHeaders({ workspace: project.workspace.current() }) },
      )
      const found = response.data?.find((node) => node.id === nodeID)
      state.setOutput(
        key,
        found
          ? { status: "ready", text: remoteLine(formatDagOutputPreview(found.output, 400) ?? "") || undefined }
          : { status: "failed" },
      )
    } catch (error) {
      TuiLog.write("error", "Loading a DAG node's output failed", { workflowID, nodeID, error: String(error) })
      state.setOutput(key, { status: "failed" })
    }
  }

  function toggleDetail() {
    const shown = active()
    const node = selectedNode()
    if (!shown || !node) return
    const key = nodeKey(shown.summary.id, node.id)
    const opening = !state.expanded().has(key)
    state.toggleExpanded(key)
    if (opening) void loadOutput(shown.summary.id, node.id)
  }

  function activate() {
    const node = selectedNode()
    if (!node) return
    if (node.child_session_id !== undefined) {
      host.closeAll()
      route.navigate({ type: "session", sessionID: node.child_session_id })
      return
    }
    toggleDetail()
  }

  function openRequests() {
    const shown = active()
    if (!shown) return
    const ctx: DagRequestContext = {
      workflow: shown.summary,
      node: selectedNode(),
      workflows: workflows().map((each) => each.summary),
    }
    host.push({ id: "dag-request", render: () => <DagRequestPanel ctx={ctx} /> })
  }

  // ── rows ──────────────────────────────────────────────────────────────────────────────────────────────
  /** The widest state symbol, so a row whose symbol is narrower still lines its columns up under `ambiguous_width` 2. */
  const symbolCells = () =>
    Math.max(...Object.values(DAG_STATE_STYLE).map((style) => cellWidth(style.glyph, ambiguousWidth())))

  const rows = createMemo<DetailRow<DagNodeRow>[]>(() => {
    const current = view()
    if (!current) return []
    const workflowID = current.summary.id
    const symbols = symbolCells()
    const aw = ambiguousWidth()
    // `note` and `body` are read when a row is selected or opened, and follow the clock and the output as they
    // change, so the rows are not rebuilt every second.
    const rowFor = (node: DagNodeRow, label: string, wave: number | undefined): DetailRow<DagNodeRow> => {
      const style = dagStateStyle(node.status, node.error_class)
      return {
        id: node.id,
        cells: [
          label,
          <text flexShrink={0} fg={theme[style.token]} wrapMode="none">
            {style.glyph + " ".repeat(symbols + 1 - cellWidth(style.glyph, aw))}
          </text>,
          remoteLine(node.name),
          <text flexShrink={0} wrapMode="none">
            {spanOf(node)}
          </text>,
        ],
        value: node,
        get note() {
          return noteOf(node, wave)
        },
        get body() {
          return detailOf(node, workflowID)
        },
      }
    }
    const result: DetailRow<DagNodeRow>[] = []
    for (const [index, wave] of current.waves.entries()) {
      for (const [at, node] of wave.entries()) {
        result.push(rowFor(node, at === 0 ? t("dagmode.panel.wave", { n: index + 1 }) : "│", index))
      }
    }
    if (current.unplaced.length > 0) {
      result.push({
        id: "section:unplaced",
        // Not a string cell: it would widen the wave column for every row.
        cells: [
          <text fg={theme.warning} wrapMode="none">
            {t("dagmode.panel.unplaced", { n: current.unplaced.length })}
          </text>,
        ],
        selectable: false,
      })
      for (const node of current.unplaced) result.push(rowFor(node, "!", undefined))
    }
    return result
  })

  // ── the part above the rows ───────────────────────────────────────────────────────────────────────────
  const barLayout = createMemo(() => {
    const current = view()
    if (!current || !loaded()) return undefined
    const layout = layoutDagBar({
      waves: current.waves,
      unplaced: current.unplaced,
      width: innerWidth(),
      ambiguousWidth: ambiguousWidth(),
      per: 5,
    })
    return layout.segments.length > 0 ? layout : undefined
  })

  const countsText = createMemo(() => {
    const current = view()
    if (!current) return ""
    const summary = current.summary
    const parts = [
      t("dagmode.panel.count.done", { done: counted(summary.completedNodes), total: counted(summary.nodeCount) }),
    ]
    if (loaded() && current.waves.length > 0) {
      parts.push(
        t("dagmode.panel.count.wave", {
          current: (dagCurrentWave(current.waves) ?? 0) + 1,
          total: current.waves.length,
        }),
      )
    }
    const extra: [number, MessageKey][] = [
      [counted(summary.runningNodes), "dagmode.panel.count.running"],
      [counted(summary.failedNodes), "dagmode.panel.count.failed"],
      [counted(summary.queuedNodes), "dagmode.panel.count.queued"],
      [counted(summary.skippedNodes), "dagmode.panel.count.skipped"],
      [counted(summary.abortedNodes), "dagmode.panel.count.aborted"],
    ]
    for (const [n, key] of extra) if (n > 0) parts.push(t(key, { n }))
    if (loaded()) {
      const elapsed = dagElapsedMs(current.nodes, now(), ACTIVE.has(summary.status))
      if (elapsed !== undefined)
        parts.push(t("dagmode.panel.count.elapsed", { time: formatDagDuration(0, elapsed) ?? "" }))
    }
    return truncateCells(parts.join(" · "), innerWidth(), ambiguousWidth())
  })

  const titleElement = (
    <box flexDirection="row" gap={1} overflow="hidden">
      <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
        {t("dagmode.panel.title")}
      </text>
      <Show when={active()}>
        {(shown) => (
          <>
            <text fg={theme[dagStatusColor(shown().summary.status)]} wrapMode="none">
              {`[${statusLabel(shown().summary.status)}]`}
            </text>
            <text fg={theme.text} wrapMode="none">
              {remoteLine(shown().summary.title)}
            </text>
          </>
        )}
      </Show>
    </box>
  )

  const summaryElement = (
    <box flexDirection="column">
      <Show when={barLayout()}>
        {(layout) => (
          <box height={1} flexShrink={0} flexDirection="row">
            <For each={layout().segments}>
              {(segment) => (
                <text flexShrink={0} fg={segment.token ? theme[segment.token] : undefined} wrapMode="none">
                  {segment.text}
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
      <text fg={theme.textMuted} wrapMode="none">
        {countsText()}
      </text>
      <Show when={view() !== undefined && !loaded()}>
        <text fg={theme.textMuted} wrapMode="none">
          {t("dagmode.panel.loading")}
        </text>
      </Show>
      <Show when={ticking()}>
        <SecondTick />
      </Show>
      <box height={1} flexShrink={0} />
    </box>
  )

  /** Made anew each time the panel goes empty, never reused: a rendered node cannot be put on screen twice. */
  const emptyBody = createMemo(() =>
    active() === undefined ? (
      <text fg={theme.textMuted} wrapMode="word">
        {t("dagmode.panel.empty")}
      </text>
    ) : undefined,
  )

  const tabs = createMemo<readonly PanelTab[] | undefined>(() => {
    const list = workflows()
    if (list.length < 2) return undefined
    return list.map((each) => ({
      id: each.summary.id,
      label: truncateCells(remoteLine(each.summary.title), TAB_LABEL_CELLS, ambiguousWidth()),
      badge: statusLabel(each.summary.status),
    }))
  })

  useBindings(() => ({
    enabled: () => active() !== undefined,
    commands: [
      { name: "dag.panel.request", title: t("dagmode.panel.hint.request"), category: "Panel", run: openRequests },
      { name: "dag.panel.detail", title: t("dagmode.panel.hint.detail"), category: "Panel", run: toggleDetail },
    ],
    bindings: [
      { key: "i", cmd: "dag.panel.request", desc: t("dagmode.panel.hint.request"), group: "Panel" },
      { key: "o", cmd: "dag.panel.detail", desc: t("dagmode.panel.hint.detail"), group: "Panel" },
    ],
  }))

  // On a narrow terminal the hint row is cut at its end, where the close hint sits: the details key, which
  // `enter` also reaches on a node without a session, gives way first.
  const hints = createMemo<PanelHint[]>(() => [
    { key: "dag.panel.request", label: t("dagmode.panel.hint.request"), when: () => active() !== undefined },
    {
      key: "dag.panel.detail",
      label: t("dagmode.panel.hint.detail"),
      when: () => selectedNode() !== undefined && dimensions().width >= PANEL_NARROW_WIDTH,
    },
  ])

  return (
    <DetailPanel
      title={titleElement}
      command="/dag"
      tabs={tabs()}
      activeTab={active()?.summary.id}
      onTab={switchWorkflow}
      summary={summaryElement}
      rows={rows()}
      selected={selectedID()}
      onSelect={(row) => state.setNode(row.id)}
      onActivate={selectedNode() ? activate : undefined}
      activateLabel={selectedNode()?.child_session_id ? t("dagmode.panel.hint.enter") : t("dagmode.panel.hint.expand")}
      body={emptyBody()}
      hints={hints()}
    />
  )
}

/**
 * The templates for asking the main agent. Choosing one closes every panel and hands its text to the
 * main session's input; nothing is sent, and nothing is asked of the server.
 */
function DagRequestPanel(props: { ctx: DagRequestContext }) {
  const host = usePanelHost()
  const prefill = usePrefillRootPrompt()

  const items = createMemo<ListItem<DagRequestKind>[]>(() =>
    dagRequestKinds(props.ctx).map((kind) => ({
      id: kind,
      value: kind,
      title: dagRequestLabel(kind, props.ctx),
      description: dagRequestText(kind, props.ctx),
    })),
  )

  return (
    <ListPanel
      title={t("dagmode.panel.request.title")}
      command="/dag"
      items={items()}
      filter={false}
      onSelect={(item) => {
        const text = dagRequestText(item.value, props.ctx)
        host.closeAll()
        prefill(text)
      }}
    />
  )
}
