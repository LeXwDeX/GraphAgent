// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useCommandShortcut } from "../keymap"
import { GUTTER, contentWidth } from "../ui/layout"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { DagIndicator, dagIndicatorCompact, dagIndicatorText, type DagIndicatorState } from "./dag-indicator"
import { LEFT_RESERVE } from "./footer-status"
import { SUBAGENT_BACK_KEY, SUBAGENT_SWITCH_KEYS } from "./subagent-path"

export type FooterHint = {
  key: string
  label: string
}

export type FooterKeyHints = {
  /** Shortcut that cycles the active agent, empty when unbound. */
  agent: string
  /** Shortcut that toggles the drawer, empty when unbound. */
  drawer: string
  /** Idle right-hand hints in display order. */
  hints: readonly FooterHint[]
}

/**
 * Builds the footer shortcut hints from the keymap. Keys are never hardcoded;
 * a command without a registered binding is omitted so the footer does not
 * advertise an action that is currently unavailable.
 */
export function useFooterKeyHints(): () => FooterKeyHints {
  const agent = useCommandShortcut("agent.cycle")
  const commands = useCommandShortcut("command.palette.show")
  const drawer = useCommandShortcut("session.drawer.toggle")
  const expand = useCommandShortcut("view.expand.toggle")
  const help = useCommandShortcut("help.show")

  return createMemo(() => {
    const hints: FooterHint[] = []
    if (commands()) hints.push({ key: commands(), label: t("shell.footer.commands") })
    if (drawer()) hints.push({ key: drawer(), label: t("shell.footer.drawer") })
    if (expand()) hints.push({ key: expand(), label: t("shell.footer.expand") })
    if (help()) hints.push({ key: help(), label: t("shell.footer.help") })
    return { agent: agent(), drawer: drawer(), hints }
  })
}

/**
 * Right-hand hints of a sub-agent view: switch sibling (only while it has one), back to the parent, and the drawer,
 * whose key comes from the keymap and is left out while it has no binding.
 */
export function subagentFooterHints(drawer: string, switchable = true): readonly FooterHint[] {
  const hints: FooterHint[] = []
  if (switchable) hints.push({ key: SUBAGENT_SWITCH_KEYS, label: t("subagent.hint.switch") })
  hints.push({ key: SUBAGENT_BACK_KEY, label: t("subagent.hint.back") })
  if (drawer) hints.push({ key: drawer, label: t("shell.footer.drawer") })
  return hints
}

/** Which sub-agent a view shows, for the read-only notice at the left of its footer (#1033 3.3). */
export type FooterSubagent = {
  kind: string
}

/** Compact home route information merged into the footer's meta row. */
export type FooterMeta = {
  /** Connected MCP server count and whether any server failed. */
  mcp?: { count: number; error: boolean }
  /** Pending project trust entries (#1040); rendered as a warning before the meta row. */
  trust?: number
  /** Application version, shown on home. */
  version?: string
}

export type FooterProps = {
  /** Current agent name, rendered in the brand color. */
  agent?: string
  /** Rendered shortcut for cycling agents. */
  agentAction?: string
  /** Right-hand idle hints. Ignored when `right` is present. */
  hints?: readonly FooterHint[]
  /** Home route MCP count and version; other routes pass only the trust count. */
  meta?: FooterMeta
  /** DAG mode indicator shown after the agent name; omitted where the session has no mode switch. */
  dag?: DagIndicatorState
  /** A sub-agent view: its read-only notice follows the agent cluster, which that view leaves empty. */
  subagent?: FooterSubagent
  /** Shared right-hand slot for transient footer content. */
  right?: JSX.Element
}

const GAP = 1
const HINT_SEPARATOR = " · "
const META_SEPARATOR = " · "

const NOTICE_SEPARATOR = " · "

/** The read-only notice: the kind, then the rest of the sentence that says why there is no input. */
function subagentNotice(kind: string) {
  return {
    kind,
    rest: [t("subagent.readonlyTag"), t("subagent.readonly")].map((part) => NOTICE_SEPARATOR + part).join(""),
  }
}

/**
 * Left-hand columns the notice of a sub-agent view takes beyond what `useFooterStatus` holds back for the agent
 * cluster, which that view does not have; the toast shares the row with the notice.
 */
export function subagentNoticeReserve(kind: string, ambiguousWidth: AmbiguousWidth): number {
  const notice = subagentNotice(kind)
  return Math.max(0, cellWidth(notice.kind + notice.rest, ambiguousWidth) + GAP - LEFT_RESERVE)
}

export function Footer(props: FooterProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const dimensions = useTerminalDimensions()

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const width = () => dimensions().width

  const layout = createMemo(() => {
    const aw = ambiguousWidth()
    const inner = Math.max(1, contentWidth(width()))
    const compact = dagIndicatorCompact(width())

    // The DAG indicator follows the agent name and outranks it: the name is
    // shortened first so the mode stays readable on narrow terminals.
    const dag = props.dag ? dagIndicatorText(props.dag, compact) : ""
    const dagWidth = cellWidth(dag, aw)

    const agent = props.agent ? truncateCells(props.agent, inner - (dag ? dagWidth + GAP : 0), aw) : ""
    const agentWidth = cellWidth(agent, aw)
    const head = agentWidth + (dag ? (agent ? GAP : 0) + dagWidth : 0)
    const action = props.agentAction ? `${props.agentAction} ${t("shell.footer.switchAgent")}` : ""
    const actionBudget = inner - head - (head > 0 ? GAP : 0)
    const actionWidth = action ? cellWidth(action, aw) : 0
    const shownAction =
      action && actionBudget > 0 ? (actionWidth <= actionBudget ? action : truncateCells(action, actionBudget, aw)) : ""

    const agentCluster = head + (shownAction ? (head > 0 ? GAP : 0) + cellWidth(shownAction, aw) : 0)

    // A sub-agent view has no agent cluster: its kind and the read-only sentence take the left, cut to what is there.
    const notice = props.subagent ? subagentNotice(props.subagent.kind) : undefined
    const noticeGap = agentCluster > 0 ? GAP : 0
    const noticeBudget = inner - agentCluster - noticeGap
    const noticeKind = notice && noticeBudget > 0 ? truncateCells(notice.kind, noticeBudget, aw) : ""
    const noticeRest =
      notice && noticeKind ? truncateCells(notice.rest, noticeBudget - cellWidth(noticeKind, aw), aw) : ""
    const noticeWidth = cellWidth(noticeKind + noticeRest, aw)
    const leftWidth = agentCluster + (noticeWidth > 0 ? noticeGap + noticeWidth : 0)

    // The shared right slot replaces idle hints and meta, but the trust warning
    // stays visible: it is the only footer reminder that project entries await a
    // decision (#1040), and session routes always mount a right slot.
    const trustText = props.meta?.trust ? t("shell.footer.trust", { count: props.meta.trust }) : ""
    const trustBudget = inner - leftWidth - (leftWidth > 0 ? GAP : 0)
    const trust = trustText && trustBudget > 0 ? truncateCells(trustText, trustBudget, aw) : ""
    const trustWidth = cellWidth(trust, aw)
    const trustGap = leftWidth > 0 && trust ? GAP : 0

    if (props.right) {
      // The renderer lays ambiguous glyphs out one cell wide; at ambiguous_width 2
      // the terminal draws them two cells wide and would push the flush-right
      // slot past the edge, so pull the slot back by the cells the left side gains.
      const shift =
        aw === 2
          ? [agent, dag, shownAction, noticeKind + noticeRest, trust].reduce(
              (sum, text) => sum + cellWidth(text, 2) - cellWidth(text, 1),
              0,
            )
          : 0
      return {
        agent,
        compact,
        action: shownAction,
        noticeGap,
        noticeKind,
        noticeRest,
        trust,
        trustGap,
        hints: [] as FooterHint[],
        meta: "",
        metaGap: 0,
        spacer: 0,
        shift,
      }
    }

    const rightBudget = inner - leftWidth - trustGap - trustWidth - (leftWidth + trustGap + trustWidth > 0 ? GAP : 0)

    const selected: FooterHint[] = []
    let joined = ""
    for (const hint of props.hints ?? []) {
      const candidate = [...selected, hint].map((item) => `${item.key} ${item.label}`).join(HINT_SEPARATOR)
      if (cellWidth(candidate, aw) > rightBudget) break
      selected.push(hint)
      joined = candidate
    }

    const hintsWidth = cellWidth(joined, aw)
    const metaParts: string[] = []
    if (props.meta?.mcp) metaParts.push(`${props.meta.mcp.error ? "⊙!" : "⊙"} ${props.meta.mcp.count} MCP`)
    if (props.meta?.version) metaParts.push(props.meta.version)
    const metaText = metaParts.join(META_SEPARATOR)
    const metaGapBase = leftWidth > 0 || trust ? GAP : 0
    const metaBudget =
      inner -
      leftWidth -
      trustGap -
      trustWidth -
      (metaText && metaGapBase ? GAP : 0) -
      hintsWidth -
      (hintsWidth > 0 && (leftWidth > 0 || trust || metaText) ? GAP : 0)
    const meta = metaText && metaBudget > 0 ? truncateCells(metaText, metaBudget, aw) : ""
    const metaGap = meta && metaGapBase ? GAP : 0
    const metaWidth = cellWidth(meta, aw)
    const spacer = Math.max(
      leftWidth + trustGap + trustWidth + metaGap + metaWidth > 0 && hintsWidth > 0 ? GAP : 0,
      inner - leftWidth - trustGap - trustWidth - metaGap - metaWidth - hintsWidth,
    )

    return {
      agent,
      compact,
      action: shownAction,
      noticeGap,
      noticeKind,
      noticeRest,
      trust,
      trustGap,
      hints: selected,
      meta,
      metaGap,
      spacer,
      shift: 0,
    }
  })

  return (
    <box height={1} flexShrink={0} flexDirection="row" paddingLeft={GUTTER} paddingRight={GUTTER + layout().shift}>
      <Show when={layout().agent || props.dag || layout().action}>
        <box flexDirection="row" gap={GAP}>
          <Show when={layout().agent}>
            <text fg={theme.primary} wrapMode="none">
              <b>{layout().agent}</b>
            </text>
          </Show>
          <Show when={props.dag}>{(state) => <DagIndicator state={state()} compact={layout().compact} />}</Show>
          <Show when={layout().action}>
            <text fg={theme.textMuted} wrapMode="none">
              {layout().action}
            </text>
          </Show>
        </box>
      </Show>
      <Show when={layout().noticeKind}>
        <box paddingLeft={layout().noticeGap}>
          <text fg={theme.text} wrapMode="none">
            <b>{layout().noticeKind}</b>
            <span style={{ fg: theme.textMuted }}>{layout().noticeRest}</span>
          </text>
        </box>
      </Show>
      <Show when={layout().trust}>
        <box paddingLeft={layout().trustGap}>
          <text fg={theme.warning} wrapMode="none">
            {layout().trust}
          </text>
        </box>
      </Show>
      <Show when={layout().meta}>
        <box paddingLeft={layout().metaGap}>
          <text fg={theme.textMuted} wrapMode="none">
            {layout().meta}
          </text>
        </box>
      </Show>
      <Show
        when={props.right}
        fallback={
          <>
            <box width={layout().spacer} flexShrink={0} />
            <Hints hints={layout().hints} />
          </>
        }
      >
        <box flexGrow={1} flexShrink={1} />
        {props.right}
      </Show>
    </box>
  )
}

function Hints(props: { hints: readonly FooterHint[] }) {
  const { theme } = useTheme()
  return (
    <Show when={props.hints.length > 0}>
      <text wrapMode="none">
        {props.hints.map((hint, index) => (
          <>
            <Show when={index > 0}>
              <span style={{ fg: theme.textMuted }}>{HINT_SEPARATOR}</span>
            </Show>
            <span style={{ fg: theme.text }}>{hint.key}</span>
            <span style={{ fg: theme.textMuted }}> {hint.label}</span>
          </>
        ))}
      </text>
    </Show>
  )
}
