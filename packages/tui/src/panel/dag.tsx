// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack, type Accessor } from "solid-js"
import { resolveRootSessionID, sessionTree } from "../ask/ask-queue"
import { useKV } from "../context/kv"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { locationHeaders, useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useTicker } from "../context/ticker-context"
import { layoutDagBar } from "../dag/bar"
import { dagFold, type DagFoldRow } from "../dag/fold"
import { dagCoverageEntries, dagModeLine, dagQualityText, dagUsage, dagUsageText, type DagModePiece } from "../dag/mode"
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
  type DagStatusToken,
  type DagWorkflowSummary,
  type DagWorkflowView,
} from "../dag/model"
import { dagUnplacedReasons } from "../dag/waves"
import { t, type MessageKey } from "../i18n"
import { useBindings } from "../keymap"
import { useOpenSubAgent } from "../session/navigate"
import { usePrefillRootPrompt } from "../session/prefill"
import type { Theme } from "../theme"
import { textAttributes, textFg } from "../ui/text"
import { cellWidth, truncateCells, truncateCellsLeft, type AmbiguousWidth } from "../ui/width"
import { TuiLog } from "../util/log"
import { remoteLine } from "../util/remote-text"
import { COLUMN_GAP, DetailPanel, type DetailRow } from "./detail"
import { usePanelHost, type PanelSpec } from "./host"
import { usePanelInnerWidth, type PanelHint, type PanelTab } from "./shell"

/** The name this panel declares what it shows under; the data layer holds one declaration per surface. */
const SOURCE = "dag-panel"

/** What a node's details say about its output, once the user opened them. */
/** `stamp` is the node's state when the read started (`outputStamp`): a later state makes it stale. */
type NodeOutput =
  | { readonly status: "loading"; readonly stamp: string }
  | { readonly status: "ready"; readonly text: string | undefined; readonly stamp: string }
  | { readonly status: "failed"; readonly stamp: string }

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
  /** Expansion slots whose children are shown, as the `nodeKey`s of the slot: every slot starts folded. */
  readonly unfolded: Accessor<ReadonlySet<string>>
  toggleUnfolded(key: string): void
  /** Outputs read on demand, by `nodeKey`: a node's output is not in its table row. */
  readonly outputs: Accessor<Readonly<Record<string, NodeOutput>>>
  setOutput(key: string, output: NodeOutput): void
  /** Forget every output read so far: after a reconnect they may predate the node's current state. */
  clearOutputs(): void
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
  const [unfolded, setUnfolded] = createSignal<ReadonlySet<string>>(new Set())
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
    unfolded,
    toggleUnfolded: (key) =>
      setUnfolded((current) => {
        const next = new Set(current)
        if (!next.delete(key)) next.add(key)
        return next
      }),
    outputs,
    setOutput: (key, output) => setOutputs((current) => ({ ...current, [key]: output })),
    clearOutputs: () => setOutputs({}),
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

/** From this width a slot row's hint row has room for the request key's hint next to the fold key's, tab key's included. */
const SLOT_REQUEST_HINT_WIDTH = 120

/** Coverage entries listed before the rest are only counted: the block is part of the summary and the panel is short. */
const COVERAGE_ENTRIES = 4

const LINE_SEPARATOR = " · "

/** A piece of a line and the theme token it is drawn in; a level is named by its role instead of a token. */
interface Piece {
  readonly text: string
  readonly token: DagStatusToken | DagModePiece["token"] | "textDim" | "secondary" | "hint"
}

/** The color of a piece: a role through the level table, a status or mode token straight from the theme. */
function pieceFg(theme: Theme, token: Piece["token"]) {
  return token === "secondary" || token === "hint" ? textFg(theme, token) : theme[token]
}

/**
 * The pieces on one line of `width` cells, `separator` between them. The piece that crosses the edge is cut with an
 * ellipsis and the ones after it are left out, so a line is never wrapped and never wider than its room.
 */
function fitLine(
  pieces: readonly Piece[],
  width: number,
  aw: AmbiguousWidth,
  separator: Piece = { text: LINE_SEPARATOR, token: "hint" },
): Piece[] {
  const fitted: Piece[] = []
  let room = width
  const gap = cellWidth(separator.text, aw)
  for (const [index, piece] of pieces.entries()) {
    if (index > 0) {
      if (room <= gap) break
      fitted.push(separator)
      room -= gap
    }
    const cells = cellWidth(piece.text, aw)
    if (cells <= room) {
      fitted.push(piece)
      room -= cells
      continue
    }
    const cut = truncateCells(piece.text, room, aw)
    if (cut !== "") fitted.push({ text: cut, token: piece.token })
    break
  }
  return fitted
}

/**
 * The worktree row (#1618): where the workflow's isolated worktree is and which branch it is on, read off the
 * summary's `worktree` and nothing else. The path is what gives way: it is cut from the left, so the end that tells
 * one worktree from another stays, and the branch is kept whole; only a line too wide even then loses the tail of
 * the branch. A worktree that was cleaned up has no directory to name, so the row is its branch and that the
 * directory is gone, and without a branch there is nothing left to say. Both strings come from the server and
 * are cleaned of escapes and line breaks first. One row, never wider than `width`; none when there is nothing to show.
 */
function worktreeLine(worktree: DagWorkflowSummary["worktree"], width: number, aw: AmbiguousWidth) {
  if (worktree === undefined) return undefined
  const branch = worktree.branch === undefined ? "" : remoteLine(worktree.branch)
  if (worktree.state === "removed") {
    return branch === "" ? undefined : truncateCells(t("dagmode.panel.worktree.removed", { branch }), width, aw)
  }
  const path = remoteLine(worktree.directory)
  if (path === "") return undefined
  const key: MessageKey = branch === "" ? "dagmode.panel.worktree.noBranch" : "dagmode.panel.worktree"
  // The room the path may take is what the words around it leave, and never less than the cut mark: a branch too long
  // for the line takes the end of the line, not the place where the path was.
  const room = Math.max(width - cellWidth(t(key, { path: "", branch }), aw), 2)
  return truncateCells(t(key, { path: truncateCellsLeft(path, room, aw), branch }), width, aw)
}

const nodeKey = (workflowID: string, nodeID: string) => `${workflowID}\u0000${nodeID}`

/** What an output read belongs to: a node that changes status or starts another attempt has a new output. */
const outputStamp = (node: DagNodeRow | undefined) => (node ? `${node.status}\u0000${node.attempt_id ?? ""}` : "")

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
  const openSubAgent = useOpenSubAgent()
  const prefill = usePrefillRootPrompt()
  const dimensions = useTerminalDimensions()

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const innerWidth = usePanelInnerWidth({ dimensions })
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
  /**
   * The nodes an expansion generated, folded under the slot that generated them; the slots the user opened show
   * theirs. What the rows draw. The bar, the counts and `nodeList` still hold every node.
   */
  const fold = createMemo(() => {
    const current = view()
    if (!current) return undefined
    const prefix = `${current.summary.id}\u0000`
    const open = new Set<string>()
    for (const key of state.unfolded()) if (key.startsWith(prefix)) open.add(key.slice(prefix.length))
    return dagFold(current.waves, current.unplaced, open)
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

  // DAG mode (F4 7.1), all of it read from what the data layer holds: the mode is the session's own field, the
  // usage follows the workflow summaries over the mode snapshot (the slots of the whole process being the latest
  // report of any session), quality and coverage are the shown workflow's own.
  const snapshot = createMemo(() => {
    const root = rootID()
    return root === undefined ? undefined : sync.data.dagMode[root]
  })
  const usage = createMemo(() => {
    const root = rootID()
    return root === undefined
      ? undefined
      : dagUsage({ snapshot: snapshot(), workflows: sync.data.dag[root], running: sync.data.dagRunning })
  })
  const modeLine = createMemo(() => {
    const root = rootID()
    const on = root !== undefined && sync.session.get(root)?.dagMode === "on"
    return fitLine(dagModeLine({ on, snapshot: snapshot(), usage: usage() }), innerWidth(), ambiguousWidth())
  })
  /** The shown workflow's itemised usage (#1475), read off its summary alone; none while the server sends none. */
  const usageText = createMemo(() => {
    const summary = active()?.summary
    return summary === undefined ? undefined : dagUsageText(summary)
  })
  const qualityText = createMemo(() => dagQualityText(active()?.summary.quality))
  /** The shown workflow's worktree (#1618), laid out to the panel's width; none when it has no isolation. */
  const worktreeText = createMemo(() => worktreeLine(active()?.summary.worktree, innerWidth(), ambiguousWidth()))
  /** A workflow paused while the budget is gone: the pause is most likely the budget's, so the panel says what ends it. */
  const budgetPaused = createMemo(() => {
    const summary = active()?.summary
    return summary?.status === "paused" && summary.checkpointPending !== true && usage()?.tier === "exhausted"
  })
  const coverage = createMemo(() => {
    const current = view()
    const count = current ? counted(current.summary.coverageCount) : 0
    if (!current || count <= 0) return undefined
    const entries = loaded() ? dagCoverageEntries(nodeList()) : []
    // The server counts more than nodes (a declined fan-out, a lane gap, a safety denial); the nodes are a subset.
    const tail = [
      entries.length > COVERAGE_ENTRIES
        ? t("dagmode.panel.coverage.more", { n: entries.length - COVERAGE_ENTRIES })
        : "",
      loaded() && count > entries.length ? t("dagmode.panel.coverage.rest", { n: count - entries.length }) : "",
    ].filter((part) => part !== "")
    return { count, entries: entries.slice(0, COVERAGE_ENTRIES), tail: tail.join(LINE_SEPARATOR) }
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
    // A node folded away is stood for by the nearest slot above it that is on show.
    const shown = (id: string) => fold()?.hidden.get(id) ?? id
    const picked = state.node()
    if (picked !== undefined && list.some((node) => node.id === picked)) return shown(picked)
    // Start on what needs a look: a failed node, else a running one, else the first.
    const startOn =
      list.find((node) => dagDisplayState(node.status, node.error_class) === "failed") ??
      list.find((node) => dagDisplayState(node.status, node.error_class) === "running") ??
      list[0]
    return startOn === undefined ? undefined : shown(startOn.id)
  })
  const selectedNode = createMemo(() => nodeList().find((node) => node.id === selectedID()))
  /** The selected row is an expansion slot: its children can be folded and unfolded. */
  const selectedSlot = createMemo(() => {
    const entry = fold()?.rows.find((each) => each.node.id === selectedID())
    return entry !== undefined && entry.children > 0
  })

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
    const cached = state.outputs()[key]
    const output = cached?.stamp === outputStamp(node) ? cached : undefined
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
    const stamp = outputStamp(sync.dag.nodes(workflowID)?.find((row) => row.id === nodeID))
    if (state.outputs()[key]?.stamp === stamp) return
    state.setOutput(key, { status: "loading", stamp })
    try {
      const response = await sdk.client.dag.nodes(
        { dagID: workflowID },
        { headers: locationHeaders({ workspace: project.workspace.current() }) },
      )
      const found = response.data?.find((node) => node.id === nodeID)
      state.setOutput(
        key,
        found
          ? { status: "ready", text: remoteLine(formatDagOutputPreview(found.output, 400) ?? "") || undefined, stamp }
          : { status: "failed", stamp },
      )
    } catch (error) {
      TuiLog.write("error", "Loading a DAG node's output failed", { workflowID, nodeID, error: String(error) })
      state.setOutput(key, { status: "failed", stamp })
    }
  }

  /**
   * Open details that need a read: none was made since the last reconnect, or it was made for an earlier
   * state of the node (it finished, or was retried). A node whose table is not in yet waits for it.
   */
  const outputsToRead = createMemo(
    () =>
      [...state.expanded()].filter((key) => {
        const [workflowID, nodeID] = key.split("\u0000")
        const node = sync.dag.nodes(workflowID ?? "")?.find((row) => row.id === nodeID)
        if (node === undefined) return false
        return state.outputs()[key]?.stamp !== outputStamp(node)
      }),
    [],
    { equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]) },
  )
  // Read them. A read stamps its entry with the node's current state at once, so it leaves the list.
  createEffect(
    on(outputsToRead, (keys) => {
      for (const key of keys) {
        const [workflowID, nodeID] = key.split("\u0000")
        if (workflowID && nodeID) void loadOutput(workflowID, nodeID)
      }
    }),
  )

  // A reconnect may have run nodes on: an output read before it can belong to an earlier state. Drop
  // them all; the open ones are read again once the reread table is in (`outputsToRead`), closed ones on
  // their next opening.
  onCleanup(sync.onResync(() => state.clearOutputs()))

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
      openSubAgent(node.child_session_id)
      return
    }
    toggleDetail()
  }

  /** Space on a slot row: show its children, or fold them away again. A view change only; nothing is asked of anyone. */
  function toggleFold(row: DetailRow<DagNodeRow>) {
    const shown = active()
    const entry = fold()?.rows.find((each) => each.node.id === row.id)
    if (!shown || !entry || entry.children === 0) return
    // The slot is the selection from here on: unfolding must not hand it back to a node it had hidden.
    state.setNode(row.id)
    state.toggleUnfolded(nodeKey(shown.summary.id, row.id))
  }

  /**
   * `i`: hand the selected node to the main agent in one press. The request is prefilled into the main session's
   * input (never sent) with the node's name and, when it has one, the reason it needs a look; the panels close.
   */
  function requestSelected() {
    const node = selectedNode()
    const shown = active()
    if (!node || !shown) return
    const reason = rows().find((row) => row.id === node.id)?.note ?? ""
    const text = t("dagmode.prefill.node", {
      title: remoteLine(shown.summary.title),
      id: remoteLine(shown.summary.id),
      name: remoteLine(node.name),
      reason: reason === "" ? "" : `：${remoteLine(reason)}`,
    })
    host.closeAll()
    prefill(text)
  }

  // ── rows ──────────────────────────────────────────────────────────────────────────────────────────────
  /** The widest state symbol, so a row whose symbol is narrower still lines its columns up under `ambiguous_width` 2. */
  const symbolCells = () =>
    Math.max(...Object.values(DAG_STATE_STYLE).map((style) => cellWidth(style.glyph, ambiguousWidth())))

  const rows = createMemo<DetailRow<DagNodeRow>[]>(() => {
    const current = view()
    const folded = fold()
    if (!current || !folded) return []
    const workflowID = current.summary.id
    const symbols = symbolCells()
    const aw = ambiguousWidth()
    // Room for a fold mark in front of every name, once the workflow has a slot to put one on.
    const marked = folded.rows.some((entry) => entry.children > 0)
    // The wave label is drawn (not a string) so it can take the muted and dim levels; it is padded to the widest of
    // its column here, where the string cells are measured by `DetailPanel` for the rest. The time is read in its
    // own cell below, so only that cell follows the clock and the rows are not rebuilt every second.
    const raw: { entry: DagFoldRow<DagNodeRow>; label: string }[] = []
    const labelled = new Set<number>()
    for (const entry of folded.rows) {
      // The first row of a wave carries its number and the rest of its nodes a bar; a node folded under a slot is in
      // none of them, so it carries neither.
      let label = ""
      if (entry.depth === 0 && entry.wave === undefined) label = "!"
      else if (entry.depth === 0 && entry.wave !== undefined) {
        label = labelled.has(entry.wave) ? "│" : t("dagmode.panel.wave", { n: entry.wave + 1 })
        labelled.add(entry.wave)
      }
      raw.push({ entry, label })
    }
    const labelWidth = Math.max(0, ...raw.map((each) => cellWidth(each.label, aw)))
    const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - cellWidth(text, aw)))
    // `note` and `body` are read when a row is selected or opened, and follow the clock and the output as they
    // change, so the rows are not rebuilt every second.
    const rowFor = (entry: DagFoldRow<DagNodeRow>, label: string): DetailRow<DagNodeRow> => {
      const node = entry.node
      const style = dagStateStyle(node.status, node.error_class)
      const slot = entry.children > 0
      const mark = marked ? (slot ? (entry.unfolded ? "▾ " : "▸ ") : "  ") : ""
      // A wave's first label is muted, the bar that continues it and the unplaced mark are dim.
      const labelToken = label === "│" || label === "!" ? "hint" : "secondary"
      return {
        id: node.id,
        cells: [
          <text flexShrink={0} fg={textFg(theme, labelToken)} wrapMode="none">
            {pad(label, labelWidth) + " ".repeat(COLUMN_GAP)}
          </text>,
          <text flexShrink={0} fg={theme[style.token]} wrapMode="none">
            {style.glyph + " ".repeat(symbols + 1 - cellWidth(style.glyph, aw))}
          </text>,
          // Two cells a level: a child sits one step in from the slot it is under.
          "  ".repeat(entry.depth) + mark + remoteLine(node.name),
          <text flexShrink={0} fg={textFg(theme, "secondary")} wrapMode="none">
            {spanOf(node)}
          </text>,
          // Direct children, not everything below: what is one step down is what unfolding shows.
          ...(slot
            ? [
                <text flexShrink={0} fg={textFg(theme, "secondary")} wrapMode="none">
                  {`  ${t(entry.children === 1 ? "dagmode.panel.fold.child" : "dagmode.panel.fold.children", { n: entry.children })}`}
                </text>,
              ]
            : []),
        ],
        value: node,
        toggleLabel: slot ? t(entry.unfolded ? "dagmode.panel.hint.fold" : "dagmode.panel.hint.unfold") : undefined,
        // A failed node's reason reads as a warning on the note line; a state, not a level.
        noteToken:
          dagDisplayState(node.status, node.error_class) === "failed"
            ? "error"
            : dagDisplayState(node.status, node.error_class) === "cancelled"
              ? "warning"
              : undefined,
        get note() {
          return noteOf(node, entry.wave)
        },
        get body() {
          return detailOf(node, workflowID)
        },
      }
    }
    const result: DetailRow<DagNodeRow>[] = []
    let headed = false
    for (const { entry, label } of raw) {
      if (entry.depth === 0 && entry.wave === undefined && !headed && current.unplaced.length > 0) {
        headed = true
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
      }
      result.push(rowFor(entry, label))
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

  const countsPieces = createMemo<Piece[]>(() => {
    const current = view()
    if (!current) return []
    const summary = current.summary
    const pieces: Piece[] = [
      {
        text: t("dagmode.panel.count.done", {
          done: counted(summary.completedNodes),
          total: counted(summary.nodeCount),
        }),
        token: "secondary",
      },
    ]
    if (loaded() && current.waves.length > 0) {
      pieces.push({
        text: t("dagmode.panel.count.wave", {
          current: (dagCurrentWave(current.waves) ?? 0) + 1,
          total: current.waves.length,
        }),
        token: "secondary",
      })
    }
    // The failed count is a state the user should see: it takes the error color, the rest stay muted.
    const extra: [number, MessageKey, Piece["token"]][] = [
      [counted(summary.runningNodes), "dagmode.panel.count.running", "secondary"],
      [counted(summary.failedNodes), "dagmode.panel.count.failed", "error"],
      [counted(summary.queuedNodes), "dagmode.panel.count.queued", "secondary"],
      [counted(summary.skippedNodes), "dagmode.panel.count.skipped", "secondary"],
      [counted(summary.abortedNodes), "dagmode.panel.count.aborted", "secondary"],
    ]
    for (const [n, key, token] of extra) if (n > 0) pieces.push({ text: t(key, { n }), token })
    if (loaded()) {
      // Only a workflow still at work counts a clock; a finished one reads the time once, without a subscription.
      const elapsed = dagElapsedMs(
        current.nodes,
        ACTIVE.has(summary.status) ? now() : ticker.now(),
        ACTIVE.has(summary.status),
      )
      if (elapsed !== undefined)
        pieces.push({
          text: t("dagmode.panel.count.elapsed", { time: formatDagDuration(0, elapsed) ?? "" }),
          token: "secondary",
        })
    }
    return pieces
  })

  const titleElement = (
    <box flexDirection="row" gap={1} overflow="hidden">
      <text fg={textFg(theme, "title")} attributes={textAttributes("title")} wrapMode="none">
        {t("dagmode.panel.title")}
      </text>
      <Show when={active()}>
        {(shown) => (
          <>
            <text fg={theme[dagStatusColor(shown().summary.status)]} wrapMode="none">
              {`[${statusLabel(shown().summary.status)}]`}
            </text>
            <text fg={textFg(theme, "body")} wrapMode="none">
              {remoteLine(shown().summary.title)}
            </text>
          </>
        )}
      </Show>
    </box>
  )

  const summaryElement = (
    <box flexDirection="column">
      <text wrapMode="none">
        <For each={modeLine()}>{(piece) => <span style={{ fg: pieceFg(theme, piece.token) }}>{piece.text}</span>}</For>
      </text>
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
      <text wrapMode="none">
        <For each={fitLine(countsPieces(), innerWidth(), ambiguousWidth())}>
          {(piece) => <span style={{ fg: pieceFg(theme, piece.token) }}>{piece.text}</span>}
        </For>
      </text>
      <Show when={worktreeText()}>
        {(text) => (
          <text fg={textFg(theme, "secondary")} wrapMode="none">
            {text()}
          </text>
        )}
      </Show>
      <Show when={usageText()}>
        {(text) => (
          <text fg={textFg(theme, "secondary")} wrapMode="none">
            {truncateCells(text(), innerWidth(), ambiguousWidth())}
          </text>
        )}
      </Show>
      <Show when={qualityText()}>
        {(text) => (
          <text fg={textFg(theme, "secondary")} wrapMode="none">
            {truncateCells(text(), innerWidth(), ambiguousWidth())}
          </text>
        )}
      </Show>
      <Show when={budgetPaused()}>
        <text fg={theme.warning} wrapMode="none">
          {truncateCells(t("dagmode.budget.exhausted"), innerWidth(), ambiguousWidth())}
        </text>
      </Show>
      <Show when={coverage()}>
        {(block) => (
          <box flexDirection="column" flexShrink={0}>
            <text fg={textFg(theme, "secondary")} wrapMode="none">
              {truncateCells(
                t("dagmode.panel.coverage.title", { count: block().count }),
                innerWidth(),
                ambiguousWidth(),
              )}
            </text>
            <For each={block().entries}>
              {(entry) => {
                const style = DAG_STATE_STYLE[entry.state]
                const pieces: Piece[] = [{ text: `  ${style.glyph} ${entry.name}`, token: style.token }]
                if (entry.reason) pieces.push({ text: entry.reason, token: "secondary" })
                return (
                  <text wrapMode="none">
                    <For each={fitLine(pieces, innerWidth(), ambiguousWidth(), { text: "  ", token: "hint" })}>
                      {(piece) => <span style={{ fg: pieceFg(theme, piece.token) }}>{piece.text}</span>}
                    </For>
                  </text>
                )
              }}
            </For>
            <Show when={block().tail}>
              <text fg={textFg(theme, "secondary")} wrapMode="none">
                {truncateCells(`  ${block().tail}`, innerWidth(), ambiguousWidth())}
              </text>
            </Show>
          </box>
        )}
      </Show>
      <Show when={view() !== undefined && !loaded()}>
        <text fg={textFg(theme, "secondary")} wrapMode="none">
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
      <text fg={textFg(theme, "secondary")} wrapMode="word">
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
      { name: "dag.panel.request", title: t("dagmode.panel.hint.request"), category: "Panel", run: requestSelected },
      { name: "dag.panel.detail", title: t("dagmode.panel.hint.detail"), category: "Panel", run: toggleDetail },
    ],
    bindings: [
      { key: "i", cmd: "dag.panel.request", desc: t("dagmode.panel.hint.request"), group: "Panel" },
      { key: "o", cmd: "dag.panel.detail", desc: t("dagmode.panel.hint.detail"), group: "Panel" },
    ],
  }))

  // The request key's hint gives way on a narrow terminal where the row would not hold it (with several workflows
  // the tab key's hint is in it as well), so that the row still ends in the close hint. The `enter` key's own hint
  // (view output, or enter a child session) is the template's `activateLabel`.
  const hints = createMemo<PanelHint[]>(() => [
    {
      key: "dag.panel.request",
      label: t("dagmode.panel.hint.request"),
      when: () => active() !== undefined && !(selectedSlot() && dimensions().width < SLOT_REQUEST_HINT_WIDTH),
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
      onToggle={toggleFold}
      activateLabel={selectedNode()?.child_session_id ? t("dagmode.panel.hint.enter") : t("dagmode.panel.hint.output")}
      // A node's body is the output of its run, which comes with the node's own expanded state: the panel opens it,
      // and `return` keeps its action (entering a child session, or opening the details).
      rowBody="selected"
      body={emptyBody()}
      hints={hints()}
    />
  )
}
