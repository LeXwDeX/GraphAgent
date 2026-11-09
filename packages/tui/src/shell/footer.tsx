// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useCommandShortcut } from "../keymap"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"

export type FooterHint = {
  key: string
  label: string
}

export type FooterKeyHints = {
  /** Shortcut that cycles the active agent, empty when unbound. */
  agent: string
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
    return { agent: agent(), hints }
  })
}

/** Compact home route information merged into the footer's meta row. */
export type FooterMeta = {
  /** Abbreviated destination directory, plus the branch when it is the current one. */
  directory?: string
  /** Connected MCP server count and whether any server failed. */
  mcp?: { count: number; error: boolean }
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
  /** Home route directory, MCP count and version. */
  meta?: FooterMeta
  /** DAG mode indicator slot. */
  dag?: JSX.Element
  /** Shared right-hand slot for transient footer content. */
  right?: JSX.Element
}

const PADDING = 2
const GAP = 1
const HINT_SEPARATOR = " · "
const META_SEPARATOR = " · "

export function Footer(props: FooterProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const dimensions = useTerminalDimensions()

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const width = () => dimensions().width

  const layout = createMemo(() => {
    const aw = ambiguousWidth()
    const inner = Math.max(1, width() - PADDING)

    const agent = props.agent ? truncateCells(props.agent, inner, aw) : ""
    const agentWidth = cellWidth(agent, aw)
    const action = props.agentAction ? `${props.agentAction} ${t("shell.footer.switchAgent")}` : ""
    const actionBudget = inner - agentWidth - (agent ? GAP : 0)
    const actionWidth = action ? cellWidth(action, aw) : 0
    const shownAction =
      action && actionBudget > 0 ? (actionWidth <= actionBudget ? action : truncateCells(action, actionBudget, aw)) : ""

    const leftWidth = agentWidth + (agent && shownAction ? GAP : 0) + (shownAction ? cellWidth(shownAction, aw) : 0)

    // The shared right slot replaces idle hints and leaves no room for meta.
    if (props.right) return { agent, action: shownAction, hints: [] as FooterHint[], meta: "", metaGap: 0, spacer: 0 }

    const rightBudget = inner - leftWidth - (leftWidth > 0 ? GAP : 0)

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
    if (props.meta?.directory) metaParts.push(props.meta.directory)
    if (props.meta?.mcp)
      metaParts.push(`${props.meta.mcp.error ? "⊙!" : "⊙"} ${props.meta.mcp.count} MCP`)
    if (props.meta?.version) metaParts.push(props.meta.version)
    const metaText = metaParts.join(META_SEPARATOR)
    const metaBudget =
      inner -
      leftWidth -
      (leftWidth > 0 && metaText ? GAP : 0) -
      hintsWidth -
      (hintsWidth > 0 && (leftWidth > 0 || metaText) ? GAP : 0)
    const meta = metaText && metaBudget > 0 ? truncateCells(metaText, metaBudget, aw) : ""
    const metaGap = leftWidth > 0 && meta ? GAP : 0
    const metaWidth = cellWidth(meta, aw)
    const spacer = Math.max(
      leftWidth + metaGap + metaWidth > 0 && hintsWidth > 0 ? GAP : 0,
      inner - leftWidth - metaGap - metaWidth - hintsWidth,
    )

    return {
      agent,
      action: shownAction,
      hints: selected,
      meta,
      metaGap,
      spacer,
    }
  })

  return (
    <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
      <Show when={layout().agent || props.dag || layout().action}>
        <box flexDirection="row" gap={GAP}>
          <Show when={layout().agent}>
            <text fg={theme.primary} wrapMode="none">
              <b>{layout().agent}</b>
            </text>
          </Show>
          <Show when={props.dag}>{props.dag}</Show>
          <Show when={layout().action}>
            <text fg={theme.textMuted} wrapMode="none">
              {layout().action}
            </text>
          </Show>
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
