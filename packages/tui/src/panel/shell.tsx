// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { BoxRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useTuiConfig } from "../config"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { formatKeyBindings, useKeymapSelector } from "../keymap"
import { cellWidth, truncateCells, type AmbiguousWidth } from "../ui/width"
import { usePanelHostDepth } from "./host"

export interface PanelTab {
  id: string
  label: string
  badge?: string
}

export interface PanelHint {
  /** Keymap command name; the displayed keys come from the registered bindings. */
  key: string
  label: string
  when?: () => boolean
}

export interface PanelShellProps {
  /** Top-left heading. Strings are measured and truncated; JSX is left to flex layout. */
  title: JSX.Element | string
  tabs?: readonly PanelTab[]
  activeTab?: string
  onTab?: (id: string) => void
  /** Top-right muted command name, for example "/config". */
  command?: string
  tone?: "default" | "warning"
  /** Footer hints supplied by the template; the host common close hint is appended. */
  hints: readonly PanelHint[]
  /** Maximum content rows; defaults to min(14, floor(terminal height * 0.45)). */
  maxRows?: number
  /**
   * Receives the content scroll container. Templates use it to reveal the
   * selected row; it is an internal extension of the shared shell.
   */
  scrollRef?: (scroll: ScrollBoxRenderable | undefined) => void
  children: JSX.Element
}

/** Below this width the command and secondary tab information are hidden first. */
export const PANEL_NARROW_WIDTH = 100

const BORDER_AND_PADDING = 4
const GAP = 2
const TAB_GAP = 2
const TITLE_MIN_WIDTH = 8
const HINT_SEPARATOR = " · "

export function PanelShell(props: PanelShellProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const hostDepth = usePanelHostDepth()
  const [contentRows, setContentRows] = createSignal<number>()

  const ambiguousWidth = (): AmbiguousWidth => (kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
  const innerWidth = () => Math.max(1, dimensions().width - BORDER_AND_PADDING)
  const maxRows = () => Math.max(1, props.maxRows ?? Math.min(14, Math.floor(dimensions().height * 0.45)))
  // The scrollbox fills the remaining main-axis space by default; measuring the
  // content lets the panel hug its rows up to the configured maximum.
  const viewportRows = () => Math.min(maxRows(), Math.max(1, contentRows() ?? maxRows()))

  const hints = createMemo<PanelHint[]>(() => {
    const seen = new Set<string>()
    const result: PanelHint[] = []
    for (const hint of props.hints) {
      if (seen.has(hint.key)) continue
      seen.add(hint.key)
      result.push(hint)
    }
    if (hostDepth > 0 && !seen.has("panel.close")) {
      result.push({ key: "panel.close", label: t("panel.hint.close") })
    }
    return result
  })

  const hintCommands = createMemo(() => hints().map((hint) => hint.key))
  const hintBindings = useKeymapSelector((keymap) =>
    keymap.getCommandBindings({ visibility: "registered", commands: hintCommands() }),
  )
  const hintText = createMemo(() =>
    hints()
      .filter((hint) => hint.when?.() !== false)
      .flatMap((hint) => {
        const keys = formatKeyBindings(hintBindings().get(hint.key), tuiConfig)
        return keys ? [`${keys} ${hint.label}`] : []
      })
      .join(HINT_SEPARATOR),
  )

  const layout = createMemo(() => {
    const aw = ambiguousWidth()
    const width = dimensions().width
    const inner = Math.max(1, width - BORDER_AND_PADDING)
    const narrow = width < PANEL_NARROW_WIDTH
    const tabs = props.tabs ?? []
    const activeId = props.activeTab ?? tabs[0]?.id
    const command = narrow ? undefined : props.command
    const commandWidth = command ? cellWidth(command, aw) : 0
    const titleIsString = typeof props.title === "string"
    const titleText = titleIsString ? (props.title as string) : ""
    const titleWidth = titleIsString ? cellWidth(titleText, aw) : 0

    const allTabs = tabs.map((tab) => {
      const active = tab.id === activeId
      const text = active ? `[${tab.label}]` : tab.label
      const badge = narrow ? undefined : tab.badge
      const tabWidth = cellWidth(text, aw) + (badge ? 1 + cellWidth(badge, aw) : 0)
      return { id: tab.id, text, badge, active, width: tabWidth }
    })

    const fullTabsWidth = allTabs.reduce((sum, tab) => sum + TAB_GAP + tab.width, 0)
    const minTitle = titleIsString ? Math.min(titleWidth, TITLE_MIN_WIDTH) : TITLE_MIN_WIDTH
    const tabsBudget = Math.max(0, inner - commandWidth - (command ? GAP : 0) - minTitle)

    let shownTabs = allTabs
    if (fullTabsWidth > tabsBudget) {
      const active = allTabs.find((tab) => tab.active) ?? allTabs[0]
      shownTabs = active
        ? [
            {
              ...active,
              badge: undefined,
              text: truncateCells(active.text, Math.max(0, tabsBudget - TAB_GAP), aw),
            },
          ]
        : []
    }
    const tabsWidth = shownTabs.reduce(
      (sum, tab) => sum + TAB_GAP + cellWidth(tab.text, aw) + (tab.badge ? 1 + cellWidth(tab.badge, aw) : 0),
      0,
    )

    const titleBudget = Math.max(0, inner - tabsWidth - commandWidth - (command ? GAP : 0))
    const title = titleIsString ? truncateCells(titleText, titleBudget, aw) : undefined

    return { title, tabs: shownTabs, command }
  })

  const titleColor = () => (props.tone === "warning" ? theme.warning : theme.primary)

  return (
    <box
      width="100%"
      flexShrink={0}
      flexDirection="column"
      backgroundColor={theme.backgroundPanel}
      borderStyle="rounded"
      border={["top", "right", "bottom", "left"]}
      borderColor={props.tone === "warning" ? theme.borderWarning : theme.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <box height={1} flexShrink={0} flexDirection="row" overflow="hidden">
        <Show
          when={typeof props.title === "string"}
          fallback={
            <box flexShrink={1} overflow="hidden">
              {props.title}
            </box>
          }
        >
          <text flexShrink={1} overflow="hidden" wrapMode="none" fg={titleColor()} attributes={TextAttributes.BOLD}>
            {layout().title}
          </text>
        </Show>
        <For each={layout().tabs}>
          {(tab) => (
            <text
              flexShrink={0}
              wrapMode="none"
              onMouseUp={() => props.onTab?.(tab.id)}
              fg={tab.active ? theme.primary : theme.textMuted}
              attributes={tab.active ? TextAttributes.BOLD : undefined}
            >
              {`${" ".repeat(TAB_GAP)}${tab.text}`}
              <Show when={tab.badge}>
                <span style={{ fg: theme.textDim }}> {tab.badge}</span>
              </Show>
            </text>
          )}
        </For>
        <box flexGrow={1} flexShrink={1} />
        <Show when={layout().command}>
          <text flexShrink={0} wrapMode="none" fg={theme.textDim}>
            {layout().command}
          </text>
        </Show>
      </box>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => props.scrollRef?.(element)}
        width="100%"
        height={viewportRows()}
        maxHeight={maxRows()}
        flexShrink={0}
        scrollbarOptions={{ visible: false }}
      >
        <box
          width="100%"
          flexDirection="column"
          flexShrink={0}
          onSizeChange={function (this: BoxRenderable) {
            const rows = this.height
            if (rows > 0 && rows !== contentRows()) setContentRows(rows)
          }}
        >
          {props.children}
        </box>
      </scrollbox>
      <text height={1} flexShrink={0} fg={theme.textDim} wrapMode="none">
        {truncateCells(hintText(), innerWidth(), ambiguousWidth())}
      </text>
    </box>
  )
}
